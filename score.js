// score.js — quick, explainable job scoring and "learn from my rejections".
// Shared by the page (window.JobScore) and the cloud job (globalThis.JobScore in Node).
// No AI here: keyword rules from modes/_profile.md plus what the feedback taught.
// Full A-H evaluations still happen in the daily career-ops run.
(function (root) {
  const lc = s => String(s || '').toLowerCase();
  // Short keywords match whole words only ("soc" must not hit "associate"); longer ones match word starts ("investigat…").
  const rx = {};
  const escRe = w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const wordRe = w => rx[w] || (rx[w] = new RegExp('\\b' + escRe(w) + (w.length <= 4 ? '\\b' : '')));
  const has = (text, words) => words.filter(w => (w instanceof RegExp ? w : wordRe(w)).test(text));

  // Archetypes, in priority order (modes/_profile.md).
  const ARCH = [
    { id: 'P1', fit: 4.5, label: 'Fraud / risk / compliance / trust & safety', words: [
      'fraud', 'kyc', 'aml', 'cdd', 'anti-money', 'anti money', 'financial crime', 'fincrime', 'transaction monitoring',
      'investigat', 'dispute', 'chargeback', 'trust and safety', 'trust & safety', 'content polic', 'content moderat',
      'risk', 'compliance', 'onboarding', 'sanction', 'abuse', 'enforcement', 'due diligence', 'scaled abuse', 'grc'] },
    { id: 'P2', fit: 4, label: 'Security operations L1 / IAM', words: [
      'soc', 'security analyst', 'security operations', 'threat', 'incident', 'iam', 'identity and access', 'identity & access',
      'cyber', 'information security', 'vulnerability', 'security engineer'] },
    { id: 'P3', fit: 3.5, label: 'Junior software / data / automation', words: [
      'software engineer', 'software developer', 'developer', 'python', 'data analyst', 'data engineer', 'automation', 'integration',
      'machine learning', /\bml\b/, 'genai', /\bai\b/, 'analytics', 'business analyst', 'systems analyst', 'sre', 'site reliability',
      'support engineer', 'technical support', 'qa engineer', 'test engineer', 'full stack', 'front end', 'frontend', 'backend', 'back end'] },
  ];
  // Hard filters (modes/_profile.md): seniority, sales/BPO/voice/data entry, stipend internships.
  const HARD = [
    [/\b(senior|sr\.?|lead|manager|principal|head|director|vp|avp|vice president|architect)\b/, 'senior title'],
    [/\b(sales|business development|telecaller|tele ?sales|voice process|bpo|data entry|inside sales)\b/, 'sales / BPO / data entry'],
    [/\b(intern|internship|apprentice)\b/, 'internship'],
    [/\b(accountant|accounts payable|accounts receivable|reconciliation|treasury|fp&a|tax|payroll|credit analyst|loan)\b/, 'finance-ops'],
  ];
  const JUNIOR = [/\b(associate|junior|jr\.?|trainee|graduate|entry[- ]level|fresher|new grad)\b/, /\b(analyst|engineer|developer|specialist)\s+(i|1)\b/, /\b(l1|level 1|tier 1)\b/];
  const MID = [/\b(ii|2|l2|level 2)\b/];
  const HIGH = [/\b(iii|iv|3|4|l3|level 3|expert|consultant|officer)\b/];
  const STOP = new Set(['and', 'the', 'for', 'with', 'of', 'in', 'to', 'a', 'an', 'at', 'on', '-', '&', 'month', 'months', 'contract', 'india', 'hyderabad', 'remote', 'hybrid', 'team', 'role']);

  // Words in almost every target title: they re-rank but never hide a job on their own.
  const GENERIC = new Set(['analyst', 'specialist', 'associate', 'executive', 'officer', 'junior', 'trainee', 'operations', 'support', 'ii', 'iii', 'l1', 'l2', 'level', 'india', 'global', 'services']);
  const label = w => (w instanceof RegExp ? w.source.replace(/\\b/g, '') : String(w));
  const tokens = title => [...new Set(lc(title).replace(/\(.*?\)/g, ' ').split(/[^a-z0-9+#]+/).filter(t => t.length >= 2 && !STOP.has(t)))];
  const normCompany = s => lc(s).replace(/\b(inc|ltd|llc|limited|private|pvt|corp|corporation|india|technologies|global)\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const cityOf = loc => lc(loc).split(/[,|;/-]/)[0].trim();

  // Learn from feedback: [{action:'reject'|'like', title, company, location, archetype, reasons:[]}]
  function learn(feedback) {
    const tok = {}, arch = {}, companies = {}, places = {};
    let rejects = 0, likes = 0;
    for (const f of feedback || []) {
      const reasons = f.reasons || [];
      if (f.action === 'like') {
        likes++;
        for (const t of tokens(f.title)) tok[t] = (tok[t] || 0) + 1.5;
        if (f.archetype) arch[f.archetype] = (arch[f.archetype] || 0) + 1.5;
        continue;
      }
      if (f.action !== 'reject') continue;
      rejects++;
      if (reasons.includes('company')) companies[normCompany(f.company)] = f.company;
      if (reasons.includes('location') && f.location) places[cityOf(f.location)] = f.location;
      // The title itself was the problem for these reasons; company/location/pay/duplicate say nothing about the work.
      if (!reasons.length || reasons.some(r => ['field', 'senior', 'type', 'other'].includes(r))) {
        for (const t of tokens(f.title)) tok[t] = (tok[t] || 0) - 1;
        if (f.archetype && reasons.includes('field')) arch[f.archetype] = (arch[f.archetype] || 0) - 1;
      }
    }
    // A word rejected 3+ times more than it was liked becomes a filter; smaller nets only re-rank.
    const avoid = Object.entries(tok).filter(([t, w]) => w <= -3 && !GENERIC.has(t)).map(([t]) => t).sort();
    const prefer = Object.entries(tok).filter(([t, w]) => w >= 1.5 && !GENERIC.has(t)).map(([t]) => t).sort();
    return { tokens: tok, archetypes: arch, avoid, prefer, companies, places, rejects, likes };
  }

  function score(job, learned) {
    const title = lc(job.title), loc = lc(job.location);
    const why = [];
    for (const [re, label] of HARD) if (re.test(title)) return { hidden: true, hiddenBy: `rule: ${label}`, fit: 0, hire: 0, rank: 0, why: [label] };
    let a = ARCH.find(x => has(title, x.words).length);
    let fit = a ? a.fit : 2.5;
    if (a) why.push(`${a.id}: ${has(title, a.words).map(label).slice(0, 2).join(', ')}`);
    else why.push('no archetype keyword in the title');
    if (a?.id === 'P1' && /\b(sql|data|analytics|technical|engineering)\b/.test(title)) { fit += 0.5; why.push('technical P1 (+)'); }
    let hire = 3;
    if (JUNIOR.some(re => re.test(title))) { hire += 1; why.push('junior / associate level'); }
    else if (HIGH.some(re => re.test(title))) { hire -= 1; why.push('level III+ / consultant: likely 3+ yrs'); }
    else if (MID.some(re => re.test(title))) { hire -= 0.5; why.push('level II: often 2+ yrs'); }
    if (/hyderabad|telangana/.test(loc)) hire += 0.25;
    else if (/remote/.test(loc) && /india|^remote$/.test(loc)) why.push('remote in India');
    let adj = 0, hiddenBy = null;
    if (learned) {
      const c = normCompany(job.company);
      if (learned.companies[c]) hiddenBy = `you rejected ${learned.companies[c]} as a company`;
      const city = cityOf(job.location);
      if (!hiddenBy && city && learned.places[city]) hiddenBy = `you rejected jobs in ${learned.places[city]}`;
      const ts = tokens(job.title);
      const bad = ts.filter(t => learned.avoid.includes(t));
      const net = ts.reduce((s, t) => s + (learned.tokens[t] || 0), 0);
      if (!hiddenBy && bad.length && net < 0) hiddenBy = `you rejected "${bad.join('", "')}" roles 3+ times`;
      adj = Math.max(-1.5, Math.min(1, net * 0.25));
      if (a && learned.archetypes[a.id]) adj += Math.max(-1, Math.min(0.5, learned.archetypes[a.id] * 0.2));
      if (adj >= 0.25) why.push('like roles you marked interested');
      if (adj <= -0.25) why.push('similar to roles you rejected');
    }
    fit = Math.max(1, Math.min(5, fit + adj));
    hire = Math.max(1, Math.min(5, hire));
    const r = x => Math.round(x * 2) / 2;
    return { hidden: !!hiddenBy, hiddenBy, archetype: a?.id || '—', fit: r(fit), hire: r(hire), rank: Math.round(fit * hire * 10) / 10, why };
  }

  // Feedback as it stands: the latest choice per job, minus anything undone.
  function active(list) {
    const undone = new Set((list || []).filter(f => f.action === 'undo').map(f => f.target));
    const latest = new Map();
    for (const f of list || []) if (f.action !== 'undo' && !undone.has(f.id)) latest.set(f.url || f.id, f);
    return [...latest.values()];
  }

  const REASONS = [
    ['field', 'Not my kind of work'], ['senior', 'Too senior / too much experience'], ['company', 'Not this company'],
    ['location', 'Wrong location'], ['pay', 'Pay too low (under ₹4 LPA)'], ['type', 'Sales / voice / BPO'],
    ['dup', 'Already applied / duplicate'], ['other', 'Other'],
  ];

  root.JobScore = { learn, score, tokens, active, REASONS, ARCH };
})(typeof window !== 'undefined' ? window : globalThis);
