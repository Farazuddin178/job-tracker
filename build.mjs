#!/usr/bin/env node
// build.mjs — collect career-ops data, encrypt it, and write data.enc.js for the static page.
//
//   node build.mjs                 # uses ../career-ops and the passphrase in .passphrase
//   CAREER_OPS_DIR=… node build.mjs
//
// Everything personal is encrypted with AES-256-GCM (key from PBKDF2-SHA256), so the
// repo can be public: without the passphrase the page shows only a password box.

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomBytes, pbkdf2Sync, createCipheriv, createHash, createHmac } from 'node:crypto';

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

// Roles to apply to live in data/to-apply.json; a role drops off once the tracker shows it
// past "Evaluated" (applied, rejected, discarded …), matched by report number or company + title.
const norm = s => String(s || '').toLowerCase().replace(/\(.*?\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
function toApply(rows) {
  const file = join(root, 'data', 'to-apply.json');
  if (!existsSync(file)) return [];
  const done = rows.filter(r => r.status !== 'Evaluated');
  const taken = role => done.some(r => (role.report && r.report === role.report) ||
    (norm(r.company).split(' ')[0] === norm(role.company).split(' ')[0] && norm(r.role) === norm(role.title)));
  return JSON.parse(readFileSync(file, 'utf8')).filter(role => !taken(role));
}

// Each CV PDF is encrypted to pdfs/{id}.js with a key from the same passphrase and a fixed
// local salt, so unchanged PDFs keep their ciphertext between builds. File names are opaque.
function encryptPdfs(roles, pass) {
  const saltFile = join(here, '.pdf-salt');
  if (!existsSync(saltFile)) writeFileSync(saltFile, randomBytes(16).toString('base64'));
  const salt = Buffer.from(readFileSync(saltFile, 'utf8').trim(), 'base64');
  const key = pbkdf2Sync(pass, salt, ITERATIONS, 32, 'sha256');
  const keyCheck = createHash('sha256').update(key).digest('hex');
  const cacheFile = join(here, '.pdf-cache.json');
  let cache = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, 'utf8')) : {};
  if (cache.keyCheck !== keyCheck) cache = { keyCheck, files: {} };
  const dir = join(here, 'pdfs');
  mkdirSync(dir, { recursive: true });
  const outDirs = existsSync(join(root, 'output')) ? readdirSync(join(root, 'output')).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse() : [];
  const keep = new Set();
  let written = 0;
  for (const role of roles) {
    const src = outDirs.map(d => join(root, 'output', d, role.pdf)).find(existsSync);
    if (!src) continue;
    const id = createHmac('sha256', key).update(role.pdf).digest('hex').slice(0, 20);
    const bytes = readFileSync(src);
    const sha = createHash('sha256').update(bytes).digest('hex');
    keep.add(id);
    role.pdfId = id;
    if (cache.files[id] === sha && existsSync(join(dir, `${id}.js`))) continue;
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([c.update(bytes), c.final(), c.getAuthTag()]);
    writeFileSync(join(dir, `${id}.js`), `(window.JOB_PDF=window.JOB_PDF||{})[${JSON.stringify(id)}]=${JSON.stringify({ iv: iv.toString('base64'), data: data.toString('base64') })};\n`);
    cache.files[id] = sha;
    written++;
  }
  for (const f of readdirSync(dir)) if (!keep.has(f.replace(/\.js$/, ''))) { unlinkSync(join(dir, f)); delete cache.files[f.replace(/\.js$/, '')]; }
  writeFileSync(cacheFile, JSON.stringify(cache));
  return { salt: salt.toString('base64'), written, total: keep.size };
}

const trackerRows = tracker();
const applyList = toApply(trackerRows);
const pdfInfo = encryptPdfs(applyList, passphrase());
const payload = {
  builtAt: new Date().toISOString(),
  tracker: trackerRows,
  followups: followups(),
  reports: reports(),
  dailies: dailies(),
  toApply: applyList,
  pdfSalt: pdfInfo.salt,
};

const salt = randomBytes(16), iv = randomBytes(12);
const key = pbkdf2Sync(passphrase(), salt, ITERATIONS, 32, 'sha256');
const cipher = createCipheriv('aes-256-gcm', key, iv);
const data = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final(), cipher.getAuthTag()]);
const enc = { v: 1, iterations: ITERATIONS, salt: salt.toString('base64'), iv: iv.toString('base64'), data: data.toString('base64'), builtAt: payload.builtAt };
writeFileSync(join(here, 'data.enc.js'), `window.JOB_DATA = ${JSON.stringify(enc)};\n`);
console.log(`Built data.enc.js — ${payload.tracker.length} tracker rows, ${payload.followups.entries.length} follow-ups due, ${payload.reports.length} reports, ${payload.dailies.length} daily runs, ${applyList.length} roles to apply (${pdfInfo.total} CV PDFs, ${pdfInfo.written} re-encrypted).`);
