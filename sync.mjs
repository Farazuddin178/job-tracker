#!/usr/bin/env node
// sync.mjs — bring what the page and the cloud job learned back into career-ops (local only).
//
//   node sync.mjs            # git pull, decrypt feed.enc.js, write career-ops/data/site-feed.json,
//                            # apply rejections (to-apply list, tracker), mark cloud jobs as seen
//   node sync.mjs --dry-run  # show what would change, write nothing in career-ops
//
// Run by publish.mjs before every build, and first thing in the daily routine.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decryptJson, parseFeedScript, passphraseFrom } from './cloud/crypto.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const dry = process.argv.includes('--dry-run');
const opsDir = resolve(process.env.CAREER_OPS_DIR || join(here, '..', 'career-ops'));
const { getCareerOpsRoot } = await import(pathToFileURL(join(opsDir, 'path-resolver.mjs')).href);
const root = getCareerOpsRoot();
await import(pathToFileURL(join(here, 'score.js')).href);
const { learn, score, active } = globalThis.JobScore;

// The cloud job commits feed.enc.js; get it before reading.
const remote = spawnSync('git', ['remote'], { cwd: here, encoding: 'utf8' }).stdout.trim();
if (remote && !process.argv.includes('--no-pull')) {
  const p = spawnSync('git', ['pull', '-q', '--rebase', '--autostash'], { cwd: here, encoding: 'utf8' });
  if (p.status !== 0) console.error(`git pull failed (continuing with the local copy): ${(p.stderr || '').trim().split('\n')[0]}`);
}

const feedFile = process.env.JOB_FEED_FILE || join(here, 'feed.enc.js'); // override for tests
if (!existsSync(feedFile)) { console.log('No feed.enc.js yet: nothing to sync.'); process.exit(0); }
const pass = passphraseFrom(process.env, join(here, '.passphrase'), readFileSync, existsSync);
const state = decryptJson(pass, parseFeedScript(readFileSync(feedFile, 'utf8')));

// Active feedback = latest choice per job, minus undone ones.
const feedback = active(state.feedback);
const learned = learn(feedback);
const rejected = new Map(feedback.filter(f => f.action === 'reject').map(f => [f.url, f]));
const liked = new Set(feedback.filter(f => f.action === 'like').map(f => f.url));

const outFile = join(root, 'data', 'site-feed.json');
const prev = existsSync(outFile) ? JSON.parse(readFileSync(outFile, 'utf8')) : {};
const applied = new Set(prev.appliedFeedback || []);
const log = [];

// 1. Rejected roles leave the to-apply list.
const applyFile = join(root, 'data', 'to-apply.json');
if (existsSync(applyFile)) {
  const list = JSON.parse(readFileSync(applyFile, 'utf8'));
  const keep = list.filter(r => !rejected.has(r.url));
  if (keep.length !== list.length) {
    log.push(`to-apply: removed ${list.length - keep.length} rejected role(s)`);
    if (!dry) writeFileSync(applyFile, JSON.stringify(keep, null, 2) + '\n');
  }
}

// 2. A rejected role with an evaluation report that is still "Evaluated" becomes Discarded (canonical writer).
for (const f of rejected.values()) {
  if (!f.report || applied.has(f.id)) continue;
  const reasons = f.reasons.length ? f.reasons.join(', ') : 'no reason given';
  const args = ['set-status.mjs', '--report', f.report, 'Discarded', '--expect-status', 'Evaluated',
    `--note=not interested (tracker site: ${reasons}${f.note ? `; ${f.note}` : ''})`];
  if (dry) { log.push(`would run: node ${args.join(' ')}`); continue; }
  const r = spawnSync(process.execPath, args, { cwd: opsDir, encoding: 'utf8' });
  if (r.status === 0) log.push(`tracker: report ${f.report} → Discarded`);
  else log.push(`tracker: report ${f.report} left as is (${(r.stderr || r.stdout).trim().split('\n')[0]})`);
  applied.add(f.id);
}

// 3. Jobs the cloud found count as seen locally, so the local scan doesn't list them again.
const { SCAN_HISTORY_PATH, appendToScanHistory } = await import(pathToFileURL(join(opsDir, 'scan.mjs')).href);
const histText = existsSync(SCAN_HISTORY_PATH) ? readFileSync(SCAN_HISTORY_PATH, 'utf8') : '';
const known = new Set(histText.split('\n').map(l => l.split('\t')[0]));
const fresh = state.jobs.filter(j => !known.has(j.url));
if (fresh.length) {
  log.push(`scan-history: ${fresh.length} cloud-found job(s) recorded as seen`);
  if (!dry) await appendToScanHistory(fresh.map(j => ({ url: j.url, title: j.title, company: j.company, location: j.location, source: 'cloud-pull', postedAt: j.posted || undefined })), new Date().toISOString().slice(0, 10), 'added');
}

// 4. The daily run reads this file: open feed jobs (scored with what was learned), feedback, learned preferences.
const jobs = state.jobs.map(j => {
  const s = score(j, learned);
  return { ...j, status: rejected.has(j.url) ? 'rejected' : liked.has(j.url) ? 'interested' : s.hidden ? 'hidden' : 'new', hiddenBy: s.hiddenBy, quick: { archetype: s.archetype, fit: s.fit, hire: s.hire } };
});
const out = {
  syncedAt: new Date().toISOString(), lastPullAt: state.lastPullAt || null,
  jobs, feedback,
  learned: { rejects: learned.rejects, likes: learned.likes, avoidWords: learned.avoid, preferWords: learned.prefer, companies: Object.values(learned.companies), places: Object.values(learned.places) },
  appliedFeedback: [...applied],
};
if (!dry) writeFileSync(outFile, JSON.stringify(out, null, 2) + '\n');
const count = s => jobs.filter(j => j.status === s).length;
console.log(`Synced: ${jobs.length} feed jobs (${count('new')} new, ${count('interested')} interested, ${count('rejected')} rejected, ${count('hidden')} hidden by filters or learned rules), ${feedback.length} feedback items.`);
for (const l of log) console.log(`  ${l}`);
