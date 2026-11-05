#!/usr/bin/env node
// cloud/notify.mjs — tell you what a pull found. Runs after the feed is saved.
//
// With the GMAIL_APP_PASSWORD secret (a Google app password for your Gmail account), it emails you
// the new jobs: title, company, score, why, posting link, and a link to download each CV on the site.
// Without it, it comments on the repo's "Job alerts" issue (counts only: the repo is public), and
// GitHub emails you that comment because you watch your own repo.
//
// Mails go only to you (the email in your profile, or NOTIFY_EMAIL). Never to anyone else.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import tls from 'node:tls';
import { decryptJson, parseFeedScript, passphraseFrom } from './crypto.mjs';

const here = join(dirname(fileURLToPath(import.meta.url)), '..');
await import(pathToFileURL(join(here, 'score.js')).href);
const { learn, score, active, groupByCompany } = globalThis.JobScore;
const SITE = 'https://farazuddin178.github.io/job-tracker/';
const REPO = process.env.GITHUB_REPOSITORY || 'Farazuddin178/job-tracker';
const pass = passphraseFrom(process.env, join(here, '.passphrase'), readFileSync, existsSync);
if (!process.env.DELTA_FILE || !existsSync(process.env.DELTA_FILE)) { console.log('No run to report.'); process.exit(0); }
const delta = decryptJson(pass, JSON.parse(readFileSync(process.env.DELTA_FILE, 'utf8')));
const state = decryptJson(pass, parseFeedScript(readFileSync(join(here, 'feed.enc.js'), 'utf8')));
const run = delta.run || {};
const fb = active(state.feedback);
const learned = learn(fb);
const rejected = new Set(fb.filter(f => f.action === 'reject').map(f => f.url));
const scored = j => ({ ...j, s: score(j, learned) });
const newUrls = new Set((delta.jobs || []).map(j => j.url));
const fresh = state.jobs.filter(j => newUrls.has(j.url)).map(scored);
// Best fit per company, as on the site: the other roles are one click away there.
const ready = groupByCompany(fresh.filter(j => !j.s.hidden && !rejected.has(j.url)), j => j.s.rank).map(g => g.best).sort((a, b) => b.s.rank - a.s.rank);
const filtered = fresh.filter(j => j.s.hidden);
const builtFor = Object.entries(delta.updates || {}).filter(([, u]) => u.cv).map(([url]) => url);
const live = state.liveness || {};
const gone = u => live[u]?.status === 'expired' || fb.some(f => f.url === u && f.action === 'closed');
const toApply = state.jobs.map(scored).filter(j => !rejected.has(j.url) && !gone(j.url) && (j.cv || fb.some(f => f.url === j.url && f.action === 'like')) && (!j.s.hidden || fb.some(f => f.url === j.url && f.action === 'like'))).length;
// Postings this run found closed (pulled jobs and evaluated roles alike).
const input0 = existsSync(join(here, 'cloud/input.enc.json')) ? decryptJson(pass, JSON.parse(readFileSync(join(here, 'cloud/input.enc.json'), 'utf8'))) : { files: {} };
const evaluated = input0.files['data/to-apply.json'] ? JSON.parse(input0.files['data/to-apply.json']) : [];
const closedNow = (delta.expiredUrls || []).map(u => state.jobs.find(j => j.url === u) || evaluated.find(r => r.url === u) || { url: u, title: u, company: '' });

// Morning run: always send a digest. Other runs: only when something new arrived.
const istHour = new Date(Date.now() + 5.5 * 3600_000).getUTCHours();
const scheduled = process.env.GITHUB_EVENT_NAME === 'schedule';
const morning = scheduled && istHour < 12;
const worth = ready.length > 0 || closedNow.length > 0 || (run.mode === 'feedback' && builtFor.length > 0) || morning || (['pull', 'check'].includes(run.mode) && !scheduled);
if (!worth) { console.log('Nothing new: no notification.'); process.exit(0); }

