import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptField, encryptField, type FieldContext } from '../../src/crypto.js';

const key = randomBytes(32);
const context: FieldContext = { country: 'SE', table: 'sites', rowId: 'SE-SITE-001', field: 'address_enc' };
const plaintext = 'Demo Site 1, Askim, Göteborg';

describe('field encryption', () => {
  it('round-trips and records the key id', () => {
    const encrypted = encryptField(plaintext, context, key, 'se-key-v1');
    expect(encrypted.keyId).toBe('se-key-v1');
    expect(encrypted.nonce).toHaveLength(12);
    expect(encrypted.ciphertext.toString('utf8')).not.toContain('Askim');
    expect(decryptField(encrypted, context, key)).toBe(plaintext);
  });

  it('uses a fresh nonce every time', () => {
    const first = encryptField(plaintext, context, key, 'k');
    const second = encryptField(plaintext, context, key, 'k');
    expect(first.nonce.equals(second.nonce)).toBe(false);
    expect(first.ciphertext.equals(second.ciphertext)).toBe(false);
  });

  it('fails with the wrong key', () => {
    const encrypted = encryptField(plaintext, context, key, 'k');
    expect(() => decryptField(encrypted, context, randomBytes(32))).toThrow();
  });

  it.each([
    ['country', { ...context, country: 'DK' }],
    ['table', { ...context, table: 'customers' }],
    ['row', { ...context, rowId: 'SE-SITE-002' }],
    ['field', { ...context, field: 'contact_enc' }],
  ])('fails when the AAD %s differs', (_part, tampered) => {
    const encrypted = encryptField(plaintext, context, key, 'k');
    expect(() => decryptField(encrypted, tampered, key)).toThrow();
  });

  it('fails when the ciphertext or tag is tampered with', () => {
    const encrypted = encryptField(plaintext, context, key, 'k');
    const badCiphertext = Buffer.from(encrypted.ciphertext);
    badCiphertext[0] = badCiphertext[0]! ^ 0xff;
    expect(() => decryptField({ ...encrypted, ciphertext: badCiphertext }, context, key)).toThrow();
    const badTag = Buffer.from(encrypted.tag);
    badTag[0] = badTag[0]! ^ 0xff;
    expect(() => decryptField({ ...encrypted, tag: badTag }, context, key)).toThrow();
  });
});
