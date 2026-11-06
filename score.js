// score.js — quick, explainable job scoring and "learn from my rejections".
// Shared by the page (window.JobScore) and the cloud job (globalThis.JobScore in Node).
// No AI here: keyword rules from the active profile (see prefsFrom) plus what the feedback taught.
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
    // Salesforce LMTS/PMTS/SMTS = lead/principal/senior member of technical staff; Wipro bands L4+ are experienced hires.
    [/\b(lmts|pmts|smts)\b|\bl[4-9]\b/, 'senior level code'],
    [/\b(sales|business development|telecaller|tele ?sales|voice process|bpo|data entry|inside sales)\b/, 'sales / BPO / data entry'],
    [/\b(intern|internship|apprentice)\b/, 'internship'],
    [/\b(accountant|accounts payable|accounts receivable|reconciliation|treasury|fp&a|tax|payroll|credit analyst|loan|grants?)\b/, 'finance-ops'],
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
        for (const t of tokens(f.title)) if (!GENERIC.has(t)) tok[t] = (tok[t] || 0) + 1.5;
        if (f.archetype) arch[f.archetype] = (arch[f.archetype] || 0) + 1.5;
        continue;
      }
      if (f.action !== 'reject') continue;
      rejects++;
      if (reasons.includes('company')) companies[normCompany(f.company)] = f.company;
      if (reasons.includes('location') && f.location) places[cityOf(f.location)] = f.location;
      // The title itself was the problem for these reasons; company/location/pay/duplicate say nothing about
      // the work, and a rejection with no reason (e.g. "their site errored") teaches nothing about titles.
      // Words found in almost every target title (analyst, associate…) never count.
      if (reasons.some(r => ['field', 'senior', 'type', 'other'].includes(r))) {
        for (const t of tokens(f.title)) if (!GENERIC.has(t)) tok[t] = (tok[t] || 0) - 1;
        if (f.archetype && reasons.includes('field')) arch[f.archetype] = (arch[f.archetype] || 0) - 1;
      }
    }
    // A word rejected 3+ times more than it was liked becomes a filter; smaller nets only re-rank.
    const avoid = Object.entries(tok).filter(([t, w]) => w <= -3 && !GENERIC.has(t)).map(([t]) => t).sort();
    const prefer = Object.entries(tok).filter(([t, w]) => w >= 1.5 && !GENERIC.has(t)).map(([t]) => t).sort();
    return { tokens: tok, archetypes: arch, avoid, prefer, companies, places, rejects, likes };
  }

  function score(job, learned, prefs = OWNER) {
    const P = prefs;
    const title = lc(job.title), loc = lc(job.location);
    const why = [];
    for (const [re, label] of P.hard) if (re.test(title)) return { hidden: true, hiddenBy: `rule: ${label}`, fit: 0, hire: 0, rank: 0, why: [label] };
    const banned = P.avoid.find(w => wordRe(w).test(title));
    if (banned) return { hidden: true, hiddenBy: `you avoid "${banned}" roles`, fit: 0, hire: 0, rank: 0, why: [banned] };
    let a = P.arch.find(x => has(title, x.words).length);
    let fit = a ? a.fit : 2.5;
    if (a) why.push(`${a.id}: ${has(title, a.words).map(label).slice(0, 2).join(', ')}`);
    else why.push('no archetype keyword in the title');
    if (a?.id === 'P1' && /\b(sql|data|analytics|technical|engineering)\b/.test(title)) { fit += 0.5; why.push('technical P1 (+)'); }
    let hire = 3;
    if (JUNIOR.some(re => re.test(title))) { hire += 1; why.push('junior / associate level'); }
    else if (HIGH.some(re => re.test(title))) { hire -= 1; why.push('level III+ / consultant: likely 3+ yrs'); }
    else if (MID.some(re => re.test(title))) { hire -= 0.5; why.push('level II: often 2+ yrs'); }
    if (P.home.test(loc)) hire += 0.25;
    else if (/remote/.test(loc) && /india|^remote$/.test(loc)) why.push('remote in India');
    let adj = 0, hiddenBy = null;
    // The job description, when the cloud job could read it (see analyzeJd).
    const jd = job.jd;
    if (jd) {
      hiddenBy = hideFor(jd, P);
      if (jd.years != null) {
        if (jd.years <= 1) { hire = Math.max(hire, 4.5); why.push(`asks ${jd.years} yr${jd.years === 1 ? "" : "s"}`); }
        else if (jd.years === 2) { hire = Math.min(hire, 3); why.push('asks 2 yrs'); }
      }
      if (jd.certs?.length) { hire -= 0.5; why.push(`wants ${jd.certs.join(', ')}`); }
      if (jd.calls) why.push('includes phone calls');
      const m = jd.matched?.length || 0;
      if (m >= 6) { fit += 0.5; why.push(`${m} of your skills in the JD`); }
      else if (m >= 3) { fit += 0.25; why.push(`${m} of your skills in the JD`); }
      else if (m <= 1) { fit -= 0.5; why.push('few of your skills in the JD'); }
      // The base resume against the JD, for a profile with no archetypes written for it.
      if (P.custom && jd.overlap != null) {
        if (jd.overlap >= 40) { fit += 0.5; why.push(`resume matches ${jd.overlap}% of the JD's terms`); }
        else if (jd.overlap < 15) { fit -= 0.5; why.push(`resume matches only ${jd.overlap}% of the JD's terms`); }
      }
    }
    if (learned) {
      const c = normCompany(job.company);
      if (!hiddenBy && learned.companies[c]) hiddenBy = `you rejected ${learned.companies[c]} as a company`;
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

  // Years and pay come from the stored JD facts, so changing them in Settings applies without a new pull.
  function hideFor(jd, P) {
    if (jd.years != null && jd.years >= P.maxYears) return `asks ${jd.years}+ years of experience`;
    if (jd.payLpa != null && jd.payLpa < P.minLpa) return `listed pay tops out at ₹${jd.payLpa.toFixed(1)} LPA, under your ₹${P.minLpa} LPA floor`;
    return jd.hide && !/years of experience|LPA floor/.test(jd.hide) ? jd.hide : null;
  }

  // Read a job description for the hard filters and the score: years asked, listed pay,
  // languages you don't speak, voice/BPO work, required certifications, and which of your skills it names.
  const SKILLS = ['python', 'sql', 'postgresql', 'mysql', 'javascript', 'typescript', 'rest api', 'flask', 'react', 'node.js', 'git',
    'pytorch', 'machine learning', 'splunk', 'wireshark', 'nmap', 'linux', 'windows server', 'investigat', 'fraud', 'escalat', 'sop',
    'sla', 'kyc', 'aml', 'risk', 'compliance', 'data analysis', 'web scraping', 'trust and safety', 'trust & safety', 'payments',
    'anomal', 'automation', '24x7', 'rotational shift', 'hindi', 'urdu', 'telugu', 'cyber', 'security', 'ai coding', 'generative ai'];
  const OTHER_LANGS = 'german|french|spanish|japanese|mandarin|chinese|korean|arabic|portuguese|italian|dutch|russian|tamil|kannada|malayalam|marathi|bengali|gujarati|polish|turkish|thai|vietnamese|indonesian|hebrew|swedish|danish|norwegian|finnish';
  function analyzeJd(text, prefs = OWNER) {
    const P = prefs;
    const t = lc(text).replace(/\s+/g, ' ');
    if (t.length < 200) return null;
    const out = { years: null, payLpa: null, certs: [], matched: [], hide: null };
    if (/\b(fresher|freshers|no prior experience|0 ?- ?1 years?|entry[- ]level)\b/.test(t)) out.years = 0;
    const ys = [];
    for (const m of t.matchAll(/(\d{1,2})(?:\.\d)?\s*\+?\s*(?:-|–|to)?\s*(?:\d{1,2})?\s*\+?\s*(?:years?|yrs?)(?:'|’)?\s*(?:of\s+)?(?:[a-z/&,-]+\s+){0,5}?(?:experience|exp\b)/g)) {
      const n = Number(m[1]); if (n <= 15) ys.push(n);
    }
    if (ys.length) out.years = Math.min(...ys);
    // Pay: "₹4,00,000", "4-6 LPA", "INR 5 lakh", "₹30,000 per month".
    const pays = [];
    for (const m of t.matchAll(/(\d+(?:\.\d+)?)\s*(?:-|–|to)\s*(\d+(?:\.\d+)?)\s*(?:lpa|lakhs?|l\.?p\.?a)/g)) pays.push(Number(m[2]));
    for (const m of t.matchAll(/(\d+(?:\.\d+)?)\s*(?:lpa|lakhs? per annum|lakhs?)/g)) pays.push(Number(m[1]));
    for (const m of t.matchAll(/(?:₹|inr|rs\.?)\s?(\d{1,3}(?:,\d{2,3})+|\d{4,7})(?:\s*(?:-|–|to)\s*(?:₹|inr|rs\.?)?\s?(\d{1,3}(?:,\d{2,3})+|\d{4,7}))?\s*(per month|\/ ?month|monthly|pm\b)?/g)) {
      const hi = Number((m[2] || m[1]).replace(/,/g, ''));
      pays.push(m[3] ? hi * 12 / 1e5 : hi / 1e5);
    }
    const real = pays.filter(p => p >= 0.5 && p <= 100);
    if (real.length) out.payLpa = Math.max(...real);
    const langs = OTHER_LANGS.split('|').filter(l => !P.languages.includes(l)).join('|');
    if (new RegExp(`(fluen|proficien|native|business[- ]level|written and (verbal|spoken))[^.]{0,50}\\b(${langs})\\b|\\b(${langs})\\b[^.]{0,25}(speaker|fluency|is (a )?must|required|mandatory)`).test(t)) out.hide = 'needs a language you don\'t speak';
    else if (!P.custom && /\b(voice process|cold call(ing)?|telecall(ing|er)?|tele ?sales|call cent(er|re)|bpo)\b/.test(t)) out.hide = 'voice / call-centre work';
    else if (!P.custom && /\b(b\.? ?com|commerce graduate|chartered accountant|mba[- ]finance)\b[^.]{0,40}\b(required|must|mandatory)\b/.test(t)) out.hide = 'needs a commerce / finance degree';
    out.hide = hideFor(out, P);
    out.certs = ['cams', 'cfe', 'cissp', 'ceh', 'security+', 'cisa', 'cism', 'oscp'].filter(c => new RegExp(`\\b${escRe(c)}(?![a-z])`).test(t) && new RegExp(`(required|must have|mandatory)[^.]{0,60}\\b${escRe(c)}|\\b${escRe(c)}[^.]{0,40}(required|mandatory)`).test(t)).map(c => c.toUpperCase());
    out.matched = P.skills.filter(s => wordRe(s).test(t));
    out.calls = /\b(inbound|outbound) calls?\b|\bphone calls?\b/.test(t);
    // Worth a look before applying. Shown on the card; none of these hide a job by themselves.
    out.flags = [];
    if (/\b(night|graveyard|us|uk|emea) shifts?\b/.test(t)) out.flags.push('night or overseas shift');
    else if (/\b(rotational|rotating) shifts?\b|\b24 ?[x*/] ?7\b/.test(t)) out.flags.push('rotational shifts');
    if (/\b(work from office|wfo|on-?site only|100% on-?site|5 days (a week )?(from|in|at) (the )?office)\b/.test(t)) out.flags.push('office every day');
    if (/\brelocat(e|ion)\b[^.]{0,40}\b(required|must|mandatory)\b|\b(must|required to|willing(ness)? to) relocate\b/.test(t)) out.flags.push('relocation required');
    if (/\bimmediate joiners?\b|\bjoin(ing)? (immediately|within (15|30) days)\b/.test(t)) out.flags.push('immediate joiner');
    if (/\b(service agreement|employment bond|training bond|service bond)\b/.test(t)) out.flags.push('employment bond');
    if (P.resume.size) {
      const jdTerms = topTerms(t, 40);
      out.overlap = jdTerms.length ? Math.round(jdTerms.filter(w => P.resume.has(w)).length / jdTerms.length * 100) : null;
    }
    return out;
  }

  // The words that say what a text is about: most frequent first, without filler.
  const FILLER = new Set(('about above across after again also among another because been before being between both but can could did does doing during each either every from further have having here into just like made make many may might more most much must need needs not now off once only other our ours out over own per same shall she should some such than that their them then there these they this those through under until upon very was were what when where which while who whom why will with within without work working would year years you your yours able ability across company experience job jobs join looking opportunity people preferred required requirements responsibilities role roles skills strong team teams using well').split(' '));
  function topTerms(text, n = Infinity) {
    const count = {};
    for (const w of lc(text).split(/[^a-z0-9+#.]+/)) {
      const t = w.replace(/\.+$/, '');
      if (t.length >= 3 && !FILLER.has(t) && !/^\d+$/.test(t)) count[t] = (count[t] || 0) + 1;
    }
    return Object.entries(count).sort((a, b) => b[1] - a[1]).slice(0, n).map(([t]) => t);
  }

  // A profile's settings as scoring rules. The owner keeps the rules from modes/_profile.md and adds to
  // them; another profile is built from its target roles, skills and resume alone, because the owner's
  // archetypes and sales/BPO filters say nothing about that person.
  const list = v => (Array.isArray(v) ? v : String(v || '').split(/[,\n]/)).map(x => lc(x).trim()).filter(Boolean);
  function prefsFrom(p, id = 'me') {
    const targets = list(p?.targetRoles), keywords = list(p?.keywords), skills = list(p?.skills);
    const base = { minLpa: Number(p?.minLpa) || 4, maxYears: Number(p?.maxYears) || 3, avoid: list(p?.avoid), languages: list(p?.languages), resume: new Set(topTerms(p?.resumeText || '')) };
    const city = lc(p?.location).split(',')[0].trim();
    const home = city ? new RegExp(escRe(city)) : /hyderabad|telangana/;
    if (id === 'me') return { ...base, custom: false, home: /hyderabad|telangana/, hard: HARD, skills: [...new Set([...SKILLS, ...skills])],
      arch: keywords.length ? [...ARCH, { id: 'K', fit: 4, label: 'Your keywords', words: keywords }] : ARCH };
    return { ...base, custom: true, home, hard: p?.hideSenior === false ? [] : HARD.slice(0, 2), skills,
      arch: [{ id: 'T1', fit: 4.5, label: 'Your target roles', words: [...targets, ...keywords] }, { id: 'T2', fit: 3, label: 'Your skills', words: skills }].filter(a => a.words.length) };
  }
  const OWNER = prefsFrom(null);

  // Best fit per company: only the top role is the recommendation, so nobody fires several tailored
  // resumes at one employer. rows: objects with the given company field; rank(row): higher is better.
  function groupByCompany(rows, rank, company = r => r.company) {
    const groups = new Map();
    for (const row of rows) {
      const k = normCompany(company(row)) || lc(company(row));
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(row);
    }
    return [...groups.values()].map(g => {
      const [best, ...others] = [...g].sort((a, b) => rank(b) - rank(a));
      return { key: normCompany(company(best)), best, others };
    });
  }

  // Applications, from wherever they are recorded: {company, title, date, variant?}.
  // A tracker row is an application from "Applied" on, whatever became of it afterwards.
  const APPLIED_STATES = ['Applied', 'Responded', 'Assessment', 'Interview', 'Offer', 'Hired', 'Rejected'];
  const appliedFromTracker = rows => (rows || []).filter(r => APPLIED_STATES.includes(r.status)).map(r => ({ company: r.company, title: r.role, date: r.date, url: r.url }));
  // Marked on the site. Kept apart from active() so it never replaces "Interested" as the choice on a job.
  function appliedLog(list) {
    const undone = new Set((list || []).filter(f => f.action === 'undo').map(f => f.target));
    return (list || []).filter(f => f.action === 'applied' && !undone.has(f.id)).map(f => ({ id: f.id, company: f.company, title: f.title, date: String(f.date || f.at || '').slice(0, 10), url: f.url, variant: f.variant, report: f.report }));
  }
  // Company key → the latest application still inside the cooldown.
  function companyLocks(applied, days, today = new Date().toISOString().slice(0, 10)) {
    const locks = {};
    for (const a of applied) {
      const when = new Date(a.date);
      if (Number.isNaN(+when)) continue;
      const until = new Date(+when + days * 86_400_000).toISOString().slice(0, 10);
      const k = normCompany(a.company);
      if (until >= today && (!locks[k] || a.date > locks[k].date)) locks[k] = { ...a, until };
    }
    return locks;
  }

  // Feedback as it stands: the latest choice per job, minus anything undone.
  function active(list) {
    const undone = new Set((list || []).filter(f => f.action === 'undo').map(f => f.target));
    const latest = new Map();
    for (const f of list || []) if (!['undo', 'applied'].includes(f.action) && !undone.has(f.id)) latest.set(f.url || f.id, f);
    return [...latest.values()];
  }

  // How old a posting is. Only a real date counts: no date means "unknown", never "old".
  function freshness(job, now = Date.now()) {
    const t = Date.parse(job?.posted || '');
    if (Number.isNaN(t)) return { age: null, band: 'unknown', order: 1, label: 'post date unknown' };
    const age = Math.max(0, Math.floor((now - t) / 86_400_000));
    const when = age === 0 ? 'today' : age === 1 ? 'yesterday' : `${age} days ago`;
    if (age <= 2) return { age, band: 'fresh', order: 0, label: `posted ${when}` };
    if (age <= 7) return { age, band: 'ok', order: 1, label: `posted ${when}` };
    return { age, band: 'old', order: 2, label: `posted ${age} days ago` };
  }
  // A rule of thumb from what is known about the job and you. It stays Low / Medium / High, never a
  // percentage: a percentage needs real outcomes to learn from, and there are none yet.
  const HARD_FLAGS = ['relocation required', 'employment bond'];
  function odds(job, fit, hire, now) {
    const f = freshness(job, now), hard = (job?.jd?.flags || []).filter(x => HARD_FLAGS.includes(x)).length;
    const points = (hire >= 4 ? 2 : hire >= 3 ? 1 : 0) + (fit >= 4 ? 2 : fit >= 3 ? 1 : 0) + (f.band === 'fresh' ? 1 : f.band === 'old' ? -1 : 0) - hard;
    return hire < 2 ? 'Low' : points >= 4 ? 'High' : points >= 2 ? 'Medium' : 'Low';
  }

  const REASONS = [
    ['field', 'Not my kind of work'], ['senior', 'Too senior / too much experience'], ['company', 'Not this company'],
    ['location', 'Wrong location'], ['pay', 'Pay too low'], ['type', 'Sales / voice / BPO'],
    ['dup', 'Already applied / duplicate'], ['other', 'Other'],
  ];

  root.JobScore = { learn, score, tokens, active, analyzeJd, prefsFrom, topTerms, normCompany, groupByCompany, appliedFromTracker, appliedLog, companyLocks, freshness, odds, REASONS, ARCH };
})(typeof window !== 'undefined' ? window : globalThis);
