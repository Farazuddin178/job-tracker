#!/usr/bin/env node
// cloud/pull.mjs — the backend behind the page's "Pull new jobs" button (GitHub Actions).
//
//   MODE=pull      scan the boards, then for every profile: read each new job description, score it,
//                  and build a tailored one-page CV for the best role per company (encrypted into cvs/)
//   MODE=check     recheck that postings are still open
//   MODE=feedback  only merge the choices and the settings the page sent
//   node cloud/pull.mjs --apply-delta FILE   re-apply a finished run on top of a newer feed.enc.js
//                                            (the workflow uses it when another run pushed first)
//
// Inputs (encrypted with the site passphrase, secret TRACKER_PASSPHRASE):
//   cloud/input.enc.json  from the local build.mjs: portals, profile, tracker, pipeline, blacklist,
//                         seen scan history, cv.md, the CV kit and the PDF salt
//   feed.enc.js           the owner's state
//   profiles.js           who else has a profile (see profiles.mjs); their state is in profiles/{id}/
//   FEEDBACK (env)        encrypted {items:[...], profile?} from the page, under WHO's passphrase (optional)
// Zero AI tokens. Public Actions logs print counts only.
import { readFileSync, writeFileSync, existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes, pbkdf2Sync, createCipheriv, createHmac } from 'node:crypto';
import { encryptJson, decryptJson, feedScript, parseFeedScript, passphraseFrom, ITERATIONS } from './crypto.mjs';
import { profilePass, teamPass, parseProfiles, teamScript, parseTeam } from './profiles.mjs';
import { renderCv, pickVariant, pdfName } from './cv.mjs';
import { parseResume, tailor } from './resume.mjs';

const here = join(dirname(fileURLToPath(import.meta.url)), '..');
await import(pathToFileURL(join(here, 'score.js')).href);
const { learn, score, active, analyzeJd, prefsFrom, topTerms, normCompany, groupByCompany, appliedLog, companyLocks } = globalThis.JobScore;
const pass = passphraseFrom(process.env, join(here, '.passphrase'), readFileSync, existsSync);
const mode = (process.env.MODE || 'pull').trim();
const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10); // IST
const KEEP_DAYS = 45, MAX_JOBS = 400, MAX_CVS = Number(process.env.MAX_CVS || 30), MAX_JDS = 80;
const feedFile = join(here, 'feed.enc.js');

const blankState = () => ({ v: 1, jobs: [], feedback: [], seen: [], runs: [] });
const loadState = () => ({ ...blankState(),
  ...(existsSync(feedFile) ? decryptJson(pass, parseFeedScript(readFileSync(feedFile, 'utf8'))) : {}) });
const blankDelta = () => ({ feedback: [], jobs: [], updates: {}, seen: [] });
const blankRun = () => ({ at: new Date().toISOString(), mode, found: 0, feedback: 0, cvs: 0, cvFailed: 0, jds: 0, hidden: 0, errors: [] });

// A run's result as a delta, so it can be replayed on a feed another run changed meanwhile.
function applyDelta(state, d) {
  const ids = new Set(state.feedback.map(f => f.id));
  for (const f of d.feedback || []) if (!ids.has(f.id)) { state.feedback.push(f); ids.add(f.id); }
  const byUrl = new Map(state.jobs.map(j => [j.url, j]));
  for (const j of d.jobs || []) if (!byUrl.has(j.url)) { state.jobs.push(j); byUrl.set(j.url, j); }
  for (const [url, u] of Object.entries(d.updates || {})) if (byUrl.has(url)) Object.assign(byUrl.get(url), u);
  const seen = new Set(state.seen.map(l => l.split('\t')[0]));
  for (const l of d.seen || []) if (!seen.has(l.split('\t')[0])) { state.seen.push(l); seen.add(l.split('\t')[0]); }
  if (d.run) state.runs = [...state.runs, d.run];
  if (d.lastPullAt) state.lastPullAt = d.lastPullAt;
  // Liveness verdicts per posting URL: {status: active|expired|uncertain, reason, at}.
  state.liveness = { ...(state.liveness || {}), ...(d.liveness || {}) };
  if (d.lastCheckAt) state.lastCheckAt = d.lastCheckAt;
  if (d.resumeCheck) state.resumeCheck = d.resumeCheck;
  const cutoff = new Date(Date.now() - KEEP_DAYS * 86_400_000).toISOString().slice(0, 10);
  state.jobs = state.jobs.filter(j => j.found >= cutoff).slice(-MAX_JOBS);
  state.seen = state.seen.slice(-5000);
  state.runs = state.runs.slice(-30);
  state.updatedAt = new Date().toISOString();
  return state;
}
function save(state) {
  writeFileSync(feedFile, feedScript({ ...encryptJson(pass, state), updatedAt: state.updatedAt }));
}

