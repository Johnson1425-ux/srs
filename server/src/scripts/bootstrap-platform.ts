/**
 * Creates the first platform administrator of a SaaS deployment.
 *
 * A super admin belongs to no school, so nothing inside a school can create
 * one: the school user routes refuse the role outright, and platform
 * administration is itself closed to anyone who is not already a super admin.
 * That leaves a fresh installation with no way in, which this script solves —
 * once. Afterwards, further administrators are added from Schools →
 * Administrators in the application.
 *
 *   npm run bootstrap:platform
 *
 * Values may be supplied as environment variables for an unattended install,
 * and anything missing is prompted for when a terminal is attached:
 *
 *   ADMIN_FIRST_NAME, ADMIN_LAST_NAME, ADMIN_EMAIL,
 *   ADMIN_PASSWORD (generated when omitted)
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { randomBytes } from 'node:crypto';
import { PrismaClient, Role } from '@prisma/client';
import argon2 from 'argon2';

const prisma = new PrismaClient();
const force = process.argv.includes('--force');

function generatePassword(): string {
  // Satisfies the password policy: upper, lower and a digit.
  return `Sms-${randomBytes(6).toString('hex')}A1`;
}

async function ask(
  rl: ReturnType<typeof createInterface> | null,
  label: string,
  envValue: string | undefined,
): Promise<string> {
  const preset = envValue?.trim();
  if (preset) return preset;

  if (!rl) {
    throw new Error(
      `Missing value for ${label}. Set it as an environment variable, or run this with a terminal attached.`,
    );
  }

  const answer = (await rl.question(`${label}: `)).trim();
  if (answer) return answer;
  throw new Error(`${label} is required`);
}

async function main(): Promise<void> {
  const existing = await prisma.user.count({ where: { role: Role.SUPER_ADMIN } });

  if (existing > 0 && !force) {
    console.error(
      `\nThis installation already has ${existing} platform administrator(s).\n` +
        'Add further ones from Schools → Administrators, where the action is\n' +
        'recorded against whoever took it.\n' +
        'Re-run with --force only if you have genuinely lost access to them all.\n',
    );
    process.exit(1);
  }

  const interactive = Boolean(stdin.isTTY);
  const rl = interactive ? createInterface({ input: stdin, output: stdout }) : null;

  try {
    console.log('\nCreating the first platform administrator\n');

    const firstName = await ask(rl, 'First name', process.env.ADMIN_FIRST_NAME);
    const lastName = await ask(rl, 'Last name', process.env.ADMIN_LAST_NAME);
    const email = (await ask(rl, 'Email', process.env.ADMIN_EMAIL)).toLowerCase();

    if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error('Email is not valid');

    const clash = await prisma.user.findFirst({ where: { email, schoolId: null } });
    if (clash) throw new Error(`${email} is already a platform account`);

    const suppliedPassword = process.env.ADMIN_PASSWORD?.trim();
    const password = suppliedPassword || generatePassword();

    await prisma.user.create({
      data: {
        schoolId: null,
        email,
        firstName,
        lastName,
        role: Role.SUPER_ADMIN,
        passwordHash: await argon2.hash(password, { type: argon2.argon2id }),
        // Only force a change when we generated the password ourselves.
        mustChangePassword: !suppliedPassword,
      },
    });

    console.log('\n  Platform administrator created.\n');
    console.log('  Sign in with:');
    console.log(`    ${email}`);
    console.log(`    ${password}`);
    if (!suppliedPassword) {
      console.log('\n  This password must be changed at first sign-in.');
    }
    console.log('\n  Next: onboard your first school from the Schools page.\n');
  } finally {
    rl?.close();
  }
}

main()
  .catch((err: unknown) => {
    console.error(`\n${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
