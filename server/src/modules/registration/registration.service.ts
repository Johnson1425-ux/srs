import {
  type RegistrationPayment,
  PaymentStatus,
  Role,
  SchoolStatus,
  SubscriptionPlan,
} from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { env, registrationFee } from '../../config/env.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { hashPassword, randomToken } from '../../lib/tokens.js';
import { money } from '../../lib/money.js';
import {
  MpesaError,
  c2bPayment,
  mpesaConfigured,
  queryStatus,
  stateForCode,
  type MpesaOutcome,
} from '../../lib/mpesa/index.js';

/** Plans a school may buy itself. TRIAL is granted by an operator, never sold. */
export const SELF_SERVICE_PLANS = [
  SubscriptionPlan.BASIC,
  SubscriptionPlan.STANDARD,
  SubscriptionPlan.PREMIUM,
] as const;

/** Mirrors the platform module's table: a plan carries its own limits. */
const PLAN_LIMITS: Record<SubscriptionPlan, { maxStudents: number; storageQuotaMb: number }> = {
  TRIAL: { maxStudents: 100, storageQuotaMb: 512 },
  BASIC: { maxStudents: 500, storageQuotaMb: 2048 },
  STANDARD: { maxStudents: 2000, storageQuotaMb: 10240 },
  PREMIUM: { maxStudents: 5000, storageQuotaMb: 51200 },
};

/** What one plan costs and grants, for the sign-up page's price list. */
export function planOffer(plan: SubscriptionPlan): {
  amount: number;
  currency: string;
  maxStudents: number;
  storageQuotaMb: number;
} {
  return { amount: registrationFee(plan), currency: 'TZS', ...PLAN_LIMITS[plan] };
}

/** How long after the push before a poll bothers the gateway for a verdict. */
const RECONCILE_AFTER_MS = 3000;

export interface RegisterSchoolInput {
  name: string;
  code: string;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  city?: string | null;
  region?: string | null;
  plan: (typeof SELF_SERVICE_PLANS)[number];
  msisdn: string;
  admin: { firstName: string; lastName: string; email: string; phone?: string };
}

/**
 * Normalises a Tanzanian number to the 255XXXXXXXXX the gateway expects.
 *
 * People type their number every way there is — `0754…`, `+255 754…`,
 * `255-754-…` — and the gateway rejects all but one of them with a code that
 * says nothing about why.
 */
export function normalizeMsisdn(input: string): string {
  const digits = input.replace(/\D/g, '');

  if (digits.startsWith('255') && digits.length === 12) return digits;
  if (digits.startsWith('0') && digits.length === 10) return `255${digits.slice(1)}`;
  if (digits.length === 9) return `255${digits}`;

  throw badRequest('Enter a Tanzanian mobile number, for example 0754 123 456', {
    field: 'msisdn',
  });
}

/** What the sign-up page is told. Never includes a gateway credential. */
export interface RegistrationView {
  claimToken: string;
  status: PaymentStatus;
  school: { id: string; name: string; code: string; status: SchoolStatus };
  plan: SubscriptionPlan;
  amount: number;
  currency: string;
  msisdn: string;
  /** The gateway's own words, which are what a caller can actually act on. */
  message: string | null;
  paidAt: Date | null;
  administratorEmail: string;
  /** Present only on the response to sign-up itself, and only outside production. */
  temporaryPassword?: string;
}

async function view(payment: RegistrationPayment): Promise<RegistrationView> {
  const school = await prisma.school.findUnique({
    where: { id: payment.schoolId },
    select: { id: true, name: true, code: true, status: true },
  });
  if (!school) throw notFound('School');

  const admin = await prisma.user.findFirst({
    where: { schoolId: payment.schoolId, role: Role.ADMIN },
    orderBy: { createdAt: 'asc' },
    select: { email: true },
  });

  return {
    claimToken: payment.claimToken,
    status: payment.status,
    school,
    plan: payment.plan,
    amount: Number(payment.amount),
    currency: payment.currency,
    msisdn: payment.msisdn,
    message: payment.resultDescription,
    paidAt: payment.paidAt,
    administratorEmail: admin?.email ?? '',
  };
}

/**
 * Records the gateway's verdict and, on success, lets the school in.
 *
 * Idempotent on purpose: a callback and a status poll can arrive at the same
 * moment, and whichever is second must change nothing. A payment that has
 * already settled is never moved again, so a late callback cannot reopen a
 * school that was refunded and suspended.
 */
