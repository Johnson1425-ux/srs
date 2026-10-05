import { generateKeyPairSync } from 'node:crypto';

/**
 * Configures M-Pesa for the test run without putting key material in the
 * repository: a throwaway RSA key pair is generated per run, which is all the
 * client needs to encrypt a bearer it never sends anywhere real.
 *
 * `MPESA_BASE_URL` points at a host that does not resolve, so a test that
 * forgets to stub `fetch` fails loudly instead of reaching the live gateway.
 *
 * Runs as a vitest setup file, before any suite imports `config/env.ts` — the
 * environment is parsed once, at import, so it has to be in place first.
 */
const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

process.env.MPESA_API_KEY ??= 'test-api-key';
process.env.MPESA_PUBLIC_KEY ??= publicKey
  .export({ type: 'spki', format: 'pem' })
  .toString();
process.env.MPESA_SERVICE_PROVIDER_CODE ??= '000000';
process.env.MPESA_CALLBACK_SECRET ??= 'test-callback-secret';
process.env.MPESA_BASE_URL ??= 'https://mpesa.invalid/stub';
