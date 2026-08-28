import { env } from '../../../config/env.js';
import type { SmsPayload, SmsProvider, SmsResult } from './types.js';

const DEFAULT_BASE = 'https://messaging-service.co.tz/api/sms/v1';

/** Recipients per request — `to` accepts an array sharing one message body. */
const BATCH_SIZE = 100;
const TIMEOUT_MS = 20_000;

/**
 * NextSMS reports an outcome per recipient inside `status`, and the useful part
 * is `groupName` — the coarse state — refined by `name`, which says why.
 *
 * PENDING means the gateway has taken the message; delivery to the handset is
 * confirmed later by a delivery report, so it counts as accepted here.
 */
const ACCEPTED_GROUPS = new Set(['PENDING', 'DELIVERED']);

/**
 * A rejection is usually final: a malformed number or an unregistered sender ID
 * fails identically however often it is retried. The exception is running out
 * of credit, which the school fixes by topping up — that message should wait
 * rather than be thrown away.
 */
const RETRYABLE_NAME_HINTS = ['CREDIT', 'BALANCE', 'FUND', 'THROTTL', 'LIMIT'];

interface NextSmsRecipient {
  to?: string;
  messageId?: string;
  smsCount?: number;
  status?: {
    groupId?: number;
    groupName?: string;
    id?: number;
    name?: string;
    description?: string;
  };
}

interface NextSmsResponse {
  messages?: NextSmsRecipient[];
  error?: string;
  message?: string;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** NextSMS wants bare digits: 255754123456, not +255754123456. */
const toLocalFormat = (recipient: string) => recipient.replace(/\D/g, '');

/**
 * Builds the Authorization header.
 *
 * NextSMS's dashboard hands out a ready-made authorization token, and it is
 * simply base64 of `username:password` — the same value this would compute from
 * the two separately. Whichever the school has to hand should work, so a pasted
 * token is accepted as-is: with its scheme (`Basic abc...`, or `Bearer abc...`
 * should they ever issue one), or bare, in which case `Basic` is assumed
 * because that is what the token encodes.
 */
export function authorizationHeader(
  token: string | undefined,
  username: string,
  password: string,
): string {
  const pasted = token?.trim();
  if (pasted) {
    return /^(basic|bearer)\s/i.test(pasted) ? pasted : `Basic ${pasted}`;
  }
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

/**
 * Pulls the readable part out of an error response.
 *
 * The gateway answers failures with a JSON envelope, and dumping that whole
 * blob into the outbox leaves a school secretary reading braces and quotes to
 * find the one sentence that says what went wrong. Anything unrecognised is
 * passed through as-is rather than hidden.
 */
export function errorText(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return 'no response body';

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === 'string') return parsed.slice(0, 200);
    if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>;
      for (const key of ['message', 'error', 'description', 'detail']) {
        const value = record[key];
        if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 200);
      }
    }
  } catch {
    // Not JSON — an HTML error page, say. Fall through to the raw text.
  }

  return trimmed.slice(0, 200);
}

function describe(status: NextSmsRecipient['status']) {
  const group = (status?.groupName ?? '').toUpperCase();
  const name = (status?.name ?? '').toUpperCase();
  const detail = status?.description || status?.name || group || 'Unknown gateway response';

  if (!group && !name) {
    // Nothing to go on. Retrying risks a duplicate, but dropping loses the
    // message outright, and a duplicate result notice is the lesser harm.
    return { error: detail, retryable: true };
  }

  if (RETRYABLE_NAME_HINTS.some((hint) => name.includes(hint) || detail.toUpperCase().includes(hint))) {
    return { error: `${detail} (${group || name})`, retryable: true };
  }

  if (group === 'REJECTED' || group === 'UNDELIVERABLE' || group === 'BLACKLISTED') {
    return { error: `${detail} (${group})`, retryable: false };
  }

  // EXPIRED and anything unrecognised may pass on another attempt.
  return { error: `${detail} (${group || name})`, retryable: true };
}

export class NextSmsProvider implements SmsProvider {
  readonly name = 'nextsms';

  private readonly url: string;
  private readonly multiUrl: string;
  private readonly authorization: string;

