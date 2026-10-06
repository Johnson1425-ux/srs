import { airtelBaseUrl, airtelConfigured, env } from '../../config/env.js';
import type { PaymentOutcome, PaymentPushRequest } from '../payments/types.js';
import {
  stateForTransactionStatus,
  type AirtelCallbackBody,
  type AirtelPushResponse,
  type AirtelStatusResponse,
  type AirtelTokenResponse,
} from './types.js';

/**
 * The OAuth2 token Airtel hands out for the client credentials.
 *
 * Cached in memory for the same reason M-Pesa's session is: fetching one per
 * payment doubles the latency of every sign-up, and losing the cache on a
 * restart costs one round trip.
 */
let token: { value: string; expiresAt: number } | null = null;

/** Expires early so a token cannot lapse between being read and being used. */
const TOKEN_EARLY_EXPIRY_MS = 60 * 1000;
const TOKEN_FALLBACK_TTL_MS = 50 * 60 * 1000;

/** Dropped on a 401 so the next call fetches a fresh one. */
export function resetTokenCache(): void {
  token = null;
}

export class AirtelError extends Error {
  readonly code: string | null;

  constructor(message: string, code: string | null = null) {
    super(message);
    this.name = 'AirtelError';
    this.code = code;
  }
}

function requireConfig(): { clientId: string; clientSecret: string } {
  if (!airtelConfigured) {
    throw new AirtelError('Airtel Money is not configured on this deployment');
  }
  return { clientId: env.AIRTEL_CLIENT_ID!, clientSecret: env.AIRTEL_CLIENT_SECRET! };
}

/**
 * Airtel wants the subscriber number without its country code.
 *
 * Everything on our side is stored as `255XXXXXXXXX`, which is what M-Pesa
 * takes; handing that straight to Airtel is rejected as an invalid subscriber,
 * with a code that does not say so.
 */
export function airtelMsisdn(msisdn: string): string {
  const digits = msisdn.replace(/\D/g, '');
  return digits.startsWith('255') && digits.length === 12 ? digits.slice(3) : digits;
}

/**
 * Records any answer that was not a plain success, in Airtel's own words.
 *
 * The customer's number is deliberately absent: the body carries it, and a
 * phone number has no business in a log file. The transaction status is logged
 * because it, not the HTTP status, is what decides whether a school is let in.
 */
function logAnswer(path: string, httpStatus: number, body: AirtelPushResponse | AirtelStatusResponse): void {
  const envelope = body.status ?? {};
  const transaction = body.data?.transaction ?? {};
  if (envelope.success === true && httpStatus < 400 && transaction.status === undefined) return;
  if (envelope.success === true && stateForTransactionStatus(transaction.status) === 'confirmed') return;

  console.error(
    `[airtel] ${path}: HTTP ${httpStatus}, success ${String(envelope.success ?? 'none')}, ` +
      `code ${envelope.code ?? envelope.result_code ?? 'none'}, ` +
      `status ${transaction.status ?? 'none'}, message ${envelope.message ?? 'none'}`,
  );
}

async function callGateway<T>(
  path: string,
  init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: unknown },
): Promise<{ status: number; body: T }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.AIRTEL_TIMEOUT_MS);

  try {
    const res = await fetch(`${airtelBaseUrl()}${path}`, {
      method: init.method,
      headers: { 'Content-Type': 'application/json', Accept: '*/*', ...init.headers },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
      signal: controller.signal,
    });

    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      throw new AirtelError(`Gateway returned a non-JSON response: ${text.slice(0, 200)}`);
    }

    // A rejected call still carries the envelope, which says far more than the
    // HTTP status does, so the body is handed back either way and the caller
    // decides. Only an expired token is handled here.
    if (res.status === 401) resetTokenCache();

    return { status: res.status, body: parsed as T };
  } catch (err) {
    if (err instanceof AirtelError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new AirtelError('Gateway did not answer in time', 'TIMEOUT');
    }
    throw new AirtelError(err instanceof Error ? err.message : 'Gateway request failed');
  } finally {
    clearTimeout(timer);
  }
}

