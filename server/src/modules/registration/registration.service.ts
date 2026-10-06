import {
  type RegistrationPayment,
  MobileMoneyProvider,
  PaymentStatus,
  Role,
  SchoolStatus,
  SubscriptionPlan,
} from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { env, registrationFee } from '../../config/env.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { hashPassword, randomToken } from '../../lib/tokens.js';
import { money, formatMoney } from '../../lib/money.js';
import {
  sendRegistrationConfirmed,
  sendRegistrationExpired,
  sendRegistrationFailed,
  sendRegistrationStarted,
  type RegistrationNotice,
} from './registration.notify.js';
import {
  anyProviderConfigured,
  paymentProvider,
  providerConfigured,
  providerOffers,
  SELF_SERVICE_PROVIDERS,
  type PaymentOutcome,
  type PaymentProvider,
} from '../../lib/payments/index.js';

export { SELF_SERVICE_PROVIDERS, anyProviderConfigured, providerOffers };

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
  /** Which mobile money network the fee is paid from. */
  provider: MobileMoneyProvider;
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

/**
 * A payment reference the C2B contract will actually accept.
 *
 * `input_TransactionReference` is capped at 20 characters and its pattern
 * (`^[0-9a-zA-Z \w+]{1,20}$`) admits no punctuation, so the readable
 * `REG-<code>-<token>` shape cannot be sent: the hyphens fail it outright, and
 * a 12-character school code overruns the cap on its own. Enough of the school
 * code is kept to recognise a row in the gateway's statement, and the random
 * tail is what makes it unique.
 */
function paymentReference(code: string): string {
  const prefix = code.replace(/[^0-9a-zA-Z]/g, '').slice(0, 4).toUpperCase();
  return `REG${prefix}${randomToken(5)}`;
}

/** What the sign-up page is told. Never includes a gateway credential. */
export interface RegistrationView {
  claimToken: string;
  status: PaymentStatus;
  school: { id: string; name: string; code: string; status: SchoolStatus };
  plan: SubscriptionPlan;
  amount: number;
  currency: string;
  provider: MobileMoneyProvider;
  /** What the school calls the network it is paying from, e.g. "Airtel Money". */
  providerLabel: string;
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
    provider: payment.provider,
    providerLabel: paymentProvider(payment.provider).label,
    msisdn: payment.msisdn,
    message: payment.resultDescription,
    paidAt: payment.paidAt,
    administratorEmail: admin?.email ?? '',
  };
}

/**
 * Gathers what the school needs to be told, from the payment alone.
 *
 * Read fresh each time rather than threaded through: a notice goes out from the
 * callback and the status poll as well as from sign-up, and those have nothing
 * in hand but a payment row.
 */
