// app.js — decrypt the tracker in the browser, render it, and drive the "Pull new jobs" button.
// Data: data.enc.js (local build), feed.enc.js (cloud job), pdfs/*.js (CVs). All AES-256-GCM,
// key from the passphrase via PBKDF2-SHA256. Nothing readable is ever sent anywhere: feedback
// goes to the cloud job encrypted, through the GitHub API, with a token kept on this device.
(() => {
  const $ = id => document.getElementById(id);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* storage unavailable */ } },
  };
  const PASS_KEY = 'jt-pass', TOKEN_KEY = 'jt-gh-token', QUEUE_KEY = 'jt-fb-queue', RUN_KEY = 'jt-run', KNOWN_KEY = 'jt-known', BEST_KEY = 'jt-best-fit';
  const forProfile = (key, id) => (id === 'me' ? key : `${key}-${id}`); // the owner keeps the storage keys from before profiles
  const REPO = 'Farazuddin178/job-tracker', WORKFLOW = 'pull-jobs.yml';
  const S = window.JobScore, A = window.JobAgent;

  // ── Crypto ──────────────────────────────────────────────────────────
  const fromB64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const toB64 = buf => { const b = new Uint8Array(buf); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); };
  const keys = new Map();
  function keyFor(pass, salt, iterations) {
    const id = `${pass}|${salt}|${iterations}`;
    if (!keys.has(id)) keys.set(id, crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey'])
      .then(base => crypto.subtle.deriveKey({ name: 'PBKDF2', salt: fromB64(salt), iterations, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])));
    return keys.get(id);
  }
  async function decryptEnc(pass, enc) {
    const key = await keyFor(pass, enc.salt, enc.iterations || 310000);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(enc.iv) }, key, fromB64(enc.data));
    return JSON.parse(new TextDecoder().decode(plain));
  }
  async function encryptJson(pass, value) {
    const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
    const s = toB64(salt);
    const key = await keyFor(pass, s, 310000);
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(value)));
    return { v: 1, iterations: 310000, salt: s, iv: toB64(iv), data: toB64(data) };
  }
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`).replace(/-/g, '').slice(0, 24);

  // ── Text helpers ────────────────────────────────────────────────────
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const md = s => esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, url) => /^https?:\/\//i.test(url) ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>` : text);
  const badge = status => `<span class="badge ${esc(String(status).toLowerCase())}">${esc(status)}</span>`;
  const isUrl = u => /^https?:\/\//i.test(u || '');
  const norm = s => String(s || '').toLowerCase().replace(/\(.*?\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
  const pad = n => String(n).padStart(2, '0');
  function ago(iso) {
    if (!iso) return 'never';
    const m = Math.round((Date.now() - new Date(iso)) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 36) return `${h} h ago`;
    return `${Math.round(h / 24)} days ago`;
  }
  function head(idx, title, count, line) {
    return `<header class="section-head reveal"><span class="ghost-num" aria-hidden="true">${esc(idx)}</span>
      <div><span class="idx">${esc(idx)} / ${esc(title)}</span><h2>${esc(title)}${count != null ? `<span class="n">${count}</span>` : ''}</h2></div>
      ${line ? `<p>${esc(line)}</p>` : ''}</header>`;
  }
  let toastTimer;
  function toast(html, ms = 6000) {
    const t = $('toast'); t.innerHTML = html; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms);
  }

  // ── State ───────────────────────────────────────────────────────────
  let DATA = null, PASS = null, ID = 'me', TEAM_PASS = null;
  let FEED = { jobs: [], feedback: [], runs: [] };
  let PROFILE = null, PREFS = S.prefsFrom(null), TEAM = null, LOCKS = {};
  let profileSaved = false, pendingProfile = null; // pendingProfile: settings waiting for Connect
  let QUEUE = [];
  const loadQueue = () => { try { QUEUE = JSON.parse(store.get(forProfile(QUEUE_KEY, ID)) || '[]'); } catch { QUEUE = []; } };
  const saveQueue = () => store.set(forProfile(QUEUE_KEY, ID), JSON.stringify(QUEUE));
  const token = () => store.get(TOKEN_KEY);
  const today = () => new Date().toISOString().slice(0, 10);
  const firstName = () => String(PROFILE?.name || '').split(' ')[0];
  const allFeedback = () => [...(FEED.feedback || []), ...QUEUE];
  let ACTIVE = [], LEARNED = S.learn([]);
  function recompute() {
    ACTIVE = S.active(allFeedback()); LEARNED = S.learn(ACTIVE);
    PREFS = S.prefsFrom(PROFILE, ID);
    LOCKS = S.companyLocks([...S.appliedFromTracker(DATA?.tracker), ...S.appliedLog(allFeedback())], Number(PROFILE?.cooldownDays) || 60);
  }
  // A profile with no local career-ops run has its tracker built from what it marked applied here.
  const trackerRows = () => (ID === 'me' ? DATA.tracker : S.appliedLog(allFeedback()).map((a, i) => ({ num: i + 1, date: a.date, company: a.company, role: a.title, score: '—', status: 'Applied', report: null, notes: '' })));
  const appliedEntry = r => S.appliedLog(allFeedback()).find(a => a.url === r.url);
  const isApplied = r => !!appliedEntry(r);
  const lockFor = r => { const l = LOCKS[S.normCompany(r.company)]; return l && l.url !== r.url ? l : null; };
  function cooldownNote(r) {
    const l = lockFor(r);
    return l ? `<p class="cool" role="note">Already applied to ${esc(l.title)} at ${esc(r.company)} on ${esc(l.date)}. Cooldown until ${esc(l.until)}${ID === 'me' ? '; any CV here keeps the version you sent them' : ''}.</p>` : '';
  }
  // What the other person is doing here: on this exact role, or anywhere at the company (a possible referral).
  function teamBadges(r) {
    const key = S.normCompany(r.company), others = (TEAM?.entries || []).filter(e => e.by !== ID && e.companyKey === key);
    if (!others.length) return '';
    const name = e => esc(TEAM.names[e.by] || 'Teammate');
    const same = e => (e.url && e.url === r.url) || norm(e.title) === norm(r.title);
    const exact = others.filter(same), rest = others.filter(e => !same(e));
    return [...exact.map(e => `<span class="badge team" title="${esc(e.date)}">${e.status === 'applied' ? `Applied by ${name(e)}` : `${name(e)} shortlisted`}</span>`),
      ...[...new Set(rest.map(e => e.by))].map(by => { const e = rest.find(x => x.by === by); return `<span class="badge team" title="${esc(e.title)}: ask about a referral">${name(e)} ${e.status === 'applied' ? 'applied here' : 'is looking here'}</span>`; })].join('');
  }
  let bestOnly = store.get(BEST_KEY) !== '0';
  // Best fit only: each company shows its top role; the rest wait in a dropdown under it.
  function bestPerCompany(rows, rank) {
    if (!bestOnly) return rows;
    const best = new Set(S.groupByCompany(rows, rank).map(g => { g.best.others = g.others; return g.best; }));
    return rows.filter(r => best.has(r));
  }
  function otherRoles(r, card) {
    if (!r.others?.length) return '';
    return `<details class="others"><summary>View ${r.others.length} other role${r.others.length === 1 ? '' : 's'} at this company</summary>
      <p class="cool">Applying to several roles at one company with differently tailored resumes can look unfocused to recruiters and ATS systems. Pick one.</p>
      <div class="grid">${r.others.map(card).join('')}</div></details>`;
  }
  const bestToggle = () => `<div class="chips best-toggle"><button type="button" data-best-only aria-pressed="${bestOnly}">Best fit per company</button></div>`;
  const choiceFor = url => ACTIVE.find(f => f.url === url);
  // Closed postings: the cloud check found it closed, or you marked it closed, unless you said it's still open.
  const LIVE = () => FEED.liveness || {};
  const isGone = url => { const c = choiceFor(url); if (c?.action === 'open') return false; return c?.action === 'closed' || LIVE()[url]?.status === 'expired'; };
  const goneWhy = url => (choiceFor(url)?.action === 'closed' ? 'you marked it closed' : LIVE()[url]?.reason || 'the job board no longer lists it');
  const userChoice = url => { const c = choiceFor(url); return c && ['like', 'reject'].includes(c.action) ? c : null; };
  function liveBadge(url) {
    const l = LIVE()[url];
    if (!l || choiceFor(url)?.action === 'open') return '';
    if (l.status === 'uncertain') return `<span class="badge urgent" title="${esc(l.reason)}">couldn't confirm it's open</span>`;
    if (l.status === 'active') return `<span class="badge" title="Checked on the job board">open · checked ${esc(ago(l.at))}</span>`;
    return '';
  }

  // ── CV PDFs ─────────────────────────────────────────────────────────
  const pdfScripts = {};
  function loadPdfScript(id) {
    if (!pdfScripts[id]) pdfScripts[id] = new Promise((ok, fail) => {
      const s = document.createElement('script');
      s.src = `pdfs/${id}.js`;
      s.onload = () => (window.JOB_PDF && window.JOB_PDF[id] ? ok(window.JOB_PDF[id]) : fail(new Error('PDF missing')));
      s.onerror = () => { delete pdfScripts[id]; fail(new Error('Could not load the PDF.')); };
      document.head.appendChild(s);
    });
    return pdfScripts[id];
  }
  // CVs built by the cloud job live in cvs/{id}.json. Pages may not have redeployed yet, so fall back to the API.
  async function loadCloudCv(id) {
    try {
      const r = await fetch(`cvs/${id}.json?v=${Date.now()}`, { cache: 'no-store' });
      if (r.ok) return await r.json();
    } catch { /* fall through */ }
    if (!token()) throw new Error('CV not on the site yet');
    const r = await gh(`/contents/cvs/${id}.json?ref=main`, { headers: { Accept: 'application/vnd.github.raw+json' } });
    if (!r.ok) throw new Error('CV not found');
    return r.json();
  }
  const pdfSalt = () => DATA.pdfSalt || FEED.pdfSalt;
  // The CV's plain text for agents; a CV built before this existed falls back to the base resume.
  async function cvPlainText(job) {
    if (job.cvId && job.cvKind === 'cvs') {
      try {
        const enc = await loadCloudCv(job.cvId);
        if (enc.text) {
          const key = await keyFor(PASS, pdfSalt(), 310000);
          return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(enc.text.iv) }, key, fromB64(enc.text.data)));
        }
      } catch { /* the base resume below */ }
    }
    return PROFILE.resumeText || '';
  }
  async function cvBlobUrl(job) {
    const enc = await (job.cvKind === 'cvs' ? loadCloudCv(job.cvId) : loadPdfScript(job.cvId));
    const key = await keyFor(PASS, pdfSalt(), 310000);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(enc.iv) }, key, fromB64(enc.data));
    return URL.createObjectURL(new Blob([plain], { type: 'application/pdf' }));
  }
  async function downloadPdf(id, name, btn, kind = 'pdfs') {
    const label = btn.innerHTML;
    btn.disabled = true; btn.textContent = 'Preparing…';
    try {
      const [enc, key] = await Promise.all([kind === 'cvs' ? loadCloudCv(id) : loadPdfScript(id), keyFor(PASS, pdfSalt(), 310000)]);
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(enc.iv) }, key, fromB64(enc.data));
      const url = URL.createObjectURL(new Blob([plain], { type: 'application/pdf' }));
      const a = Object.assign(document.createElement('a'), { href: url, download: name });
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      btn.innerHTML = label;
    } catch { btn.textContent = 'Download failed — retry'; }
    finally { btn.disabled = false; }
  }

  // ── GitHub: the Pull button ─────────────────────────────────────────
  async function gh(path, opts = {}) {
    const r = await fetch(`https://api.github.com/repos/${REPO}${path}`, {
      ...opts,
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', Authorization: `Bearer ${token()}`, ...(opts.headers || {}) },
      cache: 'no-store',
    });
    if (r.status === 401) throw new Error('GitHub refused the token (expired or wrong). Open Connect and paste a new one.');
    if (r.status === 403 || r.status === 404) throw new Error(`GitHub said ${r.status}: check the token has Actions read/write and Contents read on job-tracker.`);
    return r;
  }
  let syncTimer = null, pollTimer = null;
  const currentRun = () => { try { return JSON.parse(store.get(forProfile(RUN_KEY, ID)) || 'null'); } catch { return null; } };

  async function dispatch(mode, profile) {
    if (!token()) { openConnect(); return; }
    clearTimeout(syncTimer);
    const items = QUEUE.slice(0, 400);
    const feedback = items.length || profile ? JSON.stringify(await encryptJson(PASS, { items, profile })) : '';
    if (feedback.length > 60000) throw new Error('That is too much text to send at once. Shorten the resume and save again.');
    const at = Date.now();
    const r = await gh(`/actions/workflows/${WORKFLOW}/dispatches`, { method: 'POST', body: JSON.stringify({ ref: 'main', inputs: { mode, feedback, who: ID } }) });
    if (r.status !== 204) throw new Error(`GitHub did not start the job (${r.status}).`);
    store.set(forProfile(RUN_KEY, ID), JSON.stringify({ mode, at, profile: !!profile }));
    renderPull();
    schedulePoll(4000);
  }
  function schedulePoll(ms = 10000) { clearTimeout(pollTimer); pollTimer = setTimeout(() => poll().catch(err => setPull(esc(err.message))), ms); }
  async function poll() {
    const mark = currentRun();
    if (!mark || !token()) return;
    const r = await gh(`/actions/workflows/${WORKFLOW}/runs?per_page=10`);
    const runs = (await r.json()).workflow_runs || [];
    const run = runs.filter(x => new Date(x.created_at) >= mark.at - 60_000).pop();
    if (!run) {
      if (Date.now() - mark.at > 5 * 60_000) { store.del(forProfile(RUN_KEY, ID)); setPull('GitHub never started the job. Try again in a minute.'); return; }
      schedulePoll(5000); return;
    }
    mark.url = run.html_url; mark.status = run.status;
    store.set(forProfile(RUN_KEY, ID), JSON.stringify(mark));
    if (run.status !== 'completed') { renderPull(); schedulePoll(mark.mode === 'pull' ? 15000 : 6000); return; }
    store.del(forProfile(RUN_KEY, ID));
    if (run.conclusion !== 'success') {
      setPull(`The job failed. Most often the <code>TRACKER_PASSPHRASE</code> secret is missing or differs from your passphrase. <a href="${esc(run.html_url)}" target="_blank" rel="noopener noreferrer">See the run ↗</a>`);
      return;
    }
    await refreshFeed();
    if (await loadProfile()) { profileSaved = true; clearDraft(); }
    else if (mark.profile) { setPull('Your profile did not save. Open Settings and press Save again.'); return; }
    recompute(); renderAll();
    const last = (FEED.runs || []).slice(-1)[0];
    if (mark.mode === 'pull') toast(!last ? 'Pull finished'
      : last.found ? `Pull finished · ${last.found} new job${last.found === 1 ? '' : 's'} · ${last.cvs || 0} CV${last.cvs === 1 ? '' : 's'} ready · see To apply`
      : `Pull finished · ${last.scanned || 'all'} boards checked, no new matching postings since the last pull${last.expired ? ` · ${last.expired} closed posting${last.expired === 1 ? '' : 's'} removed` : ''}`, 9000);
    if (QUEUE.length) scheduleSync(3000);
  }
  // A repo file as text: through the API when connected (newest), else from Pages. Null when it doesn't exist.
  async function repoText(path) {
    if (token()) {
      try {
        const r = await gh(`/contents/${path}?ref=main`, { headers: { Accept: 'application/vnd.github.raw+json' } });
        if (r.ok) return r.text();
      } catch { /* a brand-new file answers 404: try Pages */ }
    }
    try {
      const r = await fetch(`${path}?v=${Date.now()}`, { cache: 'no-store' });
      return r.ok ? r.text() : null;
    } catch { return null; }
  }
  async function readFeedFile() {
    const text = await repoText(ID === 'me' ? 'feed.enc.js' : `profiles/${ID}/feed.enc.json`);
    if (!text) return null;
    if (ID !== 'me') return JSON.parse(text);
    const m = text.match(/window\.JOB_FEED\s*=\s*(\{[\s\S]*\})\s*;?\s*$/);
    return m ? JSON.parse(m[1]) : null;
  }
  async function readTeam() {
    const text = TEAM_PASS && await repoText('team.enc.js');
    const m = text && text.match(/window\.JOB_TEAM\s*=\s*(\{[\s\S]*\})\s*;?\s*$/);
    if (m) { try { TEAM = await decryptEnc(TEAM_PASS, JSON.parse(m[1])); } catch { /* keep the last copy */ } }
  }
  async function refreshFeed() {
    const enc = await readFeedFile();
    if (enc) await loadFeed(enc);
    await readTeam();
    renderAll();
  }
  async function loadProfile() {
    const text = await repoText(`profiles/${ID}/profile.enc.json`);
    if (!text) return false;
    try {
      const saved = await decryptEnc(PASS, JSON.parse(text));
      PROFILE = { ...DATA.profile, ...saved, answers: { ...DATA.profile.answers, ...saved.answers } };
      if (ID === 'me') PROFILE.resumeText = DATA.profile.resumeText; // cv.md stays the owner's resume
      return true;
    } catch { return false; }
  }
  async function loadFeed(enc) {
    if (!enc) return;
    try { FEED = { jobs: [], feedback: [], runs: [], ...(await decryptEnc(PASS, enc)) }; }
    catch { return; }
    const sent = new Set((FEED.feedback || []).map(f => f.id));
    const before = QUEUE.length;
    QUEUE = QUEUE.filter(f => !sent.has(f.id));
    if (QUEUE.length !== before) saveQueue();
    recompute();
  }
  function scheduleSync(ms = 20000) {
    if (!token()) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => { if (!currentRun() && QUEUE.length) dispatch('feedback').catch(err => setPull(esc(err.message))); }, ms);
  }

  function setPull(html) { $('pull-status').innerHTML = html; }
  function renderPull() {
    const mark = currentRun();
    const btn = $('pull-btn');
    const wrap = btn.closest('.pull');
    wrap.classList.toggle('running', !!mark && mark.mode === 'pull');
    btn.disabled = !!mark && mark.mode === 'pull';
    btn.innerHTML = mark && mark.mode === 'pull' ? 'Pulling…' : 'Pull new jobs <span aria-hidden="true">↘</span>';
    $('connect-btn').textContent = token() ? 'Connected' : 'Connect';
    $('connect-btn').classList.toggle('on', !!token());
    const last = (FEED.runs || []).filter(r => r.mode === 'pull').slice(-1)[0];
    const queued = QUEUE.length ? ` · ${QUEUE.length} choice${QUEUE.length === 1 ? '' : 's'} on this device${token() ? ', syncing' : ', not sent yet'}` : '';
    if (mark && mark.mode === 'pull') {
      setPull(`<span class="spinner"></span>Scanning boards, reading job descriptions and building a CV for each new job · started ${ago(new Date(mark.at).toISOString())}. Usually 15–30 minutes; you can close this page.${mark.url ? ` <a href="${esc(mark.url)}" target="_blank" rel="noopener noreferrer">Watch ↗</a>` : ''}`);
    } else if (mark && mark.mode === 'check') {
      setPull(`<span class="spinner"></span>Checking every posting on your lists · started ${ago(new Date(mark.at).toISOString())}. Usually 5–10 minutes.`);
    } else if (mark && mark.mode === 'feedback') {
      setPull(`<span class="spinner"></span>Saving your choices and building CVs for your picks · started ${ago(new Date(mark.at).toISOString())}. Usually 3–5 minutes.`);
    } else if (ID !== 'me' && !profileSaved) {
      setPull('Save your profile in Settings first. Your jobs are matched to your resume and target roles.');
    } else if (!token()) {
      setPull(`Connect once and this button scans your company boards in the cloud.${queued}`);
    } else {
      setPull(`Last pull ${ago(FEED.lastPullAt)}${last ? ` · ${last.found} new` : ''} · automatic pulls about 06:00 and 18:00 IST${queued}`);
    }
  }

  // ── Feedback (reject / interested) ──────────────────────────────────
  function addFeedback(item) {
    const f = { id: uid(), at: new Date().toISOString(), ...item };
    QUEUE.push(f); saveQueue(); recompute(); renderAll(); scheduleSync();
    return f;
  }
  function markApplied(r) {
    addFeedback({ action: 'applied', source: 'apply', url: r.url, company: r.company, title: r.title, date: today(), variant: r.variant || r.cvVariant, report: r.report || undefined });
  }
  function undo(f) {
    const i = QUEUE.findIndex(q => q.id === f.id);
    if (i >= 0) { QUEUE.splice(i, 1); saveQueue(); }
    else QUEUE.push({ id: uid(), at: new Date().toISOString(), action: 'undo', target: f.id, url: '' }), saveQueue(), scheduleSync();
    recompute(); renderAll();
  }
  let openReject = null; // key of the card whose reject form is open
  let picked = new Set();
  function rejectForm(key) {
    if (openReject !== key) return '';
    return `<div class="reject"><p class="q">Why isn't this one for you?</p>
      <div class="chips">${S.REASONS.map(([id, label]) => `<button type="button" data-reason="${id}" aria-pressed="${picked.has(id)}">${esc(label)}</button>`).join('')}</div>
      <label class="sr-only" for="note-${esc(key)}">Note</label><input type="text" id="note-${esc(key)}" class="reject-note" maxlength="200" placeholder="Anything else? (optional)">
      <div class="actions"><button class="btn red small" type="button" data-confirm="${esc(key)}">Reject</button><button class="btn ghost small" type="button" data-cancel>Cancel</button></div></div>`;
  }

  // ── Jobs: feed + to apply ───────────────────────────────────────────
  let FEED_JOBS = [], APPLY = [];
  function feedJobs() {
    const inApply = new Set((DATA.toApply || []).map(r => r.url));
    const tracked = new Set(DATA.tracker.map(r => `${norm(r.company).split(' ')[0]}|${norm(r.role)}`));
    return (FEED.jobs || []).filter(j => !inApply.has(j.url) && !tracked.has(`${norm(j.company).split(' ')[0]}|${norm(j.title)}`))
      .map(j => ({ ...j, s: S.score(j, LEARNED, PREFS), choice: userChoice(j.url), gone: isGone(j.url) }));
  }
  function feedCard(j, i) {
    const key = `f${i}`, c = j.choice;
    return `<article class="card${c?.action === 'reject' || (j.s.hidden && !c) ? ' dim' : ''}">
      <p class="co"><span>${esc(j.company)}</span><span>${esc(j.location || '')}</span></p>
      <h3>${esc(j.title)}</h3>
      <div class="row">
        <span class="badge">${esc(j.s.archetype)}</span>
        <span class="badge" title="Quick fit from the title (no AI)">Fit <b>${j.s.fit}</b></span>
        <span class="badge hire" title="Quick hireability from the title">Hire <b>${j.s.hire}</b></span>
        ${c?.action === 'like' ? '<span class="badge hire">★ Interested</span>' : ''}
        ${c?.action === 'reject' ? `<span class="badge rejected">Rejected${c.reasons?.length ? ` · ${esc(c.reasons.join(', '))}` : ''}</span>` : ''}
        ${j.gone ? `<span class="badge rejected" title="${esc(goneWhy(j.url))}">Closed</span>` : liveBadge(j.url)}
        ${teamBadges(j)}
      </div>
      ${cooldownNote(j)}
      <p class="why">${esc(j.s.hiddenBy && !c ? `Hidden: ${j.s.hiddenBy}` : j.s.why.join(' · '))}</p>
      ${jdRow(j)}
      <p class="meta">${[j.posted && `posted ${j.posted}`, `found ${j.found}`, j.cv && `CV: ${j.cv.variant.replace(/_/g, ' ')} version${j.cv.ats ? ` · ATS ${j.cv.ats}` : ''}`].filter(Boolean).map(esc).join(' · ')}</p>
      <div class="actions">
        ${isUrl(j.url) ? `<a class="btn ${j.cv ? 'primary' : 'ghost'} small" href="${esc(j.url)}" target="_blank" rel="noopener noreferrer">Open posting ↗</a>` : ''}
        ${j.cv ? `<button class="btn ghost small" type="button" data-pdf="${esc(j.cv.id)}" data-kind="cvs" data-name="${esc(j.cv.name)}">Download CV ↓</button>`
          : `<span class="muted mono">${esc(j.cvSkip ? 'No CV: filtered out' : j.cvLater ? 'CV only for the best role here. Press Interested to build one.' : j.cvError ? `CV failed (${j.cvError}); retried next pull` : 'CV comes with the next pull')}</span>`}
        ${j.gone ? '' : agentButtons(key)}
        ${j.gone ? `<button class="btn ghost small" type="button" data-reopen-url="${esc(j.url)}">It's still open</button>`
          : c ? `<button class="btn ghost small" type="button" data-undo-url="${esc(j.url)}">Undo</button>`
            : `<button class="btn ghost small" type="button" data-like="${i}">★ Interested</button>
               <button class="btn ghost small" type="button" data-open-reject="${key}">Not for me ✕</button>`}
        ${j.gone ? '' : `<button class="btn ghost small" type="button" data-closed="${key}" title="The posting is gone or no longer takes applications">Posting closed</button>`}
      </div>
      ${rejectForm(key)}
      ${otherRoles(j, x => feedCard(x, FEED_JOBS.indexOf(x)))}
    </article>`;
  }
  // AI Auto-Apply: the structured view of one job, and the prompt to paste into a browser agent.
  const agentButtons = key => `<button class="btn ghost small" type="button" data-agent="${esc(key)}">AI Auto-Apply</button>
    <button class="btn ghost small" type="button" data-agent-copy="${esc(key)}">Copy Agent Prompt</button>`;
  // What the job description said (the cloud job reads it through the ATS API).
  function jdRow(j) {
    if (j.jd === undefined) return '';
    if (!j.jd) return '<div class="row"><span class="badge">JD not readable · score from title</span></div>';
    const d = j.jd;
    return `<div class="row">
      <span class="badge${d.years != null && d.years >= 3 ? ' urgent' : ''}">${d.years == null ? 'years: not stated' : `asks ${d.years}+ yrs`}</span>
      <span class="badge${d.payLpa != null ? ' pay' : ''}">${d.payLpa == null ? 'pay: not listed' : `pay up to ₹${esc(d.payLpa.toFixed(1))} LPA`}</span>
      <span class="badge" title="${esc((d.matched || []).join(', '))}">${(d.matched || []).length} of your skills</span>
    </div>`;
  }
  function learnedPanel() {
    const L = LEARNED;
    const tags = (list, cls) => list.length ? list.map(t => `<span class="tag ${cls}">${esc(t)}</span>`).join('') : '<span class="muted">nothing yet</span>';
    const neg = Object.entries(L.tokens).filter(([, w]) => w < 0).sort((a, b) => a[1] - b[1]).slice(0, 8).map(([t, w]) => `${t} ${w}`);
    return `<div class="learned reveal">
      <div><h4>Taught so far</h4><div class="big">${L.rejects}<span class="muted" style="font-size:.5em"> rejected</span></div><div class="big">${L.likes}<span class="muted" style="font-size:.5em"> interested</span></div></div>
      <div><h4>Words that hide jobs</h4>${tags(L.avoid, 'neg')}<p class="muted">Rejected 3+ times more than liked.</p></div>
      <div><h4>Words that rank lower</h4>${tags(neg.filter(n => !L.avoid.includes(n.split(' ')[0])), 'neg')}</div>
      <div><h4>You like</h4>${tags(L.prefer, 'pos')}<h4 style="margin-top:1rem">Blocked</h4>${tags([...Object.values(L.companies), ...Object.values(L.places)], 'neg')}</div>
    </div>`;
  }
  function renderFeed() {
    FEED_JOBS = feedJobs();
    const liked = FEED_JOBS.filter(j => !j.gone && j.choice?.action === 'like');
    const reviewable = FEED_JOBS.filter(j => !j.gone && !j.choice && !j.s.hidden);
    const open = bestPerCompany(reviewable, j => j.s.rank + (j.jd?.matched?.length || 0) / 100).sort((a, b) => !!lockFor(a) - !!lockFor(b) || b.s.rank - a.s.rank || (b.posted || '').localeCompare(a.posted || ''));
    const hidden = FEED_JOBS.filter(j => !j.gone && !j.choice && j.s.hidden);
    const rejected = FEED_JOBS.filter(j => !j.gone && j.choice?.action === 'reject');
    const closed = FEED_JOBS.filter(j => j.gone && j.choice?.action !== 'reject');
    const idx = j => FEED_JOBS.indexOf(j);
    const cards = list => `<div class="grid">${list.map(j => feedCard(j, idx(j))).join('')}</div>`;
    $('feed-count').textContent = open.length || '';
    let html = head('02', 'New jobs', open.length, 'Fresh from your company boards. Reject what you don\'t want and say why: the list learns, and so does the daily run.');
    html += learnedPanel();
    if (liked.length) html += head('02.1', 'Interested', liked.length, 'The next daily run evaluates these first and builds a tailored CV.') + cards(liked);
    html += open.length ? head('02.2', 'To review', open.length, 'Ranked by fit × hireability, read from each job description (from the title when the description could not be read). The best role at each company comes with a tailored one-page CV.') + bestToggle() + cards(open)
      : `<p class="empty">${FEED.lastPullAt ? 'Nothing new to review. Pull again later, or wait for the next automatic pull.' : 'No pull yet. Press “Pull new jobs”.'}</p>`;
    if (hidden.length) html += `<details class="fold"><summary>Hidden by what you taught me (${hidden.length})</summary>${cards(hidden)}</details>`;
    if (rejected.length) html += `<details class="fold"><summary>Rejected (${rejected.length})</summary>${cards(rejected)}</details>`;
    if (closed.length) html += `<details class="fold"><summary>Closed postings (${closed.length})</summary>${cards(closed)}</details>`;
    $('tab-feed').innerHTML = html;
  }

  const legacyAppliedKey = r => `jt-applied-${r.pdfId || r.url}`; // ticks from before "I applied" synced
  const GROUPS = [
    ['Best chances', 'Hireability 3.5 or more: apply first.', r => r.hire >= 3.5],
    ['Good shot', 'Hireability 3: worth a tailored application.', r => r.hire >= 3 && r.hire < 3.5],
    ['Stretch', 'You miss a stated requirement. Apply if the role excites you.', r => r.hire >= 2 && r.hire < 3],
    ['Long shot', 'The posting asks for more years than you have. Low odds.', r => r.hire < 2],
  ];
  function closingSoon(r) {
    if (!r.closes) return false;
    return (new Date(r.closes) - new Date(new Date().toISOString().slice(0, 10))) / 86_400_000 <= 2;
  }
  function applyCard(r, i) {
    const done = isApplied(r), key = `a${i}`;
    const meta = [r.posted && `posted ${r.posted}`, r.found && `pulled ${r.found}`, r.years && `asks ${r.years}`, r.archetype].filter(Boolean).map(esc).join(' · ');
    return `<article class="card${done ? ' done' : ''}">
      <p class="co"><span>${esc(r.company)}</span><span>${esc(r.report ? `report ${r.report}` : r.pulled ? 'quick score' : '')}</span></p>
      <h3>${esc(r.title)}</h3>
      <div class="row">
        <span class="badge hire" title="Hireability: your realistic chance of an interview">Hire <b>${esc(r.hire)}</b></span>
        <span class="badge" title="How well the role matches your profile">Fit <b>${esc(r.fit)}</b></span>
        ${r.interested ? '<span class="badge hire">★ Your pick</span>' : ''}
        ${r.pulled && !r.interested ? '<span class="badge">New from pull</span>' : ''}
        ${r.decision ? badge(r.decision) : ''}
        ${r.closes ? `<span class="badge${closingSoon(r) ? ' urgent' : ''}">closes ${esc(r.closes)}</span>` : ''}
        ${liveBadge(r.url)}
        ${teamBadges(r)}
      </div>
      ${cooldownNote(r)}
      ${r.pay && r.pay !== 'not listed' ? `<div class="row"><span class="badge pay">₹ ${esc(r.pay)}</span></div>` : ''}
      ${r.note ? `<p>${esc(r.note)}</p>` : ''}
      ${r.why ? `<p class="why">${esc(r.why)}</p>` : ''}
      <p class="meta">${meta}</p>
      <div class="actions">
        ${isUrl(r.url) ? `<a class="btn primary small" href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">Open posting ↗</a>` : ''}
        ${r.pdfId ? `<button class="btn ghost small" type="button" data-pdf="${esc(r.pdfId)}" data-kind="${esc(r.kind || 'pdfs')}" data-name="${esc(r.pdf)}">Download CV ↓</button>` : `<span class="muted mono">${esc(r.cvNote || 'CV not built yet')}</span>`}
        ${agentButtons(key)}
        <label class="check"><input type="checkbox" data-applied="${i}" ${done ? 'checked' : ''}> I applied</label>
        <button class="btn ghost small" type="button" data-open-reject="${key}">Not for me ✕</button>
        <button class="btn ghost small" type="button" data-closed="${key}" title="The posting is gone or no longer takes applications">Posting closed</button>
      </div>
      ${rejectForm(key)}
      ${otherRoles(r, x => applyCard(x, APPLY.indexOf(x)))}
    </article>`;
  }
  function closedCard(r) {
    const mine = choiceFor(r.url)?.action === 'closed';
    return `<article class="card dim"><p class="co"><span>${esc(r.company)}</span><span>closed</span></p><h3>${esc(r.title)}</h3>
      <p class="why">${esc(goneWhy(r.url))}</p>
      <div class="actions">${isUrl(r.url) ? `<a class="btn ghost small" href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">Open posting ↗</a>` : ''}
      <button class="btn ghost small" type="button" data-reopen-url="${esc(r.url)}">${mine ? 'Undo' : "It's still open"}</button></div></article>`;
  }
  // Every pulled job that passes your filters, plus every job you marked Interested, joins To apply
  // next to the fully evaluated roles. Its score is the pull's quick score from the job description.
  function pulledForApply() {
    const local = new Set((DATA.toApply || []).map(r => r.url));
    const tracked = new Set(DATA.tracker.map(r => `${norm(r.company).split(' ')[0]}|${norm(r.role)}`));
    return (FEED.jobs || []).filter(j => !local.has(j.url) && !tracked.has(`${norm(j.company).split(' ')[0]}|${norm(j.title)}`))
      .map(j => ({ j, s: S.score(j, LEARNED), c: userChoice(j.url) }))
      .filter(({ s, c }) => c?.action === 'like' || (!c && !s.hidden))
      .map(({ j, s, c }) => ({
        company: j.company, title: j.title, url: j.url, location: j.location, jd: j.jd, posted: j.posted, found: j.found, fit: s.fit, hire: s.hire, rank: s.rank, cvVariant: j.cv?.variant,
        archetype: s.archetype, years: j.jd?.years != null ? `${j.jd.years}+ yrs` : '', why: s.why.join(' · '),
        pdfId: j.cv?.id, pdf: j.cv?.name, kind: 'cvs', pulled: true, interested: c?.action === 'like',
        pay: j.jd?.payLpa != null ? `up to ${j.jd.payLpa.toFixed(1)} LPA (listed)` : '',
        cvNote: j.cv ? '' : c?.action === 'like' ? 'CV is being built: ready a few minutes after your choice syncs' : j.cvLater ? 'CV only for the best role here. Press Interested to build one.' : j.cvError ? 'CV failed; retried next pull' : 'CV comes with the next pull',
      }));
  }
  function renderToApply() {
    const all = [...(DATA.toApply || []).filter(r => choiceFor(r.url)?.action !== 'reject'), ...pulledForApply()];
    const closedRoles = all.filter(r => isGone(r.url));
    APPLY = all.filter(r => !isGone(r.url))
      .sort((a, b) => (b.interested ? 1 : 0) - (a.interested ? 1 : 0) || !!lockFor(a) - !!lockFor(b) || b.hire - a.hire || b.fit - a.fit || (a.closes || '9').localeCompare(b.closes || '9'));
    const rankOf = r => (r.interested ? 100 : 0) + Number(r.hire) * Number(r.fit) + (r.jd?.matched?.length || 0) / 100;
    const open = bestPerCompany(APPLY.filter(r => !isApplied(r)), rankOf);
    const marked = APPLY.filter(isApplied);
    $('apply-count').textContent = open.length || '';
    if (!APPLY.length) { $('tab-apply').innerHTML = head('03', 'To apply', 0) + '<p class="empty">Nothing to apply to yet. The next daily run adds roles with a tailored CV.</p>'; return; }
    const cards = list => `<div class="grid">${list.map(r => applyCard(r, APPLY.indexOf(r))).join('')}</div>`;
    let html = head('03', 'To apply', open.length, 'Evaluated roles plus every pulled job that passes your filters. The best role at each company has a one-page CV tailored to it. Read the CV before you send it.');
    const lastCheck = FEED.lastCheckAt;
    html += bestToggle() + `<div class="pull reveal"><button class="btn ghost small" type="button" data-check>Check for closed postings</button>
      <p class="mono muted">${lastCheck ? `Last checked ${esc(ago(lastCheck))}.` : 'Not checked yet.'} Each pull also rechecks. Closed postings leave this list; found one yourself? Press “Posting closed” on its card.</p></div>`;
    const picks = open.filter(r => r.interested);
    if (picks.length) html += head('03.0', 'Your picks', picks.length, 'Jobs you marked Interested.') + cards(picks);
    GROUPS.forEach(([name, hint, test], g) => {
      const rows = open.filter(r => !r.interested && test(r));
      if (rows.length) html += head(`03.${g + 1}`, name, rows.length, hint) + cards(rows);
    });
    if (marked.length) html += `<details class="fold"><summary>Applied (${marked.length})</summary><p class="muted">Each one starts the cooldown for its company. Your teammate sees them on the Team tab.</p>${cards(marked)}</details>`;
    if (closedRoles.length) html += `<details class="fold"><summary>Closed postings (${closedRoles.length})</summary><p class="muted">Removed because the posting is gone or no longer takes applications. If one is still open, press “It's still open”.</p><div class="grid">${closedRoles.map(closedCard).join('')}</div></details>`;
    $('tab-apply').innerHTML = html;
  }

  // ── Other tabs ──────────────────────────────────────────────────────
  function renderKpis() {
    const rows = trackerRows();
    const count = s => rows.filter(r => r.status === s).length;
    const waiting = rows.filter(r => r.status === 'Applied' && /waiting/i.test(r.notes)).length;
    const due = DATA.followups.entries.length;
    const toApply = Number($('apply-count').textContent) || 0;
    const fresh = Number($('feed-count').textContent) || 0;
    const tiles = [
      ['New jobs', fresh, 'to review'], ['To apply', toApply, 'CV ready'], ['Applied', count('Applied'), `${waiting} waiting`],
      ['Interview', count('Interview') + count('Assessment'), 'active'], ['Offers', count('Offer') + count('Hired'), ''],
      ['Rejected', count('Rejected'), ''], ['Follow-ups', due, 'due now', due > 0],
    ];
    $('kpis').innerHTML = tiles.map(([l, n, sub, alert], i) =>
      `<div class="kpi${alert ? ' alert' : ''}"><div class="i">${pad(i + 1)} —</div><div class="n">${n}</div><div class="l">${esc(l)}${sub ? `<small>${esc(sub)}</small>` : ''}</div></div>`).join('');
    const best = toApply ? APPLY.filter(r => r.hire >= 3.5 && !isApplied(r)).length : 0;
    $('hero-line').textContent = best ? `${best} best chance${best === 1 ? '' : 's'} waiting.` : fresh ? `${fresh} new job${fresh === 1 ? '' : 's'} to review.` : 'Apply where you can win.';
  }
  function tableHtml(t) {
    return `<div class="table-wrap"><table><thead><tr>${t.header.map(h => `<th>${md(h)}</th>`).join('')}</tr></thead>
      <tbody>${t.rows.map(r => `<tr>${r.map(c => `<td>${md(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  }
  function dailyHtml(run, idx = '01') {
    if (!run) return '<p class="empty">No daily run yet.</p>';
    let html = head(idx, `Daily run`, null, run.date);
    if (run.answer) html += `<div class="card answer"><div><p class="co"><span>“Why are you seeking new employment?”</span></p><q>${esc(run.answer)}</q></div>
      <button class="btn ghost small" type="button" data-copy="${esc(run.answer)}">Copy</button></div>`;
    run.tables.forEach((t, i) => { html += head(`${idx}.${i + 1}`, t.heading || 'Table', t.rows.length) + tableHtml(t); });
    if (run.notes.length) html += head(`${idx}.${run.tables.length + 1}`, 'Notes', null) + `<div class="grid">${run.notes.map(n => `<div class="card"><p>${md(n)}</p></div>`).join('')}</div>`;
    return html;
  }
  function evalCard(r) {
    return `<article class="card"><p class="co"><span>Report ${esc(r.num)}</span><span>${esc(r.legitimacy || '')}</span></p><h3>${esc(r.title)}</h3>
      <div class="row"><span class="score">${esc(r.score)}</span>${badge(r.decision || '—')}
      ${isUrl(r.url) ? `<a class="btn ghost small" href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">Posting ↗</a>` : ''}</div>
      ${r.verdict ? `<p>${md(r.verdict)}</p>` : ''}</article>`;
  }
  function renderToday() {
    const interviews = trackerRows().filter(r => ['Interview', 'Assessment', 'Offer'].includes(r.status));
    let html = '';
    if (interviews.length) html += head('01', 'Active interviews', interviews.length) + `<div class="grid">${interviews.map(r =>
      `<article class="card"><p class="co"><span>${esc(r.company)}</span><span>#${esc(r.num)}</span></p><h3>${esc(r.role)}</h3><div class="row">${badge(r.status)}</div><p>${esc(r.notes)}</p></article>`).join('')}</div>`;
    // Latest pulls: what the cloud job found in the last 3 days, and how its runs went.
    const pulls = (FEED.runs || []).filter(r => r.mode === 'pull');
    const last = pulls[pulls.length - 1];
    const since = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
    const recentJobs = APPLY.filter(r => r.pulled && (r.found || '') >= since);
    const runLine = last ? `Last pull ${ago(last.at)}: ${last.found} new, ${last.cvs || 0} CVs built${last.errors?.length ? `, ${last.errors.length} boards unreachable` : ''}. Automatic pulls about 06:00 and 18:00 IST.` : 'No pull yet.';
    html += head(interviews.length ? '01.1' : '01', 'Latest pulls', recentJobs.length, runLine);
    html += recentJobs.length ? `<div class="grid">${recentJobs.map(r => applyCard(r, APPLY.indexOf(r))).join('')}</div>`
      : '<p class="empty">No new jobs in the last 3 days passed your filters. Your boards post a few a week; each one lands here and on To apply.</p>';
    if (pulls.length) html += `<details class="fold"><summary>Pull history (${pulls.length})</summary><div class="table-wrap"><table><thead><tr><th>When</th><th>New</th><th>CVs</th><th>Filtered</th><th>Boards unreachable</th></tr></thead><tbody>${
      [...pulls].reverse().map(r => `<tr><td>${esc(new Date(r.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }))}</td><td>${r.found}</td><td>${r.cvs ?? '—'}</td><td>${r.hidden ?? '—'}</td><td>${r.errors?.length || 0}</td></tr>`).join('')}</tbody></table></div></details>`;
    if (ID === 'me') html += dailyHtml(DATA.dailies[0], interviews.length ? '01.2' : '01.1');
    $('tab-today').innerHTML = html;
  }
  function renderFollowups() {
    const today = new Date().toISOString().slice(0, 10);
    const rank = e => (e.status === 'interview' || e.status === 'assessment' ? 0 : 1);
    const items = [...DATA.followups.entries].sort((a, b) => rank(a) - rank(b) || a.daysSinceApplication - b.daysSinceApplication);
    let html = head('04', 'Follow-ups', items.length, 'Tick one once you have followed up today. Ticks stay on this device.');
    if (!items.length) { $('tab-followups').innerHTML = html + '<p class="empty">Nothing due.</p>'; return; }
    html += `<div class="grid">${items.map(e => {
      const key = `jt-fu-${today}-${e.num}`, done = store.get(key) === '1';
      return `<label class="card fu${done ? ' done' : ''}"><input type="checkbox" data-key="${key}" ${done ? 'checked' : ''}>
        <div><p class="co"><span>${esc(e.company)}</span><span>#${e.num}</span></p><h3>${esc(e.role)}</h3>
        <div class="row">${badge(e.status)}<span class="badge${e.urgency === 'overdue' ? ' urgent' : ''}">${esc(e.urgency)}</span></div>
        <p class="meta">applied ${e.daysSinceApplication} days ago · due ${esc(e.nextFollowupDate)} · ${e.followupCount} sent</p></div></label>`;
    }).join('')}</div>`;
    $('tab-followups').innerHTML = html;
  }
  let statusFilter = 'All';
  function renderTracker() {
    const tracker = trackerRows();
    const statuses = ['All', ...new Set(tracker.map(r => r.status))];
    $('status-filter').innerHTML = statuses.map(s => `<button type="button" data-status="${esc(s)}" aria-pressed="${s === statusFilter}">${esc(s)}</button>`).join('');
    const q = $('search').value.trim().toLowerCase();
    const rows = tracker.filter(r => statusFilter === 'All' || r.status === statusFilter)
      .filter(r => !q || `${r.company} ${r.role} ${r.notes}`.toLowerCase().includes(q))
      .sort((a, b) => b.date.localeCompare(a.date) || b.num - a.num);
    $('tracker-list').innerHTML = rows.length ? `<div class="table-wrap"><table class="tracker-table"><thead><tr>
        <th>#</th><th>Date</th><th>Company</th><th>Role</th><th>Score</th><th>Status</th><th>Notes</th></tr></thead><tbody>
        ${rows.map(r => `<tr><td data-label="#">${r.num}</td><td data-label="Date">${esc(r.date)}</td><td data-label="Company"><strong>${esc(r.company)}</strong></td>
          <td data-label="Role">${esc(r.role)}</td><td data-label="Score">${esc(r.score)}</td><td>${badge(r.status)}</td><td data-label="Notes" class="muted">${esc(r.notes)}</td></tr>`).join('')}
        </tbody></table></div>` : '<p class="empty">No rows match.</p>';
  }
  function renderEvals() {
    const list = [...DATA.reports].reverse();
    $('tab-evals').innerHTML = head('06', 'Evaluations', list.length) + (list.length ? `<div class="grid">${list.map(evalCard).join('')}</div>` : '<p class="empty">No evaluations yet.</p>');
  }
  function renderHistory() {
    if (!DATA.dailies.length) { $('tab-history').innerHTML = head('07', 'History', 0) + '<p class="empty">No daily runs yet.</p>'; return; }
    $('tab-history').innerHTML = head('07', 'History', DATA.dailies.length) + `<div class="chips" id="runs">${DATA.dailies.map((d, i) =>
      `<button type="button" data-run="${i}" aria-pressed="${i === 0}">${esc(d.date)}</button>`).join('')}</div><div id="run-body">${dailyHtml(DATA.dailies[0], '07.1')}</div>`;
  }
  // Both people, one company per card, so a referral is easy to spot.
  let teamView = 'all';
  function renderTeam() {
    const tabBtn = document.querySelector('.tabs [data-tab="team"]');
    tabBtn.hidden = !TEAM;
    if (!TEAM) return;
    const seen = new Set();
    const rows = TEAM.entries.filter(e => { const k = `${e.by}|${e.companyKey}|${norm(e.title)}|${e.status}`; if (seen.has(k)) return false; seen.add(k); return teamView === 'all' || e.by === teamView; });
    const groups = new Map();
    for (const e of rows) { if (!groups.has(e.companyKey)) groups.set(e.companyKey, []); groups.get(e.companyKey).push(e); }
    const list = [...groups.values()].map(g => g.sort((a, b) => (b.date || '').localeCompare(a.date || ''))).sort((a, b) => (b[0].date || '').localeCompare(a[0].date || ''));
    const who = e => esc(TEAM.names[e.by] || 'Teammate');
    let html = head('08', 'Team', list.length, 'Who shortlisted and applied where. Both of you at one company? Talk first, and ask about a referral.');
    html += `<div class="chips">${[['all', 'Both of us'], ...Object.entries(TEAM.names)].map(([id, label]) => `<button type="button" data-team-view="${esc(id)}" aria-pressed="${teamView === id}">${esc(label)}</button>`).join('')}</div>`;
    html += list.length ? `<div class="grid">${list.map(g => {
      const both = new Set(g.map(e => e.by)).size > 1;
      return `<article class="card"><p class="co"><span>${esc(g[0].company)}</span><span>${both ? 'both of you' : ''}</span></p>
        <ul class="team-list">${g.map(e => `<li><span class="badge ${e.status === 'applied' ? 'applied' : ''}">${e.status === 'applied' ? 'Applied' : 'Shortlisted'}</span> <b>${who(e)}</b> ${esc(e.title)} ${e.date ? `<span class="muted mono">${esc(e.date)}</span>` : ''}</li>`).join('')}</ul></article>`;
    }).join('')}</div>` : '<p class="empty">Nothing shortlisted or applied yet.</p>';
    $('tab-team').innerHTML = html;
  }
  function renderIdentity() {
    const name = firstName();
    document.title = name ? `${name} · Job Hunt` : 'Job Hunt';
    $('who').textContent = PROFILE?.name || 'Private tracker';
    $('switch-btn').hidden = (window.JOB_PROFILES?.list || []).length < 2;
    for (const tab of ['followups', 'evals', 'history']) document.querySelector(`.tabs [data-tab="${tab}"]`).hidden = ID !== 'me';
  }
  function renderAll() {
    if (!DATA) return;
    renderIdentity(); renderFeed(); renderToApply(); renderKpis(); renderPull(); renderToday(); renderTeam();
    if (ID !== 'me') renderTracker();
    // "Updated" = the newest of the local build and the last cloud pull.
    const stamps = [DATA.builtAt, FEED.updatedAt].filter(Boolean).sort();
    $('built').textContent = stamps.length ? `Updated ${new Date(stamps.pop()).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}` : 'Not pulled yet';
  }
  // Ticks from before "I applied" synced become real entries, once.
  function migrateApplied() {
    for (const r of APPLY) {
      if (store.get(legacyAppliedKey(r)) !== '1') continue;
      if (!isApplied(r)) markApplied(r);
      store.del(legacyAppliedKey(r));
    }
  }
  const emptyData = () => ({ builtAt: null, tracker: [], followups: { entries: [] }, reports: [], dailies: [], toApply: [], pdfSalt: null,
    profile: { name: '', email: '', phone: '', linkedin: '', github: '', location: '', targetRoles: [], skills: [], keywords: [], avoid: [], languages: [], minLpa: 4, maxYears: 3, cooldownDays: 60, hideSenior: true, resumeText: '', answers: { notice: '', currentCtc: '', expectedCtc: '', whyLeaving: '', totalExperience: '', workAuth: '', skillYears: [] } } });
  async function show(id, data, pass, team) {
    ID = id; DATA = data; PASS = pass; TEAM_PASS = team;
    PROFILE = { ...data.profile };
    loadQueue();
    $('lock').hidden = true; $('app').hidden = false;
    recompute();
    renderFollowups(); renderTracker(); renderEvals(); renderHistory(); renderAll();
    if (window.JOB_TEAM && team) { try { TEAM = await decryptEnc(team, window.JOB_TEAM); } catch { /* the refresh below tries again */ } }
    const saved = await loadProfile();
    profileSaved = saved;
    if (saved) clearDraft(); else await restoreDraft();
    if (id === 'me') await loadFeed(window.JOB_FEED);
    await refreshFeed().catch(() => {});
    recompute(); renderAll(); migrateApplied();
    rememberName();
    if (id !== 'me' && !saved) openSettings(true);
    if (!token()) return;
    if (currentRun()) poll().catch(err => setPull(esc(err.message)));
    else if (QUEUE.length) scheduleSync(5000);
  }

  // ── Settings ────────────────────────────────────────────────────────
  const LISTS = { 's-roles': 'targetRoles', 's-skills': 'skills', 's-keywords': 'keywords', 's-avoid': 'avoid', 's-languages': 'languages' };
  const FIELDS = { 's-name': 'name', 's-email': 'email', 's-phone': 'phone', 's-linkedin': 'linkedin', 's-github': 'github', 's-location': 'location', 's-minlpa': 'minLpa', 's-maxyears': 'maxYears', 's-cooldown': 'cooldownDays', 's-resume': 'resumeText' };
  const ANSWERS = { 's-notice': 'notice', 's-ctc': 'currentCtc', 's-expected': 'expectedCtc', 's-why': 'whyLeaving', 's-total': 'totalExperience', 's-auth': 'workAuth' };
  const splitList = v => v.split(/[,\n]/).map(x => x.trim()).filter(Boolean);
  function openSettings(first) {
    const p = PROFILE, a = p.answers || {};
    for (const [el, k] of Object.entries(FIELDS)) $(el).value = p[k] ?? '';
    for (const [el, k] of Object.entries(LISTS)) $(el).value = (p[k] || []).join(', ');
    for (const [el, k] of Object.entries(ANSWERS)) $(el).value = a[k] ?? '';
    $('s-years').value = (a.skillYears || []).join('\n');
    $('s-senior').checked = p.hideSenior !== false;
    $('s-senior-row').hidden = ID === 'me';
    $('s-resume').readOnly = ID === 'me';
    $('s-resume-file-row').hidden = ID === 'me';
    $('s-resume-note').textContent = ID === 'me' ? 'Your resume comes from cv.md, so what the checks compare against stays in one place. Change it there.' : 'Paste it, or load a PDF and check the text it found. Keep the section headings. CVs reorder this text and never add to it.';
    const c = FEED.resumeCheck;
    $('s-check').innerHTML = ID === 'me' || !c ? '' : c.problems.length ? `<b>Resume check:</b> ${c.problems.map(esc).join(' ')}` : `<b>Resume check:</b> read ${c.jobs} job${c.jobs === 1 ? '' : 's'}, ${c.bullets} bullets, ${c.projects} projects, ${c.skills} skill lines.`;
    $('s-title').textContent = first ? 'SET UP YOUR PROFILE' : 'YOUR PROFILE';
    $('s-msg').textContent = '';
    $('settings').showModal();
  }
  // What was typed before the first save survives Connect and a reload. Encrypted like everything else.
  const draftKey = () => forProfile('jt-profile-draft', ID);
  const clearDraft = () => store.del(draftKey());
  const saveDraft = async p => store.set(draftKey(), JSON.stringify(await encryptJson(PASS, p)));
  async function restoreDraft() {
    try { const enc = JSON.parse(store.get(draftKey()) || 'null'); if (enc) PROFILE = { ...PROFILE, ...(await decryptEnc(PASS, enc)) }; }
    catch { clearDraft(); }
  }
  // The first save also starts the first pull: until then there was nothing to match jobs against.
  async function saveProfile(next) {
    const first = !profileSaved;
    await dispatch(first ? 'pull' : 'feedback', next);
    PROFILE = next; pendingProfile = null;
    recompute(); renderAll();
    if ($('settings').open) $('settings').close();
    toast(first ? 'Saved. Your first pull has started: jobs and CVs land here in about 15–30 minutes. You can close this page.'
      : 'Saved. Matching uses it now; the cloud keeps it from the next run, about 3–5 minutes away.', 9000);
  }
  function readSettings() {
    const p = { ...PROFILE, answers: { ...PROFILE.answers } };
    for (const [el, k] of Object.entries(FIELDS)) p[k] = $(el).value.trim();
    for (const k of ['minLpa', 'maxYears', 'cooldownDays']) p[k] = Number(p[k]) || emptyData().profile[k];
    p.cooldownDays = Math.min(60, Math.max(30, p.cooldownDays));
    for (const [el, k] of Object.entries(LISTS)) p[k] = splitList($(el).value);
    for (const [el, k] of Object.entries(ANSWERS)) p.answers[k] = $(el).value.trim();
    p.answers.skillYears = $('s-years').value.split('\n').map(x => x.trim()).filter(Boolean);
    p.hideSenior = ID === 'me' || $('s-senior').checked;
    p.updatedAt = new Date().toISOString();
    return p;
  }
  // PDF text stays in the browser until you save; pdf.js loads only when a PDF is chosen.
  const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174';
  function loadPdfJs() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    return new Promise((ok, fail) => {
      const el = Object.assign(document.createElement('script'), { src: `${PDFJS}/pdf.min.js` });
      el.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = `${PDFJS}/pdf.worker.min.js`; ok(window.pdfjsLib); };
      el.onerror = () => fail(new Error('Could not load the PDF reader.'));
      document.head.appendChild(el);
    });
  }
  async function resumeFromFile(file) {
    if (!/\.pdf$/i.test(file.name)) return file.text();
    const lib = await loadPdfJs();
    const doc = await lib.getDocument({ data: await file.arrayBuffer() }).promise;
    const pages = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const { items } = await (await doc.getPage(n)).getTextContent();
      pages.push(items.map(i => i.str + (i.hasEOL ? '\n' : '')).join(''));
    }
    return pages.join('\n');
  }

  // ── AI Auto-Apply ───────────────────────────────────────────────────
  function agentJob(key) {
    const r = key.startsWith('f') ? FEED_JOBS[Number(key.slice(1))] : APPLY[Number(key.slice(1))];
    return { company: r.company, title: r.title, url: r.url, location: r.location || '', posted: r.posted || '', jd: r.jd,
      cvId: r.cv?.id || r.pdfId, cvName: r.cv?.name || r.pdf || '', cvKind: r.cv ? 'cvs' : r.kind || 'pdfs' };
  }
  async function agentPayload(job) {
    return A.payload({ profile: PROFILE, job: job.cvId ? job : { ...job, cvName: '' }, resumeText: await cvPlainText(job), lock: lockFor(job) });
  }
  let agentUrl = null;
  const FIELD_LABELS = [['candidate.name', 'Name'], ['candidate.email', 'Email'], ['candidate.phone', 'Phone'], ['candidate.linkedin', 'LinkedIn'], ['candidate.github', 'GitHub'], ['candidate.location', 'Location'],
    ['job.applicationUrl', 'Application URL'], ['resume.fileName', 'Resume file'], ['answers.whyThisCompany', 'Why this company (draft)'], ['answers.whyLeavingCurrentRole', 'Why leaving'], ['answers.noticePeriod', 'Notice period'],
    ['answers.currentCtc', 'Current CTC'], ['answers.expectedCtc', 'Expected CTC'], ['answers.totalExperience', 'Total experience'], ['answers.workAuthorization', 'Work authorization']];
  async function openAgent(key) {
    const job = agentJob(key), p = await agentPayload(job);
    const get = path => path.split('.').reduce((o, k) => o?.[k], p);
    $('agent-title').textContent = `${job.title} · ${job.company}`;
    $('agent-warn').innerHTML = p.warnings.map(esc).join(' ');
    $('agent-warn').hidden = !p.warnings.length;
    const years = Object.entries(p.answers.yearsOfExperienceBySkill);
    $('ai-agent-payload').innerHTML = `<script type="application/json" id="ai-agent-json">${JSON.stringify(p).replace(/</g, '\\u003c')}<\/script>
      <dl class="agent-fields">${FIELD_LABELS.map(([path, label]) => `<div><dt>${esc(label)}</dt><dd data-field="${esc(path)}" aria-label="${esc(label)}">${esc(get(path)) || '<span class="muted">not set: the agent asks you</span>'}</dd></div>`).join('')}
      <div><dt>Years by skill</dt><dd data-field="answers.yearsOfExperienceBySkill" aria-label="Years of experience by skill">${years.length ? years.map(([k, v]) => esc(`${k}: ${v}`)).join(' · ') : '<span class="muted">not set: the agent asks you</span>'}</dd></div></dl>`;
    $('agent-prompt').value = A.prompt(p);
    $('agent-resume').value = p.resume.text;
    const link = $('agent-cv');
    link.hidden = true;
    if (agentUrl) URL.revokeObjectURL(agentUrl);
    agentUrl = null;
    $('agent').showModal();
    if (job.cvId) cvBlobUrl(job).then(url => { agentUrl = url; link.href = url; link.download = job.cvName; link.hidden = false; }).catch(() => {});
  }
  // The block holds phone and pay, so it exists only while the dialog is open.
  $('agent').addEventListener('close', () => { $('ai-agent-payload').innerHTML = ''; $('agent-prompt').value = ''; $('agent-resume').value = ''; });
  async function copyPrompt(key, btn) {
    const label = btn.textContent;
    btn.disabled = true; btn.textContent = 'Preparing…';
    try {
      await navigator.clipboard.writeText(A.prompt(await agentPayload(agentJob(key))));
      btn.textContent = 'Copied';
      toast('Agent prompt copied. It fills the form and stops before Submit: you review and submit.');
    } catch { btn.textContent = label; await openAgent(key); }
    btn.disabled = false;
    setTimeout(() => { btn.textContent = label; }, 2500);
  }

  // ── Connect dialog ──────────────────────────────────────────────────
  const tokenUrl = 'https://github.com/settings/personal-access-tokens/new?' + new URLSearchParams({
    name: 'job-tracker pull button', description: 'Starts the Pull jobs workflow and reads feed.enc.js', target_name: 'Farazuddin178',
    expires_in: '90', actions: 'write', contents: 'read',
  });
  $('token-link').href = tokenUrl;
  function openConnect() { $('token').value = ''; $('connect-msg').textContent = token() ? 'Connected on this device.' : ''; $('connect').showModal(); }
  $('connect-btn').addEventListener('click', openConnect);
  $('token-save').addEventListener('click', async () => {
    const t = $('token').value.trim();
    if (!/^(github_pat_|ghp_)[A-Za-z0-9_]{20,}$/.test(t)) { $('connect-msg').textContent = 'That does not look like a GitHub token.'; return; }
    const old = token(); store.set(TOKEN_KEY, t);
    $('connect-msg').textContent = 'Testing…';
    try {
      const r = await gh(`/actions/workflows/${WORKFLOW}`);
      if (!r.ok) throw new Error(`GitHub said ${r.status}.`);
      $('connect-msg').textContent = 'Connected. The first pull also checks the TRACKER_PASSPHRASE secret.';
      renderPull(); refreshFeed().catch(() => {});
      if (pendingProfile) { $('connect-msg').textContent = 'Connected. Saving your profile…'; await saveProfile(pendingProfile); $('connect').close(); }
      else if (QUEUE.length) scheduleSync(3000);
    } catch (err) {
      if (old) store.set(TOKEN_KEY, old); else store.del(TOKEN_KEY);
      $('connect-msg').textContent = err.message;
    }
  });
  $('token-clear').addEventListener('click', () => { store.del(TOKEN_KEY); store.del(forProfile(RUN_KEY, ID)); $('connect-msg').textContent = 'Disconnected. The token is gone from this device.'; renderPull(); });

  // ── Events ──────────────────────────────────────────────────────────
  $('lock-form').addEventListener('submit', async e => {
    e.preventDefault();
    $('lock-error').textContent = '';
    const pass = $('pass').value;
    try {
      if (!window.JOB_DATA) throw new Error('data.enc.js is missing. Run node build.mjs.');
      const who = await openWith(pass);
      if ($('remember').checked) { store.set(forProfile(PASS_KEY, who), pass); rememberName(); }
    } catch (err) {
      $('lock-error').textContent = err.message.includes('data.enc.js') ? err.message : 'Wrong passphrase.';
    }
  });
  // Your passphrase says who you are: whichever profile entry it opens is yours.
  async function openWith(pass) {
    for (const entry of window.JOB_PROFILES?.list || []) {
      let key = null;
      try { key = await decryptEnc(pass, entry.key); } catch { continue; }
      await show(entry.id, entry.id === 'me' ? await decryptEnc(pass, window.JOB_DATA) : emptyData(), pass, key.team);
      return entry.id;
    }
    await show('me', await decryptEnc(pass, window.JOB_DATA), pass, null); // before profiles.js existed
    return 'me';
  }
  // Profiles remembered on this device, for the lock screen.
  const knownProfiles = () => { try { return JSON.parse(store.get(KNOWN_KEY) || '[]'); } catch { return []; } };
  function rememberName() {
    if (!store.get(forProfile(PASS_KEY, ID))) return;
    store.set(KNOWN_KEY, JSON.stringify([...knownProfiles().filter(k => k.id !== ID), { id: ID, name: PROFILE?.name || ID }]));
  }
  $('lock-btn').addEventListener('click', () => {
    store.del(forProfile(PASS_KEY, ID));
    store.set(KNOWN_KEY, JSON.stringify(knownProfiles().filter(k => k.id !== ID)));
    location.reload();
  });
  $('switch-btn').addEventListener('click', () => { try { sessionStorage.setItem('jt-switch', '1'); } catch { /* storage unavailable */ } location.reload(); });
  $('settings-btn').addEventListener('click', () => openSettings(false));
  $('s-resume-file').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    $('s-msg').textContent = 'Reading…';
    try { $('s-resume').value = (await resumeFromFile(file)).trim(); $('s-msg').textContent = 'Check the text, then save.'; }
    catch (err) { $('s-msg').textContent = err.message || 'Could not read that file. Paste the text instead.'; }
  });
  $('s-save').addEventListener('click', async () => {
    if (!$('settings-form').reportValidity()) return;
    const next = readSettings();
    if (ID !== 'me' && (!next.resumeText || !next.targetRoles.length)) { $('s-msg').textContent = 'Add your resume and at least one target role: jobs are matched to them.'; return; }
    await saveDraft(next);
    if (!token()) {
      pendingProfile = next; PROFILE = next; // nothing typed is lost; it saves itself after Connect
      $('settings').close(); openConnect();
      $('connect-msg').textContent = 'Paste the token to finish saving your profile.';
      return;
    }
    $('s-msg').textContent = 'Saving…';
    try { await saveProfile(next); }
    catch (err) { $('s-msg').textContent = err.message; }
  });
  $('pull-btn').addEventListener('click', () => {
    if (ID !== 'me' && !profileSaved) { openSettings(true); return; }
    dispatch('pull').catch(err => setPull(esc(err.message)));
  });
  function selectTab(tab) {
    document.querySelectorAll('.tabs [data-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    document.querySelectorAll('.panel').forEach(p => { p.hidden = p.id !== `tab-${tab}`; });
    $('app').classList.toggle('compact', tab !== 'today');
    if (scrollY > 0) scrollTo({ top: 0, behavior: 'smooth' });
  }
  document.addEventListener('click', e => {
    const tab = e.target.closest('[data-tab]');
    if (tab) { e.preventDefault(); selectTab(tab.dataset.tab); return; }
    const s = e.target.closest('[data-status]');
    if (s) { statusFilter = s.dataset.status; renderTracker(); return; }
    if (e.target.closest('[data-best-only]')) { bestOnly = !bestOnly; store.set(BEST_KEY, bestOnly ? '1' : '0'); renderFeed(); renderToApply(); renderKpis(); return; }
    const tv = e.target.closest('[data-team-view]');
    if (tv) { teamView = tv.dataset.teamView; renderTeam(); return; }
    const ag = e.target.closest('[data-agent]');
    if (ag) { openAgent(ag.dataset.agent).catch(err => toast(esc(err.message))); return; }
    const agc = e.target.closest('[data-agent-copy]');
    if (agc) { copyPrompt(agc.dataset.agentCopy, agc); return; }
    const pc = e.target.closest('[data-copy-from]');
    if (pc) { navigator.clipboard?.writeText($(pc.dataset.copyFrom).value).then(() => { pc.textContent = 'Copied'; }).catch(() => {}); return; }
    const run = e.target.closest('[data-run]');
    if (run) {
      document.querySelectorAll('[data-run]').forEach(b => b.setAttribute('aria-pressed', String(b === run)));
      $('run-body').innerHTML = dailyHtml(DATA.dailies[Number(run.dataset.run)], '07.1');
      return;
    }
    const copy = e.target.closest('[data-copy]');
    if (copy) { navigator.clipboard?.writeText(copy.dataset.copy).then(() => { copy.textContent = 'Copied'; }).catch(() => {}); return; }
    const pdf = e.target.closest('[data-pdf]');
    if (pdf) { downloadPdf(pdf.dataset.pdf, pdf.dataset.name, pdf, pdf.dataset.kind || 'pdfs'); return; }
    const like = e.target.closest('[data-like]');
    if (like) {
      const j = FEED_JOBS[Number(like.dataset.like)];
      addFeedback({ action: 'like', source: 'feed', url: j.url, company: j.company, title: j.title, location: j.location, archetype: j.s.archetype });
      toast(j.cv ? 'Added to To apply · your tailored CV is ready there' : `Added to To apply · ${token() ? 'its CV builds in the cloud and is ready in about 5 minutes' : 'press Connect so the cloud can build its CV'}`);
      scheduleSync(4000);
      return;
    }
    const open = e.target.closest('[data-open-reject]');
    if (open) { openReject = open.dataset.openReject; picked = new Set(); renderFeed(); renderToApply(); focusReject(); return; }
    const reason = e.target.closest('[data-reason]');
    if (reason) {
      const id = reason.dataset.reason;
      if (picked.has(id)) picked.delete(id); else picked.add(id);
      reason.setAttribute('aria-pressed', String(picked.has(id)));
      return;
    }
    if (e.target.closest('[data-cancel]')) { openReject = null; renderFeed(); renderToApply(); return; }
    if (e.target.closest('[data-check]')) {
      if (!token()) { openConnect(); return; }
      dispatch('check').then(() => toast('Checking every posting · closed ones leave To apply in about 5–10 minutes')).catch(err => setPull(esc(err.message)));
      return;
    }
    const closedBtn = e.target.closest('[data-closed]');
    if (closedBtn) {
      const key = closedBtn.dataset.closed;
      const r = key.startsWith('f') ? FEED_JOBS[Number(key.slice(1))] : APPLY[Number(key.slice(1))];
      const f = addFeedback({ action: 'closed', source: key.startsWith('f') ? 'feed' : 'apply', url: r.url, company: r.company, title: r.title, location: r.location || '', report: r.report || undefined, reasons: [] });
      window.__lastReject = f;
      toast(`Marked closed · ${esc(r.company)} left To apply <button type="button" data-undo-last>Undo</button>`);
      return;
    }
    const reopen = e.target.closest('[data-reopen-url]');
    if (reopen) {
      const url = reopen.dataset.reopenUrl, c = choiceFor(url);
      if (c?.action === 'closed') undo(c);
      else {
        const j = (FEED.jobs || []).find(x => x.url === url) || (DATA.toApply || []).find(x => x.url === url) || {};
        addFeedback({ action: 'open', source: 'apply', url, company: j.company || '', title: j.title || '', reasons: [] });
      }
      toast('Back on To apply');
      return;
    }
    const confirm = e.target.closest('[data-confirm]');
    if (confirm) {
      const key = confirm.dataset.confirm, note = confirm.closest('.reject').querySelector('.reject-note')?.value.trim() || '';
      const isFeed = key.startsWith('f');
      const r = isFeed ? FEED_JOBS[Number(key.slice(1))] : APPLY[Number(key.slice(1))];
      const item = isFeed
        ? { action: 'reject', source: 'feed', url: r.url, company: r.company, title: r.title, location: r.location, archetype: r.s.archetype }
        : { action: 'reject', source: 'apply', url: r.url, company: r.company, title: r.title, location: '', archetype: r.archetype?.slice(0, 2) || '', report: r.report || undefined };
      openReject = null;
      const f = addFeedback({ ...item, reasons: [...picked], note });
      window.__lastReject = f;
      toast(`Rejected · ${esc(r.company)} <button type="button" data-undo-last>Undo</button>`);
      return;
    }
    if (e.target.closest('[data-undo-last]')) { if (window.__lastReject) undo(window.__lastReject); $('toast').hidden = true; return; }
    const undoUrl = e.target.closest('[data-undo-url]');
    if (undoUrl) { const f = choiceFor(undoUrl.dataset.undoUrl); if (f) undo(f); }
  });
  function focusReject() { setTimeout(() => document.querySelector('.reject [data-reason]')?.focus(), 0); }
  $('search').addEventListener('input', renderTracker);
  document.addEventListener('change', e => {
    const applied = e.target.dataset?.applied;
    if (applied) {
      const r = APPLY[Number(applied)];
      if (e.target.checked) markApplied(r); else { const f = appliedEntry(r); if (f) undo(f); }
      return;
    }
    const key = e.target.dataset?.key;
    if (!key) return;
    if (e.target.checked) store.set(key, '1'); else store.del(key);
    e.target.closest('.fu').classList.toggle('done', e.target.checked);
  });
  addEventListener('scroll', () => {
    const h = document.documentElement;
    $('progress').style.width = `${Math.min(100, (h.scrollTop / Math.max(1, h.scrollHeight - h.clientHeight)) * 100)}%`;
  }, { passive: true });

  // Auto-unlock when the passphrase was remembered on this device.
  function startup() {
    const known = knownProfiles();
    if (store.get(PASS_KEY) && !known.some(k => k.id === 'me')) known.unshift({ id: 'me', name: 'Saved profile' });
    let switching = false;
    try { switching = !!sessionStorage.getItem('jt-switch'); sessionStorage.removeItem('jt-switch'); } catch { /* storage unavailable */ }
    if (known.length === 1 && !switching) {
      const saved = store.get(forProfile(PASS_KEY, known[0].id));
      if (saved && window.JOB_DATA) openWith(saved).catch(() => store.del(forProfile(PASS_KEY, known[0].id)));
      return;
    }
    $('lock-known').innerHTML = known.map(k => `<button class="btn ghost small" type="button" data-known="${esc(k.id)}">Continue as ${esc(k.name)}</button>`).join('');
    $('lock-known').hidden = !known.length;
  }
  $('lock-known').addEventListener('click', e => {
    const b = e.target.closest('[data-known]');
    if (!b) return;
    const saved = store.get(forProfile(PASS_KEY, b.dataset.known));
    if (saved) openWith(saved).catch(() => { $('lock-error').textContent = 'That saved passphrase no longer works. Type it again.'; });
  });
  startup();
})();
