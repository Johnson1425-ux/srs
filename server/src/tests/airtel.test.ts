import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { prisma } from '../db/prisma.js';
import { app, uid } from './fixtures.js';
import { airtelMsisdn, resetTokenCache, stateForTransactionStatus } from '../lib/airtel/index.js';

/**
 * Airtel's transaction statuses, and what each one is worth.
 *
 * The expensive mistake here is the same one M-Pesa's response codes invite,
 * in the same two directions: a refusal read as a wait leaves a school in
 * PENDING_PAYMENT being polled forever, and a wait read as a refusal fails a
 * payment the customer is still in the middle of approving. `TA` is the one
 * that tempts: Airtel saying "ambiguous" is Airtel saying it does not know
 * yet, which is exactly the state a live payment sits in.
 */
describe('Airtel transaction statuses', () => {
  it('confirms only on TS', () => {
    expect(stateForTransactionStatus('TS')).toBe('confirmed');
    expect(stateForTransactionStatus('ts')).toBe('confirmed');
  });

  it('refuses only on TF', () => {
    expect(stateForTransactionStatus('TF')).toBe('failed');
  });

  it.each(['TIP', 'TA'])('waits on %s', (status) => {
    expect(stateForTransactionStatus(status)).toBe('pending');
  });

  // Anything unrecognised is waited on rather than failed: a status we cannot
  // read is not evidence that somebody's money did not move.
  it('waits on a status it has never seen, and on none at all', () => {
    expect(stateForTransactionStatus('SOMETHING_NEW')).toBe('pending');
    expect(stateForTransactionStatus(null)).toBe('pending');
    expect(stateForTransactionStatus(undefined)).toBe('pending');
  });
});

/**
 * Airtel wants the subscriber without its country code, where M-Pesa wants it
 * with. Everything on our side is stored in M-Pesa's shape, so this is the
 * conversion, and getting it wrong is an invalid-subscriber refusal that says
 * nothing about why.
 */
describe('Airtel subscriber numbers', () => {
  it('drops the Tanzanian country code', () => {
    expect(airtelMsisdn('255784123456')).toBe('784123456');
  });

  it('leaves a number that is already nine digits alone', () => {
    expect(airtelMsisdn('784123456')).toBe('784123456');
  });
});

const ok = (body: unknown, status = 200) =>
  Promise.resolve({ ok: status < 400, status, text: () => Promise.resolve(JSON.stringify(body)) });

const TOKEN = { access_token: 'test-airtel-token', token_type: 'Bearer', expires_in: '3600' };

/** The envelope Airtel wraps an accepted request in. */
const ACCEPTED = { code: '200', message: 'Success', result_code: 'ESB000010', success: true };

interface SignUpBody {
  name: string;
  code: string;
  plan: 'BASIC' | 'STANDARD' | 'PREMIUM';
  provider?: 'MPESA' | 'AIRTEL_MONEY';
  msisdn: string;
  admin: { firstName: string; lastName: string; email: string };
}

function signUpBody(overrides: Partial<SignUpBody> = {}): SignUpBody {
  const suffix = uid();
  return {
    name: `Airtel School ${suffix}`,
    code: `A${suffix.slice(-6).toUpperCase()}`,
    plan: 'BASIC',
    provider: 'AIRTEL_MONEY',
    msisdn: '0784123456',
    admin: {
      firstName: 'Neema',
      lastName: 'Kileo',
      email: `head-${suffix}@school.test`,
    },
    ...overrides,
  };
}

