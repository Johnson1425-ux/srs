import { MessageChannel } from '@prisma/client';
import { publicWebUrl } from '../../config/env.js';
import { queueMessages, normalizePhone } from '../communication/message.service.js';

/**
 * What a school is told about its own registration.
 *
 * A school signing itself up is the one correspondent the application has no
 * other way of reaching: it cannot sign in yet, so nothing can be shown to it
 * in the app, and the sign-up response is the only thing it ever sees. Close
 * the browser tab and both the temporary password and the link back to the
 * payment are gone for good — which is why these messages exist rather than
 * being a nicety.
 *
 * Everything here is queued through the ordinary outbox, so it appears in the
 * school's message history, is retried by the dispatcher, and costs nothing on
 * a deployment with no transport configured.
 *
 * None of it can fail a registration: a sign-up that took someone's money must
 * not be rolled back because an SMTP host was slow, so every function swallows
 * its errors after logging them.
 */

export interface RegistrationNotice {
  schoolId: string;
  schoolName: string;
  administratorEmail: string;
  administratorName: string;
  msisdn: string;
  claimToken: string;
  plan: string;
  amountText: string;
}

/** Where a school resumes a payment it has not finished. */
export const paymentUrl = (claimToken: string): string =>
  `${publicWebUrl}/register/${claimToken}`;

const signInUrl = (): string => `${publicWebUrl}/login`;

async function send(
  schoolId: string,
  what: string,
  messages: Parameters<typeof queueMessages>[1],
): Promise<void> {
  try {
    await queueMessages(schoolId, messages);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[registration] could not queue ${what} for school ${schoolId}`, err);
  }
}

/**
 * Sent the moment a school signs up, before the payment is known to have
 * worked.
 *
 * It carries the temporary password because this is the only message that ever
 * will: the account exists from this point on, whatever becomes of the
 * payment, and an administrator who cannot sign in cannot be helped by anyone
 * but platform staff.
 */
export async function sendRegistrationStarted(
  notice: RegistrationNotice,
  temporaryPassword: string,
): Promise<void> {
  const link = paymentUrl(notice.claimToken);

  await send(notice.schoolId, 'the sign-up message', [
    {
      channel: MessageChannel.EMAIL,
      recipient: notice.administratorEmail,
      subject: `${notice.schoolName}: finish your registration`,
      body: [
        `Hello ${notice.administratorName},`,
        '',
        `${notice.schoolName} has been registered on the ${notice.plan} plan, and we have`,
        `asked M-Pesa to charge ${notice.amountText} to ${notice.msisdn}. Enter your M-Pesa PIN on`,
        'that phone to complete it.',
        '',
        `Follow your payment here: ${link}`,
        'That link is the only way back to this payment, so keep this message.',
        '',
        'Once the payment is confirmed you can sign in with:',
        `  Email:    ${notice.administratorEmail}`,
        `  Password: ${temporaryPassword}`,
        '',
        'You will be asked to choose your own password the first time you sign in.',
        '',
        `Sign in at ${signInUrl()}`,
      ].join('\n'),
    },
    {
      // To the phone being charged, which is the one number we know is live.
      // Short on purpose: SMS is billed per 160 characters.
      channel: MessageChannel.SMS,
      recipient: normalizePhone(notice.msisdn),
      body: `${notice.schoolName}: enter your M-Pesa PIN to pay ${notice.amountText}. Track it: ${link}`,
    },
  ]);
}

/** Sent once the fee is confirmed and the school can actually be used. */
export async function sendRegistrationConfirmed(notice: RegistrationNotice): Promise<void> {
  await send(notice.schoolId, 'the payment confirmation', [
    {
      channel: MessageChannel.EMAIL,
      recipient: notice.administratorEmail,
      subject: `${notice.schoolName}: payment received, your school is open`,
      body: [
        `Hello ${notice.administratorName},`,
        '',
        `We have received ${notice.amountText} for the ${notice.plan} plan. ${notice.schoolName}`,
        'is now open and you can sign in.',
        '',
        `Sign in at ${signInUrl()} as ${notice.administratorEmail}, with the temporary`,
        'password from our earlier message. You will be asked to change it.',
      ].join('\n'),
    },
    {
      channel: MessageChannel.SMS,
      recipient: normalizePhone(notice.msisdn),
      body: `${notice.schoolName}: payment of ${notice.amountText} received. Your school is open: ${signInUrl()}`,
    },
  ]);
}

/**
 * Sent when M-Pesa refuses the payment.
 *
 * The sign-up page says the same thing, but only to a browser that is still
 * open — and a payment is most likely to be refused precisely when somebody has
 * walked away from it.
 */
export async function sendRegistrationFailed(
  notice: RegistrationNotice,
  reason: string | null,
): Promise<void> {
  const link = paymentUrl(notice.claimToken);

  await send(notice.schoolId, 'the payment failure message', [
    {
      channel: MessageChannel.EMAIL,
      recipient: notice.administratorEmail,
      subject: `${notice.schoolName}: your registration payment did not go through`,
      body: [
        `Hello ${notice.administratorName},`,
        '',
        `M-Pesa did not complete the ${notice.amountText} payment for ${notice.schoolName}.`,
        ...(reason ? ['', `M-Pesa said: ${reason}`] : []),
        '',
        `You can try again here: ${link}`,
        '',
        'Your school details are saved. Nothing has been charged.',
      ].join('\n'),
    },
  ]);
}

/** Sent when an unpaid registration is given up on and its code released. */
export async function sendRegistrationExpired(
  notice: Omit<RegistrationNotice, 'claimToken'>,
  days: number,
): Promise<void> {
  await send(notice.schoolId, 'the expiry message', [
    {
      channel: MessageChannel.EMAIL,
      recipient: notice.administratorEmail,
      subject: `${notice.schoolName}: registration cancelled`,
      body: [
        `Hello ${notice.administratorName},`,
        '',
        `The registration for ${notice.schoolName} was never paid for, so after ${days} days`,
        'we have cancelled it. Nothing was charged.',
        '',
        `You are welcome to register again at ${publicWebUrl}/register — the school code you`,
        'chose is free for anyone to use once more, including you.',
      ].join('\n'),
    },
  ]);
}
