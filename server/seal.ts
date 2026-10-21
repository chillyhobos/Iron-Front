// Sealing saved online matches: gzip, then AES-256-GCM, which both hides the match
// (no peeking at fogged armies) and signs it (no editing funds). The key comes from
// the SAVE_SECRET environment variable; Render generates one (see render.yaml).
// Without it a fixed development key is used: fine on your own PC, but anyone with
// this code could open those saves.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { gunzipSync, gzipSync } from 'zlib';

const DEV_SECRET = 'iron-front-development-saves';
export const usingDevSecret = !process.env.SAVE_SECRET;
const KEY = createHash('sha256').update(process.env.SAVE_SECRET || DEV_SECRET).digest();

/** Any JSON value → base64 text (12-byte IV, 16-byte tag, then the ciphertext). */
export function seal(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  const body = Buffer.concat([cipher.update(gzipSync(JSON.stringify(value))), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

/** Opens what seal() made. Throws if it was changed or sealed with another key. */
export function unseal(data: string): unknown {
  const raw = Buffer.from(String(data), 'base64');
  if (raw.length < 29) throw new Error('too short');
  const decipher = createDecipheriv('aes-256-gcm', KEY, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  const zipped = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
  return JSON.parse(gunzipSync(zipped).toString('utf8'));
}
