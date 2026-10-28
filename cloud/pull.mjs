#!/usr/bin/env node
// cloud/pull.mjs — the backend behind the page's "Pull new jobs" button (GitHub Actions).
//
//   MODE=pull      scan the boards, then for every new job: read the job description, score it,
//                  and build a tailored one-page CV (encrypted into cvs/{id}.json)
//   MODE=feedback  only merge the rejections / interests the page sent
//   node cloud/pull.mjs --apply-delta FILE   re-apply a finished run on top of a newer feed.enc.js
//                                            (the workflow uses it when another run pushed first)
//
// Inputs (encrypted with the site passphrase, secret TRACKER_PASSPHRASE):
//   cloud/input.enc.json  from the local build.mjs: portals, profile, tracker, pipeline, blacklist,
//                         seen scan history, cv.md, the CV kit and the PDF salt
//   feed.enc.js           this script's own state
//   FEEDBACK (env)        encrypted {items:[...]} from the page (optional)
// Zero AI tokens. Public Actions logs print counts only.
import { readFileSync, writeFileSync, existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes, pbkdf2Sync, createCipheriv, createHmac } from 'node:crypto';
import { encryptJson, decryptJson, feedScript, parseFeedScript, passphraseFrom, ITERATIONS } from './crypto.mjs';
import { renderCv, pdfName } from './cv.mjs';

const here = join(dirname(fileURLToPath(import.meta.url)), '..');
await import(pathToFileURL(join(here, 'score.js')).href);
const { learn, score, active, analyzeJd } = globalThis.JobScore;
const pass = passphraseFrom(process.env, join(here, '.passphrase'), readFileSync, existsSync);
const mode = (process.env.MODE || 'pull').trim();
const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10); // IST
const KEEP_DAYS = 45, MAX_JOBS = 400, MAX_CVS = Number(process.env.MAX_CVS || 30), MAX_JDS = 80;
const feedFile = join(here, 'feed.enc.js');

const loadState = () => ({ v: 1, jobs: [], feedback: [], seen: [], runs: [],
  ...(existsSync(feedFile) ? decryptJson(pass, parseFeedScript(readFileSync(feedFile, 'utf8'))) : {}) });

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

const state = loadState();
const delta = { feedback: [], jobs: [], updates: {}, seen: [] };
const run = { at: new Date().toISOString(), mode, found: 0, feedback: 0, cvs: 0, cvFailed: 0, jds: 0, hidden: 0, errors: [] };

// 1. Feedback from the page. Ids make re-sends harmless; "undo" removes an earlier item.
if (process.env.FEEDBACK && process.env.FEEDBACK.trim()) {
  const { items = [] } = decryptJson(pass, JSON.parse(process.env.FEEDBACK));
  const known = new Set(state.feedback.map(f => f.id));
  for (const raw of items.slice(0, 500)) {
    if (!raw || typeof raw.id !== 'string' || known.has(raw.id)) continue;
    delta.feedback.push({
      id: raw.id.slice(0, 40), at: String(raw.at || new Date().toISOString()).slice(0, 30),
      action: ['reject', 'like', 'undo'].includes(raw.action) ? raw.action : 'reject',
      target: raw.target ? String(raw.target).slice(0, 40) : undefined,
      url: String(raw.url || '').slice(0, 600), company: String(raw.company || '').slice(0, 120),
      title: String(raw.title || '').slice(0, 200), location: String(raw.location || '').slice(0, 120),
      archetype: String(raw.archetype || '').slice(0, 4), report: raw.report ? String(raw.report).slice(0, 5) : undefined,
      source: raw.source === 'apply' ? 'apply' : 'feed',
      reasons: Array.isArray(raw.reasons) ? raw.reasons.map(String).slice(0, 8) : [], note: String(raw.note || '').slice(0, 300),
    });
    known.add(raw.id);
  }
  run.feedback = delta.feedback.length;
}

