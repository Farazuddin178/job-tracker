#!/usr/bin/env node
// cloud/notify.mjs — tell you what a pull found. Runs after the feed is saved.
//
// With the GMAIL_APP_PASSWORD secret (a Google app password for your Gmail account), it emails you
// the new jobs: title, company, score, why, posting link, and a link to download each CV on the site.
// Without it, it comments on the repo's "Job alerts" issue (counts only: the repo is public), and
// GitHub emails you that comment because you watch your own repo.
//
// Each person's mail goes to the address in that person's own saved profile and carries only their own
// jobs. Yours goes to the email in your profile, or NOTIFY_EMAIL. Mail goes to nobody else, and never to an employer.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import tls from 'node:tls';
import { decryptJson, parseFeedScript, passphraseFrom } from './crypto.mjs';
import { profilePass, parseProfiles } from './profiles.mjs';

const here = join(dirname(fileURLToPath(import.meta.url)), '..');
await import(pathToFileURL(join(here, 'score.js')).href);
const { learn, score, active, groupByCompany, prefsFrom } = globalThis.JobScore;
const SITE = 'https://farazuddin178.github.io/job-tracker/';
const REPO = process.env.GITHUB_REPOSITORY || 'Farazuddin178/job-tracker';
const pass = passphraseFrom(process.env, join(here, '.passphrase'), readFileSync, existsSync);
if (!process.env.DELTA_FILE || !existsSync(process.env.DELTA_FILE)) { console.log('No run to report.'); process.exit(0); }
const delta = decryptJson(pass, JSON.parse(readFileSync(process.env.DELTA_FILE, 'utf8')));
const state = decryptJson(pass, parseFeedScript(readFileSync(join(here, 'feed.enc.js'), 'utf8')));

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const istHour = new Date(Date.now() + 5.5 * 3600_000).getUTCHours();
const scheduled = process.env.GITHUB_EVENT_NAME === 'schedule';
const morning = scheduled && istHour < 12;
const date = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
const startedBy = (process.env.WHO || 'me').trim() || 'me';

/** What one person's mail says, or null when this run gives them nothing worth a mail. */
function digest({ id, delta, state, prefs, evaluated = [], friend = false }) {
  const run = delta.run || {};
  const fb = active(state.feedback);
  const learned = learn(fb);
  const rejected = new Set(fb.filter(f => f.action === 'reject').map(f => f.url));
  const scored = j => ({ ...j, s: score(j, learned, prefs) });
  const newUrls = new Set((delta.jobs || []).map(j => j.url));
  const fresh = state.jobs.filter(j => newUrls.has(j.url)).map(scored);
  // Best fit per company, as on the site: the other roles are one click away there.
  const ready = groupByCompany(fresh.filter(j => !j.s.hidden && !rejected.has(j.url)), j => j.s.rank).map(g => g.best).sort((a, b) => b.s.rank - a.s.rank);
  const filtered = fresh.filter(j => j.s.hidden);
  const builtFor = Object.entries(delta.updates || {}).filter(([, u]) => u.cv).map(([url]) => url);
  const live = state.liveness || {};
  const gone = u => live[u]?.status === 'expired' || fb.some(f => f.url === u && f.action === 'closed');
  const liked = u => fb.some(f => f.url === u && f.action === 'like');
  const toApply = state.jobs.map(scored).filter(j => !rejected.has(j.url) && !gone(j.url) && (j.cv || liked(j.url)) && (!j.s.hidden || liked(j.url))).length;
  // Postings this run found closed (pulled jobs and evaluated roles alike).
  const closedNow = (delta.expiredUrls || []).map(u => state.jobs.find(j => j.url === u) || evaluated.find(r => r.url === u) || { url: u, title: u, company: '' });
  // Morning run: always a digest. Otherwise only when something new arrived, or they started the run.
  const askedForIt = ['pull', 'check'].includes(run.mode) && !scheduled && startedBy === id;
  const cvsReady = builtFor.length > 0 && !newUrls.size;
  const worth = ready.length > 0 || closedNow.length > 0 || cvsReady || morning || askedForIt;
  if (!worth) return null;
  const subject = ready.length
    ? `${ready.length} new job${ready.length === 1 ? '' : 's'} ${ready.some(j => j.cv) ? 'with tailored CVs' : 'for you'} · ${date}`
    : cvsReady ? `${builtFor.length} tailored CV${builtFor.length === 1 ? '' : 's'} ready · ${date}`
    : run.mode === 'check' ? `Posting check: ${closedNow.length} closed and removed, ${run.checked || 0} checked · ${date}`
    : `No new jobs this time · ${toApply} in your To apply list · ${date}`;
  const row = j => `<tr><td style="padding:10px 0;border-bottom:1px solid #ddd">
    <div style="font:600 15px Arial">${esc(j.title)}</div>
    <div style="font:13px Arial;color:#555">${esc(j.company)} · ${esc(j.location || '')}${j.posted ? ` · posted ${esc(j.posted)}` : ''}</div>
    <div style="font:13px Arial;margin-top:4px">Fit <b>${j.s.fit}</b> · Hireability <b>${j.s.hire}</b> · ${esc(j.s.why.join(' · '))}</div>
    ${j.jd ? `<div style="font:12px Arial;color:#555">${j.jd.years == null ? 'years not stated' : `asks ${j.jd.years}+ yrs`} · ${j.jd.payLpa == null ? 'pay not listed' : `pay up to ₹${j.jd.payLpa.toFixed(1)} LPA`}</div>` : ''}
    <div style="font:13px Arial;margin-top:6px"><a href="${esc(j.url)}">Open posting</a> · ${j.cv ? `<a href="${SITE}">Download the tailored CV on your tracker</a>` : j.cvSkip === 'no CV source yet' ? 'Add your resume in Settings to get a CV' : 'CV comes with the next pull'}</div></td></tr>`;
  let h = `<div style="max-width:640px;font:14px Arial;color:#111">`;
  h += `<p style="font:600 18px Arial">${esc(subject)}</p>`;
  if (ready.length) h += `<table style="width:100%;border-collapse:collapse">${ready.map(row).join('')}</table>`;
  if (cvsReady) h += `<p>Your CV is ready for: ${builtFor.map(u => esc(state.jobs.find(j => j.url === u)?.title || u)).join(', ')}. It is on your To apply page.</p>`;
  if (closedNow.length) h += `<p><b>${closedNow.length} posting${closedNow.length === 1 ? ' has' : 's have'} closed</b> and left your To apply page: ${closedNow.map(j => esc(`${j.company ? `${j.company}: ` : ''}${j.title}`)).join('; ')}.</p>`;
  if (run.uncertain) h += `<p style="color:#555">${run.uncertain} posting${run.uncertain === 1 ? '' : 's'} could not be confirmed open (page unreadable); they stay listed with a warning.</p>`;
  if (filtered.length) h += `<p style="color:#555">${filtered.length} more were filtered out by your rules (e.g. ${esc(filtered.slice(0, 3).map(j => `${j.company}: ${j.s.hiddenBy}`).join('; '))}).</p>`;
  h += `<p>${toApply} role${toApply === 1 ? '' : 's'} from pulls are on your To apply page. <a href="${SITE}">Open the tracker</a>.</p>`;
  if (!friend && run.errors?.length) h += `<p style="color:#555">${run.errors.length} job board${run.errors.length === 1 ? '' : 's'} could not be read this run; they are retried next time.</p>`;
  h += `<p style="color:#888;font-size:12px">Sent by your job-tracker pull. Nothing is ever applied or sent to employers automatically.</p></div>`;
  return { subject, html: h, ready, closedNow, toApply };
}

