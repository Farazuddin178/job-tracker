#!/usr/bin/env node
// add-profile.mjs — give someone a login to the site (local only; you hold the master passphrase).
//
//   node add-profile.mjs                 # add the next profile (p2, p3 …) and print its passphrase
//   node add-profile.mjs --show p2       # print an existing profile's passphrase again
//   node add-profile.mjs --remove p2     # take a profile off the site (its encrypted files stay in git)
//
// The passphrase is derived from your master passphrase, so no new GitHub secret is needed and the
// cloud job can read that profile. It opens only that profile, never yours. Then run node publish.mjs.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { passphraseFrom } from './cloud/crypto.mjs';
import { parseProfiles, profilesScript, profileEntry, profilePass } from './cloud/profiles.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const master = passphraseFrom(process.env, join(here, '.passphrase'), readFileSync, existsSync);
const file = join(here, 'profiles.js');
let list = existsSync(file) ? parseProfiles(readFileSync(file, 'utf8')) : [];
if (!list.some(p => p.id === 'me')) list.unshift(profileEntry(master, 'me'));

const flag = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const show = flag('--show'), remove = flag('--remove');
if (show) {
  if (!list.some(p => p.id === show) || show === 'me') { console.error(`No profile called ${show}.`); process.exit(1); }
  console.log(profilePass(master, show));
} else if (remove) {
  if (remove === 'me') { console.error('The owner profile cannot be removed.'); process.exit(1); }
  writeFileSync(file, profilesScript(list.filter(p => p.id !== remove)));
  console.log(`Removed ${remove}. Run node publish.mjs.`);
} else {
  const id = `p${Math.max(1, ...list.map(p => Number(p.id.slice(1)) || 1)) + 1}`;
  list.push(profileEntry(master, id));
  writeFileSync(file, profilesScript(list));
  console.log(`Added profile ${id}. Passphrase (give it to them privately):\n\n  ${profilePass(master, id)}\n\nThen run: node publish.mjs`);
}
