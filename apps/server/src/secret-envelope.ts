import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1';

/** Context includes the table, record ID, and field; moving ciphertext between records fails. */
export function sealSecret(value: string, key: Buffer, context: string): string {
  if (key.length !== 32 || !context) throw new Error('Invalid secret envelope configuration.');
  const dataKey = randomBytes(32);
  const encrypt = (plaintext: Buffer, encryptionKey: Buffer, purpose: string) => {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', encryptionKey, nonce);
    cipher.setAAD(Buffer.from(`${VERSION}:${context}:${purpose}`, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64url');
  };
  return `${VERSION}.${encrypt(dataKey, key, 'key')}.${encrypt(Buffer.from(value, 'utf8'), dataKey, 'value')}`;
}

export function openSecret(envelope: string, key: Buffer, context: string): string {
  if (key.length !== 32 || !context) throw new Error('Invalid secret envelope configuration.');
  const [version, wrappedKey, payload, extra] = envelope.split('.');
  if (version !== VERSION || !wrappedKey || !payload || extra) throw new Error('Invalid secret envelope.');
  const decrypt = (encoded: string, encryptionKey: Buffer, purpose: string) => {
    const bytes = Buffer.from(encoded, 'base64url');
    if (bytes.length < 28) throw new Error('Invalid secret envelope.');
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(`${VERSION}:${context}:${purpose}`, 'utf8'));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
  };
  const dataKey = decrypt(wrappedKey, key, 'key');
  if (dataKey.length !== 32) throw new Error('Invalid secret envelope.');
  return decrypt(payload, dataKey, 'value').toString('utf8');
}
