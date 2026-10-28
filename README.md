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

## Change the passphrase

Edit `.passphrase` (12+ characters), then run `node publish.mjs`. Old copies in git history stay readable with the old passphrase, so never reuse a passphrase you use anywhere else.