async function noticeFor(payment: RegistrationPayment): Promise<RegistrationNotice | null> {
  const school = await prisma.school.findUnique({
    where: { id: payment.schoolId },
    select: { id: true, name: true },
  });
  const admin = await prisma.user.findFirst({
    where: { schoolId: payment.schoolId, role: Role.ADMIN },
    orderBy: { createdAt: 'asc' },
    select: { email: true, firstName: true, lastName: true },
  });
  if (!school || !admin) return null;

  return {
    schoolId: school.id,
    schoolName: school.name,
    administratorEmail: admin.email,
    administratorName: `${admin.firstName} ${admin.lastName}`.trim(),
    msisdn: payment.msisdn,
    claimToken: payment.claimToken,
    plan: payment.plan,
    amountText: formatMoney(payment.amount, payment.currency),
    // Every message a school gets names the network it is paying from, so an
    // Airtel customer is not told to enter an M-Pesa PIN.
    providerLabel: paymentProvider(payment.provider).label,
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
  outcome: PaymentOutcome,
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
    // Conditional for the same reason as the confirmation below, and so the
    // refusal is announced once: a payment already marked FAILED matches
    // nothing, and the school is not told twice about one refusal.
    const failed = await prisma.registrationPayment.updateMany({
      where: { id: payment.id, status: PaymentStatus.PENDING },
      data: {
        status: PaymentStatus.FAILED,
        resultCode: outcome.code,
        resultDescription: outcome.description,
        transactionId: outcome.transactionId ?? payment.transactionId,
        conversationId: outcome.conversationId ?? payment.conversationId,
      },
    });

    const current = await prisma.registrationPayment.findUniqueOrThrow({
      where: { id: payment.id },
    });

    if (failed.count > 0) {
      const notice = await noticeFor(current);
      if (notice) await sendRegistrationFailed(notice, outcome.description);
    }

    return current;
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

  const confirmed = await prisma.registrationPayment.findUniqueOrThrow({
    where: { id: payment.id },
  });

  const notice = await noticeFor(confirmed);
  if (notice) await sendRegistrationConfirmed(notice);

  return confirmed;
}

/**
 * A gateway that cannot be reached is not a refused payment: the school keeps
 * its PENDING record and can try again.
 */
async function recordGatewayError(
  paymentId: string,
  provider: PaymentProvider,
  err: unknown,
): Promise<RegistrationPayment> {
  // Every gateway client raises its own error class, and all of them carry the
  // gateway's code when there was one. Read structurally rather than by class,
  // so adding a network does not mean editing this.
  const code = err instanceof Error ? (err as { code?: string | null }).code : null;

  return prisma.registrationPayment.update({
    where: { id: paymentId },
    data: {
      resultCode: code ?? 'GATEWAY_ERROR',
      resultDescription:
        err instanceof Error ? err.message : `Could not reach ${provider.label}`,
    },
  });
}

/** Resolves to null after `ms`, and drops its timer as soon as it is let go. */
function after(ms: number): { elapsed: Promise<null>; cancel: () => void } {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const elapsed = new Promise<null>((resolve) => {
    handle = setTimeout(() => resolve(null), ms);
  });
  return { elapsed, cancel: () => clearTimeout(handle) };
}

/**
 * Pushes the prompt through the school's chosen gateway and records whatever
 * came back. Never throws.
 *
 * The two waits are separated, because for M-Pesa they are wildly different
 * lengths. M-Pesa's push is the one call that waits on a person: the gateway
 * answers it when the customer types their PIN, a minute or two after the
 * sign-up form was submitted. So the request to the gateway is left open for
 * as long as a person plausibly takes, and its answer is recorded whenever it
 * lands, even though nobody is waiting on this function by then. The form
 * itself waits only `provider.pushWaitMs` and then gets the record as it
 * stands, which is what sends the customer to the "check your phone" screen.
 *
 * For M-Pesa that is what makes a payment settle without the status query,
 * which a portal application can refuse (`INS-997`, `INS-999`), and without a
 * callback URL, which a development deployment has no way to receive. Airtel
 * answers its push at once and says nothing about the money, so there its wait
 * is simply the request timeout and the status poll does the settling.
 */
async function push(payment: RegistrationPayment): Promise<RegistrationPayment> {
  const provider = paymentProvider(payment.provider);

  if (!provider.configured) {
    return prisma.registrationPayment.update({
      where: { id: payment.id },
      data: {
        resultCode: 'NOT_CONFIGURED',
        resultDescription:
          `${provider.label} is not configured on this deployment, so no payment prompt was sent.`,
      },
    });
  }

  // Deliberately not awaited here: the chain below outlives the HTTP request
  // that started it. Every path settles, so this cannot reject unobserved.
  const settled = provider
    .push({
      amount: Number(payment.amount),
      currency: payment.currency,
      msisdn: payment.msisdn,
      reference: payment.reference,
      description: `${payment.plan} registration`,
    })
    .then((outcome) => applyOutcome(payment.id, outcome))
    .catch((err: unknown) => recordGatewayError(payment.id, provider, err))
    .catch(() => null);

  const waited = after(provider.pushWaitMs);
  try {
    const answered = await Promise.race([settled, waited.elapsed]);
    return answered ?? prisma.registrationPayment.findUniqueOrThrow({ where: { id: payment.id } });
  } finally {
    waited.cancel();
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
  // Refused here rather than silently downgraded to M-Pesa: a school that
  // picked Airtel has an Airtel number in the box, and pushing that to
  // Vodacom's gateway is a payment that cannot work and an error that explains
  // nothing.
  if (!SELF_SERVICE_PROVIDERS.includes(input.provider)) {
    throw badRequest(`${input.provider} cannot be used to pay a registration fee`, {
      field: 'provider',
    });
  }

  const msisdn = normalizeMsisdn(input.msisdn);
  const code = input.code.toUpperCase();
  const adminEmail = input.admin.email.trim().toLowerCase();

  const holder = await prisma.school.findUnique({
    where: { code },
    select: { id: true, status: true },
  });

  if (holder) {
    // The code may be held by a sign-up nobody ever paid for. Release it now
    // rather than making this school wait for the next sweep — which is
    // exactly the moment it matters, and the only moment anyone notices.
    if (holder.status === SchoolStatus.PENDING_PAYMENT) {
      await expireStaleRegistrations();
    }
    if (await prisma.school.findUnique({ where: { code }, select: { id: true } })) {
      throw conflict('That school code is already taken', { field: 'code' });
    }
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
        provider: input.provider,
        msisdn,
        reference: paymentReference(code),
        claimToken: randomToken(),
      },
    });
  });

  // Sent before the push, so that the school has its password and its payment
  // link in hand whatever the gateway then says — and so this message arrives
  // ahead of any confirmation the push itself produces.
  const notice = await noticeFor(created);
  if (notice) await sendRegistrationStarted(notice, temporaryPassword);

  const pushed = await push(created);
  const result = await view(pushed);

  return {
    ...result,
    // Also handed back outside production, where a development machine usually
    // has no mail transport and the outbox is the only record of it.
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

  // A refusal counts as settled: the gateway has given its answer, and the way
  // forward is the retry button, which reopens the record. Without this a
  // failed payment would be re-queried on every poll for as long as the page
  // stayed open.
  const settled =
    payment.status === PaymentStatus.CONFIRMED ||
    payment.status === PaymentStatus.REVERSED ||
    payment.status === PaymentStatus.FAILED;
  const old = Date.now() - payment.createdAt.getTime() > RECONCILE_AFTER_MS;

  if (!settled && old && providerConfigured(payment.provider)) {
    try {
      const provider = paymentProvider(payment.provider);
      payment = await applyOutcome(payment.id, await provider.queryStatus(payment.reference));
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
    select: { code: true, status: true },
  });

  // A claim link outlives the registration it belongs to, so it can still be
  // opened after the registration was cancelled or the school suspended. Only
  // a school still waiting to be let in may be charged: confirming a payment
  // opens nothing in any other state, which would be money taken for nothing.
  if (school && school.status !== SchoolStatus.PENDING_PAYMENT) {
    throw conflict(
      'This registration is no longer open. Please register again.',
      { schoolStatus: school.status },
    );
  }

  const reopened = await prisma.registrationPayment.update({
    where: { id: payment.id },
    data: {
      status: PaymentStatus.PENDING,
      // A new reference, because the gateway refuses a repeat of one it has
      // already seen. It still carries the school code, which is what makes it
      // readable on a statement.
      reference: paymentReference(school?.code ?? 'SCHOOL'),
      resultCode: null,
      resultDescription: null,
    },
  });

  return view(await push(reopened));
}

