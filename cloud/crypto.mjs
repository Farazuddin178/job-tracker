// crypto.mjs — the one encryption format this repo uses (AES-256-GCM, key from PBKDF2-SHA256).
// The page decrypts the same shape with WebCrypto, so keep the two in step.
import { randomBytes, pbkdf2Sync, createCipheriv, createDecipheriv } from 'node:crypto';

export const ITERATIONS = 310_000;

export function encryptJson(pass, value) {
  const salt = randomBytes(16), iv = randomBytes(12);
  const key = pbkdf2Sync(pass, salt, ITERATIONS, 32, 'sha256');
  const c = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(JSON.stringify(value), 'utf8'), c.final(), c.getAuthTag()]);
  return { v: 1, iterations: ITERATIONS, salt: salt.toString('base64'), iv: iv.toString('base64'), data: data.toString('base64') };
}

export function decryptJson(pass, enc) {
  const key = pbkdf2Sync(pass, Buffer.from(enc.salt, 'base64'), enc.iterations || ITERATIONS, 32, 'sha256');
  const raw = Buffer.from(enc.data, 'base64');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(enc.iv, 'base64'));
  d.setAuthTag(raw.subarray(raw.length - 16));
  return JSON.parse(Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()]).toString('utf8'));
}

// feed.enc.js is a script the page loads: `window.JOB_FEED = {...};`
export const feedScript = enc => `window.JOB_FEED = ${JSON.stringify(enc)};\n`;
export function parseFeedScript(text) {
  const m = String(text || '').match(/window\.JOB_FEED\s*=\s*(\{[\s\S]*\})\s*;?\s*$/);
  return m ? JSON.parse(m[1]) : null;
}

export function passphraseFrom(env, file, readFileSync, existsSync) {
  const p = (env.TRACKER_PASSPHRASE || env.JOB_SITE_PASSPHRASE || (file && existsSync(file) ? readFileSync(file, 'utf8') : '')).trim();
  if (p.length < 12) throw new Error('No passphrase: set TRACKER_PASSPHRASE (cloud) or create .passphrase (local).');
  return p;
}