const applyAt = process.argv.indexOf('--apply-delta');
if (applyAt > 0) {
  const delta = decryptJson(pass, JSON.parse(readFileSync(process.argv[applyAt + 1], 'utf8')));
  save(applyDelta(loadState(), delta));
  console.log('Re-applied this run on top of the newer feed.');
  process.exit(0);
}

// ── Profiles ──────────────────────────────────────────────────────────
const readEnc = (file, p) => (existsSync(file) ? decryptJson(p, JSON.parse(readFileSync(file, 'utf8'))) : null);
const writeEnc = (file, p, value) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(encryptJson(p, value))); };
const profileFile = id => join(here, 'profiles', id, 'profile.enc.json');
const friendFeedFile = id => join(here, 'profiles', id, 'feed.enc.json');
const roster = existsSync(join(here, 'profiles.js')) ? parseProfiles(readFileSync(join(here, 'profiles.js'), 'utf8')) : [];

const me = { id: 'me', pass, state: loadState(), delta: blankDelta(), run: blankRun(), profile: readEnc(profileFile('me'), pass) };
const friends = roster.filter(p => p.id !== 'me').map(({ id }) => {
  const p = profilePass(pass, id);
  return { id, pass: p, state: { ...blankState(), ...readEnc(friendFeedFile(id), p) }, delta: blankDelta(), run: blankRun(), profile: readEnc(profileFile(id), p) };
});
const people = [me, ...friends];

// 1. What the page sent. Ids make re-sends harmless; "undo" removes an earlier item.
const FEEDBACK_ACTIONS = ['reject', 'like', 'undo', 'closed', 'open', 'applied', 'followup'];
function takeFeedback(person, items) {
  const known = new Set(person.state.feedback.map(f => f.id));
  for (const raw of items.slice(0, 500)) {
    if (!raw || typeof raw.id !== 'string' || known.has(raw.id)) continue;
    person.delta.feedback.push({
      id: raw.id.slice(0, 40), at: String(raw.at || new Date().toISOString()).slice(0, 30),
      action: FEEDBACK_ACTIONS.includes(raw.action) ? raw.action : 'reject',
      target: raw.target ? String(raw.target).slice(0, 40) : undefined,
      url: String(raw.url || '').slice(0, 600), company: String(raw.company || '').slice(0, 120),
      title: String(raw.title || '').slice(0, 200), location: String(raw.location || '').slice(0, 120),
      archetype: String(raw.archetype || '').slice(0, 4), report: raw.report ? String(raw.report).slice(0, 5) : undefined,
      source: raw.source === 'apply' ? 'apply' : 'feed', date: raw.date ? String(raw.date).slice(0, 10) : undefined,
      variant: raw.variant ? String(raw.variant).slice(0, 30) : undefined,
      reasons: Array.isArray(raw.reasons) ? raw.reasons.map(String).slice(0, 8) : [], note: String(raw.note || '').slice(0, 300),
    });
    known.add(raw.id);
  }
  person.run.feedback = person.delta.feedback.length;
}
// Settings from the page, field by field.
function cleanProfile(raw) {
  const str = (v, n = 200) => String(v ?? '').slice(0, n);
  const strs = (v, n = 80) => (Array.isArray(v) ? v : []).slice(0, 60).map(x => str(x, n)).filter(Boolean);
  const a = raw.answers || {};
  return {
    updatedAt: str(raw.updatedAt, 30), name: str(raw.name, 120), email: str(raw.email, 200), phone: str(raw.phone, 40), linkedin: str(raw.linkedin), github: str(raw.github), location: str(raw.location),
    targetRoles: strs(raw.targetRoles), skills: strs(raw.skills), keywords: strs(raw.keywords), avoid: strs(raw.avoid), languages: strs(raw.languages),
    minLpa: Number(raw.minLpa) || 0, maxYears: Number(raw.maxYears) || 3, cooldownDays: Math.min(60, Math.max(30, Number(raw.cooldownDays) || 60)), hideSenior: raw.hideSenior !== false,
    resumeText: str(raw.resumeText, 30_000), jobLocations: strs(raw.jobLocations),
    answers: { notice: str(a.notice), currentCtc: str(a.currentCtc), expectedCtc: str(a.expectedCtc), whyLeaving: str(a.whyLeaving, 300), totalExperience: str(a.totalExperience), workAuth: str(a.workAuth), skillYears: strs(a.skillYears, 60) },
  };
}
if (process.env.FEEDBACK && process.env.FEEDBACK.trim()) {
  const who = people.find(p => p.id === (process.env.WHO || 'me').trim()) || me;
  const incoming = decryptJson(who.pass, JSON.parse(process.env.FEEDBACK));
  takeFeedback(who, incoming.items || []);
  if (incoming.profile) {
    who.profile = cleanProfile(incoming.profile);
    writeEnc(profileFile(who.id), who.pass, who.profile);
    who.run.settings = true;
  }
}

