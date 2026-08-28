import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { MessageChannel, MessageStatus } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { dispatchQueuedSms, setSmsProvider } from '../modules/communication/dispatcher.js';
import { AfricasTalkingProvider } from '../modules/communication/providers/africastalking.js';
import type { SmsPayload, SmsProvider, SmsResult } from '../modules/communication/providers/types.js';
import { normalizePhone } from '../modules/communication/message.service.js';
import {
  type Fixture,
  app,
  authed,
  createSchoolFixture,
  destroyFixture,
  login,
} from './fixtures.js';

/** Records what it was asked to send and returns whatever it was told to. */
function stubProvider(reply: (m: SmsPayload) => Omit<SmsResult, 'recipient'>): SmsProvider & {
  calls: SmsPayload[][];
  senders: string[];
} {
  const calls: SmsPayload[][] = [];
  const senders: string[] = [];
  return {
    name: 'stub',
    calls,
    senders,
    async send(messages, senderId) {
      calls.push(messages);
      senders.push(senderId);
      return messages.map((m) => ({ recipient: m.recipient, ...reply(m) }));
    },
  };
}

async function queue(schoolId: string, recipients: string[], body = 'Test message') {
  await prisma.message.createMany({
    data: recipients.map((recipient) => ({
      schoolId,
      channel: MessageChannel.SMS,
      recipient,
      body,
      status: MessageStatus.QUEUED,
    })),
  });
}

const statusOf = (schoolId: string) =>
  prisma.message.findMany({
    where: { schoolId, channel: MessageChannel.SMS },
    orderBy: { recipient: 'asc' },
    select: { recipient: true, status: true, attempts: true, error: true, providerRef: true, cost: true },
  });

describe('SMS dispatch', () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await createSchoolFixture();
  });

  afterEach(async () => {
    setSmsProvider(null);
    await prisma.message.deleteMany({ where: { schoolId: fixture.school.id } });
  });

  afterAll(async () => {
    await destroyFixture(fixture);
    await prisma.$disconnect();
  });

  it('sends queued messages and records the gateway reference', async () => {
    const provider = stubProvider(() => ({
      accepted: true,
      providerRef: 'ATXid_123',
      cost: 'TZS 0.8000',
      retryable: false,
    }));
    setSmsProvider(provider);

    await queue(fixture.school.id, ['+255754000001', '+255754000002']);
    const summary = await dispatchQueuedSms();

    expect(summary).toMatchObject({ attempted: 2, sent: 2, failed: 0, skipped: false });

    const rows = await statusOf(fixture.school.id);
    expect(rows.every((r) => r.status === MessageStatus.SENT)).toBe(true);
    expect(rows[0]!.providerRef).toBe('ATXid_123');
    expect(rows[0]!.cost).toBe('TZS 0.8000');
    expect(rows[0]!.attempts).toBe(1);
  });

  it('does not resend a message that already went out', async () => {
    const provider = stubProvider(() => ({ accepted: true, retryable: false }));
    setSmsProvider(provider);

    await queue(fixture.school.id, ['+255754000003']);
    await dispatchQueuedSms();
    const second = await dispatchQueuedSms();

    expect(second.attempted).toBe(0);
    expect(provider.calls).toHaveLength(1);
  });

  it('requeues a transient failure so the next sweep retries it', async () => {
    setSmsProvider(
      stubProvider(() => ({ accepted: false, error: 'Gateway error (501)', retryable: true })),
    );

    await queue(fixture.school.id, ['+255754000004']);
    await dispatchQueuedSms();

    const [row] = await statusOf(fixture.school.id);
    expect(row!.status).toBe(MessageStatus.QUEUED);
    expect(row!.attempts).toBe(1);
    expect(row!.error).toContain('501');
  });

  it('fails an invalid number immediately rather than burning retries', async () => {
    setSmsProvider(
      stubProvider(() => ({ accepted: false, error: 'Invalid phone number (403)', retryable: false })),
    );

    await queue(fixture.school.id, ['not-a-number']);
    await dispatchQueuedSms();

    const [row] = await statusOf(fixture.school.id);
    expect(row!.status).toBe(MessageStatus.FAILED);
    expect(row!.attempts).toBe(1);
  });

  it('gives up after the configured number of attempts', async () => {
    setSmsProvider(stubProvider(() => ({ accepted: false, error: 'Timeout', retryable: true })));

    await queue(fixture.school.id, ['+255754000005']);
    for (let i = 0; i < 5; i += 1) await dispatchQueuedSms();

    const [row] = await statusOf(fixture.school.id);
    expect(row!.status).toBe(MessageStatus.FAILED);
    // Capped at SMS_MAX_ATTEMPTS (3 by default), not five.
    expect(row!.attempts).toBe(3);
  });

  it("uses the school's own sender ID", async () => {
    const provider = stubProvider(() => ({ accepted: true, retryable: false }));
    setSmsProvider(provider);

    await prisma.school.update({
      where: { id: fixture.school.id },
      data: { smsSenderId: 'MYSCHOOL' },
    });

    await queue(fixture.school.id, ['+255754000006']);
    await dispatchQueuedSms();

    expect(provider.senders[0]).toBe('MYSCHOOL');
  });

  it('does nothing when no provider is configured', async () => {
    setSmsProvider(null);
    await queue(fixture.school.id, ['+255754000007']);

    const summary = await dispatchQueuedSms();

    expect(summary.skipped).toBe(true);
    const [row] = await statusOf(fixture.school.id);
    expect(row!.status).toBe(MessageStatus.QUEUED);
    expect(row!.attempts).toBe(0);
  });
});

