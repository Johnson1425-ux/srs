import { env, mpesaBaseUrl, mpesaConfigured } from '../../config/env.js';
import { encryptForBearer } from './crypto.js';
import {
  MPESA_PENDING_CODES,
  MPESA_SUCCESS,
  stateForCode,
  type C2bPaymentRequest,
  type MpesaOutcome,
  type MpesaPaymentResponse,
  type MpesaSessionResponse,
  type MpesaStatusResponse,
} from './types.js';

/**
 * The session id the gateway hands out in exchange for the API key.
 *
 * It is valid for an hour; fetching one per payment would double the latency of
 * every sign-up for nothing. Cached in memory rather than in the database
 * because a restart losing it costs one extra round trip.
 */
let session: { id: string; expiresAt: number } | null = null;

/** Expires a little early, so a session cannot lapse mid-request. */
const SESSION_TTL_MS = 55 * 60 * 1000;

/** Dropped on a 401 so the next call fetches a fresh one. */
export function resetSessionCache(): void {
  session = null;
}

export class MpesaError extends Error {
  readonly code: string | null;

  constructor(message: string, code: string | null = null) {
    super(message);
    this.name = 'MpesaError';
    this.code = code;
  }
}

function requireConfig(): { apiKey: string; publicKey: string; providerCode: string } {
  if (!mpesaConfigured) {
    throw new MpesaError('M-Pesa is not configured on this deployment');
  }
  return {
    apiKey: env.MPESA_API_KEY!,
    publicKey: env.MPESA_PUBLIC_KEY!,
    providerCode: env.MPESA_SERVICE_PROVIDER_CODE!,
  };
}

/**
 * Records any answer that was not a success, in the gateway's own words.
 *
 * Without this such an answer reaches the customer as a sentence on the
 * sign-up page and is never written down, so a report of "it says X" cannot be
 * tied to the call that produced it — and `getSession` being rejected looks
 * exactly like `c2bPayment` being rejected. Only the path, the status and the
 * gateway's own code and wording are logged: the request body carries the
 * customer's phone number, which has no business in a log file.
 *
 * A pending code is said to be pending rather than reported as a failure,
 * since a customer who has not yet typed their PIN is the normal case.
 */
function logUnsuccessfulResponse(path: string, status: number, parsed: unknown): void {
  const body = (parsed ?? {}) as { output_ResponseCode?: string; output_ResponseDesc?: string };
  const code = body.output_ResponseCode;

  // No code at all and a clean status means there is nothing to report.
  if (code === MPESA_SUCCESS || (code === undefined && status < 400)) return;

  const outcome = code !== undefined && MPESA_PENDING_CODES.includes(code) ? 'pending' : 'rejected';

  console.error(
    `[mpesa] ${path} ${outcome}: HTTP ${status}, code ${code ?? 'none'}, ` +
      `desc ${body.output_ResponseDesc ?? 'none'}`,
  );
}

