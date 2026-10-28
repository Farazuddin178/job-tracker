// Decrypt data.enc.js in the browser (PBKDF2-SHA256 → AES-256-GCM) and render the tracker.
(() => {
  const $ = id => document.getElementById(id);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* storage unavailable */ } },
  };
  const PASS_KEY = 'jt-pass';
  const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

  async function decrypt(pass) {
    const enc = window.JOB_DATA;
    if (!enc) throw new Error('data.enc.js is missing. Run node build.mjs.');
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: b64(enc.salt), iterations: enc.iterations, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(enc.iv) }, key, b64(enc.data));
    return JSON.parse(new TextDecoder().decode(plain));
  }

  // Escape, then allow **bold** and [text](http-url). Relative links render as plain text.
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const md = s => esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, url) => /^https?:\/\//i.test(url)
      ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>` : text);
  const badge = status => `<span class="badge ${esc(String(status).toLowerCase())}">${esc(status)}</span>`;

  let DATA = null;
  let PASS = null;

  // CV PDFs: pdfs/{id}.js holds AES-GCM ciphertext; the key comes from the passphrase + DATA.pdfSalt.
  let pdfKey = null;
  const pdfScripts = {};
  function pdfKeyFor() {
    if (!pdfKey) pdfKey = crypto.subtle.importKey('raw', new TextEncoder().encode(PASS), 'PBKDF2', false, ['deriveKey'])
      .then(base => crypto.subtle.deriveKey({ name: 'PBKDF2', salt: b64(DATA.pdfSalt), iterations: window.JOB_DATA.iterations, hash: 'SHA-256' },
        base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']));
    return pdfKey;
  }
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
  async function downloadPdf(id, name, btn) {
    const label = btn.textContent;
    btn.disabled = true; btn.textContent = 'Preparing…';
    try {
      const [enc, key] = await Promise.all([loadPdfScript(id), pdfKeyFor()]);
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(enc.iv) }, key, b64(enc.data));
      const url = URL.createObjectURL(new Blob([plain], { type: 'application/pdf' }));
      const a = Object.assign(document.createElement('a'), { href: url, download: name });
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      btn.textContent = label;
    } catch (err) {
      btn.textContent = 'Download failed — retry';
    } finally { btn.disabled = false; }
  }

  function renderKpis() {
    const count = s => DATA.tracker.filter(r => r.status === s).length;
    const waiting = DATA.tracker.filter(r => r.status === 'Applied' && /waiting/i.test(r.notes)).length;
    const due = DATA.followups.entries.length;
    const toApply = (DATA.toApply || []).filter(r => store.get(appliedKey(r)) !== '1').length;
    const tiles = [
      ['To apply', toApply, 'with CV ready'],
      ['Applied', count('Applied'), `${waiting} waiting`],
      ['Interview', count('Interview') + count('Assessment'), 'active'],
      ['Offers', count('Offer') + count('Hired'), ''],
      ['Rejected', count('Rejected'), ''],
      ['Evaluated', count('Evaluated'), 'not applied yet'],
      ['Follow-ups due', due, 'overdue or urgent', due > 0],
    ];
    $('kpis').innerHTML = tiles.map(([l, n, sub, alert]) =>
      `<div class="kpi${alert ? ' alert' : ''}"><div class="n">${n}</div><div class="l">${esc(l)}${sub ? ` · ${esc(sub)}` : ''}</div></div>`).join('');
  }

  function tableHtml(t) {
    return `<div class="table-wrap"><table><thead><tr>${t.header.map(h => `<th>${md(h)}</th>`).join('')}</tr></thead>
      <tbody>${t.rows.map(r => `<tr>${r.map(c => `<td>${md(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  }

  function dailyHtml(run) {
    if (!run) return '<p class="empty">No daily run yet. Run "daily" in career-ops, then rebuild.</p>';
    let html = `<h2>Daily run — ${esc(run.date)}</h2>`;
    if (run.answer) html += `<div class="card answer"><div><strong>“Why are you seeking new employment?”</strong><br>${esc(run.answer)}</div>
      <button class="ghost" data-copy="${esc(run.answer)}">Copy</button></div>`;
    for (const t of run.tables) html += `<h2>${esc(t.heading)}</h2>${tableHtml(t)}`;
    if (run.notes.length) html += `<h2>Notes</h2>${run.notes.map(n => `<div class="card">${md(n)}</div>`).join('')}`;
    return html;
  }

  function renderToday() {
    const run = DATA.dailies[0];
    const interviews = DATA.tracker.filter(r => ['Interview', 'Assessment', 'Offer'].includes(r.status));
    let html = '';
    if (interviews.length) {
      html += '<h2>Active interviews</h2>' + interviews.map(r =>
        `<div class="card"><h3>${esc(r.company)} — ${esc(r.role)}</h3><div class="row">${badge(r.status)}<span class="muted">${esc(r.notes)}</span></div></div>`).join('');
    }
    const apply = DATA.reports.filter(r => /^apply/i.test(r.decision || ''));
    const applied = new Set(DATA.tracker.filter(r => r.report && r.status !== 'Evaluated').map(r => r.report));
    const open = apply.filter(r => !applied.has(r.num));
    if (open.length) {
      html += '<h2>Ready to apply</h2>' + open.map(evalCard).join('');
    }
    html += dailyHtml(run);
    $('tab-today').innerHTML = html;
  }

  // To apply: every confirmed role with a tailored CV, best chance of an interview first.
  const appliedKey = r => `jt-applied-${r.pdfId || r.url}`;
  const GROUPS = [
    ['Best chances', 'Hireability 3.5 or more: apply first.', r => r.hire >= 3.5],
    ['Good shot', 'Hireability 3: worth a tailored application.', r => r.hire >= 3 && r.hire < 3.5],
    ['Stretch', 'Hireability 2–2.5: you miss a stated requirement; apply if the role excites you.', r => r.hire >= 2 && r.hire < 3],
    ['Long shot', 'Hireability 1.5 or less: the posting asks for more years than you have. Low odds.', r => r.hire < 2],
  ];
  function closingSoon(r) {
    if (!r.closes) return false;
    const days = (new Date(r.closes) - new Date(new Date().toISOString().slice(0, 10))) / 86_400_000;
    return days <= 2;
  }
  function applyCard(r) {
    const done = store.get(appliedKey(r)) === '1';
    const meta = [`posted ${r.posted}`, `experience asked: ${r.years}`, r.archetype].filter(Boolean).map(esc).join(' · ');
    return `<div class="card apply${done ? ' done' : ''}">
      <div class="apply-head"><h3>${esc(r.title)}</h3><span class="muted">${esc(r.company)}</span></div>
      <div class="row">
        <span class="badge hire" title="Hireability: your realistic chance of an interview">Hire ${esc(r.hire)}/5</span>
        <span class="badge" title="How well the role matches your profile">Fit ${esc(r.fit)}/5</span>
        ${r.decision ? badge(r.decision) : ''}
        ${r.closes ? `<span class="badge${closingSoon(r) ? ' urgent' : ''}">closes ${esc(r.closes)}</span>` : ''}
        <span class="muted">${meta}</span>
      </div>
      ${r.note ? `<p class="muted">${esc(r.note)}</p>` : ''}
      <div class="actions">
        ${/^https?:\/\//.test(r.url) ? `<a class="btn" href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">Open posting ↗</a>` : ''}
        ${r.pdfId ? `<button class="ghost" data-pdf="${esc(r.pdfId)}" data-name="${esc(r.pdf)}">Download CV (PDF)</button>` : '<span class="muted">CV not built yet</span>'}
        <label class="check"><input type="checkbox" data-applied="${esc(appliedKey(r))}" ${done ? 'checked' : ''}> I applied</label>
      </div>
    </div>`;
  }
  function renderToApply() {
    const list = [...(DATA.toApply || [])].sort((a, b) => b.hire - a.hire || b.fit - a.fit || (a.closes || '9').localeCompare(b.closes || '9'));
    if (!list.length) { $('tab-apply').innerHTML = '<p class="empty">Nothing to apply to yet. Run "daily" in career-ops, then publish.</p>'; return; }
    const open = list.filter(r => store.get(appliedKey(r)) !== '1');
    const marked = list.filter(r => store.get(appliedKey(r)) === '1');
    let html = `<p class="muted">Sorted by hireability (your chance of getting an interview), then fit. Each CV is tailored to that posting and fits one A4 page. Read the CV before you send it.</p>`;
    for (const [name, hint, test] of GROUPS) {
      const rows = open.filter(test);
      if (rows.length) html += `<h2>${esc(name)} <span class="muted">(${rows.length})</span></h2><p class="muted">${esc(hint)}</p>${rows.map(applyCard).join('')}`;
    }
    if (marked.length) html += `<h2>Marked applied on this device <span class="muted">(${marked.length})</span></h2><p class="muted">They leave this list for good once career-ops sees the confirmation email and updates the tracker.</p>${marked.map(applyCard).join('')}`;
    $('tab-apply').innerHTML = html;
  }

  function evalCard(r) {
    return `<div class="card"><h3>${esc(r.title)}</h3>
      <div class="row"><span class="score">${esc(r.score)}</span>${badge(r.decision || '—')}<span class="muted">${esc(r.legitimacy || '')}</span>
      ${r.url && /^https?:\/\//.test(r.url) ? `<a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">Posting</a>` : ''}</div>
      ${r.verdict ? `<p>${md(r.verdict)}</p>` : ''}<p class="muted">Report ${esc(r.file)}</p></div>`;
  }

  function renderFollowups() {
    const today = new Date().toISOString().slice(0, 10);
    // Active processes first, then the freshest applications: a nudge matters most while the req is open.
    const rank = e => (e.status === 'interview' || e.status === 'assessment' ? 0 : 1);
    const items = [...DATA.followups.entries].sort((a, b) => rank(a) - rank(b) || a.daysSinceApplication - b.daysSinceApplication);
    if (!items.length) { $('tab-followups').innerHTML = '<p class="empty">Nothing due. 🎉</p>'; return; }
    $('tab-followups').innerHTML = `<p class="muted">Tick an item once you've followed up today. Ticks stay on this device only; record real follow-ups in career-ops ("followup").</p>` +
      items.map(e => {
        const key = `jt-fu-${today}-${e.num}`;
        const done = store.get(key) === '1';
        return `<label class="card fu${done ? ' done' : ''}"><input type="checkbox" data-key="${key}" ${done ? 'checked' : ''}>
          <div><h3>#${e.num} ${esc(e.company)} — ${esc(e.role)}</h3>
          <div class="row">${badge(e.status)}<span class="badge">${esc(e.urgency)}</span>
          <span class="muted">applied ${e.daysSinceApplication} days ago · follow-up was due ${esc(e.nextFollowupDate)} · ${e.followupCount} sent</span></div></div></label>`;
      }).join('');
  }

  let statusFilter = 'All';
  function renderTracker() {
    const statuses = ['All', ...new Set(DATA.tracker.map(r => r.status))];
    $('status-filter').innerHTML = statuses.map(s => `<button data-status="${esc(s)}" aria-pressed="${s === statusFilter}">${esc(s)}</button>`).join('');
    const q = $('search').value.trim().toLowerCase();
    const rows = DATA.tracker
      .filter(r => statusFilter === 'All' || r.status === statusFilter)
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
    $('tab-evals').innerHTML = list.length ? list.map(evalCard).join('') : '<p class="empty">No evaluations yet.</p>';
  }

  function renderHistory() {
    if (!DATA.dailies.length) { $('tab-history').innerHTML = '<p class="empty">No daily runs yet.</p>'; return; }
    $('tab-history').innerHTML = `<div class="chips" id="runs">${DATA.dailies.map((d, i) =>
      `<button data-run="${i}" aria-pressed="${i === 0}">${esc(d.date)}</button>`).join('')}</div><div id="run-body">${dailyHtml(DATA.dailies[0])}</div>`;
  }

  function show(data, pass) {
    DATA = data;
    PASS = pass;
    $('lock').hidden = true;
    $('app').hidden = false;
    $('built').textContent = `Updated ${new Date(data.builtAt).toLocaleString()}`;
    renderKpis(); renderToday(); renderToApply(); renderFollowups(); renderTracker(); renderEvals(); renderHistory();
  }

  // Events
  $('lock-form').addEventListener('submit', async e => {
    e.preventDefault();
    $('lock-error').textContent = '';
    const pass = $('pass').value;
    try {
      const data = await decrypt(pass);
      if ($('remember').checked) store.set(PASS_KEY, pass);
      show(data, pass);
    } catch (err) {
      $('lock-error').textContent = err.message.includes('data.enc.js') ? err.message : 'Wrong passphrase.';
    }
  });
  $('lock-btn').addEventListener('click', () => { store.del(PASS_KEY); location.reload(); });
  document.querySelector('.tabs').addEventListener('click', e => {
    const tab = e.target.closest('[data-tab]')?.dataset.tab;
    if (!tab) return;
    document.querySelectorAll('.tabs [data-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    document.querySelectorAll('.panel').forEach(p => { p.hidden = p.id !== `tab-${tab}`; });
  });
  $('search').addEventListener('input', renderTracker);
  document.addEventListener('click', e => {
    const s = e.target.closest('[data-status]');
    if (s) { statusFilter = s.dataset.status; renderTracker(); }
    const run = e.target.closest('[data-run]');
    if (run) {
      document.querySelectorAll('[data-run]').forEach(b => b.setAttribute('aria-pressed', String(b === run)));
      $('run-body').innerHTML = dailyHtml(DATA.dailies[Number(run.dataset.run)]);
    }
    const copy = e.target.closest('[data-copy]');
    if (copy) navigator.clipboard?.writeText(copy.dataset.copy).then(() => { copy.textContent = 'Copied'; }).catch(() => {});
    const pdf = e.target.closest('[data-pdf]');
    if (pdf) downloadPdf(pdf.dataset.pdf, pdf.dataset.name, pdf);
  });
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

  // Auto-unlock when the passphrase was remembered on this device.
  const saved = store.get(PASS_KEY);
  if (saved) decrypt(saved).then(data => show(data, saved)).catch(() => store.del(PASS_KEY));
})();