const date = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
const subject = ready.length
  ? `${ready.length} new job${ready.length === 1 ? '' : 's'} with tailored CVs · ${date}`
  : run.mode === 'check' ? `Posting check: ${closedNow.length} closed and removed, ${run.checked || 0} checked · ${date}`
  : run.mode === 'feedback' ? `CV ready for the job${builtFor.length === 1 ? '' : 's'} you marked interested · ${date}`
  : `No new jobs this time · ${toApply} in your To apply list · ${date}`;

// ── Email (Gmail SMTP, app password) ──────────────────────────────────
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function emailHtml() {
  const row = j => `<tr><td style="padding:10px 0;border-bottom:1px solid #ddd">
    <div style="font:600 15px Arial">${esc(j.title)}</div>
    <div style="font:13px Arial;color:#555">${esc(j.company)} · ${esc(j.location || '')}${j.posted ? ` · posted ${esc(j.posted)}` : ''}</div>
    <div style="font:13px Arial;margin-top:4px">Fit <b>${j.s.fit}</b> · Hireability <b>${j.s.hire}</b> · ${esc(j.s.why.join(' · '))}</div>
    ${j.jd ? `<div style="font:12px Arial;color:#555">${j.jd.years == null ? 'years not stated' : `asks ${j.jd.years}+ yrs`} · ${j.jd.payLpa == null ? 'pay not listed' : `pay up to ₹${j.jd.payLpa.toFixed(1)} LPA`}</div>` : ''}
    <div style="font:13px Arial;margin-top:6px"><a href="${esc(j.url)}">Open posting</a> · ${j.cv ? `<a href="${SITE}">Download the tailored CV on your tracker</a>` : 'CV comes with the next pull'}</div></td></tr>`;
  let h = `<div style="max-width:640px;font:14px Arial;color:#111">`;
  h += `<p style="font:600 18px Arial">${esc(subject)}</p>`;
  if (ready.length) h += `<table style="width:100%;border-collapse:collapse">${ready.map(row).join('')}</table>`;
  if (run.mode === 'feedback' && builtFor.length) h += `<p>Your CV is ready for: ${builtFor.map(u => esc(state.jobs.find(j => j.url === u)?.title || u)).join(', ')}. It is on your To apply page.</p>`;
  if (closedNow.length) h += `<p><b>${closedNow.length} posting${closedNow.length === 1 ? ' has' : 's have'} closed</b> and left your To apply page: ${closedNow.map(j => esc(`${j.company ? `${j.company}: ` : ''}${j.title}`)).join('; ')}.</p>`;
  if (run.uncertain) h += `<p style="color:#555">${run.uncertain} posting${run.uncertain === 1 ? '' : 's'} could not be confirmed open (page unreadable); they stay listed with a warning.</p>`;
  if (filtered.length) h += `<p style="color:#555">${filtered.length} more were filtered out by your rules (e.g. ${esc(filtered.slice(0, 3).map(j => `${j.company}: ${j.s.hiddenBy}`).join('; '))}).</p>`;
  h += `<p>${toApply} role${toApply === 1 ? '' : 's'} from pulls are on your To apply page. <a href="${SITE}">Open the tracker</a>.</p>`;
  if (run.errors?.length) h += `<p style="color:#555">${run.errors.length} job board${run.errors.length === 1 ? '' : 's'} could not be read this run; they are retried next time.</p>`;
  h += `<p style="color:#888;font-size:12px">Sent by your job-tracker pull. Nothing is ever applied or sent to employers automatically.</p></div>`;
  return h;
}
function smtpSend({ user, password, to, subject, html }) {
  return new Promise((resolve, reject) => {
    const sock = tls.connect(465, 'smtp.gmail.com', { servername: 'smtp.gmail.com' });
    const b64 = s => Buffer.from(s, 'utf8').toString('base64');
    const body = b64(html).replace(/.{1,76}/g, '$&\r\n');
    const msg = [`From: Job tracker <${user}>`, `To: <${to}>`, `Subject: =?UTF-8?B?${b64(subject)}?=`, 'MIME-Version: 1.0',
      'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', `Date: ${new Date().toUTCString()}`, '', body].join('\r\n');
    const steps = [
      [null, 220], [`EHLO job-tracker`, 250], ['AUTH LOGIN', 334], [b64(user), 334], [b64(password), 235],
      [`MAIL FROM:<${user}>`, 250], [`RCPT TO:<${to}>`, 250], ['DATA', 354], [`${msg}\r\n.`, 250], ['QUIT', 221],
    ];
    let buf = '', i = 0;
    const next = () => { const [cmd] = steps[i]; if (cmd != null) sock.write(`${cmd}\r\n`); };
    sock.setTimeout(30_000, () => { sock.destroy(); reject(new Error('SMTP timeout')); });
    sock.on('error', reject);
    sock.on('data', d => {
      buf += d.toString('utf8');
      const lines = buf.split('\r\n');
      const last = lines.filter(Boolean).pop() || '';
      if (!/^\d{3} /.test(last)) return; // multi-line reply not finished
      buf = '';
      const code = Number(last.slice(0, 3));
      if (code !== steps[i][1]) { sock.destroy(); reject(new Error(`SMTP step ${i} got ${code}`)); return; }
      i++;
      if (i === steps.length) { sock.end(); resolve(); return; }
      next();
    });
  });
}

