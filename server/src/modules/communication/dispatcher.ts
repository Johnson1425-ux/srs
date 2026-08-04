import { MessageChannel, MessageStatus } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { emailConfigured, env, smsConfigured } from '../../config/env.js';
import { AfricasTalkingProvider } from './providers/africastalking.js';
import { SmtpProvider } from './providers/smtp.js';
import type { DeliveryResult, EmailProvider, SmsProvider } from './providers/types.js';

let smsProvider: SmsProvider | null = null;
let emailProvider: EmailProvider | null = null;

/** Swappable for tests, and the seam a second provider would slot into. */
export function setSmsProvider(next: SmsProvider | null): void {
  smsProvider = next;
}

export function setEmailProvider(next: EmailProvider | null): void {
  emailProvider = next;
}

function activeSmsProvider(): SmsProvider | null {
  if (smsProvider) return smsProvider;
  if (!smsConfigured) return null;
  smsProvider = new AfricasTalkingProvider();
  return smsProvider;
}

function activeEmailProvider(): EmailProvider | null {
  if (emailProvider) return emailProvider;
  if (!emailConfigured) return null;
  emailProvider = new SmtpProvider();
  return emailProvider;
}

export interface DispatchSummary {
  attempted: number;
  sent: number;
  failed: number;
  skipped: boolean;
}

const NOTHING: DispatchSummary = { attempted: 0, sent: 0, failed: 0, skipped: false };

interface ClaimedMessage {
  id: string;
  recipient: string;
  subject: string | null;
  body: string;
  schoolId: string;
  attempts: number;
}

/**
 * Takes ownership of everything due on a channel.
 *
 * Messages are marked FAILED and their attempt counted *before* the request
 * goes out, so a second sweep starting mid-flight cannot send the same message
 * twice and a crash leaves a message unsent rather than silently re-sent —
 * the safer way round for something that costs money and reaches a parent.
 */
async function claim(
  channel: MessageChannel,
  maxAttempts: number,
  limit: number,
): Promise<ClaimedMessage[]> {
  const due = await prisma.message.findMany({
    where: { channel, status: MessageStatus.QUEUED, attempts: { lt: maxAttempts } },
    orderBy: { createdAt: 'asc' },
    take: limit,
    select: { id: true, recipient: true, subject: true, body: true, schoolId: true, attempts: true },
  });
  if (due.length === 0) return [];

  await prisma.message.updateMany({
    where: { id: { in: due.map((m) => m.id) } },
    data: {
      status: MessageStatus.FAILED,
      attempts: { increment: 1 },
      lastAttemptAt: new Date(),
      error: 'Dispatch interrupted',
    },
  });

  return due;
}

/** Writes back one outcome, deciding whether it earns another attempt. */
async function record(
  message: ClaimedMessage,
  result: DeliveryResult | undefined,
  maxAttempts: number,
): Promise<'sent' | 'failed'> {
  if (result?.accepted) {
    await prisma.message.update({
      where: { id: message.id },
      data: {
        status: MessageStatus.SENT,
        sentAt: new Date(),
        providerRef: result.providerRef ?? null,
        cost: result.cost ?? null,
        error: null,
      },
    });
    return 'sent';
  }

  const attemptsUsed = message.attempts + 1;
  const worthRetrying = (result?.retryable ?? true) && attemptsUsed < maxAttempts;

  await prisma.message.update({
    where: { id: message.id },
    data: {
      status: worthRetrying ? MessageStatus.QUEUED : MessageStatus.FAILED,
      error: result?.error ?? 'No response for this recipient',
    },
  });
  return 'failed';
}

/** Serialises sweeps per channel so a manual trigger cannot overlap the timer. */
const inFlight = new Map<MessageChannel, Promise<DispatchSummary>>();

function serialise(
  channel: MessageChannel,
  run: () => Promise<DispatchSummary>,
): Promise<DispatchSummary> {
  const existing = inFlight.get(channel);
  if (existing) return existing;

  const started = run().finally(() => inFlight.delete(channel));
  inFlight.set(channel, started);
  return started;
}

/**
 * Sends queued SMS. A message that fails for a reason that could pass later
 * goes back to QUEUED until it runs out of attempts; one that never could is
 * failed immediately, because retrying an invalid number just burns credit and
 * delays the queue behind it.
 */
