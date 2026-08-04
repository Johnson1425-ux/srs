import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MessageChannel, MessageStatus } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { dispatchQueuedEmail, setEmailProvider } from '../modules/communication/dispatcher.js';
import { SmtpProvider } from '../modules/communication/providers/smtp.js';
import type {
  EmailPayload,
  EmailProvider,
  EmailResult,
} from '../modules/communication/providers/types.js';
import { type Fixture, createSchoolFixture, destroyFixture } from './fixtures.js';

/** Records what it was asked to send and returns whatever it was told to. */
function stubProvider(reply: (m: EmailPayload) => Omit<EmailResult, 'recipient'>): EmailProvider & {
  calls: EmailPayload[][];
  froms: string[];
} {
  const calls: EmailPayload[][] = [];
  const froms: string[] = [];
  return {
    name: 'stub',
    calls,
    froms,
    async send(messages, from) {
      calls.push(messages);
      froms.push(from);
      return messages.map((m) => ({ recipient: m.recipient, ...reply(m) }));
    },
  };
}

async function queue(
  schoolId: string,
  recipients: string[],
  subject: string | null = 'Fee reminder',
) {
  await prisma.message.createMany({
    data: recipients.map((recipient) => ({
      schoolId,
      channel: MessageChannel.EMAIL,
      recipient,
      subject,
      body: 'The balance is due on Friday.',
      status: MessageStatus.QUEUED,
    })),
  });
}

const statusOf = (schoolId: string) =>
  prisma.message.findMany({
    where: { schoolId, channel: MessageChannel.EMAIL },
    orderBy: { recipient: 'asc' },
    select: { recipient: true, status: true, attempts: true, error: true, providerRef: true },
  });

describe('Email dispatch', () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await createSchoolFixture();
  });

  afterAll(async () => {
    await destroyFixture(fixture);
    await prisma.$disconnect();
  });

  afterEach(async () => {
    setEmailProvider(null);
    await prisma.message.deleteMany({ where: { schoolId: fixture.school.id } });
  });

  it('sends queued email and records the message id', async () => {
    const provider = stubProvider(() => ({
      accepted: true,
      providerRef: '<abc@mail>',
      retryable: false,
    }));
    setEmailProvider(provider);

    await queue(fixture.school.id, ['asha@example.com', 'juma@example.com']);
    const summary = await dispatchQueuedEmail();

    expect(summary).toMatchObject({ attempted: 2, sent: 2, failed: 0, skipped: false });
    const rows = await statusOf(fixture.school.id);
    expect(rows.every((r) => r.status === MessageStatus.SENT)).toBe(true);
    expect(rows[0]!.providerRef).toBe('<abc@mail>');
  });

  it('does not resend a message that already went out', async () => {
    const provider = stubProvider(() => ({ accepted: true, retryable: false }));
    setEmailProvider(provider);

    await queue(fixture.school.id, ['asha@example.com']);
    await dispatchQueuedEmail();
    await dispatchQueuedEmail();

    expect(provider.calls).toHaveLength(1);
  });

  it('requeues a temporary rejection so the next sweep retries it', async () => {
    setEmailProvider(
      stubProvider(() => ({ accepted: false, error: 'Mailbox busy (450)', retryable: true })),
    );

    await queue(fixture.school.id, ['asha@example.com']);
    await dispatchQueuedEmail();

    const [row] = await statusOf(fixture.school.id);
    expect(row).toMatchObject({ status: MessageStatus.QUEUED, attempts: 1 });
    expect(row!.error).toContain('450');
  });

  it('fails a rejected mailbox immediately rather than burning retries', async () => {
    setEmailProvider(
      stubProvider(() => ({ accepted: false, error: 'No such user (550)', retryable: false })),
    );

    await queue(fixture.school.id, ['nobody@example.com']);
    await dispatchQueuedEmail();

    const [row] = await statusOf(fixture.school.id);
    expect(row).toMatchObject({ status: MessageStatus.FAILED, attempts: 1 });
  });

  it('gives up after the configured number of attempts', async () => {
    setEmailProvider(stubProvider(() => ({ accepted: false, error: 'Timed out', retryable: true })));

    await queue(fixture.school.id, ['asha@example.com']);
    for (let i = 0; i < 5; i += 1) await dispatchQueuedEmail();

    const [row] = await statusOf(fixture.school.id);
    expect(row).toMatchObject({ status: MessageStatus.FAILED, attempts: 3 });
  });

  it("sends under the school's name and points replies at the school", async () => {
    const provider = stubProvider(() => ({ accepted: true, retryable: false }));
    setEmailProvider(provider);

    await prisma.school.update({
      where: { id: fixture.school.id },
      data: { name: 'Mlimani Secondary', email: 'info@mlimani.ac.tz' },
    });

    await queue(fixture.school.id, ['asha@example.com']);
    await dispatchQueuedEmail();

    // The address stays the configured one so SPF and DKIM still line up;
    // only the display name is per school.
    expect(provider.froms[0]).toBe('"Mlimani Secondary" <no-reply@example.test>');
    expect(provider.calls[0]![0]!.replyTo).toBe('info@mlimani.ac.tz');
  });

  it('substitutes a subject when one was not given', async () => {
    const provider = stubProvider(() => ({ accepted: true, retryable: false }));
    setEmailProvider(provider);

    await prisma.school.update({
      where: { id: fixture.school.id },
      data: { name: 'Mlimani Secondary' },
    });
    await queue(fixture.school.id, ['asha@example.com'], null);
    await dispatchQueuedEmail();

    expect(provider.calls[0]![0]!.subject).toBe('Message from Mlimani Secondary');
  });

  it('does nothing when no provider is configured', async () => {
    setEmailProvider(null);

    await queue(fixture.school.id, ['asha@example.com']);
    const summary = await dispatchQueuedEmail();

    expect(summary.skipped).toBe(true);
    const [row] = await statusOf(fixture.school.id);
    expect(row).toMatchObject({ status: MessageStatus.QUEUED, attempts: 0 });
  });
});

