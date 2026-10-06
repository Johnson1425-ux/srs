import { MobileMoneyProvider } from '@prisma/client';
import { airtelConfigured, env } from '../../config/env.js';
import { collectionPush, outcomeFromCallback, queryStatus } from '../airtel/client.js';
import type { AirtelCallbackBody } from '../airtel/types.js';
import type { PaymentOutcome, PaymentProvider, PaymentPushRequest } from './types.js';

/**
 * Airtel Money Tanzania, behind the shared provider seam.
 *
 * `pushWaitMs` is the plain request timeout rather than a compromise like
 * M-Pesa's: Airtel answers the push as soon as it has queued the prompt, so
 * there is nothing to wait for beyond the call itself.
 */
export const airtelProvider: PaymentProvider = {
  id: MobileMoneyProvider.AIRTEL_MONEY,
  label: 'Airtel Money',
  get configured(): boolean {
    return airtelConfigured;
  },
  get pushWaitMs(): number {
    return env.AIRTEL_TIMEOUT_MS;
  },
  push(req: PaymentPushRequest): Promise<PaymentOutcome> {
    return collectionPush(req);
  },
  queryStatus(reference: string): Promise<PaymentOutcome> {
    return queryStatus(reference);
  },
  outcomeFromCallback(body: Record<string, unknown>): {
    reference: string | null;
    outcome: PaymentOutcome;
  } {
    return outcomeFromCallback(body as AirtelCallbackBody);
  },
};