export async function applyOutcome(
  paymentId: string,
  outcome: MpesaOutcome,
): Promise<RegistrationPayment> {
  const payment = await prisma.registrationPayment.findUnique({ where: { id: paymentId } });
  if (!payment) throw notFound('Registration payment');

  if (payment.status === PaymentStatus.CONFIRMED || payment.status === PaymentStatus.REVERSED) {
    return payment;
  }

  if (outcome.state === 'pending') {
    return prisma.registrationPayment.update({
      where: { id: payment.id },
      data: {
        resultCode: outcome.code ?? payment.resultCode,
        resultDescription: outcome.description ?? payment.resultDescription,
        transactionId: outcome.transactionId ?? payment.transactionId,
        conversationId: outcome.conversationId ?? payment.conversationId,
      },
    });
  }

  if (outcome.state === 'failed') {
    return prisma.registrationPayment.update({
      where: { id: payment.id },
      data: {
        status: PaymentStatus.FAILED,
        resultCode: outcome.code,
        resultDescription: outcome.description,
        transactionId: outcome.transactionId ?? payment.transactionId,
        conversationId: outcome.conversationId ?? payment.conversationId,
      },
    });
  }

  const limits = PLAN_LIMITS[payment.plan];
  const paidAt = new Date();

  // Claimed conditionally rather than with a plain update, so a callback and a
  // status poll arriving together cannot both confirm the same payment: the
  // second one matches nothing and reads back what the first wrote.
  const claimed = await prisma.registrationPayment.updateMany({
    where: {
      id: payment.id,
      status: { in: [PaymentStatus.PENDING, PaymentStatus.FAILED] },
    },
    data: {
      status: PaymentStatus.CONFIRMED,
      resultCode: outcome.code,
      resultDescription: outcome.description,
      transactionId: outcome.transactionId ?? payment.transactionId,
      conversationId: outcome.conversationId ?? payment.conversationId,
      paidAt,
    },
  });

  if (claimed.count === 0) {
    return prisma.registrationPayment.findUniqueOrThrow({ where: { id: payment.id } });
  }

  // Only a school that is actually waiting to be let in is let in. One an
  // operator has since suspended stays suspended — a payment settling is not a
  // reason to undo that — and the fee is still recorded against it.
  await prisma.school.updateMany({
    where: { id: payment.schoolId, status: SchoolStatus.PENDING_PAYMENT },
    data: {
      status: SchoolStatus.ACTIVE,
      plan: payment.plan,
      planStartsAt: paidAt,
      planEndsAt: new Date(paidAt.getTime() + 365 * 24 * 60 * 60 * 1000),
      maxStudents: limits.maxStudents,
      storageQuotaMb: limits.storageQuotaMb,
      registrationPaidAt: paidAt,
    },
  });

  return prisma.registrationPayment.findUniqueOrThrow({ where: { id: payment.id } });
}

/** Pushes the PIN prompt and records whatever came back. Never throws. */
async function push(payment: RegistrationPayment): Promise<RegistrationPayment> {
  if (!mpesaConfigured) {
    return prisma.registrationPayment.update({
      where: { id: payment.id },
      data: {
        resultCode: 'NOT_CONFIGURED',
        resultDescription:
          'M-Pesa is not configured on this deployment, so no payment prompt was sent.',
      },
    });
  }

  try {
    const outcome = await c2bPayment({
      amount: Number(payment.amount),
      currency: payment.currency,
      msisdn: payment.msisdn,
      reference: payment.reference,
      description: `${payment.plan} registration`,
    });
    return applyOutcome(payment.id, outcome);
  } catch (err) {
    // A gateway that cannot be reached is not a refused payment: the school
    // keeps its PENDING record and can try again.
    return prisma.registrationPayment.update({
      where: { id: payment.id },
      data: {
        resultCode: err instanceof MpesaError ? (err.code ?? 'GATEWAY_ERROR') : 'GATEWAY_ERROR',
        resultDescription: err instanceof Error ? err.message : 'Could not reach M-Pesa',
      },
    });
  }
}

/**
 * Signs a school up and asks it to pay.
 *
 * The school and its first administrator are created in one transaction so a
 * failed sign-up leaves nothing half-built, and the school lands on
 * PENDING_PAYMENT: it exists, it can be paid for, and until it is, nobody but
 * platform staff can reach the application with it.
 */
