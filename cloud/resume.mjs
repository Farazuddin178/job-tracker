// cloud/resume.mjs — turn pasted or PDF-extracted resume text into a CV payload and a clean cv.md.
// The owner has a hand-built CV kit; another profile has only their resume. Tailoring here can only
// reorder what the resume says and drop the least relevant lines, so it can never add a claim.
// cv.md and the payload come from the same parse, which is what lets the career-ops fact gate pass.

const clean = s => String(s || '').replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim();
// PDF text often loses the space after a bullet, and Word's bullets arrive as private-use characters.
const BULLET = /^\s*(?:[•▪●◦·‣■□○➢➤✓✔\uf000-\uf8ff]\s*|[-*–—]\s+|\d+[.)]\s+)/;
const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
const POINT = `(?:${MONTH}\\s*,?\\s*\\d{4}|\\d{1,2}/\\d{4}|\\d{4})`;
const DATES = new RegExp(`${POINT}\\s*(?:-|–|—|to)\\s*(?:${POINT}|present|current|now|till (?:date|now)|ongoing)`, 'i');
const YEARS = new RegExp(`${POINT}(?:\\s*(?:-|–|—|to)\\s*(?:${POINT}|present))?`, 'i');
const TITLE = /\b(engineer|developer|analyst|intern|manager|associate|specialist|consultant|lead|officer|executive|designer|administrator|architect|scientist|coordinator|assistant|trainee|programmer|tester|strategist|recruiter|writer|researcher|fellow|research assistant)\b/i;
const DEGREE = /\b(b\.?\s?tech|b\.?\s?e\b|b\.?\s?sc|b\.?\s?com|b\.?\s?a\b|bca|bba|m\.?\s?tech|m\.?\s?sc|mba|mca|m\.?\s?a\b|bachelor|master|ph\.?d|diploma|degree|intermediate|ssc|hsc|12th|10th)\b/i;

