import type { PaymentState } from '../payments/types.js';

/**
 * Airtel reports a payment with a two- or three-letter transaction status, and
 * that status — not the HTTP code and not the envelope's `success` flag — is
 * the only thing that says where the money is.
 *
 *   TS   Transaction Success
 *   TF   Transaction Failed
 *   TIP  Transaction In Progress — the prompt is on the handset, unanswered
 *   TA   Transaction Ambiguous — Airtel does not know yet either
 *
 * Only `TF` is a refusal. `TA` in particular must never be read as one: it is
 * Airtel saying it cannot tell, which is the state a payment sits in while the
 * customer is still deciding, and a school told its payment failed at that
 * moment is being told something that may be about to become false.
 */
export const AIRTEL_SUCCESS = 'TS';
export const AIRTEL_FAILED = 'TF';

/** What one transaction status means on its own. */
export function stateForTransactionStatus(status: string | null | undefined): PaymentState {
  const code = status?.trim().toUpperCase();
  if (!code) return 'pending';
  if (code === AIRTEL_SUCCESS) return 'confirmed';
  if (code === AIRTEL_FAILED) return 'failed';
  return 'pending';
}

/** `POST /auth/oauth2/token` */
export interface AirtelTokenResponse {
  access_token?: string;
  token_type?: string;
  expires_in?: number | string;
}

/** The envelope every collection endpoint wraps its answer in. */
export interface AirtelStatusEnvelope {
  code?: string;
  message?: string;
  result_code?: string;
  response_code?: string;
  success?: boolean;
}

/** `POST /merchant/v1/payments/` */
export interface AirtelPushResponse {
  data?: {
    transaction?: {
      id?: string;
      status?: string;
      message?: string;
      airtel_money_id?: string;
    };
  };
  status?: AirtelStatusEnvelope;
  /** Present instead of `status` when the gateway rejects the request itself. */
  error?: string;
  error_description?: string;
}

/** `GET /standard/v1/payments/{id}` */
export interface AirtelStatusResponse {
  data?: {
    transaction?: {
      id?: string;
      message?: string;
      status?: string;
      airtel_money_id?: string;
    };
  };
  status?: AirtelStatusEnvelope;
}

/** What Airtel posts to a collection callback URL. */
export interface AirtelCallbackBody {
  transaction?: {
    id?: string;
    message?: string;
    status_code?: string;
    airtel_money_id?: string;
  };
  hash?: string;
}
