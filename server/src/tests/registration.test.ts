import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { prisma } from '../db/prisma.js';
import { app, uid } from './fixtures.js';
import { resetSessionCache } from '../lib/mpesa/index.js';
import { normalizeMsisdn } from '../modules/registration/registration.service.js';
import { toPem } from '../lib/mpesa/crypto.js';
import { signAccessToken } from '../lib/tokens.js';

/** People type their number every way there is; the gateway accepts one. */
describe('M-Pesa number normalisation', () => {
  it('accepts the three forms a Tanzanian number is written in', () => {
    expect(normalizeMsisdn('0754123456')).toBe('255754123456');
    expect(normalizeMsisdn('+255 754 123 456')).toBe('255754123456');
    expect(normalizeMsisdn('754123456')).toBe('255754123456');
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