describe("Africa's Talking request and response handling", () => {
  const fetchMock = vi.fn();

  beforeAll(() => {
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    fetchMock.mockReset();
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  const ok = (body: unknown) =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(''),
    } as unknown as Response);

  it('posts form-encoded credentials and recipients', async () => {
    fetchMock.mockReturnValue(
      ok({
        SMSMessageData: {
          Recipients: [
            { number: '+255754000001', statusCode: 101, status: 'Success', messageId: 'ATXid_1', cost: 'TZS 0.8' },
          ],
        },
      }),
    );

    const provider = new AfricasTalkingProvider('myuser', 'mykey', false);
    const results = await provider.send([{ recipient: '+255754000001', body: 'Hello' }], 'SHULE');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.africastalking.com/version1/messaging');
    expect(init.headers.apiKey).toBe('mykey');
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');

    const form = new URLSearchParams(init.body as string);
    expect(form.get('username')).toBe('myuser');
    expect(form.get('to')).toBe('+255754000001');
    expect(form.get('message')).toBe('Hello');
    expect(form.get('from')).toBe('SHULE');

    expect(results[0]).toMatchObject({ accepted: true, providerRef: 'ATXid_1', cost: 'TZS 0.8' });
  });

  it('uses the sandbox host when configured for it', async () => {
    fetchMock.mockReturnValue(ok({ SMSMessageData: { Recipients: [] } }));

    await new AfricasTalkingProvider('sandbox', 'key', true).send(
      [{ recipient: '+255754000001', body: 'Hi' }],
      'SHULE',
    );

    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.sandbox.africastalking.com/version1/messaging');
  });

  it('groups identical bodies into one request but splits differing ones', async () => {
    fetchMock.mockReturnValue(ok({ SMSMessageData: { Recipients: [] } }));

    await new AfricasTalkingProvider('u', 'k', false).send(
      [
        { recipient: '+255754000001', body: 'Same' },
        { recipient: '+255754000002', body: 'Same' },
        { recipient: '+255754000003', body: 'Different' },
      ],
      'SHULE',
    );

    // One call for the shared body, one for the personalised one.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstForm = new URLSearchParams(fetchMock.mock.calls[0]![1].body as string);
    expect(firstForm.get('to')).toBe('+255754000001,+255754000002');
  });

  it('marks a bad number permanent and a gateway error retryable', async () => {
    fetchMock.mockReturnValue(
      ok({
        SMSMessageData: {
          Recipients: [
            { number: '+255754000001', statusCode: 403, status: 'InvalidPhoneNumber' },
            { number: '+255754000002', statusCode: 501, status: 'GatewayError' },
          ],
        },
      }),
    );

    const results = await new AfricasTalkingProvider('u', 'k', false).send(
      [
        { recipient: '+255754000001', body: 'x' },
        { recipient: '+255754000002', body: 'x' },
      ],
      'SHULE',
    );

    expect(results[0]).toMatchObject({ accepted: false, retryable: false });
    expect(results[0]!.error).toContain('Invalid phone number');
    expect(results[1]).toMatchObject({ accepted: false, retryable: true });
  });

  it('does not retry a rejected sender ID reported for the whole request', async () => {
    // A bad sender ID comes back once for the request, not per recipient.
    fetchMock.mockReturnValue(
      ok({ SMSMessageData: { Message: 'InvalidSenderId', Recipients: [] } }),
    );

    const results = await new AfricasTalkingProvider('u', 'k', false).send(
      [
        { recipient: '+255754000001', body: 'x' },
        { recipient: '+255754000002', body: 'x' },
      ],
      'SCHOOL',
    );

    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r).toMatchObject({ accepted: false, retryable: false });
      expect(r.error).toContain('InvalidSenderId');
    }
  });

  it('does retry an empty balance reported for the whole request', async () => {
    fetchMock.mockReturnValue(
      ok({ SMSMessageData: { Message: 'InsufficientBalance', Recipients: [] } }),
    );

    const results = await new AfricasTalkingProvider('u', 'k', false).send(
      [{ recipient: '+255754000001', body: 'x' }],
      'SHULE',
    );
    expect(results[0]).toMatchObject({ accepted: false, retryable: true });
  });

  it('omits the sender ID when blank, as the sandbox requires', async () => {
    fetchMock.mockReturnValue(ok({ SMSMessageData: { Recipients: [] } }));

    await new AfricasTalkingProvider('u', 'k', true).send(
      [{ recipient: '+255754000001', body: 'x' }],
      '   ',
    );

    const form = new URLSearchParams(fetchMock.mock.calls[0]![1]!.body as string);
    expect(form.has('from')).toBe(false);
  });

  it('treats bad credentials as permanent and a timeout as retryable', async () => {
    fetchMock.mockReturnValue(
      Promise.resolve({
        ok: false,
        status: 401,
        text: () => Promise.resolve('Unauthorised'),
        json: () => Promise.resolve({}),
      } as unknown as Response),
    );
    const unauthorised = await new AfricasTalkingProvider('u', 'bad', false).send(
      [{ recipient: '+255754000001', body: 'x' }],
      'SHULE',
    );
    expect(unauthorised[0]).toMatchObject({ accepted: false, retryable: false });

    fetchMock.mockReset();
    fetchMock.mockRejectedValue(new Error('The operation timed out'));
    const timedOut = await new AfricasTalkingProvider('u', 'k', false).send(
      [{ recipient: '+255754000001', body: 'x' }],
      'SHULE',
    );
    expect(timedOut[0]).toMatchObject({ accepted: false, retryable: true });
  });

  it('never throws when the gateway returns nonsense', async () => {
    fetchMock.mockReturnValue(
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.reject(new Error('not json')),
        text: () => Promise.resolve('<html>'),
      } as unknown as Response),
    );

    const results = await new AfricasTalkingProvider('u', 'k', false).send(
      [{ recipient: '+255754000001', body: 'x' }],
      'SHULE',
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.accepted).toBe(false);
  });
});

