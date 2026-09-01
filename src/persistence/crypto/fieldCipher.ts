/**
 * Field-level encryption at the persistence boundary (ARCHITECTURE.md §23).
 *
 * Applied in the mappers so no service or controller ever holds ciphertext, and
 * the logger's redaction of the same field names is independent of it.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface FieldCipher {
  encrypt(plaintext: string): Buffer;
  decrypt(payload: Buffer): string;
}

export function createFieldCipher(key: Buffer): FieldCipher {
  if (key.length !== 32) throw new Error('field cipher key must be 32 bytes');
  return {
    encrypt(plaintext) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGO, key, iv);
      const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), enc]);
    },
    decrypt(payload) {
      const iv = payload.subarray(0, IV_BYTES);
      const tag = payload.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
      const decipher = createDecipheriv(ALGO, key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([
        decipher.update(payload.subarray(IV_BYTES + TAG_BYTES)),
        decipher.final(),
      ]).toString('utf8');
    },
  };
}
