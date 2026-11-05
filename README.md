# Job Search Tracker

A private dashboard for a job search shared by two people, hosted on GitHub Pages. It runs on my career-ops setup.

All data is encrypted (AES-256-GCM, key from a passphrase via PBKDF2-SHA256, 310,000 iterations) before it is committed. The repo holds only `data.enc.js`; without the passphrase the page shows a password box and nothing else.

## Daily update

```
node publish.mjs
```

This reads `../career-ops` (tracker, follow-ups, evaluation reports, `output/*/daily-*.md`), encrypts it with the passphrase in `.passphrase` (never committed), commits, and pushes.

## To apply tab and CV downloads

Roles come from `../career-ops/data/to-apply.json`; a role leaves the list once the tracker shows it past "Evaluated". Each role's one-page CV PDF (found under `../career-ops/output/*/`) is encrypted into `pdfs/{id}.js` with a key from the same passphrase and a salt kept in `.pdf-salt` (never committed). File names are opaque, so the public repo doesn't reveal which companies you're applying to. Unchanged PDFs are not re-encrypted (`.pdf-cache.json`).

## Pull new jobs (cloud) and learning from rejections

The **Pull new jobs** button starts `.github/workflows/pull-jobs.yml` (also runs daily at 07:00 IST). The workflow checks out the public career-ops scanner at the version in `cloud/career-ops-ref`. It decrypts `cloud/input.enc.json` (portals, profile, tracker, pipeline, blacklist and seen scan history, written by `build.mjs`) and runs `scan.mjs` against it, with zero AI tokens. It then adds new jobs to `feed.enc.js`. Everything stays encrypted, and the public log prints counts only.

For every new job, the pull also does three things:
- **Reads the job description** through the ATS API (`fetch-jd.mjs`).
- **Scores it** with `score.js` `analyzeJd`: years asked, listed pay, required languages and certifications, and which of your skills it names. The hard filters apply: 3+ years, pay under ₹4 LPA, a language you don't speak, voice/BPO work.
- **Builds a tailored one-page CV** with `cloud/cv.mjs`. It starts from the encrypted CV kit (`data/cv-kit.json`, built only from `cv.md` facts) and runs the career-ops gates: title check, structure, fact gate against `cv.md`, A4 `--strict-pages` PDF, ATS check.

The PDF and its plain text are encrypted into `cvs/{id}.json` and download from the job's card. Only each company's best role gets a CV, plus anything marked Interested. At most 30 CVs are built per person per run; the rest follow on the next pull.

**Closed postings.** Every pull, and the **Check for closed postings** button (workflow mode `check`, about 2 minutes), runs career-ops `check-liveness.mjs` on every job that can reach To apply: pulled jobs and the evaluated roles in `data/to-apply.json`. It asks the board's API first and loads the page only when it must.
- **Closed:** only on clear evidence (404/410, "posting withdrawn", "no longer available"). The posting moves to a **Closed postings** fold.
- **Unreadable:** the posting stays listed with a "couldn't confirm it's open" badge.
- **Posting closed** on a card marks one closed by hand. **It's still open** undoes either kind.
- **Locally,** `sync.mjs` drops closed roles from `data/to-apply.json`. It sets an evaluated role still at "Evaluated" to Discarded ("posting closed"). It records the URL in scan history as `skipped_expired`, so no scan brings it back.

On the page, **Not for me** asks for a reason, and **Interested** marks a pick. Choices queue on the device and reach the workflow encrypted, as a `feedback` run. `score.js` turns them into rules shared by the page and `sync.mjs`:
- A rejected company or place is hidden.
- A title word rejected 3+ times more than it was liked hides matching jobs. Common words like "analyst" only re-rank.
- Smaller patterns move jobs up or down.

`sync.mjs`, which `publish.mjs` runs first, writes `../career-ops/data/site-feed.json` for the daily run. It also drops rejected roles from the to-apply list, sets a rejected evaluated role to Discarded, and records cloud-found jobs in scan history.

One-time setup:
1. Add the repo secret `TRACKER_PASSPHRASE`, set to the site passphrase.
2. On each device, create a fine-grained token for this repo only, with Actions read/write and Contents read.
3. Paste the token under **Connect**. It is stored in that browser only.

