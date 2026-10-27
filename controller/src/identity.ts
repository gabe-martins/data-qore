import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
const identitySchema = z.object({ email: z.email().max(320), displayName: z.string().trim().min(1).max(255) }).strict();
const unavailable = () => new Error('User identity is unavailable. Check the configured encryption key and migration.');
export const normalizeEmail = (email: string) => email.trim().toLowerCase();
export function identityKey(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error('Configure IDENTITY_ENCRYPTION_KEY with 32 random bytes encoded as base64url.');
  const key = Buffer.from(value, 'base64url');
  if (key.length !== 32 || key.toString('base64url') !== value) throw new Error('Invalid IDENTITY_ENCRYPTION_KEY.');
  return key;
}
export class IdentityCrypto {
  private encryptionKey: Buffer;
  private lookupKey: Buffer;
  readonly keyId: string;
  constructor(value: string) {
    const master = identityKey(value);
    this.encryptionKey = Buffer.from(hkdfSync('sha256', master, 'dataqore.identity.v1', 'aes-256-gcm', 32));
    this.lookupKey = Buffer.from(hkdfSync('sha256', master, 'dataqore.identity.v1', 'email-lookup', 32));
    this.keyId = createHash('sha256').update(master).digest('hex').slice(0, 16);
  }
  lookup(email: string) { return createHmac('sha256', this.lookupKey).update(normalizeEmail(email)).digest('hex'); }
  seal(email: string, displayName: string, id: string = randomUUID()) {
    z.uuid().parse(id);
    const payload = identitySchema.parse({ email: normalizeEmail(email), displayName });
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.encryptionKey, nonce, { authTagLength: 16 });
    cipher.setAAD(Buffer.from(`dataqore/users/${id}/identity/v1`));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
    return { id, emailLookup: this.lookup(payload.email), identityCiphertext: ['dqpii', '1', this.keyId, nonce.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join(':') };
  }
  open<T extends { id: string; emailLookup: string; identityCiphertext: string }>(row: T) {
    try {
      const match = /^dqpii:1:([a-f0-9]{16}):([A-Za-z0-9_-]{16}):([A-Za-z0-9_-]{22}):([A-Za-z0-9_-]{1,8192})$/.exec(row.identityCiphertext);
      if (!match || match[1] !== this.keyId || !/^[a-f0-9]{64}$/.test(row.emailLookup)) throw unavailable();
      const decode = (s: string) => { const b = Buffer.from(s, 'base64url'); if (b.toString('base64url') !== s) throw unavailable(); return b; };
      const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey, decode(match[2]), { authTagLength: 16 });
      decipher.setAAD(Buffer.from(`dataqore/users/${row.id}/identity/v1`)); decipher.setAuthTag(decode(match[3]));
      const payload = identitySchema.parse(JSON.parse(Buffer.concat([decipher.update(decode(match[4])), decipher.final()]).toString('utf8')));
      if (!timingSafeEqual(Buffer.from(this.lookup(payload.email), 'hex'), Buffer.from(row.emailLookup, 'hex'))) throw unavailable();
      return { ...row, ...payload };
    } catch { throw unavailable(); }
  }
}
