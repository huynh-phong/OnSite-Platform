import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const NONCE_BYTES = 12;

/** Binds a ciphertext to the row and field it belongs to, so it cannot be moved elsewhere. */
export interface FieldContext {
  country: string;
  table: string;
  rowId: string;
  field: string;
}

export interface EncryptedField {
  ciphertext: Buffer;
  nonce: Buffer;
  tag: Buffer;
  keyId: string;
}

function aad({ country, table, rowId, field }: FieldContext): Buffer {
  return Buffer.from(`${country}|${table}|${rowId}|${field}`, 'utf8');
}

export function encryptField(plaintext: string, context: FieldContext, key: Buffer, keyId: string): EncryptedField {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, nonce);
  cipher.setAAD(aad(context));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { ciphertext, nonce, tag: cipher.getAuthTag(), keyId };
}

/** Throws if the key, nonce, tag, ciphertext or context do not match. */
export function decryptField(encrypted: EncryptedField, context: FieldContext, key: Buffer): string {
  const decipher = createDecipheriv(ALGORITHM, key, encrypted.nonce);
  decipher.setAAD(aad(context));
  decipher.setAuthTag(encrypted.tag);
  return Buffer.concat([decipher.update(encrypted.ciphertext), decipher.final()]).toString('utf8');
}