// ── GitHub issue comment (fallback; counts only) ─────────────────────
async function issueComment() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('no GITHUB_TOKEN');
  const api = (p, o = {}) => fetch(`https://api.github.com/repos/${REPO}${p}`, { ...o, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' } });
  const list = await (await api('/issues?state=all&per_page=100')).json();
  let issue = Array.isArray(list) ? list.find(x => x.title === 'Job alerts' && !x.pull_request) : null;
  if (!issue) issue = await (await api('/issues', { method: 'POST', body: JSON.stringify({ title: 'Job alerts', body: `Each pull comments here, so GitHub emails you. Details are only on the tracker: ${SITE}` }) })).json();
  if (issue.state === 'closed') await api(`/issues/${issue.number}`, { method: 'PATCH', body: JSON.stringify({ state: 'open' }) });
  const body = `**${subject}**\n\n${closedNow.length ? `${closedNow.length} closed posting${closedNow.length === 1 ? '' : 's'} removed from To apply. ` : ''}${ready.length ? `${ready.length} new job${ready.length === 1 ? '' : 's'} passed your filters and ${ready.length === 1 ? 'has' : 'have'} a tailored CV.` : 'No new jobs passed your filters.'} ${toApply} role${toApply === 1 ? '' : 's'} from pulls are on your To apply page.\n\nOpen the tracker: ${SITE}`;
  const r = await api(`/issues/${issue.number}/comments`, { method: 'POST', body: JSON.stringify({ body }) });
  if (!r.ok) throw new Error(`issue comment ${r.status}`);
}

const input = existsSync(join(here, 'cloud/input.enc.json')) ? decryptJson(pass, JSON.parse(readFileSync(join(here, 'cloud/input.enc.json'), 'utf8'))) : { files: {} };
const profileEmail = ((input.files['config/profile.yml'] || '').match(/^\s*email:\s*["']?([^"'\s#]+@[^"'\s#]+)/m) || [])[1];
const to = process.env.NOTIFY_EMAIL || profileEmail;
const user = process.env.GMAIL_USER || to;
if (process.env.GMAIL_APP_PASSWORD && to) {
  try {
    await smtpSend({ user, password: process.env.GMAIL_APP_PASSWORD.replace(/\s+/g, ''), to, subject, html: emailHtml() });
    console.log('Email sent.');
    process.exit(0);
  } catch (err) { console.log(`Email failed (${err.message}); falling back to a GitHub notification.`); }
}
try { await issueComment(); console.log('GitHub notification posted.'); }
catch (err) { console.log(`Notification failed: ${err.message}`); }
