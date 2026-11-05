// cloud/resume.mjs — turn pasted or PDF-extracted resume text into a CV payload and a clean cv.md.
// The owner has a hand-built CV kit; another profile has only their resume. Tailoring here can only
// reorder what the resume says and drop the least relevant lines, so it can never add a claim.
// cv.md and the payload come from the same parse, which is what lets the career-ops fact gate pass.

const clean = s => String(s || '').replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim();
const BULLET = /^\s*(?:[-*•▪●◦·‣–—]|\d+[.)])\s+/;
const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
const POINT = `(?:${MONTH}\\s*,?\\s*\\d{4}|\\d{1,2}/\\d{4}|\\d{4})`;
const DATES = new RegExp(`${POINT}\\s*(?:-|–|—|to)\\s*(?:${POINT}|present|current|now|till date|ongoing)`, 'i');
const YEARS = new RegExp(`${POINT}(?:\\s*(?:-|–|—|to)\\s*(?:${POINT}|present))?`, 'i');
const TITLE = /\b(engineer|developer|analyst|intern|manager|associate|specialist|consultant|lead|officer|executive|designer|administrator|architect|scientist|coordinator|assistant|trainee|programmer|tester|strategist|recruiter|writer)\b/i;
const DEGREE = /\b(b\.?\s?tech|b\.?\s?e\b|b\.?\s?sc|b\.?\s?com|b\.?\s?a\b|bca|bba|m\.?\s?tech|m\.?\s?sc|mba|mca|m\.?\s?a\b|bachelor|master|ph\.?d|diploma|degree|intermediate|ssc|hsc|12th|10th)\b/i;

