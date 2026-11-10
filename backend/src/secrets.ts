// Encryption at rest for credentials the owner enters in settings (tax portal keys, webhook secret).
// Key: HC_SECRET_KEY environment variable (any long random string). Without it a fixed development key
// is used and the settings screen warns the owner.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const DEV_KEY = 'home-care-development-key-do-not-use-in-production';

export const usingDevKey = () => !process.env.HC_SECRET_KEY;
const key = () => createHash('sha256').update(process.env.HC_SECRET_KEY ?? DEV_KEY).digest();

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['enc:v1', iv.toString('base64'), c.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

export function decrypt(stored: string): string {
  if (!stored.startsWith('enc:v1:')) return stored;
  const [, , iv, tag, data] = stored.split(':');
  const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
}

/** What the settings screen may show about a secret. */
export const maskSecret = (v: string) => (v ? { set: true, last4: v.slice(-4) } : { set: false, last4: '' });
