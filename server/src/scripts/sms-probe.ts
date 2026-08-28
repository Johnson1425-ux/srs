/**
 * Sends one message through the configured SMS gateway and prints the whole
 * exchange — the URL, the headers, the body sent, and the raw reply.
 *
 * A gateway that answers `HTTP 500: Invalid Request` tells a school nothing
 * about which part it objected to, and the outbox only ever shows the reply.
 * This shows both halves, so the difference between a wrong sender ID, a
 * rejected number and a malformed body is visible in one run.
 *
 *   npm run sms:probe -- 0754123456
 *
 * Nothing is delivered and no credit is spent unless --live is passed, so this
 * is safe to run against a production account while hunting a rejection.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { env, smsConfigured } from '../config/env.js';
import { normalizePhone } from '../modules/communication/message.service.js';

const REDACTED = (value: string) => {
  const [scheme, token] = value.split(' ');
  if (!token) return '<hidden>';
  return `${scheme} ${token.slice(0, 4)}...${token.slice(-2)} (${token.length} chars)`;
};

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const recipient = args.find((a) => !a.startsWith('--'));
  const live = args.includes('--live');

  if (!recipient) {
    console.error('Usage: npm run sms:probe -- 0754123456 [--live]');
    process.exitCode = 1;
    return;
  }

  // Settings are read from the .env of the working directory, so running this
  // from the wrong folder reports "not configured" while the server itself
  // sends happily. Say which file was read rather than leaving that a mystery.
  const envFile = resolve(process.cwd(), '.env');
  console.log(`Settings:   ${existsSync(envFile) ? envFile : `no .env in ${process.cwd()}`}`);
  console.log(`Provider:   ${env.SMS_PROVIDER}`);

  if (!smsConfigured) {
    console.error(
      '\nThis provider is not configured, so nothing would be sent.\n' +
        'Either the settings above are not the ones your server uses — run this\n' +
        'from the same folder — or SMS_PROVIDER and its credentials are unset.',
    );
    process.exitCode = 1;
    return;
  }

  if (env.SMS_PROVIDER !== 'nextsms') {
    console.error(`\nThis probe only covers NextSMS so far, not ${env.SMS_PROVIDER}.`);
    process.exitCode = 1;
    return;
  }

  // Validated but not delivered unless --live is asked for explicitly. A
  // diagnostic that texts a parent and spends credit every time it runs is one
  // people hesitate to run, which defeats the point of having it.
  const testMode = !live;
  const base = (env.NEXTSMS_BASE_URL ?? 'https://messaging-service.co.tz/api/sms/v1').replace(
    /\/+$/,
    '',
  );
  const url = `${base}${testMode ? '/test' : ''}/text/single`;

  // Built the same way the provider builds it, so the probe cannot pass while
  // the real sends fail.
  const { authorizationHeader } = await import('../modules/communication/providers/nextsms.js');
  const authorization = authorizationHeader(
    env.NEXTSMS_AUTH_TOKEN,
    env.NEXTSMS_USERNAME ?? '',
    env.NEXTSMS_PASSWORD ?? '',
  );

  const to = normalizePhone(recipient).replace(/\D/g, '');
  const from = env.SMS_SENDER_ID.trim() || undefined;
  const body = { from, to, text: 'Test message from the school management system.' };

  console.log(`Mode:       ${testMode ? 'test — validated, not delivered, not billed' : 'LIVE'}`);
  console.log(`URL:        POST ${url}`);
  console.log(`Auth:       ${REDACTED(authorization)}`);
  console.log(`Sender ID:  ${from ?? '(none — the account default applies)'}`);
  console.log(`Recipient:  ${recipient} normalised to ${to}`);
  console.log(`Body sent:  ${JSON.stringify(body)}`);
  console.log('');

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    console.error(`Could not reach the gateway: ${err instanceof Error ? err.message : err}`);
    console.error('A proxy or firewall between this server and the gateway would do that.');
    process.exitCode = 1;
    return;
  }

  const raw = await response.text().catch(() => '');
  console.log(`Status:     ${response.status} ${response.statusText}`);
  console.log(`Reply:      ${raw || '(empty)'}`);

  if (response.status === 401 || response.status === 403) {
    console.log('\nThe credentials were refused. Check NEXTSMS_AUTH_TOKEN, or the username');
    console.log('and password if you are using those instead.');
  } else if (!response.ok) {
    console.log('\nThe gateway rejected the request itself. Compare the body above against');
    console.log('their documentation — the sender ID and the shape of `to` are the usual');
    console.log('culprits. An unregistered alphanumeric sender ID is rejected outright.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
