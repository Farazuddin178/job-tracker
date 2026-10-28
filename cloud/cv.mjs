// cloud/cv.mjs — one tailored, one-page CV PDF per job, from the CV kit (data/cv-kit.json, which only
// reorders and reframes cv.md facts) through the career-ops gates: title check, structure check,
// HTML build, fact gate against cv.md, A4 one-page PDF (--strict-pages), ATS check.
// No personal content lives in this file: the kit arrives encrypted.
import { writeFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Which kit variant fits a job: the title decides first, the job description breaks ties.
const RULES = [
  [/front[- ]?end|\breact\b|\bui (developer|engineer)\b/, 'frontend'],
  [/data engineer|\betl\b|big data|data pipeline/, 'data_eng'],
  [/machine learning|\bml\b|\bai\b|data scien|genai|generative|computer vision|\bnlp\b/, 'ml'],
  [/automation|\btest(ing)?\b|\bqa\b|quality assurance|\brpa\b/, 'automation'],
  [/\bsre\b|site reliability|devops|cloud op|infrastructure|platform engineer|production support|operations engineer/, 'sre'],
  [/\bgrc\b|governance, risk/, 'compliance'],
  [/\bsoc\b|security|cyber|\biam\b|identity|threat|incident|vulnerab/, 'security'],
  [/trust|safety|abuse|content polic|moderat|enforcement|integrity/, t => /engineering|\bsql\b|data|analytic|technical/.test(t) ? 'ts_tech' : 'ts'],
  [/content|research|editor|taxonom|data quality|metadata/, 'content_analyst'],
  [/fraud|chargeback|dispute|\baml\b|\bkyc\b|\bcdd\b|fincrime|financial crime|transaction monitoring|sanction|investigat|recover/, 'fraud'],
  [/\brisk\b/, t => /data|analytic|\bsql\b|model|quant/.test(t) ? 'risk_data' : 'compliance'],
  [/compliance|regulator|audit|controls|onboarding|due diligence/, 'compliance'],
  [/data analyst|analytics|business intelligence|\bbi\b|reporting|insight/, 'data'],
  [/business analyst|systems analyst|support|implementation|consultant|functional|technical analyst|customer success/, 'tech_analyst'],
  [/software|developer|engineer|programmer|full stack|backend|back end/, 'dev'],
];
export function pickVariant(title, jdText = '') {
  for (const text of [String(title).toLowerCase(), String(jdText).toLowerCase().slice(0, 3000)]) {
    for (const [re, v] of RULES) if (re.test(text)) return typeof v === 'function' ? v(text) : v;
  }
  return 'tech_analyst';
}

function payloadFrom(kit, variantId) {
  const v = kit.variants[variantId];
  if (!v) throw new Error(`unknown CV variant ${variantId}`);
  const pick = (table, keys) => keys.map(k => (typeof k === 'string' ? structuredClone(kit[table][k]) : structuredClone(k)));
  return {
    ...structuredClone(kit.base), candidate: { ...kit.base.candidate, title: v.title }, summary: v.summary,
    experience: [{ ...kit.experience.amazon, bullets: v.bullets.map(k => kit.bullets[k]) }, structuredClone(kit.experience.embrizon)],
    projects: pick('projects', v.projects), certifications: pick('certs', v.certs), skills: pick('skills', v.skills),
  };
}

// Ways to win back space when the render spills onto page 2, one per retry.
const SHRINK = [
  (p) => { if (p.projects.length > 2) { p.projects = p.projects.slice(0, 2); return 'dropped 3rd project'; } },
  (p, kit) => { const i = p.projects.findIndex(x => x.description === kit.projects.LEGAL_LONG?.description); if (i >= 0) { p.projects[i] = structuredClone(kit.projects.LEGAL_SHORT); return 'short legal-project line'; } },
  (p) => { if (p.certifications.length > 1) { p.certifications = p.certifications.slice(0, 1); return 'dropped training line'; } },
  (p) => { if (p.skills.length > 2) { p.skills = p.skills.slice(0, 2); return 'dropped 3rd skills line'; } },
];

const titleCase = s => String(s).replace(/\(.*?\)/g, ' ').replace(/[^A-Za-z0-9 ]+/g, ' ').trim().split(/\s+/)
  .map(w => (w.length <= 3 && w === w.toUpperCase() ? w : w[0].toUpperCase() + w.slice(1).toLowerCase())).join('');
export function pdfName(kit, title, company) {
  const who = kit.base.candidate.name.replace(/\s+/g, '_');
  const co = titleCase(company).slice(0, 20) || 'Company';
  const room = Math.max(8, 64 - `${who}__${co}.pdf`.length);
  // Whole words only: drop trailing words until the name fits.
  const words = titleCase(title).match(/[A-Z]{2,}(?![a-z])|[A-Z0-9][a-z0-9]*/g) || ['Role'];
  let role = '';
  for (const w of words) { if ((role + w).length > room) break; role += w; }
  if (!role) role = words[0].slice(0, room);
  return `${who}_${role}_${co}.pdf`;
}

/**
 * Render one CV. opsDir: career-ops checkout; env: must carry CAREER_OPS_ROOT (the data root with cv.md).
 * Returns { ok, pdf, variant, ats, notes, error }.
 */
export function renderCv({ opsDir, env, kit, job, jdText, workDir, override }) {
  mkdirSync(workDir, { recursive: true });
  const run = args => { const r = spawnSync(process.execPath, args, { cwd: opsDir, env, encoding: 'utf8', timeout: 180_000 }); return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`.trim() }; };
  const template = run(['cv-templates.mjs', 'resolve', 'cv']).out.split('\n').pop();
  const variant = override ? 'tailored' : pickVariant(job.title, jdText);
  const payload = override ? structuredClone(override) : payloadFrom(kit, variant);
  const slug = Math.random().toString(36).slice(2, 10);
  const json = join(workDir, `cv-${slug}.json`), html = join(workDir, `cv-${slug}.html`), pdf = join(workDir, `cv-${slug}.pdf`);
  const notes = [];
  let error = null, ats = null;
  for (let attempt = 0; attempt <= SHRINK.length; attempt++) {
    writeFileSync(json, JSON.stringify(payload, null, 2));
    error = null;
    for (const [label, args] of [
      ['title check', ['cv-title-check.mjs', json, '--summary']],
      ['structure check', ['verify-cv-structure.mjs', json]],
      ['HTML build', ['build-cv-html.mjs', json, html, template]],
      ['fact gate', ['verify-cv-facts.mjs', html]],
      ['PDF', ['generate-pdf.mjs', html, pdf, '--format=a4', '--max-pages=1', '--strict-pages']],
      ['ATS', ['verify-ats.mjs', html]],
    ]) {
      const r = run(args);
      if (label === 'ATS') { ats = Number((r.out.match(/Score: (\d+)/) || [])[1]) || null; continue; }
      if (r.code !== 0) { error = `${label} failed`; if (process.env.CV_DEBUG) console.error(label, r.out.split('\n').slice(-8).join('\n')); break; }
    }
    if (!error || error !== 'PDF failed') break;
    let cut = null;
    for (const f of SHRINK) { cut = f(payload, kit); if (cut) break; }
    if (!cut) break;
    notes.push(cut);
  }
  if (error && existsSync(pdf)) unlinkSync(pdf); // a failed --strict-pages render still writes the file
  for (const f of [json, html]) if (existsSync(f)) unlinkSync(f);
  return { ok: !error, pdf: error ? null : pdf, variant, ats, notes, error };
}
