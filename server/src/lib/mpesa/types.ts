/** `INS-0` is the gateway's only success code; everything else is a refusal. */
export const MPESA_SUCCESS = 'INS-0';

/**
 * Codes that mean "ask again later" rather than "this failed".
 *
 * The customer has a prompt on their phone and has not answered it yet, so the
 * payment is still live and must not be marked FAILED.
 */
export const MPESA_PENDING_CODES: readonly string[] = [
  'INS-1', // internal error, retriable
  'INS-9', // request timed out — the prompt may still be answered
  'INS-10', // duplicate: a push for this reference is already in flight
  'INS-995', // customer profile problem that resolves on their side
];

export interface MpesaSessionResponse {
  output_ResponseCode?: string;
  output_ResponseDesc?: string;
  output_SessionID?: string;
}

export interface MpesaPaymentResponse {
  output_ResponseCode?: string;
  output_ResponseDesc?: string;
  output_TransactionID?: string;
  output_ConversationID?: string;
  output_ThirdPartyConversationID?: string;
}

export interface MpesaStatusResponse {
  output_ResponseCode?: string;
  output_ResponseDesc?: string;
  output_ResponseTransactionStatus?: string;
  output_TransactionID?: string;
  output_ThirdPartyConversationID?: string;
}

export interface C2bPaymentRequest {
  amount: number;
  currency: string;
  msisdn: string;
  /** Our idempotency key, echoed back by the gateway and by any callback. */
  reference: string;
  /** Shown to the customer on the PIN prompt. */
  description: string;
}

/** What a push or a status query tells us about one payment. */
export interface MpesaOutcome {
  state: 'confirmed' | 'pending' | 'failed';
  code: string | null;
  description: string | null;
  transactionId: string | null;
  conversationId: string | null;
}

/**
 * What a gateway response code means on its own.
 *
 * Shared by the push, the status query and the callback so a code that means
 * "still waiting" is never recorded as a refusal on one path and a wait on
 * another.
 */
export function stateForCode(code: string | null | undefined): 'confirmed' | 'pending' | 'failed' {
  if (!code) return 'pending';
  if (code === MPESA_SUCCESS) return 'confirmed';
  return MPESA_PENDING_CODES.includes(code) ? 'pending' : 'failed';
}
