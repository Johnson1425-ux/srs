/**
 * Gives up on registrations nobody paid for, and releases their school codes.
 *
 * Sign-up releases a code it finds held by a stale registration, so this is
 * not required for correctness — it is here so an operator, or a nightly cron
 * entry, can clear them out without waiting for someone to want the same code.
 *
 *   npm run registrations:expire --workspace=server
 */
import { prisma } from '../db/prisma.js';
import { env } from '../config/env.js';
import { expireStaleRegistrations } from '../modules/registration/registration.service.js';

async function main(): Promise<void> {
  const { expired } = await expireStaleRegistrations();

  // eslint-disable-next-line no-console
  console.log(
    expired === 0
      ? `No registrations older than ${env.REGISTRATION_TTL_DAYS} days are still unpaid.`
      : `Cancelled ${expired} unpaid registration(s) older than ${env.REGISTRATION_TTL_DAYS} days and released their school codes.`,
  );
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
