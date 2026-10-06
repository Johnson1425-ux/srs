import type { MobileMoneyProvider } from '@prisma/client';

/**
 * What one payment is doing, as every gateway path reports it.
 *
 * Three states and no more: the money has arrived, it has not arrived yet, or
 * the gateway has refused. Anything a provider cannot classify is `pending`,
 * because the opposite mistake takes a school that is mid-payment and tells it
 * the payment failed.
 */
export type PaymentState = 'confirmed' | 'pending' | 'failed';

/** What a push, a status query or a callback tells us about one payment. */
export interface PaymentOutcome {
  state: PaymentState;
  /** The gateway's own code, kept verbatim so a report can be traced to a call. */
  code: string | null;
  description: string | null;
  transactionId: string | null;
  conversationId: string | null;
}

/** One payment, in the terms every provider needs and none of them share. */
export interface PaymentPushRequest {
  amount: number;
  currency: string;
  /** Always stored as 255XXXXXXXXX; a provider reshapes it for its own gateway. */
  msisdn: string;
  /** Our idempotency key, echoed back by the gateway and by any callback. */
  reference: string;
  /** Shown to the customer on the prompt. */
  description: string;
}

/**
 * One mobile money gateway, reduced to what registration actually asks of it.
 *
 * Registration never names a gateway: it takes the provider the school chose,
 * pushes a prompt, and reads back an outcome. That is the whole seam — adding
 * a network is writing one of these, not editing the sign-up flow.
 */
export interface PaymentProvider {
  readonly id: MobileMoneyProvider;
  /** What the school sees on the sign-up form, e.g. "M-Pesa". */
  readonly label: string;
  /** False when this deployment has no credentials for the gateway. */
  readonly configured: boolean;
  /**
   * How long the sign-up request waits on the push before answering with
   * whatever the record says.
   *
   * It differs by an order of magnitude between gateways: M-Pesa answers the
   * push itself when the customer types their PIN, so its wait is a
   * compromise, while Airtel answers at once and leaves the prompt to the
   * status query.
   */
  readonly pushWaitMs: number;
  /** Pushes a prompt to the handset. Resolves with whatever the gateway said. */
  push(req: PaymentPushRequest): Promise<PaymentOutcome>;
  /** Asks the gateway what became of a payment we pushed. */
  queryStatus(reference: string): Promise<PaymentOutcome>;
  /** Reads a callback body this gateway posts, or null if it is not ours. */
  outcomeFromCallback(body: Record<string, unknown>): {
    reference: string | null;
    outcome: PaymentOutcome;
  };
}