async function accessToken(): Promise<string> {
  if (token && token.expiresAt > Date.now()) return token.value;

  const { clientId, clientSecret } = requireConfig();
  const { body } = await callGateway<AirtelTokenResponse>('auth/oauth2/token', {
    method: 'POST',
    headers: {},
    body: { client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' },
  });

  if (!body.access_token) {
    throw new AirtelError('Airtel would not issue an access token');
  }

  // `expires_in` is seconds and comes back as a string in some markets.
  const ttlSeconds = Number(body.expires_in);
  const ttlMs = Number.isFinite(ttlSeconds) && ttlSeconds > 0
    ? ttlSeconds * 1000 - TOKEN_EARLY_EXPIRY_MS
    : TOKEN_FALLBACK_TTL_MS;

  token = { value: body.access_token, expiresAt: Date.now() + Math.max(ttlMs, 0) };
  return token.value;
}

/** Every collection call is bearer-authenticated and scoped to one market. */
async function marketHeaders(): Promise<Record<string, string>> {
  return {
    Authorization: `Bearer ${await accessToken()}`,
    'X-Country': env.AIRTEL_COUNTRY,
    'X-Currency': env.AIRTEL_CURRENCY,
  };
}

function outcomeFrom(
  state: PaymentOutcome['state'],
  envelope: { code?: string; result_code?: string; message?: string } | undefined,
  transaction: { id?: string; status?: string; message?: string; airtel_money_id?: string } | undefined,
  reference: string | null,
): PaymentOutcome {
  return {
    state,
    code: transaction?.status ?? envelope?.result_code ?? envelope?.code ?? null,
    description: transaction?.message ?? envelope?.message ?? null,
    // The money reference people quote in a dispute is the Airtel Money id,
    // not the id we sent, so that is what is recorded when there is one.
    transactionId: transaction?.airtel_money_id ?? transaction?.id ?? null,
    conversationId: reference,
  };
}

/**
 * Pushes a USSD prompt to the customer's handset
 * (`POST /merchant/v1/payments/`).
 *
 * Unlike M-Pesa's C2B push this answers immediately: Airtel acknowledges that
 * it has queued the prompt and says nothing about whether anyone accepted it.
 * So a successful push is `pending` by definition, and the status poll — not
 * this call — is what confirms a payment. That is why there is no long hold
 * here and no `AIRTEL_PUSH_WAIT_MS` to go with it.
 *
 * A timeout is reported as pending rather than thrown: the prompt may well
 * have been queued before the connection gave up, and a school whose phone is
 * ringing must not be told the payment failed.
 */
export async function collectionPush(req: PaymentPushRequest): Promise<PaymentOutcome> {
  requireConfig();

  let answer: { status: number; body: AirtelPushResponse };
  try {
    answer = await callGateway<AirtelPushResponse>('merchant/v1/payments/', {
      method: 'POST',
      headers: await marketHeaders(),
      body: {
        reference: req.description,
        subscriber: {
          country: env.AIRTEL_COUNTRY,
          currency: env.AIRTEL_CURRENCY,
          msisdn: airtelMsisdn(req.msisdn),
        },
        transaction: {
          amount: req.amount,
          country: env.AIRTEL_COUNTRY,
          currency: req.currency,
          id: req.reference,
        },
      },
    });
  } catch (err) {
    if (err instanceof AirtelError && err.code === 'TIMEOUT') {
      return {
        state: 'pending',
        code: 'TIMEOUT',
        description: 'Waiting for the customer to approve the prompt',
        transactionId: null,
        conversationId: req.reference,
      };
    }
    throw err;
  }

  logAnswer('merchant/v1/payments/', answer.status, answer.body);

  const envelope = answer.body.status;
  const transaction = answer.body.data?.transaction;

  // A transaction status, when there is one, is the last word: it is the only
  // field that speaks about the money rather than about the request.
  if (transaction?.status) {
    return outcomeFrom(
      stateForTransactionStatus(transaction.status),
      envelope,
      transaction,
      req.reference,
    );
  }

  // No transaction status at all. An accepted request means the prompt is on
  // its way and nobody has answered it, which is pending; a refused one is a
  // refusal of this push, and the school is shown the retry button.
  if (envelope?.success === true) {
    return outcomeFrom('pending', envelope, transaction, req.reference);
  }

  return outcomeFrom('failed', envelope, transaction, req.reference);
}

/**
 * Asks Airtel what became of a payment we pushed
 * (`GET /standard/v1/payments/{id}`).
 *
 * This is the path that settles an Airtel payment, since the push never does
 * and a development deployment has no reachable callback URL.
 */
export async function queryStatus(reference: string): Promise<PaymentOutcome> {
  requireConfig();

  const { status, body } = await callGateway<AirtelStatusResponse>(
    `standard/v1/payments/${encodeURIComponent(reference)}`,
    { method: 'GET', headers: await marketHeaders() },
  );

  logAnswer('standard/v1/payments/', status, body);

  const envelope = body.status;
  const transaction = body.data?.transaction;

  if (transaction?.status) {
    return outcomeFrom(
      stateForTransactionStatus(transaction.status),
      envelope,
      transaction,
      reference,
    );
  }

  // The query was refused, which says nothing about the customer's money — the
  // same rule M-Pesa's query follows, and for the same reason: reading a
  // refused question as a refused payment marks a school FAILED for a fault on
  // our side of the call, and would do it to a school whose money had already
  // left their wallet. The payment stays where it was; the push answer, the
  // callback or a later answered query settles it, and an unanswered one
  // expires on REGISTRATION_TTL_DAYS.
  //
  // Airtel's own wording is dropped rather than shown, for the same reason
  // M-Pesa's is: "Invalid subscription" on a sign-up page tells a school
  // nothing it can act on.
  return {
    state: 'pending',
    code: null,
    description: null,
    transactionId: transaction?.airtel_money_id ?? null,
    conversationId: reference,
  };
}

/**
 * Reads the callback Airtel posts when a collection settles.
 *
 * `status_code` is the same transaction status the query returns, so a
 * callback and a poll cannot disagree about what `TA` means.
 */
export function outcomeFromCallback(body: AirtelCallbackBody): {
  reference: string | null;
  outcome: PaymentOutcome;
} {
  const transaction = body.transaction ?? {};
  return {
    reference: transaction.id ?? null,
    outcome: {
      state: stateForTransactionStatus(transaction.status_code),
      code: transaction.status_code ?? null,
      description: transaction.message ?? null,
      transactionId: transaction.airtel_money_id ?? null,
      conversationId: transaction.id ?? null,
    },
  };
}

export { airtelConfigured };
