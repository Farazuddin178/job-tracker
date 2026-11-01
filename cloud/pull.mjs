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
  // Liveness verdicts per posting URL: {status: active|expired|uncertain, reason, at}.
  state.liveness = { ...(state.liveness || {}), ...(d.liveness || {}) };
  if (d.lastCheckAt) state.lastCheckAt = d.lastCheckAt;
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
      action: ['reject', 'like', 'undo', 'closed', 'open'].includes(raw.action) ? raw.action : 'reject',
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

// Both modes need the career-ops tools: a pull scans and builds CVs; a feedback run builds the CV
// for any job just marked "Interested" that doesn't have one yet.
const opsDir = process.env.CAREER_OPS_DIR;
if (opsDir && existsSync(join(opsDir, 'scan.mjs'))) {
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

    if (mode === 'pull') {
    // 2. Scan. Seen = what the local run has seen + what earlier cloud pulls added.
    const histFile = join(root, 'data/scan-history.tsv');
    const before = existsSync(histFile) ? readFileSync(histFile, 'utf8') : '';
    const known = new Set(scanHistoryDataLines(before).filter(Boolean).map(l => l.split('\t')[0]));
    const extra = state.seen.filter(l => !known.has(l.split('\t')[0]));
    writeFileSync(histFile, before.replace(/\n?$/, '\n') + (extra.length ? extra.join('\n') + '\n' : ''));
    for (const l of extra) known.add(l.split('\t')[0]);
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
    delta.lastPullAt = run.at;
    }

    // 3. Job description → score → tailored CV, for new jobs, recent ones still missing a CV, and
    // every job marked "Interested" without one (built even if a filter hid it: you picked it).
    const fbNow = active([...state.feedback, ...delta.feedback]);
    const learned = learn(fbNow);
    const rejected = new Set(fbNow.filter(f => f.action === 'reject').map(f => f.url));
    const liked = new Set(fbNow.filter(f => f.action === 'like').map(f => f.url));
    const recent = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10);
    const pending = mode === 'pull' ? [...delta.jobs, ...state.jobs.filter(j => j.found >= recent && !j.cv && !j.cvSkip)] : [];
    const todo = [...state.jobs.filter(j => liked.has(j.url) && !j.cv), ...pending]
      .filter((j, i, a) => !rejected.has(j.url) && a.findIndex(x => x.url === j.url) === i);
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
      if (s.hidden && !liked.has(job.url)) { u.cvSkip = s.hiddenBy; run.hidden++; }
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

    // 4. Is each posting still open? Every job that can reach To apply: pulled jobs you haven't
    // rejected or marked closed, plus the evaluated roles from career-ops. check-liveness.mjs asks the
    // job board's API first and loads the page only when it must; "expired" needs clear evidence
    // (404/410, "no longer accepting applications"), anything unreadable stays "uncertain".
    // A pull rechecks what wasn't confirmed in the last 20 hours; "check" (the page's button) rechecks all.
    if (mode === 'pull' || mode === 'check') {
      const closedByYou = new Set(fbNow.filter(f => f.action === 'closed').map(f => f.url));
      const localApply = input.files['data/to-apply.json'] ? JSON.parse(input.files['data/to-apply.json']).map(r => r.url) : [];
      const fresh = url => { const l = state.liveness?.[url]; return l && l.status === 'active' && Date.now() - new Date(l.at) < 20 * 3600_000; };
      const urls = [...new Set([...state.jobs, ...delta.jobs].map(j => j.url).concat(localApply))]
        .filter(u => /^https?:\/\//.test(u) && !rejected.has(u) && !closedByYou.has(u) && state.liveness?.[u]?.status !== 'expired')
        .filter(u => mode === 'check' || !fresh(u) && !delta.jobs.some(j => j.url === u));
      if (urls.length) {
        const file = join(root, 'liveness-urls.txt');
        writeFileSync(file, urls.join('\n'));
        const r = spawnSync(process.execPath, ['check-liveness.mjs', '--no-fallback', '--no-record', '--file', file], { cwd: opsDir, env, encoding: 'utf8', timeout: 30 * 60_000, maxBuffer: 32 << 20 });
        const lines = (r.stdout || '').split('\n');
        delta.liveness = {};
        for (let i = 0; i < lines.length; i++) {
          const m = lines[i].match(/^\S+\s+(active|expired|uncertain)\s+(?:\(api\)\s+)?(?:.*\s)?(https?:\/\/\S+)\s*$/);
          if (!m || !urls.includes(m[2])) continue;
          const reason = m[1] !== 'active' && /^\s{6,}\S/.test(lines[i + 1] || '') ? lines[i + 1].trim().slice(0, 160) : '';
          delta.liveness[m[2]] = { status: m[1], reason, at: new Date().toISOString() };
        }
        const v = Object.values(delta.liveness);
        Object.assign(run, { checked: v.length, expired: v.filter(x => x.status === 'expired').length, uncertain: v.filter(x => x.status === 'uncertain').length });
        delta.expiredUrls = Object.entries(delta.liveness).filter(([, x]) => x.status === 'expired').map(([u]) => u);
      }
      delta.lastCheckAt = new Date().toISOString();
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
} else if (mode === 'pull') throw new Error('CAREER_OPS_DIR must point at a career-ops checkout.');

delta.run = run;
save(applyDelta(state, delta));
if (process.env.DELTA_FILE) writeFileSync(process.env.DELTA_FILE, JSON.stringify(encryptJson(pass, delta)));
// Counts only: Actions logs of a public repo are public, so never print company names or titles.
console.log(`mode=${mode} checked=${run.checked || 0} closed=${run.expired || 0} unconfirmed=${run.uncertain || 0} new jobs=${run.found} job descriptions read=${run.jds} CVs built=${run.cvs} CV failures=${run.cvFailed} filtered=${run.hidden} feedback added=${run.feedback} source errors=${run.errors.length}`);
