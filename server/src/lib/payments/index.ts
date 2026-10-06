import { MobileMoneyProvider } from '@prisma/client';
import { airtelProvider } from './airtel.provider.js';
import { mpesaProvider } from './mpesa.provider.js';
import type { PaymentProvider } from './types.js';

/**
 * Every mobile money network the registration fee can be paid from.
 *
 * Order is the order the sign-up form offers them in, so M-Pesa stays first:
 * it is both the largest network in Tanzania and the one that was here before
 * this list existed.
 *
 * MIXX by Yas and HaloPesa are in the `MobileMoneyProvider` enum because
 * school fees are recorded against them by hand, but no gateway is integrated
 * for them, so they are not here and cannot be chosen at sign-up.
 */
const PROVIDERS: readonly PaymentProvider[] = [mpesaProvider, airtelProvider];

const BY_ID = new Map<MobileMoneyProvider, PaymentProvider>(PROVIDERS.map((p) => [p.id, p]));

/** The providers sign-up may offer, whether or not this deployment has keys. */
export const SELF_SERVICE_PROVIDERS = PROVIDERS.map((p) => p.id);

/** Whether a sign-up can be paid for through `provider` on this deployment. */
export function providerConfigured(provider: MobileMoneyProvider): boolean {
  return BY_ID.get(provider)?.configured ?? false;
}

/** True when at least one gateway has credentials. */
export const anyProviderConfigured = (): boolean => PROVIDERS.some((p) => p.configured);

/**
 * The gateway for one provider.
 *
 * Throws rather than returning null for a provider with no integration: the
 * request schema will not admit one, so reaching here with it is a bug and not
 * something a sign-up should be allowed to limp along with.
 */
export function paymentProvider(provider: MobileMoneyProvider): PaymentProvider {
  const found = BY_ID.get(provider);
  if (!found) throw new Error(`No payment gateway is integrated for ${provider}`);
  return found;
}

/** What the sign-up page needs to label and enable the provider choice. */
export function providerOffers(): { provider: MobileMoneyProvider; label: string; enabled: boolean }[] {
  return PROVIDERS.map((p) => ({ provider: p.id, label: p.label, enabled: p.configured }));
}

export { airtelProvider, mpesaProvider };
export type {
  PaymentOutcome,
  PaymentProvider,
  PaymentPushRequest,
  PaymentState,
} from './types.js';