// ── Email (Gmail SMTP, app password) ──────────────────────────────────
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

// ── GitHub issue comment (fallback for the owner; counts only: the repo is public) ──────
async function issueComment({ subject, ready, closedNow, toApply }) {
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
const password = (process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '');

// The owner.
const ownerProfile = existsSync(join(here, 'profiles/me/profile.enc.json')) ? decryptJson(pass, JSON.parse(readFileSync(join(here, 'profiles/me/profile.enc.json'), 'utf8'))) : null;
const ownerPrefs = prefsFrom({ ...(ownerProfile || {}), resumeText: input.files['cv.md'] || '' }, 'me');
const mine = digest({ id: 'me', delta, state, prefs: ownerPrefs, evaluated: input.files['data/to-apply.json'] ? JSON.parse(input.files['data/to-apply.json']) : [] });
if (!mine) console.log('Nothing new: no notification.');
else {
  let sent = false;
  if (password && to) {
    try { await smtpSend({ user, password, to, subject: mine.subject, html: mine.html }); sent = true; console.log('Email sent.'); }
    catch (err) { console.log(`Email failed (${err.message}); falling back to a GitHub notification.`); }
  }
  if (!sent) {
    try { await issueComment(mine); console.log('GitHub notification posted.'); }
    catch (err) { console.log(`Notification failed: ${err.message}`); }
  }
}

// Everyone else: their own jobs, to the address in their own saved profile. No app password, no mail.
const roster = existsSync(join(here, 'profiles.js')) ? parseProfiles(readFileSync(join(here, 'profiles.js'), 'utf8')) : [];
for (const { id } of roster.filter(p => p.id !== 'me')) {
  const file = name => join(here, 'profiles', id, name), deltaFile = `${process.env.DELTA_FILE}.${id}`, p = profilePass(pass, id);
  if (!password || !existsSync(deltaFile) || !existsSync(file('profile.enc.json')) || !existsSync(file('feed.enc.json'))) continue;
  try {
    const profile = decryptJson(p, JSON.parse(readFileSync(file('profile.enc.json'), 'utf8')));
    if (!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(profile.email || '')) continue;
    const theirs = digest({ id, delta: decryptJson(p, JSON.parse(readFileSync(deltaFile, 'utf8'))), state: { feedback: [], jobs: [], ...decryptJson(p, JSON.parse(readFileSync(file('feed.enc.json'), 'utf8'))) }, prefs: prefsFrom(profile, id), friend: true });
    if (!theirs) continue;
    await smtpSend({ user, password, to: profile.email, subject: theirs.subject, html: theirs.html });
    console.log('Email sent to a profile.'); // never the address: Actions logs are public
  } catch (err) { console.log(`A profile's email failed (${err.message}).`); }
}
