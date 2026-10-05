import { constants, publicEncrypt } from 'node:crypto';

/**
 * Wraps a bare base64 key in PEM armour.
 *
 * The OpenAPI portal shows the public key as one long base64 line with no
 * header, which is what most people paste into the environment. Node's
 * `publicEncrypt` wants PEM, so accept either and normalise.
 */
export function toPem(publicKey: string): string {
  const trimmed = publicKey.trim();
  if (trimmed.includes('-----BEGIN')) return trimmed;

  const body = trimmed.replace(/\s+/g, '');
  const lines = body.match(/.{1,64}/g) ?? [];
  return `-----BEGIN PUBLIC KEY-----\n${lines.join('\n')}\n-----END PUBLIC KEY-----\n`;
}

/**
 * Encrypts a credential for the `Authorization: Bearer` header.
 *
 * M-Pesa's OpenAPI uses the same operation twice: the API key is encrypted to
 * fetch a session, and the session id it returns is encrypted again as the
 * bearer for every call after that. RSA with PKCS#1 v1.5 padding is what the
 * gateway decrypts with — not OAEP, which fails with a bare INS-4 and no
 * explanation.
 */
export function encryptForBearer(value: string, publicKey: string): string {
  return publicEncrypt(
    { key: toPem(publicKey), padding: constants.RSA_PKCS1_PADDING },
    Buffer.from(value, 'utf8'),
  ).toString('base64');
}