/**
 * Gives up on registrations nobody ever paid for.
 *
 * An unpaid sign-up holds its school code against everyone else, including the
 * school that chose it — so without this, one abandoned attempt costs a school
 * the name it wanted permanently, and the row sits in PENDING_PAYMENT forever.
 *
 * The code is released by lengthening it past the twelve characters sign-up
 * accepts, which no new registration can produce, so the original is free
 * again while the record of what happened survives. The school is moved to
 * CANCELLED rather than deleted: it cost nothing to keep, and deleting cascades
 * through every table a school owns.
 */
export async function expireStaleRegistrations(
  now: Date = new Date(),
): Promise<{ expired: number }> {
  const cutoff = new Date(now.getTime() - env.REGISTRATION_TTL_DAYS * 24 * 60 * 60 * 1000);

  const stale = await prisma.school.findMany({
    where: {
      status: SchoolStatus.PENDING_PAYMENT,
      createdAt: { lt: cutoff },
      // Belt and braces: a school with a confirmed payment should never still
      // be PENDING_PAYMENT, and if one is, it is not ours to cancel.
      registrationPayments: { none: { status: PaymentStatus.CONFIRMED } },
    },
    select: { id: true, code: true, name: true },
    // Bounded because sign-up runs this sweep when it finds a code held by a
    // stale registration, and no one request should ever be made to clear a
    // backlog. The script, or the next sign-up, takes the rest.
    take: 200,
    orderBy: { createdAt: 'asc' },
  });

  let expired = 0;

  for (const school of stale) {
    const payments = await prisma.registrationPayment.findMany({
      where: { schoolId: school.id },
      orderBy: { createdAt: 'desc' },
    });

    // Read before the work and sent after it, so a transaction that fails
    // cannot leave a school told its registration was cancelled when it was
    // not.
    const latest = payments[0];
    const notice = latest ? await noticeFor(latest) : null;

    await prisma.$transaction([
      prisma.registrationPayment.updateMany({
        where: { schoolId: school.id, status: PaymentStatus.PENDING },
        data: {
          status: PaymentStatus.FAILED,
          resultCode: 'EXPIRED',
          resultDescription: `Not paid within ${env.REGISTRATION_TTL_DAYS} days`,
        },
      }),
      prisma.school.update({
        where: { id: school.id },
        data: {
          status: SchoolStatus.CANCELLED,
          code: `${school.code}-EXP-${school.id.slice(-6).toUpperCase()}`,
        },
      }),
      // Nobody signs in to a cancelled school, and `authenticate` refuses it
      // anyway; revoking is what makes that true immediately.
      prisma.session.updateMany({
        where: { user: { schoolId: school.id }, revokedAt: null },
        data: { revokedAt: now },
      }),
    ]);

    if (notice) await sendRegistrationExpired(notice, env.REGISTRATION_TTL_DAYS);

    expired += 1;
  }

  return { expired };
}

