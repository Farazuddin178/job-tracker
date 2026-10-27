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

run(process.execPath, ['build.mjs'], { stdio: 'inherit' });
run('git', ['add', 'index.html', 'styles.css', 'app.js', 'build.mjs', 'publish.mjs', 'README.md', '.gitignore', 'data.enc.js']);
const changed = run('git', ['diff', '--cached', '--quiet'], { allowFail: true }).status !== 0;
if (changed) run('git', ['commit', '-m', `Update tracker ${new Date().toISOString().slice(0, 10)}`]);
else console.log('Nothing changed since the last publish.');

const remote = run('git', ['remote'], { allowFail: true }).stdout.trim();
if (process.argv.includes('--no-push') || !remote) {
  console.log(remote ? 'Skipped push (--no-push).' : 'No git remote yet — add one, then run node publish.mjs again.');
} else {
  run('git', ['push', '-u', remote.split('\n')[0], 'HEAD'], { stdio: 'inherit' });
  console.log('Pushed. GitHub Pages updates in a minute or two.');
}