const SECTIONS = [
  ['summary', /^(professional |career |personal )?(summary|profile|objective)$|^about( me)?$/],
  ['experience', /^((work|professional|relevant|industry)\s+)?experience$|^employment( history)?$|^work history$|^internships?$/],
  ['projects', /^((academic|personal|key|selected)\s+)?projects$/],
  ['education', /^education(al qualifications?)?$|^academics?$|^academic (background|qualifications?)$/],
  ['skills', /^((technical|core|key|professional)\s+)?(skills|competencies)$|^technologies$|^tools( & technologies)?$/],
  ['certs', /^(certifications?|certificates?|licenses?|training|courses?)( (&|and) (training|certifications?|courses?))?$/],
  ['other', /^(awards|honou?rs|achievements|interests|hobbies|languages|publications|references|activities|volunteering|declaration|extra.*)$/],
];
function sectionOf(line) {
  const t = clean(line.replace(/^#+\s*/, '')).replace(/[:|]+$/, '').toLowerCase();
  if (!t || t.split(' ').length > 5) return null;
  return SECTIONS.find(([, re]) => re.test(t))?.[0] || null;
}

// "Marketing Analyst | Acme Corp, Pune" → title, company, location, whichever order they came in.
function splitHead(parts) {
  const pieces = parts.join(' | ').split(/\s+[|—–-]\s+|\s+at\s+|\s+@\s+|\s*,\s+|\s*\|\s*/).map(clean).filter(Boolean);
  const at = Math.max(0, pieces.findIndex(p => TITLE.test(p)));
  const role = pieces[at] || '';
  const [company = '', ...rest] = pieces.filter((_, i) => i !== at);
  return { role, company, location: rest.join(', ') };
}

function parseExperience(lines) {
  const jobs = [];
  let cur = null, pending = [];
  const spill = () => {
    if (!pending.length) return;
    if (cur?.bullets.length) cur.bullets[cur.bullets.length - 1] += ` ${pending.join(' ')}`; // a wrapped line
    else if (cur && !cur.company) cur.company = splitHead(pending).company || clean(pending[0]);
    else if (cur) cur.bullets.push(...pending);
    pending = [];
  };
  for (const raw of lines) {
    const bullet = BULLET.test(raw);
    const text = clean(raw.replace(BULLET, ''));
    if (!text) continue;
    const date = !bullet && text.match(DATES);
    if (date) {
      // At most the last two short lines above the dates are the job's heading; anything else is wrapped text.
      const head = pending.slice(-2).filter(l => l.length <= 70);
      pending = pending.slice(0, pending.length - head.length);
      spill();
      const here = clean(text.replace(date[0], '').replace(/[(|,–—-]+\s*\)?\s*$/, ''));
      cur = { ...splitHead(here ? [...head, here] : head), dates: clean(date[0]), bullets: [] };
      jobs.push(cur);
    } else if (bullet) { spill(); cur?.bullets.push(text); }
    else pending.push(text);
  }
  spill();
  return jobs;
}

function parseProjects(lines) {
  const out = [];
  let cur = null;
  for (const raw of lines) {
    const bullet = BULLET.test(raw), text = clean(raw.replace(BULLET, ''));
    if (!text) continue;
    const split = text.match(/^(.{3,70}?)\s*(?:—|–| - |: )\s*(.{10,})$/);
    if (split) { cur = { name: split[1], description: split[2] }; out.push(cur); }
    else if (!cur || (!bullet && text.length <= 70 && cur.description)) { cur = { name: text, description: '' }; out.push(cur); }
    else cur.description = clean(`${cur.description} ${text}`);
  }
  return out.filter(p => p.description);
}

function parseEducation(lines) {
  const out = [];
  for (const raw of lines) {
    const text = clean(raw.replace(BULLET, ''));
    if (!text) continue;
    const year = (text.match(YEARS) || [''])[0];
    const rest = clean(text.replace(year, '').replace(/[,|–—-]+\s*$/, ''));
    const [title, ...org] = rest.split(/\s*,\s+|\s+\|\s+|\s+[—–-]\s+/);
    const last = out[out.length - 1];
    if (last && !last.org && !DEGREE.test(title)) { last.org = rest; last.year ||= clean(year); }
    else out.push({ title, org: org.join(', '), year: clean(year) });
  }
  return out.filter(e => e.title);
}

function parseSkills(lines) {
  const out = [];
  for (const raw of lines) {
    const text = clean(raw.replace(BULLET, ''));
    if (!text) continue;
    const m = text.match(/^([^:]{2,40}):\s*(.+)$/);
    if (m) out.push({ category: m[1], items: m[2] });
    else if (out.length && out[out.length - 1].category === 'Skills') out[out.length - 1].items += `, ${text}`;
    else out.push({ category: 'Skills', items: text });
  }
  return out;
}

/** text + profile → { payload, md, check }. check.problems says what a person should fix in their resume. */
export function parseResume(text, profile) {
  const sections = { top: [] };
  let at = 'top';
  for (const line of String(text || '').replace(/\r/g, '').split('\n')) {
    const s = sectionOf(line);
    if (s) { at = s; (sections[at] ||= []); continue; }
    (sections[at] ||= []).push(line);
  }
  const candidate = { name: clean(profile.name), phone: clean(profile.phone), email: clean(profile.email), linkedin: clean(profile.linkedin), github: clean(profile.github), location: clean(profile.location) };
  const experience = parseExperience(sections.experience || []).filter(j => j.role && j.company);
  const payload = {
    lang: 'en', page_format: 'a4', candidate,
    sections: { summary: 'Summary', experience: 'Experience', projects: 'Projects', education: 'Education', certifications: 'Certifications', skills: 'Skills' },
    summary: clean((sections.summary || []).join(' ')),
    experience, projects: parseProjects(sections.projects || []), education: parseEducation(sections.education || []),
    certifications: (sections.certs || []).map(l => clean(l.replace(BULLET, ''))).filter(Boolean).map(title => ({ title, org: '', year: '' })),
    skills: parseSkills(sections.skills || []),
  };
  const problems = [];
  if (!candidate.name) problems.push('Add your name in Settings.');
  if (!candidate.email) problems.push('Add your email in Settings.');
  if (!payload.summary) problems.push('No Summary section found.');
  if (!experience.length && !payload.projects.length) problems.push('No Experience or Projects section found. Put each job on its own line with its dates, like "Jan 2024 – Present".');
  if ((sections.experience || []).some(l => DATES.test(l)) && !experience.length) problems.push('Found dates under Experience, but could not tell the job title from the company.');
  if (!payload.skills.length) problems.push('No Skills section found.');
  if (!payload.education.length) problems.push('No Education section found.');
  const check = { jobs: experience.length, bullets: experience.reduce((n, j) => n + j.bullets.length, 0), projects: payload.projects.length, skills: payload.skills.length, problems };
  return { payload, md: toMarkdown(payload), check };
}

// The shape examples/cv-example.md uses, which the CV checks read by heading.
function toMarkdown(p) {
  const c = p.candidate, out = [`# CV -- ${c.name}`, ''];
  for (const [label, v] of [['Location', c.location], ['Email', c.email], ['Phone', c.phone], ['LinkedIn', c.linkedin], ['GitHub', c.github]]) if (v) out.push(`**${label}:** ${v}`);
  if (p.summary) out.push('', '## Professional Summary', '', p.summary);
  if (p.experience.length) out.push('', '## Work Experience');
  for (const j of p.experience) {
    out.push('', `### ${j.company}${j.location ? ` — ${j.location}` : ''}`, '', `**${j.role}**`, j.dates, '');
    out.push(...j.bullets.map(b => `- ${b}`));
  }
  if (p.projects.length) out.push('', '## Projects', '', ...p.projects.map(x => `- **${x.name}** — ${x.description}`));
  if (p.education.length) out.push('', '## Education', '', ...p.education.map(e => `- ${[e.title, e.org, e.year].filter(Boolean).join(', ')}`));
  if (p.certifications.length) out.push('', '## Certifications', '', ...p.certifications.map(x => `- ${x.title}`));
  if (p.skills.length) out.push('', '## Skills', '', ...p.skills.map(s => `- **${s.category}:** ${s.items}`));
  return `${out.join('\n')}\n`;
}

/** The same facts, most relevant to this job first. Job order stays chronological. */
export function tailor(payload, jdText, topTerms) {
  const jd = new Set(topTerms(jdText || '', 60));
  const hits = s => topTerms(s).filter(w => jd.has(w)).length;
  const byHits = (list, text) => list.map((x, i) => [x, hits(text(x)), i]).sort((a, b) => b[1] - a[1] || a[2] - b[2]).map(([x]) => x);
  const p = structuredClone(payload);
  for (const j of p.experience) j.bullets = byHits(j.bullets, b => b);
  p.projects = byHits(p.projects, x => `${x.name} ${x.description}`);
  for (const s of p.skills) s.items = byHits(s.items.split(/\s*,\s*/), x => x).join(', ');
  p.skills = byHits(p.skills, s => s.items);
  return p;
}
