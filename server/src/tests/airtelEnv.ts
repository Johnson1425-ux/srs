/**
 * Configures Airtel Money for the test run.
 *
 * Nothing secret is needed: Airtel authenticates with an OAuth2 client id and
 * secret rather than a key pair, and the client never sends them anywhere real
 * because `AIRTEL_BASE_URL` points at a host that does not resolve. A test
 * that forgets to stub `fetch` fails loudly instead of reaching the sandbox.
 *
 * Runs as a vitest setup file, before any suite imports `config/env.ts` — the
 * environment is parsed once, at import, so it has to be in place first.
 */
process.env.AIRTEL_CLIENT_ID ??= 'test-airtel-client';
process.env.AIRTEL_CLIENT_SECRET ??= 'test-airtel-secret';
process.env.AIRTEL_CALLBACK_SECRET ??= 'test-airtel-callback-secret';
process.env.AIRTEL_BASE_URL ??= 'https://airtel.invalid/stub';
