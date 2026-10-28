# Job Search Tracker

A private dashboard for my career-ops job search, hosted on GitHub Pages.

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

The PDF is encrypted into `cvs/{id}.json` and downloads from the job's card. At most 30 CVs are built per run; the rest follow on the next pull.

On the page, **Not for me** asks for a reason, and **Interested** marks a pick. Choices queue on the device and reach the workflow encrypted, as a `feedback` run. `score.js` turns them into rules shared by the page and `sync.mjs`:
- A rejected company or place is hidden.
- A title word rejected 3+ times more than it was liked hides matching jobs. Common words like "analyst" only re-rank.
- Smaller patterns move jobs up or down.

`sync.mjs`, which `publish.mjs` runs first, writes `../career-ops/data/site-feed.json` for the daily run. It also drops rejected roles from the to-apply list, sets a rejected evaluated role to Discarded, and records cloud-found jobs in scan history.

One-time setup:
1. Add the repo secret `TRACKER_PASSPHRASE`, set to the site passphrase.
2. On each device, create a fine-grained token for this repo only, with Actions read/write and Contents read.
3. Paste the token under **Connect**. It is stored in that browser only.

## Change the passphrase

Edit `.passphrase` (12+ characters), update the `TRACKER_PASSPHRASE` repo secret to match, then run `node publish.mjs`. The cloud feed (`feed.enc.js`) is still under the old passphrase, so the next pull can't read it; delete `feed.enc.js`, run `node build.mjs` (it creates an empty one), `git add feed.enc.js`, then publish. Old copies in git history stay readable with the old passphrase, so never reuse a passphrase you use anywhere else.
