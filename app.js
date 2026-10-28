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
  const PASS_KEY = 'jt-pass', TOKEN_KEY = 'jt-gh-token', QUEUE_KEY = 'jt-fb-queue', RUN_KEY = 'jt-run';
  const REPO = 'Farazuddin178/job-tracker', WORKFLOW = 'pull-jobs.yml';
  const S = window.JobScore;

  // ── Crypto ──────────────────────────────────────────────────────────
  const fromB64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const toB64 = buf => { const b = new Uint8Array(buf); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); };
  const keys = new Map();
  function keyFor(pass, salt, iterations) {
    const id = `${salt}|${iterations}`;
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
  let DATA = null, PASS = null;
  let FEED = { jobs: [], feedback: [], runs: [] };
  let QUEUE = [];
  try { QUEUE = JSON.parse(store.get(QUEUE_KEY) || '[]'); } catch { QUEUE = []; }
  const saveQueue = () => store.set(QUEUE_KEY, JSON.stringify(QUEUE));
  const token = () => store.get(TOKEN_KEY);
  const allFeedback = () => [...(FEED.feedback || []), ...QUEUE];
  let ACTIVE = [], LEARNED = S.learn([]);
  function recompute() { ACTIVE = S.active(allFeedback()); LEARNED = S.learn(ACTIVE); }
  const choiceFor = url => ACTIVE.find(f => f.url === url);

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
  async function downloadPdf(id, name, btn, kind = 'pdfs') {
    const label = btn.innerHTML;
    btn.disabled = true; btn.textContent = 'Preparing…';
    try {
      const [enc, key] = await Promise.all([kind === 'cvs' ? loadCloudCv(id) : loadPdfScript(id), keyFor(PASS, DATA.pdfSalt, window.JOB_DATA.iterations)]);
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
  const currentRun = () => { try { return JSON.parse(store.get(RUN_KEY) || 'null'); } catch { return null; } };

  async function dispatch(mode) {
    if (!token()) { openConnect(); return; }
    clearTimeout(syncTimer);
    const items = QUEUE.slice(0, 400);
    const feedback = items.length ? JSON.stringify(await encryptJson(PASS, { items })) : '';
    const at = Date.now();
    const r = await gh(`/actions/workflows/${WORKFLOW}/dispatches`, { method: 'POST', body: JSON.stringify({ ref: 'main', inputs: { mode, feedback } }) });
    if (r.status !== 204) throw new Error(`GitHub did not start the job (${r.status}).`);
    store.set(RUN_KEY, JSON.stringify({ mode, at }));
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
      if (Date.now() - mark.at > 5 * 60_000) { store.del(RUN_KEY); setPull('GitHub never started the job. Try again in a minute.'); return; }
      schedulePoll(5000); return;
    }
    mark.url = run.html_url; mark.status = run.status;
    store.set(RUN_KEY, JSON.stringify(mark));
    if (run.status !== 'completed') { renderPull(); schedulePoll(mark.mode === 'pull' ? 15000 : 6000); return; }
    store.del(RUN_KEY);
    if (run.conclusion !== 'success') {
      setPull(`The job failed. Most often the <code>TRACKER_PASSPHRASE</code> secret is missing or differs from your passphrase. <a href="${esc(run.html_url)}" target="_blank" rel="noopener noreferrer">See the run ↗</a>`);
      return;
    }
    await refreshFeed();
    const last = (FEED.runs || []).slice(-1)[0];
    if (mark.mode === 'pull') toast(last ? `Pull finished · ${last.found} new job${last.found === 1 ? '' : 's'} · ${last.cvs || 0} CV${last.cvs === 1 ? '' : 's'} ready` : 'Pull finished');
    if (QUEUE.length) scheduleSync(3000);
  }
  async function refreshFeed() {
    if (!token()) return;
    const r = await gh('/contents/feed.enc.js?ref=main', { headers: { Accept: 'application/vnd.github.raw+json' } });
    if (!r.ok) return;
    const text = await r.text();
    const m = text.match(/window\.JOB_FEED\s*=\s*(\{[\s\S]*\})\s*;?\s*$/);
    if (!m) return;
    await loadFeed(JSON.parse(m[1]));
    renderAll();
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
    } else if (!token()) {
      setPull(`Connect once and this button scans your 38 boards in the cloud.${queued}`);
    } else {
      setPull(`Last pull ${ago(FEED.lastPullAt)}${last ? ` · ${last.found} new` : ''} · auto-pull daily 07:00 IST${queued}`);
    }
  }

  // ── Feedback (reject / interested) ──────────────────────────────────
  function addFeedback(item) {
    const f = { id: uid(), at: new Date().toISOString(), ...item };
    QUEUE.push(f); saveQueue(); recompute(); renderAll(); scheduleSync();
    return f;
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
      .map(j => ({ ...j, s: S.score(j, LEARNED), choice: choiceFor(j.url) }));
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
      </div>
      <p class="why">${esc(j.s.hiddenBy && !c ? `Hidden: ${j.s.hiddenBy}` : j.s.why.join(' · '))}</p>
      ${jdRow(j)}
      <p class="meta">${[j.posted && `posted ${j.posted}`, `found ${j.found}`, j.cv && `CV: ${j.cv.variant.replace(/_/g, ' ')} version${j.cv.ats ? ` · ATS ${j.cv.ats}` : ''}`].filter(Boolean).map(esc).join(' · ')}</p>
      <div class="actions">
        ${isUrl(j.url) ? `<a class="btn ${j.cv ? 'primary' : 'ghost'} small" href="${esc(j.url)}" target="_blank" rel="noopener noreferrer">Open posting ↗</a>` : ''}
        ${j.cv ? `<button class="btn ghost small" type="button" data-pdf="${esc(j.cv.id)}" data-kind="cvs" data-name="${esc(j.cv.name)}">Download CV ↓</button>`
          : `<span class="muted mono">${esc(j.cvSkip ? 'No CV: filtered out' : j.cvError ? `CV failed (${j.cvError}); retried next pull` : 'CV comes with the next pull')}</span>`}
        ${c ? `<button class="btn ghost small" type="button" data-undo-url="${esc(j.url)}">Undo</button>`
            : `<button class="btn ghost small" type="button" data-like="${i}">★ Interested</button>
               <button class="btn ghost small" type="button" data-open-reject="${key}">Not for me ✕</button>`}
      </div>
      ${rejectForm(key)}
    </article>`;
  }
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
    const liked = FEED_JOBS.filter(j => j.choice?.action === 'like');
    const open = FEED_JOBS.filter(j => !j.choice && !j.s.hidden).sort((a, b) => b.s.rank - a.s.rank || (b.posted || '').localeCompare(a.posted || ''));
    const hidden = FEED_JOBS.filter(j => !j.choice && j.s.hidden);
    const rejected = FEED_JOBS.filter(j => j.choice?.action === 'reject');
    const idx = j => FEED_JOBS.indexOf(j);
    const cards = list => `<div class="grid">${list.map(j => feedCard(j, idx(j))).join('')}</div>`;
    $('feed-count').textContent = open.length || '';
    let html = head('02', 'New jobs', open.length, 'Fresh from your company boards. Reject what you don\'t want and say why: the list learns, and so does the daily run.');
    html += learnedPanel();
    if (liked.length) html += head('02.1', 'Interested', liked.length, 'The next daily run evaluates these first and builds a tailored CV.') + cards(liked);
    html += open.length ? head('02.2', 'To review', open.length, 'Ranked by fit × hireability, read from each job description (from the title when the description could not be read). Each comes with a tailored one-page CV.') + cards(open)
      : `<p class="empty">${FEED.lastPullAt ? 'Nothing new to review. Pull again later, or wait for the 07:00 auto-pull.' : 'No pull yet. Press “Pull new jobs”.'}</p>`;
    if (hidden.length) html += `<details class="fold"><summary>Hidden by what you taught me (${hidden.length})</summary>${cards(hidden)}</details>`;
    if (rejected.length) html += `<details class="fold"><summary>Rejected (${rejected.length})</summary>${cards(rejected)}</details>`;
    $('tab-feed').innerHTML = html;
  }

  const appliedKey = r => `jt-applied-${r.pdfId || r.url}`;
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
    const done = store.get(appliedKey(r)) === '1', key = `a${i}`;
    const meta = [r.posted && `posted ${r.posted}`, r.years && `asks ${r.years}`, r.archetype].filter(Boolean).map(esc).join(' · ');
    return `<article class="card${done ? ' done' : ''}">
      <p class="co"><span>${esc(r.company)}</span><span>${esc(r.report ? `report ${r.report}` : '')}</span></p>
      <h3>${esc(r.title)}</h3>
      <div class="row">
        <span class="badge hire" title="Hireability: your realistic chance of an interview">Hire <b>${esc(r.hire)}</b></span>
        <span class="badge" title="How well the role matches your profile">Fit <b>${esc(r.fit)}</b></span>
        ${r.decision ? badge(r.decision) : ''}
        ${r.closes ? `<span class="badge${closingSoon(r) ? ' urgent' : ''}">closes ${esc(r.closes)}</span>` : ''}
      </div>
      ${r.pay && r.pay !== 'not listed' ? `<div class="row"><span class="badge pay">₹ ${esc(r.pay)}</span></div>` : ''}
      ${r.note ? `<p>${esc(r.note)}</p>` : ''}
      <p class="meta">${meta}</p>
      <div class="actions">
        ${isUrl(r.url) ? `<a class="btn primary small" href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">Open posting ↗</a>` : ''}
        ${r.pdfId ? `<button class="btn ghost small" type="button" data-pdf="${esc(r.pdfId)}" data-name="${esc(r.pdf)}">Download CV ↓</button>` : '<span class="muted mono">CV not built yet</span>'}
        <label class="check"><input type="checkbox" data-applied="${esc(appliedKey(r))}" ${done ? 'checked' : ''}> I applied</label>
        <button class="btn ghost small" type="button" data-open-reject="${key}">Not for me ✕</button>
      </div>
      ${rejectForm(key)}
    </article>`;
  }
  function renderToApply() {
    APPLY = [...(DATA.toApply || [])].filter(r => choiceFor(r.url)?.action !== 'reject')
      .sort((a, b) => b.hire - a.hire || b.fit - a.fit || (a.closes || '9').localeCompare(b.closes || '9'));
    const open = APPLY.filter(r => store.get(appliedKey(r)) !== '1');
    const marked = APPLY.filter(r => store.get(appliedKey(r)) === '1');
    $('apply-count').textContent = open.length || '';
    if (!APPLY.length) { $('tab-apply').innerHTML = head('03', 'To apply', 0) + '<p class="empty">Nothing to apply to yet. The next daily run adds roles with a tailored CV.</p>'; return; }
    const cards = list => `<div class="grid">${list.map(r => applyCard(r, APPLY.indexOf(r))).join('')}</div>`;
    let html = head('03', 'To apply', open.length, 'Each CV is tailored to that posting and fits one A4 page. Read it before you send it.');
    GROUPS.forEach(([name, hint, test], g) => {
      const rows = open.filter(test);
      if (rows.length) html += head(`03.${g + 1}`, name, rows.length, hint) + cards(rows);
    });
    if (marked.length) html += `<details class="fold"><summary>Marked applied on this device (${marked.length})</summary><p class="muted">They leave for good once career-ops sees the confirmation email.</p>${cards(marked)}</details>`;
    $('tab-apply').innerHTML = html;
  }

  // ── Other tabs ──────────────────────────────────────────────────────
  function renderKpis() {
    const count = s => DATA.tracker.filter(r => r.status === s).length;
    const waiting = DATA.tracker.filter(r => r.status === 'Applied' && /waiting/i.test(r.notes)).length;
    const due = DATA.followups.entries.length;
    const toApply = APPLY.filter(r => store.get(appliedKey(r)) !== '1').length;
    const fresh = FEED_JOBS.filter(j => !j.choice && !j.s.hidden).length;
    const tiles = [
      ['New jobs', fresh, 'to review'], ['To apply', toApply, 'CV ready'], ['Applied', count('Applied'), `${waiting} waiting`],
      ['Interview', count('Interview') + count('Assessment'), 'active'], ['Offers', count('Offer') + count('Hired'), ''],
      ['Rejected', count('Rejected'), ''], ['Follow-ups', due, 'due now', due > 0],
    ];
    $('kpis').innerHTML = tiles.map(([l, n, sub, alert], i) =>
      `<div class="kpi${alert ? ' alert' : ''}"><div class="i">${pad(i + 1)} —</div><div class="n">${n}</div><div class="l">${esc(l)}${sub ? `<small>${esc(sub)}</small>` : ''}</div></div>`).join('');
    const best = toApply ? APPLY.filter(r => r.hire >= 3.5 && store.get(appliedKey(r)) !== '1').length : 0;
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
    const interviews = DATA.tracker.filter(r => ['Interview', 'Assessment', 'Offer'].includes(r.status));
    let html = '';
    if (interviews.length) html += head('01', 'Active interviews', interviews.length) + `<div class="grid">${interviews.map(r =>
      `<article class="card"><p class="co"><span>${esc(r.company)}</span><span>#${esc(r.num)}</span></p><h3>${esc(r.role)}</h3><div class="row">${badge(r.status)}</div><p>${esc(r.notes)}</p></article>`).join('')}</div>`;
    html += dailyHtml(DATA.dailies[0], interviews.length ? '01.1' : '01');
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
    const statuses = ['All', ...new Set(DATA.tracker.map(r => r.status))];
    $('status-filter').innerHTML = statuses.map(s => `<button type="button" data-status="${esc(s)}" aria-pressed="${s === statusFilter}">${esc(s)}</button>`).join('');
    const q = $('search').value.trim().toLowerCase();
    const rows = DATA.tracker.filter(r => statusFilter === 'All' || r.status === statusFilter)
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
  function renderAll() {
    if (!DATA) return;
    renderFeed(); renderToApply(); renderKpis(); renderPull();
  }
  function show(data, pass) {
    DATA = data; PASS = pass;
    $('lock').hidden = true; $('app').hidden = false;
    $('built').textContent = `Updated ${new Date(data.builtAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`;
    recompute();
    renderToday(); renderFollowups(); renderTracker(); renderEvals(); renderHistory(); renderAll();
    loadFeed(window.JOB_FEED).then(renderAll).then(() => {
      if (!token()) return;
      refreshFeed().catch(() => {});
      if (currentRun()) poll().catch(err => setPull(esc(err.message)));
      else if (QUEUE.length) scheduleSync(5000);
    });
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
      renderPull(); refreshFeed().catch(() => {}); if (QUEUE.length) scheduleSync(3000);
    } catch (err) {
      if (old) store.set(TOKEN_KEY, old); else store.del(TOKEN_KEY);
      $('connect-msg').textContent = err.message;
    }
  });
  $('token-clear').addEventListener('click', () => { store.del(TOKEN_KEY); store.del(RUN_KEY); $('connect-msg').textContent = 'Disconnected. The token is gone from this device.'; renderPull(); });

  // ── Events ──────────────────────────────────────────────────────────
  $('lock-form').addEventListener('submit', async e => {
    e.preventDefault();
    $('lock-error').textContent = '';
    const pass = $('pass').value;
    try {
      if (!window.JOB_DATA) throw new Error('data.enc.js is missing. Run node build.mjs.');
      const data = await decryptEnc(pass, window.JOB_DATA);
      if ($('remember').checked) store.set(PASS_KEY, pass);
      show(data, pass);
    } catch (err) {
      $('lock-error').textContent = err.message.includes('data.enc.js') ? err.message : 'Wrong passphrase.';
    }
  });
  $('lock-btn').addEventListener('click', () => { store.del(PASS_KEY); location.reload(); });
  $('pull-btn').addEventListener('click', () => dispatch('pull').catch(err => setPull(esc(err.message))));
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
      toast('Marked interested · the next daily run evaluates it first');
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
      if (e.target.checked) store.set(applied, '1'); else store.del(applied);
      renderToApply(); renderKpis();
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
  const saved = store.get(PASS_KEY);
  if (saved && window.JOB_DATA) decryptEnc(saved, window.JOB_DATA).then(data => show(data, saved)).catch(() => store.del(PASS_KEY));
})();
