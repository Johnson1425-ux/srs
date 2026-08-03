import { MessageChannel, MessageStatus } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { env, smsConfigured } from '../../config/env.js';
import { AfricasTalkingProvider } from './providers/africastalking.js';
import type { SmsProvider } from './providers/types.js';

let provider: SmsProvider | null = null;

/** Swappable for tests, and the seam a second provider would slot into. */
export function setSmsProvider(next: SmsProvider | null): void {
  provider = next;
}

function activeProvider(): SmsProvider | null {
  if (provider) return provider;
  if (!smsConfigured) return null;
  provider = new AfricasTalkingProvider();
  return provider;
}

export interface DispatchSummary {
  attempted: number;
  sent: number;
  failed: number;
  skipped: boolean;
}

/** Serialises sweeps so a manual trigger cannot overlap the timer. */
let inFlight: Promise<DispatchSummary> | null = null;

/**
 * Sends queued SMS.
 *
 * Messages are claimed before the request goes out, so a second sweep starting
 * mid-flight cannot send the same message twice. A message that fails for a
 * reason that could pass later goes back to QUEUED until it runs out of
 * attempts; one that never could is failed immediately, because retrying an
 * invalid number just burns credit and delays the queue behind it.
 */
export async function dispatchQueuedSms(limit = 200): Promise<DispatchSummary> {
  if (inFlight) return inFlight;

  inFlight = (async (): Promise<DispatchSummary> => {
    const active = activeProvider();
    if (!active) return { attempted: 0, sent: 0, failed: 0, skipped: true };

    const due = await prisma.message.findMany({
      where: {
        channel: MessageChannel.SMS,
        status: MessageStatus.QUEUED,
        attempts: { lt: env.SMS_MAX_ATTEMPTS },
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: { id: true, recipient: true, body: true, schoolId: true, attempts: true },
    });
    if (due.length === 0) return { attempted: 0, sent: 0, failed: 0, skipped: false };

    // Claim them first: a crash after this leaves them FAILED rather than
    // silently re-sent, which is the safer way round for something that costs
    // money and reaches a parent's phone.
    await prisma.message.updateMany({
      where: { id: { in: due.map((m) => m.id) } },
      data: {
        status: MessageStatus.FAILED,
        attempts: { increment: 1 },
        lastAttemptAt: new Date(),
        error: 'Dispatch interrupted',
      },
    });

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
      const results = await active.send(
        batch.map((m) => ({ recipient: m.recipient, body: m.body })),
        senderFor.get(schoolId) ?? env.SMS_SENDER_ID,
      );

      // A recipient can legitimately appear more than once in one sweep, so
      // results are consumed per message rather than looked up by number.
      const queues = new Map<string, typeof results>();
      for (const r of results) {
        const list = queues.get(r.recipient) ?? [];
        list.push(r);
        queues.set(r.recipient, list);
      }

      for (const message of batch) {
        const result = queues.get(message.recipient)?.shift();

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
          sent += 1;
          continue;
        }

        const error = result?.error ?? 'No response for this recipient';
        const attemptsUsed = message.attempts + 1;
        const worthRetrying = (result?.retryable ?? true) && attemptsUsed < env.SMS_MAX_ATTEMPTS;

        await prisma.message.update({
          where: { id: message.id },
          data: {
            status: worthRetrying ? MessageStatus.QUEUED : MessageStatus.FAILED,
            error,
          },
        });
        failed += 1;
      }
    }

    return { attempted: due.length, sent, failed, skipped: false };
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

/** Fire-and-forget nudge, so queueing a message does not block the response. */
export function nudgeDispatcher(): void {
  if (!smsConfigured && !provider) return;
  void dispatchQueuedSms().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[sms] dispatch failed', err);
  });
}

let timer: NodeJS.Timeout | null = null;

/** Periodic sweep, so retries and anything missed still go out. */
export function startSmsWorker(intervalMs = 60_000): void {
  if (timer || !smsConfigured) return;
  timer = setInterval(() => nudgeDispatcher(), intervalMs);
  timer.unref();
  // eslint-disable-next-line no-console
  console.log(`SMS worker started (${env.SMS_PROVIDER}, every ${intervalMs / 1000}s)`);
}

export function stopSmsWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
