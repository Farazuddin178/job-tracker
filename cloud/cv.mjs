// cloud/cv.mjs — one tailored, one-page CV PDF per job, from the CV kit (data/cv-kit.json, which only
// reorders and reframes cv.md facts) through the career-ops gates: title check, structure check,
// HTML build, fact gate against cv.md, A4 one-page PDF (--strict-pages), ATS check.
// No personal content lives in this file: the kit arrives encrypted.
import { writeFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tailor } from './resume.mjs';

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

// Three tracks, one master each. A job's version still sets the headline, summary and skills lines (the
// part worth tuning); the work bullets and projects come from the track's master, so every CV in a track
// tells the same story.
export const TRACKS = {
  fraud_risk: { label: 'Fraud / Risk / T&S', master: 'fraud', variants: ['fraud', 'compliance', 'ts', 'ts_tech', 'risk_data', 'content_analyst'] },
  soc_iam: { label: 'SOC / IAM', master: 'security', variants: ['security'] },
  swe_data: { label: 'Junior SWE / Data', master: 'dev', variants: ['dev', 'frontend', 'data', 'data_eng', 'ml', 'automation', 'sre', 'tech_analyst'] },
};
export const trackOf = variant => Object.keys(TRACKS).find(t => TRACKS[t].variants.includes(variant)) || 'swe_data';

function payloadFrom(kit, variantId, exact = false) {
  const v = kit.variants[variantId];
  if (!v) throw new Error(`unknown CV variant ${variantId}`);
  const body = (!exact && kit.variants[TRACKS[trackOf(variantId)].master]) || v;
  const pick = (table, keys) => keys.map(k => (typeof k === 'string' ? structuredClone(kit[table][k]) : structuredClone(k)));
  return {
    ...structuredClone(kit.base), candidate: { ...kit.base.candidate, title: v.title }, summary: v.summary,
    experience: [{ ...kit.experience.amazon, bullets: body.bullets.map(k => kit.bullets[k]) }, structuredClone(kit.experience.embrizon)],
    projects: pick('projects', body.projects), certifications: pick('certs', v.certs), skills: pick('skills', v.skills),
  };
}

// Ways to win back space when the render spills onto page 2, one per retry.
// A sentence-level cut keeps only words the person wrote: the first sentence(s) up to `max` characters.
const firstSentences = (s, max) => {
  const parts = String(s).split(/(?<=[.;])\s+(?=[A-Z(])/);
  let out = parts[0];
  for (const x of parts.slice(1)) { if ((out + ' ' + x).length > max) break; out += ' ' + x; }
  return out.length >= 40 && out.length < String(s).length ? out : null;
};
const SHRINK = [
  // A resume pasted by a profile (no kit variants): long paragraphs and extra lines come off first.
  (p, kit) => {
    if (kit?.variants) return;
    let n = 0;
    for (const j of p.experience || []) j.bullets = j.bullets.map(b => { const c = b.length > 240 && firstSentences(b, 220); if (c) n++; return c || b; });
    if (n) return `shortened ${n} long bullet${n === 1 ? '' : 's'} to the first sentence`;
  },
  (p, kit) => { if (!kit?.variants && p.summary && p.summary.length > 320) { const c = firstSentences(p.summary, 300); if (c) { p.summary = c; return 'shortened the summary'; } } },
  (p, kit) => { if (!kit?.variants && p.education?.length > 2) { p.education = p.education.slice(0, 2); return 'kept the first two education lines'; } },
  (p, kit) => { if (!kit?.variants && p.certifications?.length > 2) { p.certifications = p.certifications.slice(0, 2); return 'kept the first two certifications'; } },
  (p) => { if (p.projects.length > 2) { p.projects = p.projects.slice(0, 2); return 'dropped 3rd project'; } },
  (p, kit) => { const i = p.projects.findIndex(x => x.description === kit.projects.LEGAL_LONG?.description); if (i >= 0) { p.projects[i] = structuredClone(kit.projects.LEGAL_SHORT); return 'short legal-project line'; } },
  // On a security CV the hands-on lab is the strongest proof, so a project goes first.
  (p) => { if (/security/i.test(p.candidate.title) && p.projects.length > 1) { p.projects = p.projects.slice(0, 1); return 'dropped 2nd project'; } },
  (p) => { if (p.certifications.length > 1) { p.certifications = p.certifications.slice(0, 1); return 'dropped training line'; } },
  (p) => { if (p.skills.length > 2) { p.skills = p.skills.slice(0, 2); return 'dropped 3rd skills line'; } },
  (p) => { const j = [...p.experience].sort((a, b) => b.bullets.length - a.bullets.length)[0]; if (j?.bullets.length > 2) { j.bullets.pop(); return 'dropped the least relevant bullet'; } },
];

// The CV as plain text, for application forms and agents that can't take a file.
export function cvText(p) {
  const c = p.candidate, out = [c.name, [c.location, c.phone, c.email, c.linkedin, c.github].filter(Boolean).join(' | ')];
  if (p.summary) out.push('', 'SUMMARY', p.summary);
  if (p.experience?.length) out.push('', 'EXPERIENCE');
  for (const j of p.experience || []) out.push(`${j.role}, ${j.company} (${j.dates})`, ...j.bullets.map(b => `- ${b}`));
  if (p.projects?.length) out.push('', 'PROJECTS', ...p.projects.map(x => `- ${x.name}: ${x.description}`));
  if (p.education?.length) out.push('', 'EDUCATION', ...p.education.map(e => `- ${[e.title, e.org, e.year].filter(Boolean).join(', ')}`));
  if (p.certifications?.length) out.push('', 'CERTIFICATIONS', ...p.certifications.map(x => `- ${[x.title, x.org].filter(Boolean).join(', ')}`));
  if (p.skills?.length) out.push('', 'SKILLS', ...p.skills.map(x => `- ${x.category}: ${x.items}`));
  return out.join('\n');
}

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
 * variant forces a kit variant (a company you already applied to keeps the version you sent it).
 * Returns { ok, pdf, text, variant, ats, notes, error }.
 */
export function renderCv({ opsDir, env, kit, job, jdText, workDir, override, variant: forced }) {
  mkdirSync(workDir, { recursive: true });
  const run = args => { const r = spawnSync(process.execPath, args, { cwd: opsDir, env, encoding: 'utf8', timeout: 180_000 }); return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`.trim() }; };
  const template = run(['cv-templates.mjs', 'resolve', 'cv']).out.split('\n').pop();
  const variant = override ? 'tailored' : forced && kit.variants[forced] ? forced : pickVariant(job.title, jdText);
  // A company you already applied to keeps the exact version it saw; everything else is the track master with light touches.
  const topTerms = globalThis.JobScore?.topTerms;
  const master = override ? null : payloadFrom(kit, variant, !!forced);
  const payload = override ? structuredClone(override) : forced || !topTerms ? master : tailor(master, jdText, topTerms, 2);
  const slug = Math.random().toString(36).slice(2, 10);
  const json = join(workDir, `cv-${slug}.json`), html = join(workDir, `cv-${slug}.html`), pdf = join(workDir, `cv-${slug}.pdf`);
  const notes = [];
  let error = null, ats = null;
  for (let attempt = 0; attempt <= 16; attempt++) {
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
  return { ok: !error, pdf: error ? null : pdf, text: error ? '' : cvText(payload), variant, track: override ? 'your_resume' : trackOf(variant), ats, notes, error };
}