export async function registerSchool(input: RegisterSchoolInput): Promise<RegistrationView> {
  const msisdn = normalizeMsisdn(input.msisdn);
  const code = input.code.toUpperCase();
  const adminEmail = input.admin.email.trim().toLowerCase();

  if (await prisma.school.findUnique({ where: { code }, select: { id: true } })) {
    throw conflict('That school code is already taken', { field: 'code' });
  }

  const amount = registrationFee(input.plan);
  if (amount <= 0) {
    // Only reachable by misconfiguration: a plan priced at zero would hand out
    // a working school for nothing on a public endpoint.
    throw badRequest(`The ${input.plan} plan has no registration fee configured`, {
      field: 'plan',
    });
  }

  const temporaryPassword = `Sms-${randomToken(5)}`;
  const limits = PLAN_LIMITS[input.plan];

  const created = await prisma.$transaction(async (tx) => {
    const school = await tx.school.create({
      data: {
        name: input.name,
        code,
        email: input.email ?? null,
        phone: input.phone ?? null,
        address: input.address ?? null,
        city: input.city ?? null,
        region: input.region ?? null,
        plan: input.plan,
        status: SchoolStatus.PENDING_PAYMENT,
        maxStudents: limits.maxStudents,
        storageQuotaMb: limits.storageQuotaMb,
      },
    });

    await tx.user.create({
      data: {
        schoolId: school.id,
        email: adminEmail,
        phone: input.admin.phone ?? null,
        firstName: input.admin.firstName,
        lastName: input.admin.lastName,
        role: Role.ADMIN,
        passwordHash: await hashPassword(temporaryPassword),
        mustChangePassword: true,
      },
    });

    // The same defaults an operator-created school gets, so a paid school can
    // start entering marks the moment it is let in.
    await tx.gradeScale.create({
      data: {
        schoolId: school.id,
        name: 'Default (Tanzania)',
        isDefault: true,
        bands: {
          create: [
            { grade: 'A', minScore: 75, maxScore: 100, points: 5, remark: 'Excellent' },
            { grade: 'B', minScore: 65, maxScore: 74.99, points: 4, remark: 'Very Good' },
            { grade: 'C', minScore: 45, maxScore: 64.99, points: 3, remark: 'Good' },
            { grade: 'D', minScore: 30, maxScore: 44.99, points: 2, remark: 'Satisfactory' },
            { grade: 'F', minScore: 0, maxScore: 29.99, points: 1, remark: 'Fail' },
          ],
        },
      },
    });

    return tx.registrationPayment.create({
      data: {
        schoolId: school.id,
        plan: input.plan,
        amount: money(amount),
        currency: 'TZS',
        msisdn,
        reference: `REG-${code}-${randomToken(6)}`,
        claimToken: randomToken(),
      },
    });
  });

  const pushed = await push(created);
  const result = await view(pushed);

  return {
    ...result,
    // No mail transport is wired up yet, so outside production the password is
    // handed back rather than lost. Mirrors /auth/forgot-password.
    ...(env.NODE_ENV === 'production' ? {} : { temporaryPassword }),
  };
}

async function findByClaimToken(claimToken: string): Promise<RegistrationPayment> {
  const payment = await prisma.registrationPayment.findUnique({ where: { claimToken } });
  if (!payment) throw notFound('Registration');
  return payment;
}

/**
 * Where the sign-up page's "waiting for your PIN" screen gets its answer.
 *
 * Asks the gateway for a verdict when the record is still open and the push is
 * old enough to have one. That reconciliation is what makes the sandbox work
 * without a publicly reachable callback URL.
 */
export async function registrationStatus(claimToken: string): Promise<RegistrationView> {
  let payment = await findByClaimToken(claimToken);

  const settled =
    payment.status === PaymentStatus.CONFIRMED || payment.status === PaymentStatus.REVERSED;
  const old = Date.now() - payment.createdAt.getTime() > RECONCILE_AFTER_MS;

  if (!settled && old && mpesaConfigured) {
    try {
      payment = await applyOutcome(payment.id, await queryStatus(payment.reference));
    } catch {
      // A gateway that will not answer leaves the record as it is; the page
      // polls again.
    }
  }

  return view(payment);
}

/** Pushes the prompt again after a refusal, without creating a second school. */
export async function retryRegistrationPayment(claimToken: string): Promise<RegistrationView> {
  const payment = await findByClaimToken(claimToken);

  if (payment.status === PaymentStatus.CONFIRMED) {
    throw conflict('This registration has already been paid for');
  }

  const school = await prisma.school.findUnique({
    where: { id: payment.schoolId },
    select: { code: true },
  });

  const reopened = await prisma.registrationPayment.update({
    where: { id: payment.id },
    data: {
      status: PaymentStatus.PENDING,
      // A new reference, because the gateway refuses a repeat of one it has
      // already seen. It still carries the school code, which is what makes it
      // readable on a statement.
      reference: `REG-${school?.code ?? 'SCHOOL'}-${randomToken(6)}`,
      resultCode: null,
      resultDescription: null,
    },
  });

  return view(await push(reopened));
}

/**
 * Settles a payment from a gateway callback.
 *
 * The callback is unauthenticated by nature, so it is accepted only when it
 * carries a reference we issued; the shared secret is checked by the route
 * before this is reached. It can only ever move a payment forward, and the
 * amount is never read from the callback — it is whatever we priced.
 */
export async function confirmFromCallback(payload: {
  reference: string;
  resultCode?: string;
  resultDescription?: string;
  transactionId?: string;
  conversationId?: string;
}): Promise<{ matched: boolean; status?: PaymentStatus }> {
  const payment = await prisma.registrationPayment.findUnique({
    where: { reference: payload.reference },
  });

  // An unknown reference is not an error worth telling the caller about: a
  // gateway retrying against the wrong deployment would learn which references
  // exist here.
  if (!payment) return { matched: false };

  const outcome: MpesaOutcome = {
    state: stateForCode(payload.resultCode),
    code: payload.resultCode ?? null,
    description: payload.resultDescription ?? null,
    transactionId: payload.transactionId ?? null,
    conversationId: payload.conversationId ?? null,
  };

  const updated = await applyOutcome(payment.id, outcome);
  return { matched: true, status: updated.status };
}
