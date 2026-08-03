import { env } from '../../../config/env.js';
import type { SmsPayload, SmsProvider, SmsResult } from './types.js';

const LIVE_URL = 'https://api.africastalking.com/version1/messaging';
const SANDBOX_URL = 'https://api.sandbox.africastalking.com/version1/messaging';

/** Recipients per request. Africa's Talking takes a comma-separated list. */
const BATCH_SIZE = 100;
const TIMEOUT_MS = 20_000;

/**
 * Africa's Talking per-recipient status codes.
 *
 * 101/102 mean the message was accepted. The rest are failures, and the
 * distinction that matters is whether repeating the request could ever help:
 * a blacklisted or malformed number will fail identically every time, whereas
 * a routing or gateway error may not.
 */
const ACCEPTED = new Set([100, 101, 102]);

const PERMANENT = new Map<number, string>([
  [402, 'Invalid sender ID'],
  [403, 'Invalid phone number'],
  [404, 'Unsupported number type'],
  [406, 'Number is blacklisted'],
]);

const TRANSIENT = new Map<number, string>([
  [401, 'Held for risk review'],
  [405, 'Insufficient account balance'],
  [407, 'Could not route the message'],
  [500, 'Gateway internal error'],
  [501, 'Gateway error'],
  [502, 'Rejected by the gateway'],
]);

interface AtRecipient {
  number?: string;
  status?: string;
  statusCode?: number;
  messageId?: string;
  cost?: string;
}

interface AtResponse {
  SMSMessageData?: {
    Message?: string;
    Recipients?: AtRecipient[];
  };
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function describe(code: number | undefined, status: string | undefined) {
  if (code === undefined) return { error: status ?? 'Unknown gateway response', retryable: true };
  const permanent = PERMANENT.get(code);
  if (permanent) return { error: `${permanent} (${code})`, retryable: false };
  const transient = TRANSIENT.get(code);
  if (transient) return { error: `${transient} (${code})`, retryable: true };
  return { error: `${status ?? 'Failed'} (${code})`, retryable: true };
}

export class AfricasTalkingProvider implements SmsProvider {
  readonly name = 'africastalking';

  private readonly username: string;
  private readonly apiKey: string;
  private readonly url: string;

  constructor(
    username = env.AFRICASTALKING_USERNAME ?? '',
    apiKey = env.AFRICASTALKING_API_KEY ?? '',
    sandbox = env.AFRICASTALKING_SANDBOX,
    baseUrl = env.AFRICASTALKING_BASE_URL,
  ) {
    this.username = username;
    this.apiKey = apiKey;
    this.url = baseUrl ?? (sandbox ? SANDBOX_URL : LIVE_URL);
  }

  async send(messages: SmsPayload[], senderId: string): Promise<SmsResult[]> {
    if (messages.length === 0) return [];

    // One request carries one body, so recipients are grouped by message text.
    // A school-wide announcement is a single call; personalised reminders are
    // necessarily one call each.
    const byBody = new Map<string, string[]>();
    for (const m of messages) {
      const list = byBody.get(m.body) ?? [];
      list.push(m.recipient);
      byBody.set(m.body, list);
    }

    const results: SmsResult[] = [];
    for (const [body, recipients] of byBody) {
      for (const batch of chunk(recipients, BATCH_SIZE)) {
        results.push(...(await this.sendOne(batch, body, senderId)));
      }
    }
    return results;
  }

  private async sendOne(
    recipients: string[],
    body: string,
    senderId: string,
  ): Promise<SmsResult[]> {
    const form = new URLSearchParams({
      username: this.username,
      to: recipients.join(','),
      message: body,
    });
    // A blank sender ID makes the gateway use the account default, which is
    // what an unregistered alphanumeric ID would need.
    if (senderId.trim()) form.set('from', senderId.trim());

    const failAll = (error: string, retryable: boolean): SmsResult[] =>
      recipients.map((recipient) => ({ recipient, accepted: false, error, retryable }));

    let response: Response;
    try {
      response = await fetch(this.url, {
        method: 'POST',
        headers: {
          apiKey: this.apiKey,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: form.toString(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      // Network failure or timeout: nothing was decided, so it is worth another go.
      return failAll(err instanceof Error ? err.message : 'Network error', true);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      // Credentials are wrong, not the message — retrying will not fix it.
      const retryable = response.status !== 401 && response.status !== 403;
      return failAll(`HTTP ${response.status}: ${text.slice(0, 200)}`, retryable);
    }

    let payload: AtResponse;
    try {
      payload = (await response.json()) as AtResponse;
    } catch {
      return failAll('Gateway returned a malformed response', true);
    }

    const reported = payload.SMSMessageData?.Recipients ?? [];
    if (reported.length === 0) {
      // The gateway accepted nothing and said why in Message, e.g. no credit.
      return failAll(payload.SMSMessageData?.Message ?? 'Gateway accepted no recipients', true);
    }

    const byNumber = new Map(reported.map((r) => [r.number ?? '', r]));

    return recipients.map((recipient) => {
      const entry = byNumber.get(recipient);
      if (!entry) {
        return {
          recipient,
          accepted: false,
          error: 'Gateway did not report on this recipient',
          retryable: true,
        };
      }

      if (ACCEPTED.has(entry.statusCode ?? -1)) {
        return {
          recipient,
          accepted: true,
          providerRef: entry.messageId,
          cost: entry.cost,
          retryable: false,
        };
      }

      const { error, retryable } = describe(entry.statusCode, entry.status);
      return { recipient, accepted: false, error, retryable };
    });
  }
}