  constructor(
    username = env.NEXTSMS_USERNAME ?? '',
    password = env.NEXTSMS_PASSWORD ?? '',
    testMode = env.NEXTSMS_TEST_MODE,
    baseUrl = env.NEXTSMS_BASE_URL ?? DEFAULT_BASE,
    authToken = env.NEXTSMS_AUTH_TOKEN,
  ) {
    const base = baseUrl.replace(/\/+$/, '');
    // The test path validates the request and reports back without sending
    // anything or spending credit.
    const prefix = `${base}${testMode ? '/test' : ''}`;
    this.url = `${prefix}/text/single`;
    this.multiUrl = `${prefix}/text/multi`;
    this.authorization = authorizationHeader(authToken, username, password);
  }

  async send(messages: SmsPayload[], senderId: string): Promise<SmsResult[]> {
    if (messages.length === 0) return [];

    // One request carries one body, so recipients are grouped by message text.
    const byBody = new Map<string, string[]>();
    for (const m of messages) {
      const list = byBody.get(m.body) ?? [];
      list.push(m.recipient);
      byBody.set(m.body, list);
    }

    // Personalised messages — a result notice per child — would otherwise be
    // one HTTP request each. `text/multi` carries them all in a single call,
    // so publishing to four hundred parents is one request, not four hundred.
    if (byBody.size > 1) {
      const results: SmsResult[] = [];
      for (const batch of chunk(messages, BATCH_SIZE)) {
        results.push(...(await this.sendMany(batch, senderId)));
      }
      return results;
    }

    const results: SmsResult[] = [];
    for (const [body, recipients] of byBody) {
      for (const batch of chunk(recipients, BATCH_SIZE)) {
        results.push(...(await this.sendOne(batch, body, senderId)));
      }
    }
    return results;
  }

  /** Many different messages in one request, one entry per recipient. */
  private async sendMany(batch: SmsPayload[], senderId: string): Promise<SmsResult[]> {
    const from = senderId.trim() || undefined;
    return this.post(
      this.multiUrl,
      {
        messages: batch.map((m) => ({ from, to: toLocalFormat(m.recipient), text: m.body })),
      },
      batch.map((m) => m.recipient),
    );
  }

  private async sendOne(
    recipients: string[],
    text: string,
    senderId: string,
  ): Promise<SmsResult[]> {
    return this.post(
      this.url,
      { from: senderId.trim() || undefined, to: recipients.map(toLocalFormat), text },
      recipients,
    );
  }

  /** Shared transport: send the payload, then map the reply back per recipient. */
  private async post(
    url: string,
    request: unknown,
    recipients: string[],
  ): Promise<SmsResult[]> {
    const failAll = (error: string, retryable: boolean): SmsResult[] =>
      recipients.map((recipient) => ({ recipient, accepted: false, error, retryable }));

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: this.authorization,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      // Nothing was decided, so it is worth another go.
      return failAll(err instanceof Error ? err.message : 'Network error', true);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      // Credentials or a malformed request will fail identically next time.
      const retryable = response.status !== 401 && response.status !== 403 && response.status !== 400;
      return failAll(`HTTP ${response.status}: ${errorText(body)}`, retryable);
    }

    let payload: NextSmsResponse;
    try {
      payload = (await response.json()) as NextSmsResponse;
    } catch {
      return failAll('Gateway returned a malformed response', true);
    }

    const reported = payload.messages ?? [];
    if (reported.length === 0) {
      const message = payload.error ?? payload.message ?? 'Gateway accepted no recipients';
      return failAll(message, !/sender|invalid|unauthor/i.test(message));
    }

    // The gateway echoes bare digits, so match on that rather than our +E.164.
    const byNumber = new Map(reported.map((r) => [toLocalFormat(r.to ?? ''), r]));

    return recipients.map((recipient) => {
      const entry = byNumber.get(toLocalFormat(recipient));
      if (!entry) {
        return {
          recipient,
          accepted: false,
          error: 'Gateway did not report on this recipient',
          retryable: true,
        };
      }

      if (ACCEPTED_GROUPS.has((entry.status?.groupName ?? '').toUpperCase())) {
        return {
          recipient,
          accepted: true,
          providerRef: entry.messageId,
          // Billing is per 160-character segment, which is what a school is
          // actually charged for.
          cost: entry.smsCount ? `${entry.smsCount} SMS` : undefined,
          retryable: false,
        };
      }

      const { error, retryable } = describe(entry.status);
      return { recipient, accepted: false, error, retryable };
    });
  }
}