export function dispatchQueuedSms(limit = 200): Promise<DispatchSummary> {
  return serialise(MessageChannel.SMS, async () => {
    const provider = activeSmsProvider();
    if (!provider) return { ...NOTHING, skipped: true };

    const due = await claim(MessageChannel.SMS, env.SMS_MAX_ATTEMPTS, limit);
    if (due.length === 0) return NOTHING;

    // The sender ID is per school, falling back to the deployment default.
    const schoolIds = [...new Set(due.map((m) => m.schoolId))];
    const schools = await prisma.school.findMany({
      where: { id: { in: schoolIds } },
      select: { id: true, smsSenderId: true },
    });
    const senderFor = new Map(schools.map((s) => [s.id, s.smsSenderId || env.SMS_SENDER_ID]));

    let sent = 0;
    let failed = 0;

    for (const schoolId of schoolIds) {
      const batch = due.filter((m) => m.schoolId === schoolId);
      const results = await provider.send(
        batch.map((m) => ({ recipient: m.recipient, body: m.body })),
        senderFor.get(schoolId) ?? env.SMS_SENDER_ID,
      );

      // A recipient can legitimately appear more than once in one sweep, so
      // results are consumed per message rather than looked up by number.
      const queues = new Map<string, DeliveryResult[]>();
      for (const r of results) {
        const list = queues.get(r.recipient) ?? [];
        list.push(r);
        queues.set(r.recipient, list);
      }

      for (const message of batch) {
        const outcome = await record(
          message,
          queues.get(message.recipient)?.shift(),
          env.SMS_MAX_ATTEMPTS,
        );
        outcome === 'sent' ? (sent += 1) : (failed += 1);
      }
    }

    return { attempted: due.length, sent, failed, skipped: false };
  });
}

/**
 * Builds the From header.
 *
 * The address stays the configured one, because that is what the relay is
 * authorised to send as and what SPF and DKIM are aligned to — swapping in the
 * school's own address would get the mail rejected or filed as spam. Only the
 * display name is per school, with replies pointed at the school itself.
 */
function fromHeader(schoolName: string): string {
  const configured = env.SMTP_FROM ?? '';
  const address = configured.match(/<([^>]+)>/)?.[1] ?? configured.trim();
  if (!address) return configured;
  return `"${schoolName.replace(/["\\]/g, '')}" <${address}>`;
}

/** Sends queued email, on the same claim-then-send terms as SMS. */
export function dispatchQueuedEmail(limit = 200): Promise<DispatchSummary> {
  return serialise(MessageChannel.EMAIL, async () => {
    const provider = activeEmailProvider();
    if (!provider) return { ...NOTHING, skipped: true };

    const due = await claim(MessageChannel.EMAIL, env.EMAIL_MAX_ATTEMPTS, limit);
    if (due.length === 0) return NOTHING;

    const schoolIds = [...new Set(due.map((m) => m.schoolId))];
    const schools = await prisma.school.findMany({
      where: { id: { in: schoolIds } },
      select: { id: true, name: true, email: true },
    });
    const schoolById = new Map(schools.map((s) => [s.id, s]));

    let sent = 0;
    let failed = 0;

    for (const schoolId of schoolIds) {
      const batch = due.filter((m) => m.schoolId === schoolId);
      const school = schoolById.get(schoolId);
      const name = school?.name ?? 'School';

      const results = await provider.send(
        batch.map((m) => ({
          recipient: m.recipient,
          // A subject is optional when queueing but not on the wire, and an
          // empty one is a spam signal.
          subject: m.subject?.trim() || `Message from ${name}`,
          body: m.body,
          replyTo: school?.email ?? undefined,
        })),
        fromHeader(name),
      );

      // Email is addressed individually, so results come back one per message
      // in order — the same address can appear twice with different subjects.
      for (const [i, message] of batch.entries()) {
        const outcome = await record(message, results[i], env.EMAIL_MAX_ATTEMPTS);
        outcome === 'sent' ? (sent += 1) : (failed += 1);
      }
    }

    return { attempted: due.length, sent, failed, skipped: false };
  });
}

/** Fire-and-forget nudge, so queueing a message does not block the response. */
export function nudgeDispatcher(channel: MessageChannel = MessageChannel.SMS): void {
  const run =
    channel === MessageChannel.EMAIL
      ? emailConfigured || emailProvider
        ? dispatchQueuedEmail
        : null
      : smsConfigured || smsProvider
        ? dispatchQueuedSms
        : null;
  if (!run) return;

  void run().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`[${channel.toLowerCase()}] dispatch failed`, err);
  });
}

let timer: NodeJS.Timeout | null = null;

/** Periodic sweep, so retries and anything missed still go out. */
export function startMessageWorker(intervalMs = 60_000): void {
  if (timer || (!smsConfigured && !emailConfigured)) return;
  timer = setInterval(() => {
    nudgeDispatcher(MessageChannel.SMS);
    nudgeDispatcher(MessageChannel.EMAIL);
  }, intervalMs);
  timer.unref();

  const channels = [smsConfigured && env.SMS_PROVIDER, emailConfigured && env.EMAIL_PROVIDER]
    .filter(Boolean)
    .join(', ');
  // eslint-disable-next-line no-console
  console.log(`Message worker started (${channels}, every ${intervalMs / 1000}s)`);
}

export function stopMessageWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
  void emailProvider?.close?.();
}
