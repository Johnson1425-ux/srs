import { MessageChannel, MessageStatus } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { emailConfigured, smsConfigured } from '../../config/env.js';
import { nudgeDispatcher } from './dispatcher.js';

export interface OutboundMessage {
  channel: MessageChannel;
  recipient: string;
  recipientUserId?: string | null;
  subject?: string | null;
  body: string;
}

/**
 * Renders `{{placeholders}}` in a template body.
 * Unknown placeholders are left untouched so a typo is visible rather than
 * silently producing an empty gap in a parent's SMS.
 */
export function renderTemplate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) =>
    key in vars ? String(vars[key]) : match,
  );
}

function transportConfigured(channel: MessageChannel): boolean {
  if (channel === MessageChannel.SMS) return smsConfigured;
  if (channel === MessageChannel.EMAIL) return emailConfigured;
  return true; // IN_APP and PUSH are served from the database
}

/**
 * Queues messages for delivery.
 *
 * With no gateway configured (the default in development), messages are stored
 * with status QUEUED and nothing is dispatched — the school still gets a full
 * outbox history, and wiring a real provider later means implementing `deliver`
 * without touching any caller.
 */
export async function queueMessages(
  schoolId: string,
  messages: OutboundMessage[],
): Promise<{ queued: number; dispatched: number }> {
  if (messages.length === 0) return { queued: 0, dispatched: 0 };

  await prisma.message.createMany({
    data: messages.map((m) => ({
      schoolId,
      channel: m.channel,
      recipient: m.recipient,
      recipientUserId: m.recipientUserId ?? null,
      subject: m.subject ?? null,
      body: m.body,
      status: MessageStatus.QUEUED,
    })),
  });

  const deliverable = messages.filter((m) => transportConfigured(m.channel));

  // In-app messages need no external transport, so mark them delivered now.
  const inApp = deliverable.filter((m) => m.channel === MessageChannel.IN_APP);
  if (inApp.length > 0) {
    await prisma.message.updateMany({
      where: {
        schoolId,
        channel: MessageChannel.IN_APP,
        status: MessageStatus.QUEUED,
        recipient: { in: inApp.map((m) => m.recipient) },
      },
      data: { status: MessageStatus.SENT, sentAt: new Date() },
    });
  }

  // Hand off to the dispatcher without waiting: a bulk send of several hundred
  // must not hold the request open while the gateway works through it.
  if (smsConfigured && messages.some((m) => m.channel === MessageChannel.SMS)) {
    nudgeDispatcher(MessageChannel.SMS);
  }
  if (emailConfigured && messages.some((m) => m.channel === MessageChannel.EMAIL)) {
    nudgeDispatcher(MessageChannel.EMAIL);
  }

  return { queued: messages.length, dispatched: inApp.length };
}

/** Normalises Tanzanian numbers to E.164, e.g. 0754123456 -> +255754123456. */
export function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('255')) return `+${digits}`;
  if (digits.startsWith('0')) return `+255${digits.slice(1)}`;
  if (digits.length === 9) return `+255${digits}`;
  return `+${digits}`;
}
