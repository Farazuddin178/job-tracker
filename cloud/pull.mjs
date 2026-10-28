#!/usr/bin/env node
// cloud/pull.mjs — the backend behind the page's "Pull new jobs" button (GitHub Actions).
//
//   MODE=pull      decrypt the inputs, run career-ops scan.mjs against them, add new jobs to the feed
//   MODE=feedback  only merge the rejections / interests the page sent
//
// Inputs (all encrypted with the site passphrase, secret TRACKER_PASSPHRASE):
//   cloud/input.enc.json  written by the local build.mjs: portals.yml, profile, tracker, pipeline,
//                         blacklist and the scan history that counts as "seen"
//   feed.enc.js           this script's own state: jobs found so far, feedback, cloud scan history
//   FEEDBACK (env)        encrypted {items:[...]} from the page (optional)
// Output: feed.enc.js (the workflow commits it). Zero AI tokens: pure ATS APIs, like scan.mjs.
import { readFileSync, writeFileSync, existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { encryptJson, decryptJson, feedScript, parseFeedScript, passphraseFrom } from './crypto.mjs';

const here = join(dirname(fileURLToPath(import.meta.url)), '..');
const pass = passphraseFrom(process.env, join(here, '.passphrase'), readFileSync, existsSync);
const mode = (process.env.MODE || 'pull').trim();
const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10); // IST
const KEEP_DAYS = 45, MAX_JOBS = 400;

const feedFile = join(here, 'feed.enc.js');
let state = { v: 1, jobs: [], feedback: [], seen: [], runs: [] };
if (existsSync(feedFile)) state = { ...state, ...decryptJson(pass, parseFeedScript(readFileSync(feedFile, 'utf8'))) };

// 1. Feedback from the page. Ids make re-sends harmless; "undo" removes an earlier item.
let addedFeedback = 0;
if (process.env.FEEDBACK && process.env.FEEDBACK.trim()) {
  const { items = [] } = decryptJson(pass, JSON.parse(process.env.FEEDBACK));
  const known = new Set(state.feedback.map(f => f.id));
  for (const raw of items.slice(0, 500)) {
    if (!raw || typeof raw.id !== 'string' || known.has(raw.id)) continue;
    const f = {
      id: raw.id.slice(0, 40), at: String(raw.at || new Date().toISOString()).slice(0, 30),
      action: ['reject', 'like', 'undo'].includes(raw.action) ? raw.action : 'reject',
      target: raw.target ? String(raw.target).slice(0, 40) : undefined,
      url: String(raw.url || '').slice(0, 600), company: String(raw.company || '').slice(0, 120),
      title: String(raw.title || '').slice(0, 200), location: String(raw.location || '').slice(0, 120),
      archetype: String(raw.archetype || '').slice(0, 4), report: raw.report ? String(raw.report).slice(0, 5) : undefined,
      source: raw.source === 'apply' ? 'apply' : 'feed',
      reasons: Array.isArray(raw.reasons) ? raw.reasons.map(String).slice(0, 8) : [], note: String(raw.note || '').slice(0, 300),
    };
    state.feedback.push(f); known.add(f.id); addedFeedback++;
  }
}

// 2. Scan, using the same scanner and filters as the local daily run.
const run = { at: new Date().toISOString(), mode, found: 0, feedback: addedFeedback, errors: [] };
if (mode === 'pull') {
  const opsDir = process.env.CAREER_OPS_DIR;
  if (!opsDir || !existsSync(join(opsDir, 'scan.mjs'))) throw new Error('CAREER_OPS_DIR must point at a career-ops checkout.');
  const { parseScanHistoryLine, scanHistoryDataLines } = await import(pathToFileURL(join(opsDir, 'lib/scan-history-columns.mjs')).href);
  const input = decryptJson(pass, JSON.parse(readFileSync(join(here, 'cloud/input.enc.json'), 'utf8')));
  const root = mkdtempSync(join(tmpdir(), 'jobs-'));
  try {
    for (const [rel, text] of Object.entries(input.files)) {
      if (rel.includes('..')) continue;
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    }
    // Seen = what the local run has seen + what earlier cloud pulls added.
    const histFile = join(root, 'data/scan-history.tsv');
    const before = existsSync(histFile) ? readFileSync(histFile, 'utf8') : '';
    const known = new Set(scanHistoryDataLines(before).filter(Boolean).map(l => l.split('\t')[0]));
    const extra = state.seen.filter(l => !known.has(l.split('\t')[0]));
    writeFileSync(histFile, before.replace(/\n?$/, '\n') + (extra.length ? extra.join('\n') + '\n' : ''));
    for (const l of extra) known.add(l.split('\t')[0]);

    const r = spawnSync(process.execPath, ['scan.mjs', '--json', '--quiet', '--since', '21'], {
      cwd: opsDir, env: { ...process.env, CAREER_OPS_ROOT: root, TRACKER_PASSPHRASE: '' }, encoding: 'utf8', timeout: 50 * 60_000, maxBuffer: 64 << 20,
    });
    let receipt = null;
    try { receipt = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { /* no receipt */ }
    if (receipt) Object.assign(run, { scanned: receipt.scanned, filtered: receipt.filtered, duplicates: receipt.duplicates, errors: receipt.errors.map(e => `${e.company}: ${e.error}`.slice(0, 160)) });
    if (r.status !== 0 && r.status !== 2) run.errors.push(`scan.mjs exited ${r.status}: ${(r.stderr || '').trim().split('\n').slice(-3).join(' ').slice(0, 300)}`);

    const after = readFileSync(histFile, 'utf8');
    const added = scanHistoryDataLines(after).filter(Boolean).filter(l => !known.has(l.split('\t')[0]));
    const haveUrl = new Set(state.jobs.map(j => j.url));
    for (const line of added) {
      const h = parseScanHistoryLine(line);
      if (h.status !== 'added') continue;
      state.seen.push(line);
      if (haveUrl.has(h.url)) continue;
      state.jobs.push({ url: h.url, company: h.company, title: h.title, location: h.location, posted: h.posted_at || '', found: today, portal: h.portal });
      haveUrl.add(h.url); run.found++;
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
  state.lastPullAt = run.at;
}

// 3. Housekeeping: old jobs leave the feed (their scan-history line stays, so they never come back).
const cutoff = new Date(Date.now() - KEEP_DAYS * 86_400_000).toISOString().slice(0, 10);
state.jobs = state.jobs.filter(j => j.found >= cutoff).slice(-MAX_JOBS);
state.seen = state.seen.slice(-5000);
state.runs = [...state.runs, run].slice(-30);
state.updatedAt = new Date().toISOString();

const enc = { ...encryptJson(pass, state), updatedAt: state.updatedAt };
writeFileSync(feedFile, feedScript(enc));
// Counts only: Actions logs of a public repo are public, so never print company names or titles.
console.log(`mode=${mode} new jobs=${run.found} feedback added=${addedFeedback} feed size=${state.jobs.length} source errors=${run.errors.length}`);
