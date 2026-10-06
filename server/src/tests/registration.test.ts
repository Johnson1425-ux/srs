import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { prisma } from '../db/prisma.js';
import { app, uid } from './fixtures.js';
import { resetSessionCache } from '../lib/mpesa/index.js';
import {
  expireStaleRegistrations,
  normalizeMsisdn,
} from '../modules/registration/registration.service.js';
import { toPem } from '../lib/mpesa/crypto.js';
import { stateForCode } from '../lib/mpesa/types.js';
import { signAccessToken } from '../lib/tokens.js';

/**
 * The published response-code table, as the portal documents it.
 *
 * Every code here is either a wait or a refusal, and getting one wrong is
 * expensive in opposite directions: a refusal read as a wait leaves a school in
 * PENDING_PAYMENT being polled forever, and a wait read as a refusal fails a
 * payment the customer is still in the middle of approving.
 */
describe('M-Pesa response codes', () => {
  const PENDING = ['INS-1', 'INS-9', 'INS-10'];

  const REFUSALS = [
    'INS-6', // Transaction Failed
    'INS-13', // Invalid Shortcode Used
    'INS-15', // Invalid Amount Used
    'INS-17', // Invalid Transaction Reference
    'INS-20', // Not All Parameters Provided
    'INS-21', // Parameter validations failed
    'INS-26', // Invalid Currency Used
    'INS-28', // Invalid ThirdPartyConversationID Used
    'INS-30', // Invalid Purchased Items Description Used
    'INS-990', // Customer Transaction Value Limit Breached
    'INS-991', // Customer Transaction Count Limit Breached
    'INS-992', // Multiple Limits Breached
    'INS-993', // Organization Transaction Count Limit Breached
    'INS-994', // Organization Transaction Value Limit Breached
    'INS-995', // API Single Transaction Limit Breached
    'INS-996', // API Being Used Outside Of Usage Time
    'INS-997', // API Not Enabled
    'INS-998', // Invalid Market
    'INS-2006', // Insufficient balance
    'INS-2051', // MSISDN invalid
  ];

  it('confirms only on INS-0', () => {
    expect(stateForCode('INS-0')).toBe('confirmed');
  });

  it.each(PENDING)('waits on %s', (code) => {
    expect(stateForCode(code)).toBe('pending');
  });

  it.each(REFUSALS)('refuses %s', (code) => {
    expect(stateForCode(code)).toBe('failed');
  });

  // A limit breach does not come back under the limit by being asked again,
  // so polling one is how a school waits for an answer that never arrives.
  it('treats a breached limit as a refusal, not something to poll', () => {
    expect(stateForCode('INS-995')).toBe('failed');
  });

  // No code at all is the one genuinely unknown case: the push may still be
  // live on the handset, so it is waited on rather than failed.
  it('waits when the gateway said nothing at all', () => {
    expect(stateForCode(null)).toBe('pending');
    expect(stateForCode(undefined)).toBe('pending');
  });
});

/** People type their number every way there is; the gateway accepts one. */
describe('M-Pesa number normalisation', () => {
  it('accepts the three forms a Tanzanian number is written in', () => {
    expect(normalizeMsisdn('0754123456')).toBe('255754123456');
    expect(normalizeMsisdn('+255 754 123 456')).toBe('255754123456');
    expect(normalizeMsisdn('754123456')).toBe('255754123456');
  });

  // The sandbox answers these with fixed scenarios, and they are the only way
  // to exercise a path that needs a customer to tap something on a handset.
  it('lets the sandbox test handsets through untouched', () => {
    expect(normalizeMsisdn('000000000001')).toBe('000000000001');
    expect(normalizeMsisdn('000000000008')).toBe('000000000008');
    // Still twelve digits, which is what the gateway's own pattern asks for.
    expect(normalizeMsisdn('000000000001')).toMatch(/^[0-9]{12,14}$/);
  });

  it('refuses anything that is not one of them, rather than guessing', () => {
    expect(() => normalizeMsisdn('12345')).toThrow(/Tanzanian mobile number/);
    expect(() => normalizeMsisdn('07541234567')).toThrow(/Tanzanian mobile number/);
  });
});

