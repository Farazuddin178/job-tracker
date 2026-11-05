// cloud/profiles.mjs — who can open the site, and how their keys relate.
//
// Each person's passphrase is their login. "me" is the master passphrase (TRACKER_PASSPHRASE); every other
// profile's passphrase and the shared team passphrase are derived from it, so the cloud job can read all
// profiles from that one secret. A derived passphrase opens only its own profile: it can't reach the master.
//
// profiles.js is public and holds opaque ids plus, per profile, the team passphrase encrypted under that
// profile's passphrase. Decrypting an entry is how the page learns who just logged in.
import { createHmac } from 'node:crypto';
import { encryptJson, decryptJson } from './crypto.mjs';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I: this gets read out to a friend
export function derivePass(master, label) {
  const bytes = createHmac('sha256', master).update(label).digest();
  const chars = [...bytes.subarray(0, 24)].map(b => ALPHABET[b % 32]).join('');
  return chars.match(/.{4}/g).join('-');
}
export const teamPass = master => derivePass(master, 'team');
export const profilePass = (master, id) => (id === 'me' ? master : derivePass(master, `profile:${id}`));

export const profileEntry = (master, id) => ({ id, key: encryptJson(profilePass(master, id), { id, team: teamPass(master) }) });
export const profilesScript = list => `window.JOB_PROFILES = ${JSON.stringify({ v: 1, list })};\n`;
export function parseProfiles(text) {
  const m = String(text || '').match(/window\.JOB_PROFILES\s*=\s*(\{[\s\S]*\})\s*;?\s*$/);
  return m ? JSON.parse(m[1]).list : [];
}
// Still readable with this master? False after the passphrase was changed.
export function entryMatches(master, entry) {
  try { return decryptJson(profilePass(master, entry.id), entry.key).id === entry.id; } catch { return false; }
}

export const teamScript = enc => `window.JOB_TEAM = ${JSON.stringify(enc)};\n`;
export function parseTeam(text) {
  const m = String(text || '').match(/window\.JOB_TEAM\s*=\s*(\{[\s\S]*\})\s*;?\s*$/);
  return m ? JSON.parse(m[1]) : null;
}