## Profiles

A passphrase is a login: whichever entry in `profiles.js` it opens says who you are.

To add someone:
1. Run `node add-profile.mjs`. It prints their passphrase once (`--show p2` prints it again).
2. Run `node publish.mjs`.
3. Give them the passphrase, the site link and a GitHub token (see one-time setup) privately. A fine-grained token can only be created for the creator's own repos, so make it yourself. It can start the workflow, and can't decrypt anything.
4. They open **Settings**, fill it in and paste or upload their resume. The next pull is theirs too.

How the data is split:
- `feed.enc.js` and `data.enc.js` are the owner's. Other profiles live in `profiles/{id}/`, encrypted under their own passphrase, and CVs in `cvs/` under a key from it.
- `team.enc.js` is the shared view, written by the cloud job: who shortlisted or applied where (company, title, link, date, status). Nothing else about either person is in it.
- A derived passphrase opens only its own profile and the shared view. The master can derive every other passphrase, so the owner could read a friend's data. That protection is against outsiders, not against the repo owner.

Matching is per profile. `score.js` `prefsFrom` turns Settings into rules. The owner keeps the rules from `modes/_profile.md` and Settings adds to them. Another profile is scored only on their target roles, skills, keywords and resume. Everyone shares one scan of the owner's boards with all target titles added to the filter, and each person gets only the jobs matching their own titles. Location rules in `portals.yml` also apply to everyone.

Another profile's CV comes from `cloud/resume.mjs`. It parses their resume into the career-ops CV shape, then for each job reorders bullets, projects and skills by the job description and drops the least relevant lines if the page overflows. It never adds words, and the same gates run as for the owner. The Settings dialog shows what the parser read.

### What each profile gets

- **Jobs:** one shared scan of the company boards. Each person's list is filtered to their own target roles and job locations (their home city and remote in India when Job locations is empty), so a place only one person asked for never reaches the other.
- **Tailored CVs:** from their base resume, reordered and never added to. Settings checks the resume as soon as it is pasted or loaded (PDF, Word or text) and says what it could read.
- **Email:** their own jobs, sent through the Gmail app password to the address in their own saved profile. Nobody else receives it, and nothing goes to employers.

## Company guardrails

- **Best fit per company** (on by default, toggle on New jobs and To apply): each company shows its top role by fit × hireability; the others sit under "View X other roles at this company".
- **Cooldown:** after you apply, a company stays flagged for 60 days (30–60 in Settings), from tracker rows at Applied or later and from **I applied** on the site. New roles there show "Already applied to [Role] at [Company] on [Date]" and sort last.
- **Same story:** while the owner's cooldown runs, any CV for that company keeps the kit variant already sent. CVs that differ are rebuilt on the next pull. Another profile has one resume, so it can't contradict itself.

**I applied** syncs through the feed, so it reaches every device and the Team tab. On a role with a report, `sync.mjs` sets the tracker to Applied.

## AI Auto-Apply

Each card has **AI Auto-Apply** and **Copy Agent Prompt**, built by `agent.js` after unlock.

- The dialog holds `#ai-agent-payload`: a `<script type="application/json" id="ai-agent-json">` block plus labelled `<dd data-field="…">` fields, the resume download and the plain-text resume. It holds phone and pay, so it exists in the page only while the dialog is open.
- Answers come only from Settings (for the owner, `application_answers` in `config/profile.yml`). An empty one is listed as `unanswered`, and the agent asks.
- "Why this company?" is a draft from skills found in both the job description and the resume, leaving out anything marked as learning.
- **The agent fills the form and stops before Submit.** The person reviews it and clicks Submit. Text on the page counts as information, never as instructions to the agent.

## Change the passphrase

Edit `.passphrase` (12+ characters), update the `TRACKER_PASSPHRASE` repo secret to match, then run `node publish.mjs`. Every other profile's passphrase changes with it, and their files can't be read until they're re-encrypted, so avoid this once someone else is using the site. The cloud feed (`feed.enc.js`) is still under the old passphrase, so the next pull can't read it; delete `feed.enc.js`, run `node build.mjs` (it creates an empty one), `git add feed.enc.js`, then publish. Old copies in git history stay readable with the old passphrase, so never reuse a passphrase you use anywhere else.