/** The portal shows one long base64 line; Node wants PEM. */
describe('M-Pesa public key handling', () => {
  it('wraps a bare base64 key in PEM armour at 64 characters a line', () => {
    const pem = toPem('A'.repeat(100));
    expect(pem.startsWith('-----BEGIN PUBLIC KEY-----\n')).toBe(true);
    expect(pem.trimEnd().endsWith('-----END PUBLIC KEY-----')).toBe(true);
    expect(pem.split('\n')[1]).toHaveLength(64);
  });

  it('leaves a key that already has its armour alone', () => {
    const armoured = '-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----';
    expect(toPem(` ${armoured} `)).toBe(armoured);
  });
});

const ok = (body: unknown) =>
  Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(body)) });

const SESSION = { output_ResponseCode: 'INS-0', output_SessionID: 'test-session' };

interface SignUpBody {
  name: string;
  code: string;
  plan: 'BASIC' | 'STANDARD' | 'PREMIUM';
  msisdn: string;
  admin: { firstName: string; lastName: string; email: string };
}

function signUpBody(overrides: Partial<SignUpBody> = {}): SignUpBody {
  const suffix = uid();
  return {
    name: `Registered School ${suffix}`,
    code: `R${suffix.slice(-6).toUpperCase()}`,
    plan: 'BASIC',
    msisdn: '0754123456',
    admin: {
      firstName: 'Asha',
      lastName: 'Mbeki',
      email: `head-${suffix}@school.test`,
    },
    ...overrides,
  };
}

