#!/usr/bin/env node
// build.mjs — collect career-ops data, encrypt it, and write data.enc.js for the static page.
//
//   node build.mjs                 # uses ../career-ops and the passphrase in .passphrase
//   CAREER_OPS_DIR=… node build.mjs
//
// Everything personal is encrypted with AES-256-GCM (key from PBKDF2-SHA256), so the
// repo can be public: without the passphrase the page shows only a password box.

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomBytes, pbkdf2Sync, createCipheriv } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const opsDir = resolve(process.env.CAREER_OPS_DIR || join(here, '..', 'career-ops'));
const { getCareerOpsRoot, resolveTrackerPath } = await import(pathToFileURL(join(opsDir, 'path-resolver.mjs')).href);
const root = getCareerOpsRoot();
const ITERATIONS = 310_000;

function passphrase() {
  if (process.env.JOB_SITE_PASSPHRASE) return process.env.JOB_SITE_PASSPHRASE;
  const file = join(here, '.passphrase');
  if (!existsSync(file)) throw new Error('No passphrase: create .passphrase (one line) or set JOB_SITE_PASSPHRASE.');
  const p = readFileSync(file, 'utf8').trim();
  if (p.length < 12) throw new Error('Passphrase must be at least 12 characters.');
  return p;
}

// Markdown table → { header, rows } (cells keep inline markdown; the page renders links safely).
function parseTable(lines, start) {
  const out = { header: [], rows: [] };
  let i = start;
  const split = l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
  out.header = split(lines[i]); i += 2; // skip the --- row
  for (; i < lines.length && lines[i].trim().startsWith('|'); i++) out.rows.push(split(lines[i]));
  return out;
}

function tracker() {
  const path = resolveTrackerPath(root);
  const lines = readFileSync(path, 'utf8').split('\n');
  const at = lines.findIndex(l => /^\|\s*#\s*\|/.test(l));
  const t = parseTable(lines, at);
  const col = name => t.header.findIndex(h => h.toLowerCase() === name);
  const [cNum, cDate, cCo, cRole, cScore, cStatus, cReport, cNotes] = ['#', 'date', 'company', 'role', 'score', 'status', 'report', 'notes'].map(col);
  return t.rows.map(r => ({
    num: Number(r[cNum]), date: r[cDate], company: r[cCo], role: r[cRole], score: r[cScore],
    status: r[cStatus], report: (r[cReport].match(/\[(\d+)\]/) || [])[1] || null, notes: r[cNotes] || '',
  }));
}

function followups() {
  const r = spawnSync(process.execPath, ['followup-cadence.mjs', '--json'], { cwd: opsDir, encoding: 'utf8' });
  if (r.status !== 0) return { error: (r.stderr || '').trim().slice(0, 300), entries: [] };
  const j = JSON.parse(r.stdout);
  return {
    metadata: j.metadata,
    entries: j.entries.filter(e => ['overdue', 'urgent'].includes(e.urgency)).map(e => ({
      num: e.num, company: e.company, role: e.role, status: e.status, urgency: e.urgency,
      daysSinceApplication: e.daysSinceApplication, nextFollowupDate: e.nextFollowupDate, followupCount: e.followupCount,
    })),
  };
}

function reports() {
  const dir = join(root, 'reports');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => /^\d{3,}-.*\.md$/.test(f)).sort().map(f => {
    const text = readFileSync(join(dir, f), 'utf8');
    const field = name => (text.match(new RegExp(`^\\*\\*${name}:\\*\\*\\s*(.+)$`, 'm')) || [])[1]?.trim() || null;
    const verdict = (text.match(/^## Verdict \(lead\)\s*\n+([^\n]+)/m) || [])[1] || null;
    return {
      num: f.slice(0, 3), file: f, title: (text.match(/^# Evaluation:\s*(.+)$/m) || [])[1] || f,
      score: field('Score'), decision: field('Decision'), url: field('URL'), legitimacy: field('Legitimacy'), verdict,
    };
  });
}

// Daily runs live in output/{date}/daily-{date}.md; keep every run, newest first.
function dailies() {
  const out = join(root, 'output');
  if (!existsSync(out)) return [];
  const runs = [];
  for (const d of readdirSync(out).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse()) {
    const file = join(out, d, `daily-${d}.md`);
    if (!existsSync(file)) continue;
    const lines = readFileSync(file, 'utf8').split('\n');
    const tables = [];
    let heading = '';
    for (let i = 0; i < lines.length; i++) {
      if (/^#{2,3} /.test(lines[i])) heading = lines[i].replace(/^#+\s*/, '');
      if (lines[i].trim().startsWith('|') && lines[i + 1]?.includes('---')) {
        const t = parseTable(lines, i);
        tables.push({ heading, ...t });
        i += t.rows.length + 1;
      }
    }
    const answer = (lines.join('\n').match(/"Why are you seeking new employment\?"[^:]*:\s*\*([^*]+)\*/) || [])[1] || null;
    runs.push({ date: d, tables, answer, notes: lines.filter(l => /^- \*\*/.test(l)).map(l => l.slice(2)) });
  }
  return runs;
}

const payload = {
  builtAt: new Date().toISOString(),
  tracker: tracker(),
  followups: followups(),
  reports: reports(),
  dailies: dailies(),
};

const salt = randomBytes(16), iv = randomBytes(12);
const key = pbkdf2Sync(passphrase(), salt, ITERATIONS, 32, 'sha256');
const cipher = createCipheriv('aes-256-gcm', key, iv);
const data = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final(), cipher.getAuthTag()]);
const enc = { v: 1, iterations: ITERATIONS, salt: salt.toString('base64'), iv: iv.toString('base64'), data: data.toString('base64'), builtAt: payload.builtAt };
writeFileSync(join(here, 'data.enc.js'), `window.JOB_DATA = ${JSON.stringify(enc)};\n`);
console.log(`Built data.enc.js — ${payload.tracker.length} tracker rows, ${payload.followups.entries.length} follow-ups due, ${payload.reports.length} reports, ${payload.dailies.length} daily runs.`);