const SECTIONS = [
  ['summary', /^(professional |career |personal )?(summary|profile|objective)$|^about( me)?$/],
  ['experience', /^((work|professional|relevant|industry|research|employment)\s+)?experiences?(\s*(&|and)\s*internships?)?$|^employment( history)?$|^work history$|^internships?(\s*(&|and)\s*experience)?$|^career history$/],
  ['projects', /^((academic|personal|key|selected|research|notable|major|technical)\s+)?projects$|^projects?\s*(&|and)\s*publications$/],
  ['education', /^education(al qualifications?)?$|^academics?$|^academic (background|qualifications?)$/],
  ['skills', /^((technical|core|key|professional|relevant)\s+)?(skills|competencies|proficiency|expertise)(\s*(&|and)\s*(tools|technologies|interests))?$|^technologies$|^tools( & technologies)?$/],
  ['certs', /^(certifications?|certificates?|licenses?|training|courses?)( (&|and) (training|certifications?|courses?))?$/],
  ['other', /^((selected|research|key)\s+)?(awards|honou?rs|achievements|interests|hobbies|languages|publications|papers|patents|references|activities|volunteering|declaration|extra.*|conferences|talks|positions of responsibility|leadership)((\s*(&|and)\s*\w+))?$/],
];
function sectionOf(line) {
  let t = clean(line.replace(/^#+\s*/, '')).replace(/[:|]+$/, '').trim().toLowerCase();
  // Letter-spaced headings: "W O R K  E X P E R I E N C E". Their word gaps rarely survive PDF text.
  if (/^([a-z] ){3,}[a-z]( |$)/.test(t)) t = t.replace(/ /g, '').replace(/^(work|professional|relevant|industry|research|employment|technical|core|key|academic|personal|selected|career)(?=[a-z])/, '$1 ');
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
  const BULLET_LESS = new Set(); // jobs whose lines carry no bullet marker at all
  const spill = () => {
    if (!pending.length) return;
    // Bullets drawn as shapes leave plain lines; a line that starts in lower case continues the one above.
    pending = pending.reduce((out, l) => { if (/^[a-z]/.test(l) && out.length) out[out.length - 1] += ` ${l}`; else out.push(l); return out; }, []);
    if (cur?.bullets.length && /^[a-z]/.test(pending[0])) { cur.bullets[cur.bullets.length - 1] += ` ${pending.shift()}`; }
    if (!pending.length) return;
    if (cur?.bullets.length && BULLET_LESS.has(cur)) cur.bullets.push(...pending);
    else if (cur?.bullets.length) cur.bullets[cur.bullets.length - 1] += ` ${pending.join(' ')}`; // a wrapped line
    else if (cur && !cur.company) cur.company = splitHead(pending).company || clean(pending[0]);
    else if (cur) { cur.bullets.push(...pending); BULLET_LESS.add(cur); }
    pending = [];
  };
  for (const raw of lines) {
    const bullet = BULLET.test(raw);
    const text = clean(raw.replace(BULLET, ''));
    if (!text) continue;
    const date = !bullet && text.match(DATES);
    if (date) {
      const here = clean(text.replace(date[0], '').replace(/[(|,–—-]+\s*\)?\s*$/, ''));
      // The heading: this line when it names the role; else up to two short lines above it. Anything else is text of the job before.
      const need = here && TITLE.test(here) ? 0 : here ? 1 : 2;
      const head = need ? pending.slice(-need).filter(l => l.length <= 70) : [];
      pending = pending.slice(0, pending.length - head.length);
      spill();
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
    // No Summary heading: their own introduction, if the top of the page has one, is the summary.
    summary: clean((sections.summary || []).join(' ')) || clean((sections.top || []).filter(l => clean(l).length > 80 && !/@|https?:|linkedin|\+?\d[\d\s-]{8,}/i.test(l)).join(' ')),
    experience, projects: parseProjects(sections.projects || []), education: parseEducation(sections.education || []),
    certifications: (sections.certs || []).map(l => clean(l.replace(BULLET, ''))).filter(Boolean).map(title => ({ title, org: '', year: '' })),
    skills: parseSkills(sections.skills || []),
  };
  const problems = [];
  if (!candidate.name) problems.push('Add your name in Settings.');
  if (!candidate.email) problems.push('Add your email in Settings.');
  if (!payload.summary) problems.push('No Summary section found.');
  if (!experience.length && !payload.projects.length) problems.push('No Experience or Projects section found. Put each job on its own line with its dates, like "Jan 2024 – Present".');
  // Never drop a job quietly: a CV missing someone's experience is worse than no CV.
  const expLines = (sections.experience || []).filter(l => clean(l));
  const dated = expLines.filter(l => !BULLET.test(l) && DATES.test(clean(l))).length;
  if (dated && !experience.length) problems.push('Found dates under Experience, but could not tell the job title from the company.');
  else if (expLines.length && !dated) problems.push('Found an Experience section, but no job dates in it. Put each job on its own line with its dates, like "Data Scientist, Acme, Jan 2024 – Present".');
  else if (dated > experience.length) problems.push(`Could read only ${experience.length} of ${dated} jobs under Experience. Put each job on its own line as "Title, Company, Jan 2024 – Present".`);
  if (!payload.skills.length) problems.push('No Skills section found.');
  if (!payload.education.length) problems.push('No Education section found.');
  const check = { jobs: experience.length, bullets: experience.reduce((n, j) => n + j.bullets.length, 0), measured: experience.flatMap(j => j.bullets).filter(isMeasured).length, projects: payload.projects.length, skills: payload.skills.length, problems };
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

// A bullet with a result you could check: a figure with a unit, not just any digit.
const MEASURED = /\d[\d,.]*\s*(%|\+|k\b|m\b|x\b|lakh|crore|users?|customers?|clients?|records?|cases?|alerts?|hours?|hrs?|days?|tickets?|transactions?|accounts?|requests?|people|members?)/i;
export const isMeasured = b => MEASURED.test(b);

/**
 * The same facts, with light touches only: at most `lift` bullets (those that speak most to this job) move
 * to the top of their job, and every other bullet keeps its place. Skills and projects are reordered. Job
 * order stays chronological. Nothing is reworded, so the resume stays recognisably the same document.
 */
export function tailor(payload, jdText, topTerms, lift = 3) {
  const jd = new Set(topTerms(jdText || '', 60));
  const hits = s => topTerms(s).filter(w => jd.has(w)).length;
  const byHits = (list, text) => list.map((x, i) => [x, hits(text(x)), i]).sort((a, b) => b[1] - a[1] || a[2] - b[2]).map(([x]) => x);
  const p = structuredClone(payload);
  const lifted = new Set(p.experience.flatMap(j => j.bullets).map((b, i) => [b, hits(b), i]).filter(x => x[1] > 0 && x[0].length >= 40).sort((a, b) => b[1] - a[1] || a[2] - b[2]).slice(0, lift).map(x => x[0]));
  for (const j of p.experience) j.bullets = [...byHits(j.bullets.filter(b => lifted.has(b)), b => b), ...j.bullets.filter(b => !lifted.has(b))];
  p.projects = byHits(p.projects, x => `${x.name} ${x.description}`);
  for (const s of p.skills) s.items = byHits(s.items.split(/\s*,\s*/), x => x).join(', ');
  p.skills = byHits(p.skills, s => s.items);
  return p;
}