const delta = me.delta, run = me.run, state = me.state;
const pickKeys = (obj, keys) => Object.fromEntries(Object.entries(obj || {}).filter(([k]) => keys.has(k)));

// The title_filter.positive block of portals.yml, as text so its 160 KB of comments stay untouched.
const POSITIVE = /(title_filter:\s*\n(?:\s*#.*\n)*\s*positive:\s*\n(?:\s*#.*\n)*)((?:\s*-\s.*\n|\s*#.*\n)*)/;
const ALLOW = /(^location_filter:\s*\n(?:\s*#.*\n)*\s*allow:\s*\n(?:\s*#.*\n)*)((?:\s*-\s.*\n|\s*#.*\n)*)/m;
const positiveList = text => [...(text.match(POSITIVE)?.[2] || '').matchAll(/^\s*-\s*["']?(?:word:)?(.+?)["']?\s*(?:#.*)?$/gm)].map(m => m[1].toLowerCase());
// The scanner's own rule: a substring, except that a 2-3 letter keyword ("AI") must be a whole word.
const wantsTitle = (title, words) => { const t = title.toLowerCase(); return words.some(w => (w.length <= 3 ? new RegExp(`\\b${w.replace(/[^a-z0-9]/g, '')}\\b`).test(t) : t.includes(w))); };
// "Junior Data Analyst" must also catch a plain "Data Analyst" posting, so level words don't count.
const LEVEL = /\b(junior|jr\.?|senior|sr\.?|associate|entry[- ]level|trainee|graduate|fresher)\b/g;
// Boards spell the same role differently: "ML Engineer" is also "Machine Learning Engineer".
const VARIANTS = [[/\bml\b/, 'machine learning'], [/\bmachine learning\b/, 'ml'], [/\bai\b/, 'artificial intelligence'], [/\bartificial intelligence\b/, 'ai'], [/\bdata scientist\b/, 'data science'], [/\bsde\b/, 'software development engineer'], [/\bswe\b/, 'software engineer']];
const titleWords = p => {
  const words = [...(p?.targetRoles || []), ...(p?.keywords || [])].map(w => w.toLowerCase().replace(LEVEL, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
  return [...new Set(words.flatMap(w => [w, ...VARIANTS.filter(([re]) => re.test(w)).map(([re, to]) => w.replace(re, to))]))];
};
// Each person's own places. The scan reads the union; every job is then checked against the person it goes to.
const ALIASES = [['bengaluru', 'bangalore'], ['gurugram', 'gurgaon'], ['mumbai', 'bombay', 'navi mumbai'], ['chennai', 'madras'], ['kolkata', 'calcutta'], ['hyderabad', 'secunderabad', 'gachibowli', 'hitec city', 'hitech city'], ['delhi', 'new delhi'], ['thiruvananthapuram', 'trivandrum'], ['kochi', 'cochin'], ['pune', 'pimpri']];
const REMOTE_INDIA = ['remote - india', 'india - remote', 'remote, india', 'india, remote', 'india (remote)', 'remote (india)', 'remote india', 'india remote', 'work from home'];
const homeCity = p => String(p?.location || '').split(',')[0].trim().toLowerCase();
const placeWords = p => {
  const asked = (p?.jobLocations || []).map(w => w.toLowerCase().trim()).filter(Boolean);
  const places = asked.length ? asked : [homeCity(p)].filter(Boolean);
  return [...new Set(places.flatMap(w => ALIASES.find(a => a.includes(w)) || [w]))];
};
const wantsPlace = (location, words) => { const l = String(location || '').toLowerCase(); return !l || !words.length || [...words, ...REMOTE_INDIA].some(w => l.includes(w)); };
const NO_RESUME = 'no CV source yet';

// Both modes need the career-ops tools: a pull scans and builds CVs; a feedback run builds the CV
// for any job just marked "Interested" that doesn't have one yet.
const opsDir = process.env.CAREER_OPS_DIR;
if (opsDir && existsSync(join(opsDir, 'scan.mjs'))) {
  const { parseScanHistoryLine, scanHistoryDataLines } = await import(pathToFileURL(join(opsDir, 'lib/scan-history-columns.mjs')).href);
  const input = decryptJson(pass, JSON.parse(readFileSync(join(here, 'cloud/input.enc.json'), 'utf8')));
  const root = mkdtempSync(join(tmpdir(), 'jobs-'));
  const env = { ...process.env, CAREER_OPS_ROOT: root, TRACKER_PASSPHRASE: '', FEEDBACK: '' };
  const ready = friends.filter(f => titleWords(f.profile).length);
  try {
    for (const [rel, text] of Object.entries(input.files)) {
      if (rel.includes('..')) continue;
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    }
    me.prefs = prefsFrom({ ...(me.profile || {}), resumeText: input.files['cv.md'] || '' }, 'me');
    me.cooldownDays = me.profile?.cooldownDays || 60;
    me.extraApplied = input.files['data/applied.json'] ? JSON.parse(input.files['data/applied.json']) : [];
    const kit = input.files['data/cv-kit.json'] ? JSON.parse(input.files['data/cv-kit.json']) : null;
    me.pdfKey = input.pdfSalt ? pbkdf2Sync(pass, Buffer.from(input.pdfSalt, 'base64'), ITERATIONS, 32, 'sha256') : null;
    const work = join(root, 'cv-work');
    me.pdfName = job => pdfName(kit, job.title, job.company);
    // A recorded version the kit no longer has falls back to the title, or the CV would be rebuilt on every pull.
    me.lockedVariant = lock => (kit?.variants[lock.variant] ? lock.variant : pickVariant(lock.title));
    me.render = !kit ? null : (job, jdText, lock) => renderCv({ opsDir, env, kit, job, jdText, workDir: work, variant: lock && me.lockedVariant(lock) });

    // Each friend gets a small data root of their own: the CV checks read cv.md and the profile from there.
    for (const f of ready) {
      f.prefs = prefsFrom(f.profile, f.id);
      f.cooldownDays = f.profile.cooldownDays || 60;
      f.extraApplied = [];
      if (!f.state.pdfSalt) f.state.pdfSalt = randomBytes(16).toString('base64');
      f.pdfKey = pbkdf2Sync(f.pass, Buffer.from(f.state.pdfSalt, 'base64'), ITERATIONS, 32, 'sha256');
      const parsed = parseResume(f.profile.resumeText, f.profile);
      if (JSON.stringify(parsed.check) !== JSON.stringify(f.state.resumeCheck)) f.delta.resumeCheck = parsed.check;
      const fRoot = join(root, 'people', f.id);
      mkdirSync(join(fRoot, 'config'), { recursive: true });
      mkdirSync(join(fRoot, 'data'), { recursive: true });
      writeFileSync(join(fRoot, 'cv.md'), parsed.md);
      const q = JSON.stringify, c = parsed.payload.candidate;
      writeFileSync(join(fRoot, 'config/profile.yml'), `candidate:\n  full_name: ${q(c.name)}\n  email: ${q(c.email)}\n  phone: ${q(c.phone)}\n  location: ${q(c.location)}\n  linkedin: ${q(c.linkedin)}\n  github: ${q(c.github)}\nstyle:\n  font_family: "Arial, Helvetica, sans-serif"\n  font_size: "10pt"\ncv:\n  template: ats\n`);
      writeFileSync(join(fRoot, 'data/applications.md'), '# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|------|-------|--------|-----|--------|-------|\n');
      const fEnv = { ...env, CAREER_OPS_ROOT: fRoot };
      const nameKit = { projects: {}, base: { candidate: { name: c.name || 'Candidate' } } };
      f.pdfName = job => pdfName(nameKit, job.title, job.company);
      // A company already applied to needs no lock here: one resume, reordered, can't contradict itself.
      f.render = !f.profile.resumeText || parsed.check.problems.some(p => /name|email|Experience/.test(p)) ? null
        : (job, jdText) => renderCv({ opsDir, env: fEnv, kit: nameKit, job, jdText, workDir: join(fRoot, 'cv-work'), override: tailor(parsed.payload, jdText, topTerms) });
    }

    if (mode === 'pull') {
    // 2. Scan. Seen = what the local run has seen + what earlier cloud pulls added.
    const histFile = join(root, 'data/scan-history.tsv');
    const before = existsSync(histFile) ? readFileSync(histFile, 'utf8') : '';
    const known = new Set(scanHistoryDataLines(before).filter(Boolean).map(l => l.split('\t')[0]));
    const extra = state.seen.filter(l => !known.has(l.split('\t')[0]));
    writeFileSync(histFile, before.replace(/\n?$/, '\n') + (extra.length ? extra.join('\n') + '\n' : ''));
    for (const l of extra) known.add(l.split('\t')[0]);
    // One scan for everyone: the owner's boards, with each person's target titles added to the filter.
    const portalsFile = join(root, 'portals.yml');
    const portals = existsSync(portalsFile) ? readFileSync(portalsFile, 'utf8') : '';
    const ownerWords = [...positiveList(portals), ...titleWords(me.profile)];
    const added = [...new Set([...titleWords(me.profile), ...ready.flatMap(f => titleWords(f.profile))])];
    const ownerPlaces = (portals.match(ALLOW)?.[2] || '').split('\n').map(l => l.match(/^\s*-\s*["']?(.+?)["']?\s*(?:#.*)?$/)?.[1]?.toLowerCase()).filter(Boolean);
    const friendPlaces = [...new Set(ready.flatMap(f => placeWords(f.profile)))].filter(w => !ownerPlaces.includes(w));
    // A place only a friend asked for: passed the filter for them, so it stays off the owner's list.
    const onlyFriends = loc => { const l = String(loc || '').toLowerCase(); return friendPlaces.some(w => l.includes(w)) && !ownerPlaces.some(w => l.includes(w)); };
    let scanPortals = portals;
    if (added.length && POSITIVE.test(scanPortals)) scanPortals = scanPortals.replace(POSITIVE, (m, a, b) => `${a}${added.map(w => `    - ${JSON.stringify(w)}\n`).join('')}${b}`);
    if (friendPlaces.length && ownerPlaces.length) scanPortals = scanPortals.replace(ALLOW, (m, a, b) => `${a}${friendPlaces.map(w => `    - ${JSON.stringify(w)}\n`).join('')}${b}`);
    if (scanPortals !== portals) writeFileSync(portalsFile, scanPortals);
    const scan = () => {
      const res = spawnSync(process.execPath, ['scan.mjs', '--json', '--quiet', '--since', '21'], { cwd: opsDir, env, encoding: 'utf8', timeout: 40 * 60_000, maxBuffer: 64 << 20 });
      let rec = null;
      try { rec = JSON.parse(res.stdout.trim().split('\n').pop()); } catch { /* no receipt */ }
      return [res, rec];
    };
    let [r, receipt] = scan();
    // A network blip can fail most boards at once (31 Oct: 27 of 38). Wait and scan again; the
    // second pass only adds what the first missed, because scan history already holds the rest.
    if (!receipt || receipt.errors.length >= Math.max(5, (receipt.scanned || 0) * 0.4)) {
      run.retried = true;
      spawnSync(process.execPath, ['-e', 'setTimeout(()=>{}, 45000)']);
      [r, receipt] = scan();
    }
    if (receipt) Object.assign(run, { scanned: receipt.scanned, errors: receipt.errors.map(e => `${e.company}: ${e.error}`.slice(0, 160)) });
    if (r.status !== 0 && r.status !== 2) run.errors.push(`scan.mjs exited ${r.status}`);
    const haveUrl = new Set(state.jobs.map(j => j.url));
    const fresh = [];
    for (const line of scanHistoryDataLines(readFileSync(histFile, 'utf8')).filter(Boolean)) {
      if (known.has(line.split('\t')[0])) continue;
      const h = parseScanHistoryLine(line);
      if (h.status !== 'added') continue;
      delta.seen.push(line);
      fresh.push({ url: h.url, company: h.company, title: h.title, location: h.location, posted: h.posted_at || '', found: today, portal: h.portal });
    }
    // A job only the friend's keywords caught doesn't belong on the owner's list, and the reverse.
    for (const j of fresh) if (!haveUrl.has(j.url) && wantsTitle(j.title, ownerWords) && !onlyFriends(j.location)) { delta.jobs.push(j); haveUrl.add(j.url); }
    run.found = delta.jobs.length;
    delta.lastPullAt = run.at;
    // Every posting of the last three weeks, not just this run's: a new or changed profile sees them all.
    const since = new Date(Date.now() - 21 * 86_400_000).toISOString().slice(0, 10);
    const recent = scanHistoryDataLines(readFileSync(histFile, 'utf8')).filter(Boolean).map(parseScanHistoryLine)
      .filter(h => h.status === 'added' && h.first_seen >= since && state.liveness?.[h.url]?.status !== 'expired')
      .map(h => ({ url: h.url, company: h.company, title: h.title, location: h.location, posted: h.posted_at || '', found: today, portal: h.portal }));
    for (const f of ready) {
      const words = titleWords(f.profile), places = placeWords(f.profile), have = new Set(f.state.jobs.map(j => j.url));
      for (const j of recent) if (!have.has(j.url) && wantsTitle(j.title, words) && wantsPlace(j.location, places)) { f.delta.jobs.push(j); have.add(j.url); }
      f.run.found = f.delta.jobs.length;
      f.delta.lastPullAt = run.at;
    }
    }

    // 3. Job description → score → tailored CV, for new jobs, recent ones still missing a CV, and
    // every job marked "Interested" without one (built even if a filter hid it: you picked it).
    // Only a company's best role gets a CV: several tailored resumes at one employer read as spam.
    mkdirSync(join(here, 'cvs'), { recursive: true });
    const jdTexts = new Map(); // one read per posting, shared between profiles
    const readJd = url => {
      if (jdTexts.has(url)) return jdTexts.get(url);
      const f = spawnSync(process.execPath, ['fetch-jd.mjs', url], { cwd: opsDir, env, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 << 20 });
      const text = f.status === 0 && f.stdout.trim() ? f.stdout : '';
      jdTexts.set(url, text);
      return text;
    };
    function storeCv(P, job, out) {
      const seal = bytes => { const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', P.pdfKey, iv); return { iv: iv.toString('base64'), data: Buffer.concat([c.update(bytes), c.final(), c.getAuthTag()]).toString('base64') }; };
      const id = createHmac('sha256', P.pdfKey).update(`cloud:${job.url}`).digest('hex').slice(0, 20);
      writeFileSync(join(here, 'cvs', `${id}.json`), JSON.stringify({ ...seal(readFileSync(out.pdf)), text: seal(Buffer.from(out.text, 'utf8')) }));
      return id;
    }
    function buildCvs(P) {
      const R = P.run, updates = P.delta.updates;
      const feedback = [...P.state.feedback, ...P.delta.feedback];
      const fbNow = active(feedback);
      const learned = learn(fbNow);
      const rejected = new Set(fbNow.filter(f => f.action === 'reject').map(f => f.url));
      const liked = new Set(fbNow.filter(f => f.action === 'like').map(f => f.url));
      const closed = new Set([...fbNow.filter(f => f.action === 'closed').map(f => f.url), ...Object.entries(P.state.liveness || {}).filter(([, l]) => l.status === 'expired').map(([u]) => u)]);
      const locks = companyLocks([...P.extraApplied, ...appliedLog(feedback)], P.cooldownDays);
      const lockOf = job => locks[normCompany(job.company)];
      const recent = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10);
      const all = [...P.state.jobs, ...P.delta.jobs];
      const pending = mode === 'pull' ? [...P.delta.jobs, ...P.state.jobs.filter(j => j.found >= recent && !j.cv && (!j.cvSkip || j.cvSkip === NO_RESUME || R.settings))] : [];
      // A CV built before you applied to that company, in a different version from the one you sent.
      const contradicting = mode === 'pull' && P.lockedVariant ? P.state.jobs.filter(j => j.cv && lockOf(j) && j.cv.variant !== P.lockedVariant(lockOf(j))) : [];
      const todo = [...P.state.jobs.filter(j => liked.has(j.url) && !j.cv), ...pending, ...contradicting]
        .filter((j, i, a) => !rejected.has(j.url) && a.findIndex(x => x.url === j.url) === i);
      let jds = 0, cvs = 0;
      for (const job of todo) {
        if (job.jd || jds >= MAX_JDS) continue;
        jds++;
        const text = readJd(job.url);
        updates[job.url] = { jd: text ? analyzeJd(text, P.prefs) || undefined : null };
        if (updates[job.url].jd) R.jds++;
      }
      const view = j => ({ ...j, ...updates[j.url] });
      const rankOf = j => score(j, learned, P.prefs).rank + (j.jd?.matched?.length || 0) / 100;
      const open = all.filter(j => !rejected.has(j.url) && !closed.has(j.url)).map(view).filter(j => !score(j, learned, P.prefs).hidden);
      const best = new Set(groupByCompany(open, rankOf).map(g => g.best.url));
      for (const job of todo) {
        const s = score(view(job), learned, P.prefs), u = updates[job.url] || {};
        if (s.hidden && !liked.has(job.url)) { u.cvSkip = s.hiddenBy; R.hidden++; }
        else if (!best.has(job.url) && !liked.has(job.url)) u.cvLater = true;
        else if (!P.render || !P.pdfKey) u.cvSkip = NO_RESUME;
        else if (cvs < MAX_CVS) {
          cvs++;
          const out = P.render(job, readJd(job.url), lockOf(job));
          if (out.ok) {
            u.cv = { id: storeCv(P, job, out), name: P.pdfName(job), variant: out.variant, track: out.track, ats: out.ats, cuts: out.notes, at: today };
            u.cvLater = false; u.cvError = undefined; u.cvSkip = undefined;
            R.cvs++;
          } else { u.cvError = out.error; R.cvFailed++; }
        }
        if (Object.keys(u).length) updates[job.url] = u;
      }
    }
    // A light run only saves choices: no browser was installed for it, and no CV is due.
    if (process.env.LIGHT !== 'yes') {
      buildCvs(me);
      for (const f of ready) {
        try { buildCvs(f); }
        catch (err) { f.run.errors.push(`build failed: ${err.name}`); run.errors.push(`a profile's build failed: ${err.name}`); }
      }
    }

    // 4. Is each posting still open? Every job that can reach To apply: pulled jobs you haven't
    // rejected or marked closed, plus the evaluated roles from career-ops. check-liveness.mjs asks the
    // job board's API first and loads the page only when it must; "expired" needs clear evidence
    // (404/410, "no longer accepting applications"), anything unreadable stays "uncertain".
    // A pull rechecks what wasn't confirmed in the last 20 hours; "check" (the page's button) rechecks all.
    if (mode === 'pull' || mode === 'check') {
      const fbNow = active([...state.feedback, ...delta.feedback]);
      const rejected = new Set(fbNow.filter(f => f.action === 'reject').map(f => f.url));
      const closedByYou = new Set(fbNow.filter(f => f.action === 'closed').map(f => f.url));
      const localApply = input.files['data/to-apply.json'] ? JSON.parse(input.files['data/to-apply.json']).map(r => r.url) : [];
      const fresh = url => { const l = state.liveness?.[url]; return l && l.status === 'active' && Date.now() - new Date(l.at) < 20 * 3600_000; };
      const ownerUrls = [...state.jobs, ...delta.jobs].map(j => j.url).concat(localApply);
      const friendUrls = ready.flatMap(f => [...f.state.jobs, ...f.delta.jobs].map(j => j.url));
      const urls = [...new Set([...ownerUrls, ...friendUrls])]
        .filter(u => /^https?:\/\//.test(u) && !rejected.has(u) && !closedByYou.has(u) && state.liveness?.[u]?.status !== 'expired')
        .filter(u => mode === 'check' || !fresh(u) && !delta.jobs.some(j => j.url === u));
      if (urls.length) {
        const file = join(root, 'liveness-urls.txt');
        writeFileSync(file, urls.join('\n'));
        const r = spawnSync(process.execPath, ['check-liveness.mjs', '--no-fallback', '--no-record', '--file', file], { cwd: opsDir, env, encoding: 'utf8', timeout: 30 * 60_000, maxBuffer: 32 << 20 });
        const lines = (r.stdout || '').split('\n');
        const verdicts = {};
        for (let i = 0; i < lines.length; i++) {
          const m = lines[i].match(/^\S+\s+(active|expired|uncertain)\s+(?:\(api\)\s+)?(?:.*\s)?(https?:\/\/\S+)\s*$/);
          if (!m || !urls.includes(m[2])) continue;
          const reason = m[1] !== 'active' && /^\s{6,}\S/.test(lines[i + 1] || '') ? lines[i + 1].trim().slice(0, 160) : '';
          verdicts[m[2]] = { status: m[1], reason, at: new Date().toISOString() };
        }
        delta.liveness = pickKeys(verdicts, new Set(ownerUrls));
        for (const f of ready) f.delta.liveness = pickKeys(verdicts, new Set([...f.state.jobs, ...f.delta.jobs].map(j => j.url)));
        const v = Object.values(verdicts);
        Object.assign(run, { checked: v.length, expired: v.filter(x => x.status === 'expired').length, uncertain: v.filter(x => x.status === 'uncertain').length });
        delta.expiredUrls = Object.entries(delta.liveness).filter(([, x]) => x.status === 'expired').map(([u]) => u);
      }
      delta.lastCheckAt = new Date().toISOString();
      for (const f of ready) f.delta.lastCheckAt = delta.lastCheckAt;
    }

    // 5. The shared view: who shortlisted and who applied, nothing else about either person.
    if (friends.length) {
      const entriesFor = (P, extra) => {
        const all = [...P.state.feedback, ...P.delta.feedback];
        const row = (status, x) => ({ by: P.id, status, company: x.company, companyKey: normCompany(x.company), title: x.title, url: x.url || '', date: String(x.date || x.at || '').slice(0, 10) });
        return [...extra.map(a => row('applied', a)), ...appliedLog(all).map(a => row('applied', a)), ...active(all).filter(f => f.action === 'like').map(f => row('shortlisted', f))];
      };
      const names = Object.fromEntries(people.map(p => [p.id, p.profile?.name || (p.id === 'me' && kit?.base.candidate.name) || 'Teammate']));
      const team = { names, entries: [...entriesFor(me, me.extraApplied), ...friends.flatMap(f => entriesFor(f, []))] };
      const tp = teamPass(pass), file = join(here, 'team.enc.js');
      const old = existsSync(file) ? decryptJson(tp, parseTeam(readFileSync(file, 'utf8'))) : null;
      if (JSON.stringify(old) !== JSON.stringify(team)) writeFileSync(file, teamScript(encryptJson(tp, team)));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
} else if (mode === 'pull') throw new Error('CAREER_OPS_DIR must point at a career-ops checkout.');

delta.run = run;
save(applyDelta(state, delta));
if (process.env.DELTA_FILE) writeFileSync(process.env.DELTA_FILE, JSON.stringify(encryptJson(pass, delta)));
for (const f of friends) {
  const d = f.delta;
  if (d.feedback.length || d.jobs.length || Object.keys(d.updates).length || d.liveness || d.resumeCheck || f.run.settings) {
    if (mode === 'pull' || f.run.feedback || f.run.cvs) d.run = f.run;
    writeEnc(friendFeedFile(f.id), f.pass, applyDelta(f.state, d));
    if (process.env.DELTA_FILE) writeFileSync(`${process.env.DELTA_FILE}.${f.id}`, JSON.stringify(encryptJson(f.pass, d))); // for the mail
  }
}
// Counts only: Actions logs of a public repo are public, so never print company names or titles.
console.log(`mode=${mode} checked=${run.checked || 0} closed=${run.expired || 0} unconfirmed=${run.uncertain || 0} new jobs=${run.found} job descriptions read=${run.jds} CVs built=${run.cvs} CV failures=${run.cvFailed} filtered=${run.hidden} feedback added=${run.feedback} source errors=${run.errors.length}`);
for (const f of friends) console.log(`profile: new jobs=${f.run.found} CVs built=${f.run.cvs} CV failures=${f.run.cvFailed} feedback added=${f.run.feedback}`);
