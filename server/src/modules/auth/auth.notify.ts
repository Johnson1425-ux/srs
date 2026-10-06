import { MessageChannel } from '@prisma/client';
import { env, publicWebUrl } from '../../config/env.js';
import { normalizePhone, queueMessages } from '../communication/message.service.js';

/** Where a reset token is redeemed. */
export const passwordResetUrl = (token: string): string =>
  `${publicWebUrl}/reset-password/${token}`;

export interface ResetRecipient {
  schoolId: string;
  email: string;
  name: string;
  phone: string | null;
}

/**
 * Sends a password reset link.
 *
 * Queued rather than sent inline, so a slow SMTP host cannot hold up the
 * response — and so a failure here cannot change what the endpoint answers:
 * it deliberately says the same thing whether or not the address exists, and
 * an error leaking out of this would undo that.
 */
export async function sendPasswordReset(to: ResetRecipient, token: string): Promise<void> {
  const link = passwordResetUrl(token);
  const minutes = env.PASSWORD_RESET_TTL_MINUTES;

  try {
    await queueMessages(to.schoolId, [
      {
        channel: MessageChannel.EMAIL,
        recipient: to.email,
        subject: 'Reset your password',
        body: [
          `Hello ${to.name},`,
          '',
          'Someone asked to reset the password for this account. Open the link below',
          `to choose a new one. It stops working in ${minutes} minutes.`,
          '',
          link,
          '',
          'If this was not you, ignore this message. Your password has not changed.',
        ].join('\n'),
      },
      ...(to.phone
        ? [
            {
              channel: MessageChannel.SMS,
              recipient: normalizePhone(to.phone),
              body: `Reset your password (${minutes} min): ${link}`,
            },
          ]
        : []),
    ]);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[auth] could not queue the password reset message', err);
  }
}