if (mode === 'pull') {
  const opsDir = process.env.CAREER_OPS_DIR;
  if (!opsDir || !existsSync(join(opsDir, 'scan.mjs'))) throw new Error('CAREER_OPS_DIR must point at a career-ops checkout.');
  const { parseScanHistoryLine, scanHistoryDataLines } = await import(pathToFileURL(join(opsDir, 'lib/scan-history-columns.mjs')).href);
  const input = decryptJson(pass, JSON.parse(readFileSync(join(here, 'cloud/input.enc.json'), 'utf8')));
  const root = mkdtempSync(join(tmpdir(), 'jobs-'));
  const env = { ...process.env, CAREER_OPS_ROOT: root, TRACKER_PASSPHRASE: '', FEEDBACK: '' };
  try {
    for (const [rel, text] of Object.entries(input.files)) {
      if (rel.includes('..')) continue;
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    }

    // 2. Scan. Seen = what the local run has seen + what earlier cloud pulls added.
    const histFile = join(root, 'data/scan-history.tsv');
    const before = existsSync(histFile) ? readFileSync(histFile, 'utf8') : '';
    const known = new Set(scanHistoryDataLines(before).filter(Boolean).map(l => l.split('\t')[0]));
    const extra = state.seen.filter(l => !known.has(l.split('\t')[0]));
    writeFileSync(histFile, before.replace(/\n?$/, '\n') + (extra.length ? extra.join('\n') + '\n' : ''));
    for (const l of extra) known.add(l.split('\t')[0]);
    const r = spawnSync(process.execPath, ['scan.mjs', '--json', '--quiet', '--since', '21'], { cwd: opsDir, env, encoding: 'utf8', timeout: 50 * 60_000, maxBuffer: 64 << 20 });
    let receipt = null;
    try { receipt = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { /* no receipt */ }
    if (receipt) Object.assign(run, { scanned: receipt.scanned, errors: receipt.errors.map(e => `${e.company}: ${e.error}`.slice(0, 160)) });
    if (r.status !== 0 && r.status !== 2) run.errors.push(`scan.mjs exited ${r.status}`);
    const haveUrl = new Set(state.jobs.map(j => j.url));
    for (const line of scanHistoryDataLines(readFileSync(histFile, 'utf8')).filter(Boolean)) {
      if (known.has(line.split('\t')[0])) continue;
      const h = parseScanHistoryLine(line);
      if (h.status !== 'added') continue;
      delta.seen.push(line);
      if (haveUrl.has(h.url)) continue;
      delta.jobs.push({ url: h.url, company: h.company, title: h.title, location: h.location, posted: h.posted_at || '', found: today, portal: h.portal });
      haveUrl.add(h.url);
    }
    run.found = delta.jobs.length;

    // 3. For new jobs (and recent ones still missing a CV): job description → score → tailored CV.
    const learned = learn(active([...state.feedback, ...delta.feedback]));
    const rejected = new Set(active([...state.feedback, ...delta.feedback]).filter(f => f.action === 'reject').map(f => f.url));
    const recent = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10);
    const todo = [...delta.jobs, ...state.jobs.filter(j => j.found >= recent && !j.cv && !j.cvSkip)].filter(j => !rejected.has(j.url));
    const kit = input.files['data/cv-kit.json'] ? JSON.parse(input.files['data/cv-kit.json']) : null;
    const pdfKey = input.pdfSalt ? pbkdf2Sync(pass, Buffer.from(input.pdfSalt, 'base64'), ITERATIONS, 32, 'sha256') : null;
    mkdirSync(join(here, 'cvs'), { recursive: true });
    const work = join(root, 'cv-work');
    let jds = 0, cvs = 0;
    for (const job of todo) {
      const u = {};
      let jdText = '';
      if (!job.jd && jds < MAX_JDS) {
        jds++;
        const f = spawnSync(process.execPath, ['fetch-jd.mjs', job.url], { cwd: opsDir, env, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 << 20 });
        if (f.status === 0 && f.stdout.trim()) { jdText = f.stdout; u.jd = analyzeJd(jdText) || undefined; if (u.jd) run.jds++; }
        else u.jd = null;
      }
      const s = score({ ...job, ...u }, learned);
      if (s.hidden) { u.cvSkip = s.hiddenBy; run.hidden++; }
      else if (!kit || !pdfKey) u.cvSkip = 'no CV kit in the cloud input yet';
      else if (cvs < MAX_CVS) {
        cvs++;
        const out = renderCv({ opsDir, env, kit, job, jdText, workDir: work });
        if (out.ok) {
          const name = pdfName(kit, job.title, job.company);
          const id = createHmac('sha256', pdfKey).update(`cloud:${job.url}`).digest('hex').slice(0, 20);
          const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', pdfKey, iv);
          const data = Buffer.concat([c.update(readFileSync(out.pdf)), c.final(), c.getAuthTag()]);
          writeFileSync(join(here, 'cvs', `${id}.json`), JSON.stringify({ iv: iv.toString('base64'), data: data.toString('base64') }));
          u.cv = { id, name, variant: out.variant, ats: out.ats, cuts: out.notes, at: today };
          run.cvs++;
        } else { u.cvError = out.error; run.cvFailed++; }
      }
      if (Object.keys(u).length) delta.updates[job.url] = u;
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
  delta.lastPullAt = run.at;
}

delta.run = run;
save(applyDelta(state, delta));
if (process.env.DELTA_FILE) writeFileSync(process.env.DELTA_FILE, JSON.stringify(encryptJson(pass, delta)));
// Counts only: Actions logs of a public repo are public, so never print company names or titles.
console.log(`mode=${mode} new jobs=${run.found} job descriptions read=${run.jds} CVs built=${run.cvs} CV failures=${run.cvFailed} filtered=${run.hidden} feedback added=${run.feedback} source errors=${run.errors.length}`);
