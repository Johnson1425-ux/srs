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
      // SMS is billed per segment and smart punctuation triples that, so the
      // text is folded to the GSM alphabet before it is stored and sent.
      body: m.channel === MessageChannel.SMS ? toGsm7(m.body) : m.body,
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

/**
 * GSM 03.38 — the alphabet a gateway can pack seven bits to the character.
 * A single character outside it forces the whole message into UCS-2, where a
 * segment holds 70 characters instead of 160. An em dash or a curly quote can
 * therefore double or triple what a school is billed, which is why this is
 * counted properly rather than estimated as length / 160.
 */
const GSM_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡' +
  'ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
/** These cost two characters each, being an escape plus the character. */
const GSM_EXTENDED = '^{}\\[~]|€';

/**
 * Typographic characters that a word processor produces and GSM 03.38 has no
 * room for. Each one on its own would push an entire message into UCS-2 and
 * more than double its cost, so they are folded to their plain equivalents.
 */
const GSM_SUBSTITUTIONS: Array<[RegExp, string]> = [
  [/[\u2013\u2014\u2015]/g, '-'],
  [/[\u2018\u2019\u201B]/g, "'"],
  [/[\u201C\u201D]/g, '"'],
  [/\u2026/g, '...'],
  [/\u00A0/g, ' '],
  [/[\u2022\u00B7]/g, '-'],
  [/\u00D7/g, 'x'],
];

/** Folds smart punctuation so a message stays in the cheap alphabet. */
export function toGsm7(text: string): string {
  return GSM_SUBSTITUTIONS.reduce((acc, [pattern, plain]) => acc.replace(pattern, plain), text);
}

export function isGsm7(text: string): boolean {
  return [...text].every((c) => GSM_BASIC.includes(c) || GSM_EXTENDED.includes(c));
}

/** How many segments a gateway will bill this message as. */
export function smsSegments(text: string): number {
  if (text.length === 0) return 0;

  if (!isGsm7(text)) {
    // UCS-2: 70 per single segment, 67 once concatenated.
    return text.length <= 70 ? 1 : Math.ceil(text.length / 67);
  }

  const units = [...text].reduce((n, c) => n + (GSM_EXTENDED.includes(c) ? 2 : 1), 0);
  return units <= 160 ? 1 : Math.ceil(units / 153);
}
