#!/usr/bin/env node
// publish.mjs — rebuild data.enc.js and push it to GitHub Pages.
//   node publish.mjs            # build, commit, push (if a remote is set)
//   node publish.mjs --no-push  # build and commit only
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const cwd = dirname(fileURLToPath(import.meta.url));
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', ...opts });
  if (r.status !== 0 && !opts.allowFail) {
    console.error(`${cmd} ${args.join(' ')} failed:\n${r.stderr || r.stdout}`);
    process.exit(r.status ?? 1);
  }
  return r;
};

// Pull the cloud job's commits and apply the page's feedback to career-ops first.
run(process.execPath, ['sync.mjs'], { stdio: 'inherit' });
run(process.execPath, ['build.mjs'], { stdio: 'inherit' });
run('git', ['add', 'index.html', 'styles.css', 'app.js', 'build.mjs', 'publish.mjs', 'README.md', '.gitignore', 'data.enc.js', 'score.js', 'sync.mjs', 'fx.js', 'add-profile.mjs', 'agent.js', 'profiles.js', 'favicon.svg', 'site.webmanifest', 'icons']);
run('git', ['add', '-A', 'cloud', '.github']);
if (!run('git', ['ls-files', 'feed.enc.js'], { allowFail: true }).stdout.trim()) run('git', ['add', 'feed.enc.js']); // first run only; the cloud job owns it
run('git', ['add', '-A', 'pdfs']); // encrypted CVs, including removed ones
const changed = run('git', ['diff', '--cached', '--quiet'], { allowFail: true }).status !== 0;
if (changed) run('git', ['commit', '-m', `Update tracker ${new Date().toISOString().slice(0, 10)}`]);
else console.log('Nothing changed since the last publish.');

const remote = run('git', ['remote'], { allowFail: true }).stdout.trim();
if (process.argv.includes('--no-push') || !remote) {
  console.log(remote ? 'Skipped push (--no-push).' : 'No git remote yet — add one, then run node publish.mjs again.');
} else {
  run('git', ['pull', '-q', '--rebase'], { allowFail: true }); // the cloud job may have pushed meanwhile
  run('git', ['push', '-u', remote.split('\n')[0], 'HEAD'], { stdio: 'inherit' });
  console.log('Pushed. Waiting for GitHub Pages to deploy…');
  await confirmDeploy(remote.split('\n')[0]);
}

// GitHub Pages refuses a deploy while another is in progress (the cloud job's push can land
// seconds before ours), leaving the site on the older commit. Watch the deploy for HEAD and,
// if it fails, push an empty commit to trigger a fresh one.
async function confirmDeploy(remoteName) {
  const url = run('git', ['remote', 'get-url', remoteName]).stdout.trim();
  const m = url.match(/github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/);
  if (!m || typeof fetch !== 'function') return;
  const api = `https://api.github.com/repos/${m[1]}/${m[2]}/actions/runs?per_page=10`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const sha = run('git', ['rev-parse', 'HEAD']).stdout.trim();
    let result = null;
    for (let i = 0; i < 40 && !result; i++) { // up to ~10 minutes
      await new Promise(r => setTimeout(r, 15000));
      try {
        const res = await fetch(api, { headers: { Accept: 'application/vnd.github+json' } });
        if (!res.ok) continue;
        const pages = (await res.json()).workflow_runs
          .find(r => r.head_sha === sha && r.name === 'pages build and deployment');
        if (pages?.status === 'completed') result = pages.conclusion;
      } catch { /* offline for a moment; keep polling */ }
    }
    if (result === 'success') return console.log('Site updated.');
    if (!result) return console.log('Could not confirm the Pages deploy; check the Actions tab if the site looks old.');
    console.log(`Pages deploy ${result} (usually another deploy was running); retrying (${attempt}/3)…`);
    run('git', ['commit', '--allow-empty', '-m', 'Redeploy site']);
    run('git', ['pull', '-q', '--rebase'], { allowFail: true });
    run('git', ['push', remoteName, 'HEAD'], { stdio: 'inherit' });
  }
  console.log('Pages deploy kept failing; check the Actions tab.');
}