describe('SMTP failure handling', () => {
  /** Builds an SmtpProvider whose transport fails or succeeds as instructed. */
  const providerWith = (sendMail: (opts: Record<string, unknown>) => Promise<unknown>) =>
    new SmtpProvider({ createTransport: () => ({ sendMail }) });

  const one = (recipient = 'asha@example.com') => [{ recipient, subject: 's', body: 'b' }];

  it('treats a 5xx reply as permanent and a 4xx as worth retrying', async () => {
    const permanent = providerWith(() =>
      Promise.reject(Object.assign(new Error('No such user'), { responseCode: 550 })),
    );
    const rejected = await permanent.send(one('nobody@example.com'), 'School <no-reply@x.com>');
    expect(rejected[0]).toMatchObject({ accepted: false, retryable: false });
    expect(rejected[0]!.error).toContain('550');

    const temporary = providerWith(() =>
      Promise.reject(Object.assign(new Error('Try later'), { responseCode: 451 })),
    );
    const deferred = await temporary.send(one(), 'School <no-reply@x.com>');
    expect(deferred[0]).toMatchObject({ accepted: false, retryable: true });
  });

  it('treats bad credentials as permanent and a dropped connection as retryable', async () => {
    const auth = providerWith(() =>
      Promise.reject(Object.assign(new Error('Invalid login'), { code: 'EAUTH' })),
    );
    expect((await auth.send(one(), 'from@x.com'))[0]).toMatchObject({
      accepted: false,
      retryable: false,
    });

    const dropped = providerWith(() =>
      Promise.reject(Object.assign(new Error('Connection closed'), { code: 'ECONNECTION' })),
    );
    expect((await dropped.send(one(), 'from@x.com'))[0]).toMatchObject({
      accepted: false,
      retryable: true,
    });
  });

  it('catches a recipient the server took the message for but then refused', async () => {
    const provider = providerWith(() =>
      Promise.resolve({ messageId: '<x@mail>', rejected: ['nobody@example.com'] }),
    );

    const results = await provider.send(one('nobody@example.com'), 'from@x.com');
    expect(results[0]).toMatchObject({ accepted: false, retryable: false });
  });

  it('one bad address does not fail the rest of the batch', async () => {
    const provider = providerWith((opts) =>
      opts.to === 'bad@example.com'
        ? Promise.reject(Object.assign(new Error('No such user'), { responseCode: 550 }))
        : Promise.resolve({ messageId: `<${String(opts.to)}>` }),
    );

    const results = await provider.send(
      [
        { recipient: 'asha@example.com', subject: 's', body: 'b' },
        { recipient: 'bad@example.com', subject: 's', body: 'b' },
        { recipient: 'juma@example.com', subject: 's', body: 'b' },
      ],
      'from@x.com',
    );

    expect(results.map((r) => r.accepted)).toEqual([true, false, true]);
  });

  it('passes the reply-to address through to the message', async () => {
    const seen: Record<string, unknown>[] = [];
    const provider = providerWith((opts) => {
      seen.push(opts);
      return Promise.resolve({ messageId: '<x@mail>' });
    });

    await provider.send(
      [{ recipient: 'asha@example.com', subject: 'Fees', body: 'b', replyTo: 'info@school.ac.tz' }],
      '"Mlimani" <no-reply@x.com>',
    );

    expect(seen[0]).toMatchObject({
      from: '"Mlimani" <no-reply@x.com>',
      to: 'asha@example.com',
      replyTo: 'info@school.ac.tz',
      subject: 'Fees',
    });
  });
});