/**
 * Settles a payment from a gateway callback.
 *
 * The callback is unauthenticated by nature, so it is accepted only when it
 * carries a reference we issued; the shared secret is checked by the route
 * before this is reached. It can only ever move a payment forward, and the
 * amount is never read from the callback — it is whatever we priced.
 *
 * Each gateway reads its own body, through its provider: M-Pesa's `output_*`
 * response codes and Airtel's `status_code` mean different things, and one
 * endpoint guessing between the two would eventually guess wrong about
 * somebody's money. The provider is also checked against the payment, so a
 * callback posted to the wrong endpoint settles nothing.
 */
export async function confirmFromCallback(
  provider: MobileMoneyProvider,
  body: Record<string, unknown>,
): Promise<{ matched: boolean; status?: PaymentStatus }> {
  const { reference, outcome } = paymentProvider(provider).outcomeFromCallback(body);
  if (!reference) return { matched: false };

  const payment = await prisma.registrationPayment.findUnique({ where: { reference } });

  // An unknown reference is not an error worth telling the caller about: a
  // gateway retrying against the wrong deployment would learn which references
  // exist here. The same goes for one belonging to the other network.
  if (!payment || payment.provider !== provider) return { matched: false };

  const updated = await applyOutcome(payment.id, outcome);
  return { matched: true, status: updated.status };
}
