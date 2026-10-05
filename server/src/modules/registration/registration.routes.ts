import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { timingSafeEqual } from 'node:crypto';
import { asyncHandler, validate } from '../../lib/http.js';
import { env, isProduction, mpesaConfigured } from '../../config/env.js';
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
  /** The phone that will be prompted for a PIN. */
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
      paymentsEnabled: mpesaConfigured,
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
function secretMatches(presented: string | undefined): boolean {
  if (!env.MPESA_CALLBACK_SECRET || !presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(env.MPESA_CALLBACK_SECRET);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The gateway's own notification, where a deployment has a reachable URL for
 * one. Everything here is also settled by the status poll, so this is an
 * optimisation rather than the only path — which is what lets the sandbox work
 * from a laptop.
 *
 * Field names follow the gateway's `output_*` convention, with the plain names
 * accepted too since the callback shape varies by market.
 */
const callbackSchema = z
  .object({
    input_ThirdPartyConversationID: z.string().optional(),
    output_ThirdPartyConversationID: z.string().optional(),
    reference: z.string().optional(),
    output_ResponseCode: z.string().optional(),
    resultCode: z.string().optional(),
    output_ResponseDesc: z.string().optional(),
    resultDescription: z.string().optional(),
    output_TransactionID: z.string().optional(),
    transactionId: z.string().optional(),
    output_ConversationID: z.string().optional(),
    conversationId: z.string().optional(),
  })
  .passthrough();

registrationRouter.post(
  '/mpesa/callback',
  validate(callbackSchema),
  asyncHandler(async (req, res) => {
    if (!secretMatches(req.header('X-Callback-Secret'))) {
      throw forbidden('Invalid callback secret');
    }

    const body = req.body as z.infer<typeof callbackSchema>;
    const reference =
      body.output_ThirdPartyConversationID ??
      body.input_ThirdPartyConversationID ??
      body.reference;

    if (!reference) {
      res.status(202).json({ received: true, matched: false });
      return;
    }

    const result = await service.confirmFromCallback({
      reference,
      resultCode: body.output_ResponseCode ?? body.resultCode,
      resultDescription: body.output_ResponseDesc ?? body.resultDescription,
      transactionId: body.output_TransactionID ?? body.transactionId,
      conversationId: body.output_ConversationID ?? body.conversationId,
    });

    // Always 202, matched or not: a gateway retrying against the wrong
    // deployment must not be able to discover which references exist here.
    res.status(202).json({ received: true, matched: result.matched });
  }),
);
