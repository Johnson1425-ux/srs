import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { timingSafeEqual } from 'node:crypto';
import { asyncHandler, validate } from '../../lib/http.js';
import { MobileMoneyProvider } from '@prisma/client';
import { env, isProduction } from '../../config/env.js';
import { forbidden } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import * as service from './registration.service.js';

/**
 * Self-service school sign-up, and the registration fee that goes with it.
 *
 * Mounted above `authenticate` — a school signing up has no account yet — so
 * every route here is reachable by anyone and is rate-limited accordingly.
 */
export const registrationRouter: Router = Router();

// Creating a school is cheap for the caller and expensive for us, so the limit
// is tighter than the application-wide one.
const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: isProduction ? 10 : 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: { code: 'TOO_MANY_REQUESTS', message: 'Too many sign-up attempts, try again later' },
  },
});

const pollLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: isProduction ? 60 : 10_000,
  standardHeaders: true,
  legacyHeaders: false,
});

const registerSchema = z.object({
  name: z.string().trim().min(2).max(150),
  code: z
    .string()
    .trim()
    .min(2)
    .max(12)
    .regex(/^[A-Za-z0-9]+$/, 'Code must be alphanumeric'),
  email: z.string().email().nullish(),
  phone: z.string().max(30).nullish(),
  address: z.string().max(300).nullish(),
  city: z.string().max(100).nullish(),
  region: z.string().max(100).nullish(),
  // TRIAL is deliberately absent: it is free, and a free option on a public
  // endpoint is a way straight past the gate.
  plan: z.enum(['BASIC', 'STANDARD', 'PREMIUM']),
  /**
   * Which mobile money network pays the fee. Defaults to M-Pesa so a client
   * written before Airtel existed keeps working unchanged.
   *
   * Only the networks with a gateway behind them are admitted — the enum has
   * four, because school fees are recorded against all four by hand.
   */
  provider: z
    .enum([MobileMoneyProvider.MPESA, MobileMoneyProvider.AIRTEL_MONEY])
    .default(MobileMoneyProvider.MPESA),
  /** The phone that will be prompted to approve the payment. */
  msisdn: z.string().trim().min(9).max(20),
  admin: z.object({
    firstName: z.string().trim().min(1).max(60),
    lastName: z.string().trim().min(1).max(60),
    email: z.string().email(),
    phone: z.string().max(30).optional(),
  }),
});

/** What the sign-up page needs to price the plans before anyone fills it in. */
registrationRouter.get(
  '/plans',
  asyncHandler(async (_req, res) => {
    res.json({
      currency: 'TZS',
      // Kept for a client written before there was more than one network: it
      // means "some network can take money", which is what it always meant.
      paymentsEnabled: service.anyProviderConfigured(),
      providers: service.providerOffers(),
      data: service.SELF_SERVICE_PLANS.map((plan) => ({
        plan,
        ...service.planOffer(plan),
      })),
    });
  }),
);

registrationRouter.post(
  '/',
  signupLimiter,
  validate(registerSchema),
  asyncHandler(async (req, res) => {
    const result = await service.registerSchool(req.body as z.infer<typeof registerSchema>);
    await audit(req, {
      action: 'registration.signup',
      entityType: 'School',
      entityId: result.school.id,
      metadata: { plan: result.plan, status: result.status },
    });
    // 202: the school exists, but nothing has been paid for yet.
    res.status(202).json(result);
  }),
);

registrationRouter.get(
  '/:claimToken',
  pollLimiter,
  asyncHandler(async (req, res) => {
    res.json(await service.registrationStatus(req.params.claimToken as string));
  }),
);

registrationRouter.post(
  '/:claimToken/retry',
  signupLimiter,
  asyncHandler(async (req, res) => {
    res.json(await service.retryRegistrationPayment(req.params.claimToken as string));
  }),
);

/** Constant-time compare so the secret cannot be guessed a byte at a time. */
function secretMatches(expected: string | undefined, presented: string | undefined): boolean {
  if (!expected || !presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * A gateway's own notification, where a deployment has a reachable URL for
 * one. Everything here is also settled by the status poll, so this is an
 * optimisation rather than the only path — which is what lets the sandbox work
 * from a laptop.
 *
 * One route per network, each with its own secret, rather than one endpoint
 * sniffing the body: M-Pesa's `output_ResponseCode` and Airtel's `status_code`
 * overlap in neither values nor meaning, and the provider is what tells the
 * service which of the two it is reading. A callback posted to the other
 * network's route settles nothing.
 */
function callbackRoute(
  path: string,
  provider: MobileMoneyProvider,
  secret: () => string | undefined,
): void {
  registrationRouter.post(
    path,
    // Passthrough on purpose: the body is a gateway's, its shape varies by
    // market, and the provider is what reads it. Nothing in it is trusted —
    // the reference has to be one we issued, it has to belong to this
    // network, and the amount is never read from a callback at all.
    validate(z.object({}).passthrough()),
    asyncHandler(async (req, res) => {
      if (!secretMatches(secret(), req.header('X-Callback-Secret'))) {
        throw forbidden('Invalid callback secret');
      }

      const result = await service.confirmFromCallback(
        provider,
        req.body as Record<string, unknown>,
      );

      // Always 202, matched or not: a gateway retrying against the wrong
      // deployment must not be able to discover which references exist here.
      res.status(202).json({ received: true, matched: result.matched });
    }),
  );
}

callbackRoute('/mpesa/callback', MobileMoneyProvider.MPESA, () => env.MPESA_CALLBACK_SECRET);
callbackRoute(
  '/airtel/callback',
  MobileMoneyProvider.AIRTEL_MONEY,
  () => env.AIRTEL_CALLBACK_SECRET,
);