describe('school registration behind an M-Pesa payment', () => {
  const fetchMock = vi.fn();
  const created: string[] = [];

  beforeEach(() => {
    fetchMock.mockReset();
    resetSessionCache();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    await prisma.school.deleteMany({ where: { id: { in: created } } });
    await prisma.$disconnect();
  });

  /**
   * Answers `getSession` whenever it is asked — the client caches the session,
   * so whether it asks at all depends on what ran before — and hands out the
   * queued responses for everything else, in order.
   */
  function gateway(...responses: unknown[]): void {
    const queue = [...responses];
    fetchMock.mockImplementation((url: unknown) => {
      if (String(url).includes('getSession')) return ok(SESSION);
      return ok(queue.shift() ?? { output_ResponseCode: 'INS-9' });
    });
  }

  async function signUp(overrides: Partial<SignUpBody> = {}) {
    const body = signUpBody(overrides);
    const res = await request(app).post('/api/v1/registration').send(body);
    if (res.status === 202) created.push(res.body.school.id as string);
    return { res, body };
  }

  it('prices the plans it will sell, and says whether it can take money', async () => {
    const res = await request(app).get('/api/v1/registration/plans');

    expect(res.status).toBe(200);
    expect(res.body.currency).toBe('TZS');
    expect(res.body.paymentsEnabled).toBe(true);
    expect(res.body.data.map((p: { plan: string }) => p.plan)).toEqual([
      'BASIC',
      'STANDARD',
      'PREMIUM',
    ]);
    // A trial is free, so it is not on offer: a free option on a public
    // endpoint would be a way straight past the gate.
    expect(res.body.data.every((p: { amount: number }) => p.amount > 0)).toBe(true);
  });

  it('refuses the free trial plan on the public endpoint', async () => {
    gateway();
    const res = await request(app)
      .post('/api/v1/registration')
      .send({ ...signUpBody(), plan: 'TRIAL' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('creates the school unpaid, hands back no tokens, and asks for a PIN', async () => {
    // The prompt is on the phone and unanswered: INS-9 is "still waiting".
    gateway({ output_ResponseCode: 'INS-9', output_ResponseDesc: 'Request timeout' });

    const { res, body } = await signUp();

    expect(res.status).toBe(202);
    expect(res.body.status).toBe('PENDING');
    expect(res.body.school.status).toBe('PENDING_PAYMENT');
    expect(res.body.amount).toBe(150000);
    expect(res.body.msisdn).toBe('255754123456');
    expect(res.body.claimToken).toBeTruthy();
    // Nothing that would let the caller in.
    expect(res.body.accessToken).toBeUndefined();
    expect(res.body.refreshToken).toBeUndefined();

    // The amount is priced on the server, whatever the browser sent.
    const payment = await prisma.registrationPayment.findUniqueOrThrow({
      where: { claimToken: res.body.claimToken },
    });
    expect(Number(payment.amount)).toBe(150000);
    expect(payment.msisdn).toBe('255754123456');

    const amountSent = JSON.parse(fetchMock.mock.calls[1]![1].body as string);
    expect(amountSent.input_Amount).toBe('150000.00');
    expect(amountSent.input_ThirdPartyConversationID).toBe(payment.reference);
    expect(amountSent.input_CustomerMSISDN).toBe('255754123456');
    // The credential never appears in the body — it is an encrypted bearer.
    expect(fetchMock.mock.calls[1]![1].headers.Authorization).toMatch(/^Bearer .+/);
    expect(amountSent.input_Amount).not.toContain('api-key');

    expect(body.admin.email).toBeTruthy();
  });

  it('sends a payment body every field of which the C2B contract accepts', async () => {
    gateway({ output_ResponseCode: 'INS-9' });

    // The longest code the sign-up form allows, since the reference is built
    // from it and input_TransactionReference is the field with the least room.
    await signUp({ code: 'ABCDEFGH1234' });

    const sent = JSON.parse(fetchMock.mock.calls[1]![1].body as string);

    // Straight from the published C2B Single Payment parameter table. A
    // reference carrying a hyphen, or one character over the cap, is refused
    // by the gateway rather than by anything here, so the contract is checked
    // on our side instead of in production.
    expect(sent.input_Amount).toMatch(/^\d*\.?\d+$/);
    expect(sent.input_CustomerMSISDN).toMatch(/^[0-9]{12,14}$/);
    expect(sent.input_Currency).toMatch(/^[a-zA-Z]{1,3}$/);
    expect(sent.input_ServiceProviderCode).toMatch(/^([0-9A-Za-z]{4,12})$/);
    expect(sent.input_TransactionReference).toMatch(/^[0-9a-zA-Z \w+]{1,20}$/);
    expect(sent.input_ThirdPartyConversationID).toMatch(/^[0-9a-zA-Z \w+]{1,40}$/);
    expect(sent.input_PurchasedItemsDesc).toMatch(/^[0-9a-zA-Z \w+]{1,256}$/);
  });

  it('will not let an unpaid school sign in, but says how to finish paying', async () => {
    gateway({ output_ResponseCode: 'INS-9', output_ResponseDesc: 'Request timeout' });
    const { res } = await signUp();
    const { temporaryPassword, administratorEmail, claimToken } = res.body;

    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: administratorEmail, password: temporaryPassword });

    expect(login.status).toBe(402);
    expect(login.body.error.code).toBe('PAYMENT_REQUIRED');
    expect(login.body.error.details.claimToken).toBe(claimToken);
    expect(login.body.accessToken).toBeUndefined();
  });

  it('refuses an access token minted for an unpaid school', async () => {
    gateway({ output_ResponseCode: 'INS-9', output_ResponseDesc: 'Request timeout' });
    const { res } = await signUp();

    const admin = await prisma.user.findFirstOrThrow({
      where: { schoolId: res.body.school.id },
    });
    // Signed with the real secret: the gate has to hold on the request path,
    // not only at login.
    const token = signAccessToken({
      sub: admin.id,
      schoolId: admin.schoolId,
      role: admin.role,
    });

    const me = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`);
    expect(me.status).toBe(402);

    const students = await request(app)
      .get('/api/v1/students')
      .set('Authorization', `Bearer ${token}`);
    expect(students.status).toBe(402);
  });

  it('opens the school when the callback confirms the payment', async () => {
    gateway({ output_ResponseCode: 'INS-9', output_ResponseDesc: 'Request timeout' });
    const { res } = await signUp({ plan: 'STANDARD' });
    const { claimToken, temporaryPassword, administratorEmail } = res.body;
    const payment = await prisma.registrationPayment.findUniqueOrThrow({ where: { claimToken } });

    const callback = {
      output_ThirdPartyConversationID: payment.reference,
      output_ResponseCode: 'INS-0',
      output_ResponseDesc: 'Request processed successfully',
      output_TransactionID: 'TXN12345',
    };

    const forged = await request(app)
      .post('/api/v1/registration/mpesa/callback')
      .set('X-Callback-Secret', 'not-the-secret')
      .send(callback);
    expect(forged.status).toBe(403);

    const unsigned = await request(app)
      .post('/api/v1/registration/mpesa/callback')
      .send(callback);
    expect(unsigned.status).toBe(403);

    // Still unpaid after both attempts.
    expect(
      (await prisma.school.findUniqueOrThrow({ where: { id: res.body.school.id } })).status,
    ).toBe('PENDING_PAYMENT');

    const accepted = await request(app)
      .post('/api/v1/registration/mpesa/callback')
      .set('X-Callback-Secret', 'test-callback-secret')
      .send(callback);
    expect(accepted.status).toBe(202);
    expect(accepted.body.matched).toBe(true);

    const school = await prisma.school.findUniqueOrThrow({ where: { id: res.body.school.id } });
    expect(school.status).toBe('ACTIVE');
    expect(school.plan).toBe('STANDARD');
    expect(school.registrationPaidAt).not.toBeNull();
    // The plan's own limits came with it.
    expect(school.maxStudents).toBe(2000);

    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: administratorEmail, password: temporaryPassword });
    expect(login.status).toBe(200);
    expect(login.body.accessToken).toBeTruthy();
    expect(login.body.user.mustChangePassword).toBe(true);
  });

  it('ignores a replayed callback and a reference it never issued', async () => {
    gateway({ output_ResponseCode: 'INS-9', output_ResponseDesc: 'Request timeout' });
    const { res } = await signUp();
    const payment = await prisma.registrationPayment.findUniqueOrThrow({
      where: { claimToken: res.body.claimToken },
    });

    const send = (reference: string) =>
      request(app)
        .post('/api/v1/registration/mpesa/callback')
        .set('X-Callback-Secret', 'test-callback-secret')
        .send({
          output_ThirdPartyConversationID: reference,
          output_ResponseCode: 'INS-0',
          output_TransactionID: 'TXN-FIRST',
        });

    await send(payment.reference);
    const first = await prisma.registrationPayment.findUniqueOrThrow({ where: { id: payment.id } });

    const replay = await send(payment.reference);
    expect(replay.status).toBe(202);
    const second = await prisma.registrationPayment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(second.paidAt?.toISOString()).toBe(first.paidAt?.toISOString());
    expect(second.transactionId).toBe('TXN-FIRST');

    // An unknown reference is accepted and discarded: answering differently
    // would say which references exist here.
    const unknown = await send('REG-NOT-OURS');
    expect(unknown.status).toBe(202);
    expect(unknown.body.matched).toBe(false);
  });

  it('settles a payment from the status poll, with no callback at all', async () => {
    gateway({ output_ResponseCode: 'INS-9', output_ResponseDesc: 'Request timeout' });
    const { res } = await signUp();
    const payment = await prisma.registrationPayment.findUniqueOrThrow({
      where: { claimToken: res.body.claimToken },
    });

    // The poll leaves a very fresh push alone; age it past that window.
    await prisma.registrationPayment.update({
      where: { id: payment.id },
      data: { createdAt: new Date(Date.now() - 60_000) },
    });

    gateway({
      output_ResponseCode: 'INS-0',
      output_ResponseTransactionStatus: 'Completed',
      output_TransactionID: 'TXN-POLLED',
    });

    const status = await request(app).get(`/api/v1/registration/${res.body.claimToken}`);

    expect(status.status).toBe(200);
    expect(status.body.status).toBe('CONFIRMED');
    expect(status.body.school.status).toBe('ACTIVE');
    expect(
      (await prisma.registrationPayment.findUniqueOrThrow({ where: { id: payment.id } }))
        .transactionId,
    ).toBe('TXN-POLLED');
  });

  it('leaves a school unpaid when the payment is refused, and allows another try', async () => {
    gateway({
      output_ResponseCode: 'INS-2006',
      output_ResponseDesc: 'Not enough balance',
    });
    const { res } = await signUp();

    expect(res.body.status).toBe('FAILED');
    expect(res.body.message).toBe('Not enough balance');
    expect(res.body.school.status).toBe('PENDING_PAYMENT');

    const before = await prisma.registrationPayment.findUniqueOrThrow({
      where: { claimToken: res.body.claimToken },
    });

    gateway({ output_ResponseCode: 'INS-0', output_TransactionID: 'TXN-RETRY' });
    const retry = await request(app).post(`/api/v1/registration/${res.body.claimToken}/retry`);

    expect(retry.status).toBe(200);
    expect(retry.body.status).toBe('CONFIRMED');
    expect(retry.body.school.status).toBe('ACTIVE');

    const after = await prisma.registrationPayment.findUniqueOrThrow({ where: { id: before.id } });
    // A fresh reference: the gateway refuses a repeat of one it has seen.
    expect(after.reference).not.toBe(before.reference);

    // And no second school was created for the retry.
    expect(
      await prisma.registrationPayment.count({ where: { schoolId: res.body.school.id } }),
    ).toBe(1);
  });

  it('does not reopen a school an operator suspended, but still records the fee', async () => {
    gateway({ output_ResponseCode: 'INS-9' });
    const { res } = await signUp();
    await prisma.school.update({
      where: { id: res.body.school.id },
      data: { status: 'SUSPENDED' },
    });
    const payment = await prisma.registrationPayment.findUniqueOrThrow({
      where: { claimToken: res.body.claimToken },
    });

    const callback = await request(app)
      .post('/api/v1/registration/mpesa/callback')
      .set('X-Callback-Secret', 'test-callback-secret')
      .send({
        output_ThirdPartyConversationID: payment.reference,
        output_ResponseCode: 'INS-0',
        output_TransactionID: 'TXN-LATE',
      });

    expect(callback.status).toBe(202);
    // The money is accounted for; a settling payment is not a reason to undo a
    // suspension.
    expect(
      (await prisma.registrationPayment.findUniqueOrThrow({ where: { id: payment.id } })).status,
    ).toBe('CONFIRMED');
    expect(
      (await prisma.school.findUniqueOrThrow({ where: { id: res.body.school.id } })).status,
    ).toBe('SUSPENDED');
  });

  it('will not sell the same school code twice', async () => {
    gateway({ output_ResponseCode: 'INS-9' });
    const { res, body } = await signUp();
    expect(res.status).toBe(202);

    const again = await request(app)
      .post('/api/v1/registration')
      .send({ ...signUpBody(), code: body.code });

    expect(again.status).toBe(409);
    expect(again.body.error.details.field).toBe('code');
  });

  it('records the school as unpaid when the gateway cannot be reached', async () => {
    fetchMock.mockImplementation(() => Promise.reject(new Error('getaddrinfo ENOTFOUND')));

    const { res } = await signUp();

    expect(res.status).toBe(202);
    // Unreachable is not refused: the record stays open so it can be retried.
    expect(res.body.status).toBe('PENDING');
    expect(res.body.school.status).toBe('PENDING_PAYMENT');
    expect(res.body.message).toMatch(/ENOTFOUND|Could not reach/);
  });
});

/**
 * What a school is actually told.
 *
 * A school signing itself up cannot be reached inside the application, because
 * it cannot sign in yet. If these messages do not go out, the temporary
 * password and the link back to the payment exist only in one HTTP response —
 * and a school that closes the tab is locked out of an account it has paid for.
 */
describe('what a registering school is told', () => {
  const fetchMock = vi.fn();
  const created: string[] = [];

  beforeEach(() => {
    fetchMock.mockReset();
    resetSessionCache();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockImplementation((url: unknown) =>
      String(url).includes('getSession')
        ? ok(SESSION)
        : ok({ output_ResponseCode: 'INS-9', output_ResponseDesc: 'Request timeout' }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    await prisma.school.deleteMany({ where: { id: { in: created } } });
    await prisma.$disconnect();
  });

  async function signUp(overrides: Partial<SignUpBody> = {}) {
    const res = await request(app)
      .post('/api/v1/registration')
      .send({ ...signUpBody(), ...overrides });
    if (res.status === 202) created.push(res.body.school.id as string);
    return res;
  }

  const outbox = (schoolId: string) =>
    prisma.message.findMany({ where: { schoolId }, orderBy: { createdAt: 'asc' } });

  it('emails the temporary password and the payment link, and texts the payer', async () => {
    const res = await signUp();
    const messages = await outbox(res.body.school.id);

    const email = messages.find((m) => m.channel === 'EMAIL');
    expect(email).toBeDefined();
    expect(email!.recipient).toBe(res.body.administratorEmail);
    // Without the password in this message there is no way into the account.
    expect(email!.body).toContain(res.body.temporaryPassword);
    expect(email!.body).toContain(`/register/${res.body.claimToken}`);

    const sms = messages.find((m) => m.channel === 'SMS');
    expect(sms).toBeDefined();
    expect(sms!.recipient).toBe('+255754123456');
    expect(sms!.body).toContain(`/register/${res.body.claimToken}`);

    // No transport is configured in tests, so they wait in the outbox.
    expect(messages.every((m) => m.status === 'QUEUED')).toBe(true);
  });

  it('says the school is open once the payment confirms, and says it once', async () => {
    const res = await signUp();
    const payment = await prisma.registrationPayment.findUniqueOrThrow({
      where: { claimToken: res.body.claimToken },
    });

    const callback = () =>
      request(app)
        .post('/api/v1/registration/mpesa/callback')
        .set('X-Callback-Secret', 'test-callback-secret')
        .send({
          output_ThirdPartyConversationID: payment.reference,
          output_ResponseCode: 'INS-0',
          output_TransactionID: 'TXN-NOTIFY',
        });

    await callback();
    const after = await outbox(res.body.school.id);
    const confirmations = after.filter((m) => m.subject?.includes('your school is open'));
    expect(confirmations).toHaveLength(1);
    expect(confirmations[0]!.body).toContain('/login');

    // A replayed callback confirms nothing a second time, so it must not
    // produce a second message either.
    await callback();
    const replayed = await outbox(res.body.school.id);
    expect(replayed.filter((m) => m.subject?.includes('your school is open'))).toHaveLength(1);
  });

  it('emails a refusal once, however many times the page polls', async () => {
    fetchMock.mockImplementation((url: unknown) =>
      String(url).includes('getSession')
        ? ok(SESSION)
        : ok({ output_ResponseCode: 'INS-2006', output_ResponseDesc: 'Not enough balance' }),
    );

    const res = await signUp();
    expect(res.body.status).toBe('FAILED');

    const failureCount = async () =>
      (await outbox(res.body.school.id)).filter((m) => m.subject?.includes('did not go through'))
        .length;

    expect(await failureCount()).toBe(1);

    // A refusal is a settled answer, so polling it neither re-queries the
    // gateway nor re-sends the message.
    await request(app).get(`/api/v1/registration/${res.body.claimToken}`);
    await request(app).get(`/api/v1/registration/${res.body.claimToken}`);
    expect(await failureCount()).toBe(1);
  });
});

/**
 * Giving up on registrations nobody paid for.
 *
 * An unpaid sign-up holds its school code against everyone, the school that
 * chose it included — so without expiry, one abandoned attempt costs a school
 * the name it wanted permanently.
 */
describe('expiring unpaid registrations', () => {
  const fetchMock = vi.fn();
  const created: string[] = [];

  beforeEach(() => {
    fetchMock.mockReset();
    resetSessionCache();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockImplementation((url: unknown) =>
      String(url).includes('getSession')
        ? ok(SESSION)
        : ok({ output_ResponseCode: 'INS-9', output_ResponseDesc: 'Request timeout' }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    await prisma.school.deleteMany({ where: { id: { in: created } } });
    await prisma.$disconnect();
  });

  async function signUp(overrides: Partial<SignUpBody> = {}) {
    const res = await request(app)
      .post('/api/v1/registration')
      .send({ ...signUpBody(), ...overrides });
    if (res.status === 202) created.push(res.body.school.id as string);
    return res;
  }

  /** Ages a sign-up past the retention window. */
  const age = (schoolId: string, days: number) =>
    prisma.school.update({
      where: { id: schoolId },
      data: { createdAt: new Date(Date.now() - days * 24 * 60 * 60 * 1000) },
    });

  it('leaves a registration that is merely unpaid alone', async () => {
    const res = await signUp();

    expect(await expireStaleRegistrations()).toEqual({ expired: 0 });
    expect(
      (await prisma.school.findUniqueOrThrow({ where: { id: res.body.school.id } })).status,
    ).toBe('PENDING_PAYMENT');
  });

  it('never touches a school that paid', async () => {
    const res = await signUp();
    const payment = await prisma.registrationPayment.findUniqueOrThrow({
      where: { claimToken: res.body.claimToken },
    });
    await request(app)
      .post('/api/v1/registration/mpesa/callback')
      .set('X-Callback-Secret', 'test-callback-secret')
      .send({
        output_ThirdPartyConversationID: payment.reference,
        output_ResponseCode: 'INS-0',
      });

    await age(res.body.school.id, 400);

    expect(await expireStaleRegistrations()).toEqual({ expired: 0 });
    const school = await prisma.school.findUniqueOrThrow({ where: { id: res.body.school.id } });
    expect(school.status).toBe('ACTIVE');
    expect(school.code).toBe(res.body.school.code);
  });

  it('cancels a stale registration, releases its code and tells the school', async () => {
    const res = await signUp();
    const code = res.body.school.code as string;
    await age(res.body.school.id, 30);

    expect(await expireStaleRegistrations()).toEqual({ expired: 1 });

    const school = await prisma.school.findUniqueOrThrow({ where: { id: res.body.school.id } });
    expect(school.status).toBe('CANCELLED');
    // Released by lengthening it past what sign-up accepts, so the original is
    // free and no new sign-up can ever produce this one.
    expect(school.code).not.toBe(code);
    expect(school.code.startsWith(`${code}-EXP-`)).toBe(true);
    expect(school.code.length).toBeGreaterThan(12);

    const payment = await prisma.registrationPayment.findUniqueOrThrow({
      where: { claimToken: res.body.claimToken },
    });
    expect(payment.status).toBe('FAILED');
    expect(payment.resultCode).toBe('EXPIRED');

    const messages = await prisma.message.findMany({ where: { schoolId: res.body.school.id } });
    expect(messages.some((m) => m.subject?.includes('registration cancelled'))).toBe(true);

    // And the code is genuinely usable again.
    const reuse = await signUp({ code });
    expect(reuse.status).toBe(202);
    expect(reuse.body.school.code).toBe(code);
  });

  it('releases a held code at sign-up, without waiting for the sweep', async () => {
    const first = await signUp();
    const code = first.body.school.code as string;
    await age(first.body.school.id, 30);

    // No sweep is run here: taking the code is what triggers the release.
    const second = await signUp({ code });

    expect(second.status).toBe(202);
    expect(second.body.school.code).toBe(code);
    expect(
      (await prisma.school.findUniqueOrThrow({ where: { id: first.body.school.id } })).status,
    ).toBe('CANCELLED');
  });

  it('refuses to charge again through a cancelled registration\'s link', async () => {
    const res = await signUp();
    await age(res.body.school.id, 30);
    await expireStaleRegistrations();

    // The claim link outlives the registration, and a retry through it would
    // take money for a school that confirming can no longer open.
    const retry = await request(app).post(`/api/v1/registration/${res.body.claimToken}/retry`);

    expect(retry.status).toBe(409);
    expect(retry.body.error.message).toMatch(/no longer open/);
    expect(retry.body.error.details.schoolStatus).toBe('CANCELLED');
  });

  it('shuts a cancelled school out, at login and on every request', async () => {
    const res = await signUp();
    const { administratorEmail, temporaryPassword } = res.body;
    const admin = await prisma.user.findFirstOrThrow({
      where: { schoolId: res.body.school.id },
    });
    await age(res.body.school.id, 30);
    await expireStaleRegistrations();

    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: administratorEmail, password: temporaryPassword });
    expect(login.status).toBe(403);
    expect(login.body.error.message).toMatch(/closed/);

    // Nothing read this status before an expiry could produce it, so the
    // request path is checked too.
    const token = signAccessToken({
      sub: admin.id,
      schoolId: admin.schoolId,
      role: admin.role,
    });
    const me = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`);
    expect(me.status).toBe(403);
  });
});