describe('school registration paid with Airtel Money', () => {
  const fetchMock = vi.fn();
  const created: string[] = [];

  beforeEach(() => {
    fetchMock.mockReset();
    resetTokenCache();
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
   * Answers the token endpoint whenever it is asked — the client caches the
   * token, so whether it asks at all depends on what ran before — and hands
   * out the queued responses for everything else, in order.
   */
  function gateway(...responses: unknown[]): void {
    const queue = [...responses];
    fetchMock.mockImplementation((url: unknown) => {
      if (String(url).includes('auth/oauth2/token')) return ok(TOKEN);
      return ok(queue.shift() ?? { status: ACCEPTED, data: { transaction: { status: 'TIP' } } });
    });
  }

  /** The collection push, which is always the call after the token. */
  function pushCall(): { url: string; init: { body: string; headers: Record<string, string> } } {
    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('merchant/v1/payments'));
    if (!call) throw new Error('no collection push was made');
    return { url: String(call[0]), init: call[1] as never };
  }

  async function signUp(overrides: Partial<SignUpBody> = {}) {
    const body = signUpBody(overrides);
    const res = await request(app).post('/api/v1/registration').send(body);
    if (res.status === 202) created.push(res.body.school.id as string);
    return { res, body };
  }

  it('offers both networks, and says which of them can take money', async () => {
    const res = await request(app).get('/api/v1/registration/plans');

    expect(res.status).toBe(200);
    expect(res.body.providers).toEqual([
      { provider: 'MPESA', label: 'M-Pesa', enabled: true },
      { provider: 'AIRTEL_MONEY', label: 'Airtel Money', enabled: true },
    ]);
    // The old flag still means what it always meant: some network can take
    // money. A client written before there was a choice keeps working.
    expect(res.body.paymentsEnabled).toBe(true);
  });

  it('defaults to M-Pesa when the request names no network at all', async () => {
    gateway();
    const { res } = await signUp({ provider: undefined });

    expect(res.status).toBe(202);
    expect(res.body.provider).toBe('MPESA');
  });

  it('refuses a network with no gateway behind it', async () => {
    // HaloPesa is in the enum because school fees are recorded against it by
    // hand. Accepting it here would create a school that can never be paid for.
    const res = await request(app)
      .post('/api/v1/registration')
      .send({ ...signUpBody(), provider: 'HALOPESA' });

    expect(res.status).toBe(400);
  });

  it('sends a collection request the Airtel contract accepts, and waits', async () => {
    gateway({ status: ACCEPTED, data: { transaction: { id: 'TZ-1', status: 'TIP' } } });

    const { res } = await signUp();

    expect(res.status).toBe(202);
    expect(res.body.status).toBe('PENDING');
    expect(res.body.provider).toBe('AIRTEL_MONEY');
    expect(res.body.providerLabel).toBe('Airtel Money');
    expect(res.body.school.status).toBe('PENDING_PAYMENT');

    const payment = await prisma.registrationPayment.findUniqueOrThrow({
      where: { claimToken: res.body.claimToken },
    });
    expect(payment.provider).toBe('AIRTEL_MONEY');
    // Stored in the one shape everything on our side uses, whichever gateway
    // it is going to.
    expect(payment.msisdn).toBe('255784123456');

    const { init } = pushCall();
    const sent = JSON.parse(init.body);

    // The subscriber goes without its country code, which is the one thing
    // Airtel and M-Pesa disagree about in the same field.
    expect(sent.subscriber.msisdn).toBe('784123456');
    expect(sent.subscriber.country).toBe('TZ');
    expect(sent.subscriber.currency).toBe('TZS');
    expect(sent.transaction.id).toBe(payment.reference);
    expect(sent.transaction.amount).toBe(150000);
    expect(sent.transaction.currency).toBe('TZS');

    // The market is carried in headers, not the body, and the credentials
    // never appear in either: they bought a bearer token.
    expect(init.headers['X-Country']).toBe('TZ');
    expect(init.headers['X-Currency']).toBe('TZS');
    expect(init.headers.Authorization).toBe('Bearer test-airtel-token');
    expect(init.body).not.toContain('test-airtel-secret');
  });

  it('settles the payment from the status poll and opens the school', async () => {
    gateway(
      { status: ACCEPTED, data: { transaction: { id: 'TZ-2', status: 'TIP' } } },
      {
        status: ACCEPTED,
        data: {
          transaction: {
            id: 'TZ-2',
            airtel_money_id: 'MP210603.1234.L06941',
            message: 'Transaction Successful',
            status: 'TS',
          },
        },
      },
    );

    const { res } = await signUp({ plan: 'STANDARD' });
    const { claimToken } = res.body;

    // The poll only asks the gateway once the push is old enough to have an
    // answer, which is what the sign-up page's own polling interval covers.
    await new Promise((resolve) => setTimeout(resolve, 3100));

    const polled = await request(app).get(`/api/v1/registration/${claimToken}`);
    expect(polled.status).toBe(200);
    expect(polled.body.status).toBe('CONFIRMED');

    const school = await prisma.school.findUniqueOrThrow({ where: { id: res.body.school.id } });
    expect(school.status).toBe('ACTIVE');
    expect(school.plan).toBe('STANDARD');
    expect(school.registrationPaidAt).not.toBeNull();

    // The id a school quotes in a dispute is Airtel's, not the one we sent.
    const payment = await prisma.registrationPayment.findUniqueOrThrow({ where: { claimToken } });
    expect(payment.transactionId).toBe('MP210603.1234.L06941');
  });

  it('does not fail a payment because the status query itself was refused', async () => {
    gateway(
      { status: ACCEPTED, data: { transaction: { id: 'TZ-3', status: 'TIP' } } },
      // No transaction at all, and the envelope says the question was refused:
      // this is about our subscription, not about anybody's money.
      {
        status: {
          code: 'DP00800001008',
          message: 'Invalid subscription',
          result_code: 'ESB000008',
          success: false,
        },
      },
    );

    const { res } = await signUp();
    await new Promise((resolve) => setTimeout(resolve, 3100));

    const polled = await request(app).get(`/api/v1/registration/${res.body.claimToken}`);
    expect(polled.status).toBe(200);
    // Still open: the push answer, a callback or a later answered query
    // settles it, and an unanswered one expires on REGISTRATION_TTL_DAYS.
    expect(polled.body.status).toBe('PENDING');
    // Airtel's own wording is not shown — it tells a school nothing it can act
    // on, and it is about a request it never made.
    expect(polled.body.message).not.toContain('Invalid subscription');

    const school = await prisma.school.findUniqueOrThrow({ where: { id: res.body.school.id } });
    expect(school.status).toBe('PENDING_PAYMENT');
  });

  it('leaves the school unpaid when the push itself is refused, and allows another try', async () => {
    gateway({
      status: {
        code: 'DP00800001006',
        message: 'Transaction Failed',
        result_code: 'ESB000033',
        success: false,
      },
    });

    const { res } = await signUp();
    expect(res.body.status).toBe('FAILED');

    const school = await prisma.school.findUniqueOrThrow({ where: { id: res.body.school.id } });
    expect(school.status).toBe('PENDING_PAYMENT');

    // The retry button reopens the record rather than creating a second school.
    gateway({ status: ACCEPTED, data: { transaction: { id: 'TZ-4', status: 'TIP' } } });
    const retried = await request(app).post(
      `/api/v1/registration/${res.body.claimToken}/retry`,
    );
    expect(retried.status).toBe(200);
    expect(retried.body.status).toBe('PENDING');
    expect(await prisma.school.count({ where: { code: res.body.school.code } })).toBe(1);
  });

  it('opens the school when the Airtel callback confirms the payment', async () => {
    gateway({ status: ACCEPTED, data: { transaction: { id: 'TZ-5', status: 'TIP' } } });
    const { res } = await signUp();
    const payment = await prisma.registrationPayment.findUniqueOrThrow({
      where: { claimToken: res.body.claimToken },
    });

    const callback = {
      transaction: {
        id: payment.reference,
        message: 'Transaction Successful',
        status_code: 'TS',
        airtel_money_id: 'MP210603.5678.L06941',
      },
    };

    const forged = await request(app)
      .post('/api/v1/registration/airtel/callback')
      .set('X-Callback-Secret', 'not-the-secret')
      .send(callback);
    expect(forged.status).toBe(403);

    const unsigned = await request(app)
      .post('/api/v1/registration/airtel/callback')
      .send(callback);
    expect(unsigned.status).toBe(403);

    // The M-Pesa secret is not the Airtel secret, however similar the routes
    // look: one leaked secret must not open the other network's endpoint.
    const crossed = await request(app)
      .post('/api/v1/registration/airtel/callback')
      .set('X-Callback-Secret', 'test-callback-secret')
      .send(callback);
    expect(crossed.status).toBe(403);

    expect(
      (await prisma.school.findUniqueOrThrow({ where: { id: res.body.school.id } })).status,
    ).toBe('PENDING_PAYMENT');

    const accepted = await request(app)
      .post('/api/v1/registration/airtel/callback')
      .set('X-Callback-Secret', 'test-airtel-callback-secret')
      .send(callback);
    expect(accepted.status).toBe(202);
    expect(accepted.body.matched).toBe(true);

    const school = await prisma.school.findUniqueOrThrow({ where: { id: res.body.school.id } });
    expect(school.status).toBe('ACTIVE');
  });

  it('will not settle one network\'s payment through the other network\'s callback', async () => {
    gateway({ status: ACCEPTED, data: { transaction: { id: 'TZ-6', status: 'TIP' } } });
    const { res } = await signUp();
    const payment = await prisma.registrationPayment.findUniqueOrThrow({
      where: { claimToken: res.body.claimToken },
    });

    // An M-Pesa success code, carrying a real Airtel payment's reference, on
    // the M-Pesa route with the M-Pesa secret. Everything is valid except
    // which network the payment belongs to.
    const crossed = await request(app)
      .post('/api/v1/registration/mpesa/callback')
      .set('X-Callback-Secret', 'test-callback-secret')
      .send({
        output_ThirdPartyConversationID: payment.reference,
        output_ResponseCode: 'INS-0',
        output_TransactionID: 'TXN-WRONG-NETWORK',
      });

    // Accepted and discarded, like any reference we did not issue: answering
    // differently would say which references exist here.
    expect(crossed.status).toBe(202);
    expect(crossed.body.matched).toBe(false);

    const school = await prisma.school.findUniqueOrThrow({ where: { id: res.body.school.id } });
    expect(school.status).toBe('PENDING_PAYMENT');
  });

  it('tells the school which network it is paying from', async () => {
    gateway({ status: ACCEPTED, data: { transaction: { id: 'TZ-7', status: 'TIP' } } });
    const { res } = await signUp();

    const messages = await prisma.message.findMany({
      where: { schoolId: res.body.school.id },
    });
    expect(messages.length).toBeGreaterThan(0);

    // A school that chose Airtel and is told to enter its M-Pesa PIN has been
    // told to do something impossible.
    for (const message of messages) {
      expect(message.body).toContain('Airtel Money');
      expect(message.body).not.toContain('M-Pesa');
    }
  });

  it('records the school as unpaid when Airtel cannot be reached', async () => {
    fetchMock.mockRejectedValue(new Error('getaddrinfo ENOTFOUND airtel.invalid'));

    const { res } = await signUp();

    expect(res.status).toBe(202);
    expect(res.body.status).toBe('PENDING');

    const payment = await prisma.registrationPayment.findUniqueOrThrow({
      where: { claimToken: res.body.claimToken },
    });
    // A gateway that cannot be reached is not a refused payment: the school
    // keeps its PENDING record and the retry button.
    expect(payment.status).toBe('PENDING');
    expect(payment.resultCode).toBe('GATEWAY_ERROR');
  });
});
