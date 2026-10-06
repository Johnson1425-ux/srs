import { MobileMoneyProvider } from '@prisma/client';
import { env, mpesaConfigured } from '../../config/env.js';
import { c2bPayment, queryStatus } from '../mpesa/client.js';
import { stateForCode } from '../mpesa/types.js';
import type { PaymentOutcome, PaymentProvider, PaymentPushRequest } from './types.js';

/**
 * Vodacom M-Pesa, behind the shared provider seam.
 *
 * Nothing here changes how M-Pesa behaves: it forwards to the same client the
 * sign-up flow has always called. The one thing it adds is a way for
 * registration to reach it without naming it.
 */
export const mpesaProvider: PaymentProvider = {
  id: MobileMoneyProvider.MPESA,
  label: 'M-Pesa',
  get configured(): boolean {
    return mpesaConfigured;
  },
  get pushWaitMs(): number {
    return env.MPESA_PUSH_TIMEOUT_MS;
  },
  push(req: PaymentPushRequest): Promise<PaymentOutcome> {
    return c2bPayment(req);
  },
  queryStatus(reference: string): Promise<PaymentOutcome> {
    return queryStatus(reference);
  },
  /**
   * Field names follow the gateway's `output_*` convention, with the plain
   * names accepted too since the callback shape varies by market.
   */
  outcomeFromCallback(body: Record<string, unknown>): {
    reference: string | null;
    outcome: PaymentOutcome;
  } {
    const str = (key: string): string | undefined => {
      const value = body[key];
      return typeof value === 'string' ? value : undefined;
    };

    const reference =
      str('output_ThirdPartyConversationID') ??
      str('input_ThirdPartyConversationID') ??
      str('reference') ??
      null;
    const code = str('output_ResponseCode') ?? str('resultCode') ?? null;

    return {
      reference,
      outcome: {
        state: stateForCode(code),
        code,
        description: str('output_ResponseDesc') ?? str('resultDescription') ?? null,
        transactionId: str('output_TransactionID') ?? str('transactionId') ?? null,
        conversationId: str('output_ConversationID') ?? str('conversationId') ?? null,
      },
    };
  },
};