/**
 * The dispatcher was well covered but only ever called directly, so a broken
 * request schema on the routes in front of it went unnoticed: every "Send
 * queued now" answered 400. These drive the HTTP layer instead.
 */
describe('dispatch and retry endpoints', () => {
  let fixture: Fixture;
  let token: string;

  beforeAll(async () => {
    fixture = await createSchoolFixture();
    token = await login(fixture.users.admin!.email);
  });

  afterAll(async () => {
    await destroyFixture(fixture);
    await prisma.$disconnect();
  });

  afterEach(async () => {
    await prisma.message.deleteMany({ where: { schoolId: fixture.school.id } });
    setSmsProvider(null);
  });

  const dispatch = (body?: unknown) => {
    const req = request(app).post('/api/v1/notifications/messages/dispatch').set(authed(token));
    return body === undefined ? req : req.send(body as object);
  };

  it('sends the queue when asked for one channel', async () => {
    setSmsProvider(stubProvider(() => ({ accepted: true, providerRef: 'ref-1' })));
    await queue(fixture.school.id, ['+255754000001']);

    const res = await dispatch({ channel: 'SMS' });

    expect(res.status).toBe(200);
    expect(res.body.sms).toMatchObject({ attempted: 1, sent: 1 });
    // Asking for SMS must not touch the other transport.
    expect(res.body.email).toBeNull();
  });

  it('sends both transports when no channel is named', async () => {
    setSmsProvider(stubProvider(() => ({ accepted: true })));
    await queue(fixture.school.id, ['+255754000002']);

    const res = await dispatch({});

    expect(res.status).toBe(200);
    expect(res.body.sms).not.toBeNull();
    expect(res.body.email).not.toBeNull();
  });

  it('treats no body at all as both transports', async () => {
    setSmsProvider(stubProvider(() => ({ accepted: true })));

    const res = await dispatch();

    expect(res.status).toBe(200);
    expect(res.body.sms).not.toBeNull();
  });

  it('rejects a channel that is not a transport', async () => {
    const res = await dispatch({ channel: 'CARRIER_PIGEON' });

    expect(res.status).toBe(400);
    expect(res.body.error.details[0].field).toBe('channel');
  });

  it('requeues failed messages and sends them again', async () => {
    await queue(fixture.school.id, ['+255754000003']);
    await prisma.message.updateMany({
      where: { schoolId: fixture.school.id },
      data: { status: MessageStatus.FAILED, attempts: 3, error: 'Out of credit' },
    });

    setSmsProvider(stubProvider(() => ({ accepted: true, providerRef: 'ref-2' })));
    const res = await request(app)
      .post('/api/v1/notifications/messages/retry-failed')
      .set(authed(token))
      .send({ channel: 'SMS' });

    expect(res.status).toBe(200);
    expect(res.body.requeued).toBe(1);

    const [message] = await statusOf(fixture.school.id);
    expect(message).toMatchObject({ status: MessageStatus.SENT, providerRef: 'ref-2' });
    // The old failure must not linger next to a successful send.
    expect(message!.error).toBeNull();
  });
});

describe('phone normalisation', () => {
  it('converts Tanzanian formats to E.164', () => {
    expect(normalizePhone('0754123456')).toBe('+255754123456');
    expect(normalizePhone('255754123456')).toBe('+255754123456');
    expect(normalizePhone('754123456')).toBe('+255754123456');
    expect(normalizePhone('+255 754 123 456')).toBe('+255754123456');
  });
});