async function callGateway<T>(
  path: string,
  init: { method: 'GET' | 'POST'; bearer: string; body?: unknown; timeoutMs: number },
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs);

  try {
    const res = await fetch(`${mpesaBaseUrl()}${path}`, {
      method: init.method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${init.bearer}`,
        // The gateway rejects a request without an Origin outright.
        Origin: '*',
      },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
      signal: controller.signal,
    });

    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      throw new MpesaError(`Gateway returned a non-JSON response: ${text.slice(0, 200)}`);
    }

    // A rejected call still carries output_ResponseCode, which says far more
    // than the HTTP status does, so the body is handed back either way and the
    // caller decides. Only an authentication failure is handled here, because
    // it means the cached session is stale.
    //
    // A 401 alone does not mean that: the published table answers INS-6,
    // "Transaction Failed", with 401, so a customer declining a prompt would
    // throw away a perfectly good session. A 401 carrying a response code is
    // that documented case; one carrying none is the gateway rejecting the
    // credential itself.
    if (res.status === 401 && (parsed as { output_ResponseCode?: string }).output_ResponseCode === undefined) {
      resetSessionCache();
    }

    logUnsuccessfulResponse(path, res.status, parsed);

    return parsed as T;
  } catch (err) {
    if (err instanceof MpesaError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new MpesaError('Gateway did not answer in time', 'TIMEOUT');
    }
    throw new MpesaError(err instanceof Error ? err.message : 'Gateway request failed');
  } finally {
    clearTimeout(timer);
  }
}

async function sessionId(): Promise<string> {
  if (session && session.expiresAt > Date.now()) return session.id;

  const { apiKey, publicKey } = requireConfig();
  const body = await callGateway<MpesaSessionResponse>('getSession/', {
    method: 'GET',
    bearer: encryptForBearer(apiKey, publicKey),
    timeoutMs: env.MPESA_PUSH_TIMEOUT_MS,
  });

  if (body.output_ResponseCode !== MPESA_SUCCESS || !body.output_SessionID) {
    throw new MpesaError(
      body.output_ResponseDesc ?? 'Could not open an M-Pesa session',
      body.output_ResponseCode ?? null,
    );
  }

  session = { id: body.output_SessionID, expiresAt: Date.now() + SESSION_TTL_MS };
  return session.id;
}

/** Every call after `getSession` is bearer-authenticated with the session id. */
async function sessionBearer(): Promise<string> {
  const { publicKey } = requireConfig();
  return encryptForBearer(await sessionId(), publicKey);
}

function outcomeFromCode(
  code: string | null,
  description: string | null,
  transactionId: string | null,
  conversationId: string | null,
): MpesaOutcome {
  return { state: stateForCode(code), code, description, transactionId, conversationId };
}

/**
 * Pushes a PIN prompt to the customer's handset and takes the money if they
 * accept it (`c2bPayment/singleStage`).
 *
 * The call blocks while the customer reads the prompt, which is longer than a
 * browser request should be held open, so it is given a short timeout and a
 * timeout is reported as `pending` — the prompt is still on the phone, and
 * `queryStatus` below is what settles it.
 */
export async function c2bPayment(req: C2bPaymentRequest): Promise<MpesaOutcome> {
  const { providerCode } = requireConfig();

  let body: MpesaPaymentResponse;
  try {
    body = await callGateway<MpesaPaymentResponse>('c2bPayment/singleStage/', {
      method: 'POST',
      bearer: await sessionBearer(),
      timeoutMs: env.MPESA_PUSH_TIMEOUT_MS,
      body: {
        input_Amount: req.amount.toFixed(2),
        input_Country: 'TZN',
        input_Currency: req.currency,
        input_CustomerMSISDN: req.msisdn,
        input_ServiceProviderCode: providerCode,
        input_ThirdPartyConversationID: req.reference,
        input_TransactionReference: req.reference,
        input_PurchasedItemsDesc: req.description,
      },
    });
  } catch (err) {
    if (err instanceof MpesaError && err.code === 'TIMEOUT') {
      return outcomeFromCode('TIMEOUT', 'Waiting for the customer to approve the prompt', null, null);
    }
    throw err;
  }

  return outcomeFromCode(
    body.output_ResponseCode ?? null,
    body.output_ResponseDesc ?? null,
    body.output_TransactionID ?? null,
    body.output_ConversationID ?? null,
  );
}

/**
 * Asks the gateway what became of a payment we pushed.
 *
 * This is what makes the sandbox usable from a laptop: the gateway cannot reach
 * a callback URL on a development machine, so the status poll from the sign-up
 * page reconciles instead.
 */
export async function queryStatus(reference: string): Promise<MpesaOutcome> {
  const { providerCode } = requireConfig();

  const query = new URLSearchParams({
    input_QueryReference: reference,
    input_ServiceProviderCode: providerCode,
    input_ThirdPartyConversationID: reference,
    input_Country: 'TZN',
  });

  const body = await callGateway<MpesaStatusResponse>(`queryTransactionStatus/?${query}`, {
    method: 'GET',
    bearer: await sessionBearer(),
    timeoutMs: env.MPESA_PUSH_TIMEOUT_MS,
  });

  const code = body.output_ResponseCode ?? null;
  const transactionStatus = body.output_ResponseTransactionStatus?.trim().toLowerCase() ?? '';
  const description = body.output_ResponseDesc ?? body.output_ResponseTransactionStatus ?? null;
  const transactionId = body.output_TransactionID ?? null;

  // A query that succeeds still says nothing in the log, because only refusals
  // are recorded — and a transaction status we do not recognise is read as
  // "still waiting", which looks exactly like a customer who has not typed
  // their PIN. The wording below is the only way to tell those apart.
  if (code === MPESA_SUCCESS) {
    console.info(
      `[mpesa] queryTransactionStatus/ answered: status ${
        body.output_ResponseTransactionStatus ?? 'none'
      }, transaction ${transactionId ?? 'none'}`,
    );
  }

  // The query itself can succeed while reporting a payment that has not
  // settled, so the transaction status decides and the response code only says
  // whether the question was answered.
  if (code === MPESA_SUCCESS) {
    if (transactionStatus === 'completed' || transactionStatus === 'success') {
      return { state: 'confirmed', code, description, transactionId, conversationId: null };
    }
    if (transactionStatus === 'failed' || transactionStatus === 'cancelled') {
      return { state: 'failed', code, description, transactionId, conversationId: null };
    }
    return { state: 'pending', code, description, transactionId, conversationId: null };
  }

  return outcomeFromCode(code, description, transactionId, null);
}

export { mpesaConfigured };
