/**
 * Creates the first account a fresh deployment can sign in with.
 *
 *   npm run bootstrap                    a school and its administrator
 *   npm run bootstrap -- --super-admin   the platform administrator, no school
 *
 * A SaaS deployment onboards tenants through `POST /platform/schools`, which
 * requires a super admin — and a super admin can only be created here, since
 * onboarding is the thing it exists to do. Use `--super-admin` when you intend
 * to add schools through the platform screens yourself.
 *
 * A standalone installation has no platform administration at all, so it wants
 * the default form: one school, with its own ADMIN as the highest role.
 *
 * Values may be supplied as environment variables for unattended installs, and
 * anything missing is prompted for when a terminal is attached:
 *
 *   SCHOOL_NAME, SCHOOL_CODE, ADMIN_FIRST_NAME, ADMIN_LAST_NAME,
 *   ADMIN_EMAIL, ADMIN_PASSWORD (generated when omitted)
 *
 * `--super-admin` reads the same ADMIN_* variables and ignores the SCHOOL_ ones.
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { PrismaClient, Role, SchoolStatus, SubscriptionPlan } from '@prisma/client';
import argon2 from 'argon2';
import { randomBytes } from 'node:crypto';

const prisma = new PrismaClient();

const mode = process.env.DEPLOYMENT_MODE === 'standalone' ? 'standalone' : 'saas';
const force = process.argv.includes('--force');
const superAdminOnly = process.argv.includes('--super-admin');

function generatePassword(): string {
  // Satisfies the password policy: upper, lower and a digit.
  return `Sms-${randomBytes(6).toString('hex')}A1`;
}

async function ask(
  rl: ReturnType<typeof createInterface> | null,
  label: string,
  envValue: string | undefined,
  fallback?: string,
): Promise<string> {
  const preset = envValue?.trim();
  if (preset) return preset;

  if (!rl) {
    throw new Error(
      `Missing value for ${label}. Set it as an environment variable, or run this with a terminal attached.`,
    );
  }

  const suffix = fallback ? ` [${fallback}]` : '';
  const answer = (await rl.question(`${label}${suffix}: `)).trim();

  if (answer) return answer;
  if (fallback) return fallback;
  throw new Error(`${label} is required`);
}

/**
 * Creates the platform administrator and nothing else.
 *
 * It belongs to no school — that is what `schoolId: null` means on User, and
 * why the uniqueness of its email has to be checked by hand: the
 * `@@unique([schoolId, email])` index does not constrain rows where schoolId
 * is null, because Postgres treats each null as distinct.
 */
async function createSuperAdmin(rl: ReturnType<typeof createInterface> | null): Promise<void> {
  if (mode === 'standalone' && !force) {
    console.error(
      '\nA standalone installation has no platform administration to run.\n' +
        "The school's own ADMIN is the highest role, and /platform is not\n" +
        'mounted at all. Run without --super-admin to create the school, or\n' +
        'pass --force if you are converting this installation to saas.\n',
    );
    process.exit(1);
  }

  const existing = await prisma.user.count({ where: { role: Role.SUPER_ADMIN, schoolId: null } });

  if (existing > 0 && !force) {
    console.error(
      `\nThis deployment already has ${existing} platform administrator(s).\n` +
        'Create any further ones from the platform screens, where the action\n' +
        'is audited. Re-run with --force to add one here anyway.\n',
    );
    process.exit(1);
  }

  console.log('\nCreating the platform administrator\n');

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
      email,
      firstName,
      lastName,
      role: Role.SUPER_ADMIN,
      passwordHash: await argon2.hash(password, { type: argon2.argon2id }),
      // Only force a change when we generated the password ourselves.
      mustChangePassword: !suppliedPassword,
    },
  });

  console.log('\n  Platform administrator created\n');
  console.log('  Sign in with:');
  console.log(`    ${email}`);
  console.log(`    ${password}`);
  if (!suppliedPassword) {
    console.log('\n  This password must be changed at first sign-in.');
  }
  console.log('\n  Next: add each school under Platform. Every one gets its own');
  console.log('  administrator, who sets up its academic year from there.\n');
}

async function main(): Promise<void> {
  const interactive = Boolean(stdin.isTTY);
  const rl = interactive ? createInterface({ input: stdin, output: stdout }) : null;

  try {
    if (superAdminOnly) {
      await createSuperAdmin(rl);
      return;
    }

    const existing = await prisma.school.count();

    if (existing > 0 && mode === 'standalone' && !force) {
      console.error(
        `\nThis installation already has ${existing} school(s).\n` +
          'A standalone installation is meant to hold exactly one.\n' +
          'Re-run with --force if you genuinely intend to add another.\n',
      );
      process.exit(1);
    }

    console.log(`\nSetting up a new school (${mode} mode)\n`);

    const name = await ask(rl, 'School name', process.env.SCHOOL_NAME);
    const rawCode = await ask(rl, 'School code (short, e.g. MLM)', process.env.SCHOOL_CODE);
    const code = rawCode.toUpperCase();

    if (!/^[A-Z0-9]{2,12}$/.test(code)) {
      throw new Error('School code must be 2-12 alphanumeric characters');
    }

    const clash = await prisma.school.findUnique({ where: { code } });
    if (clash) throw new Error(`School code ${code} is already in use`);

    const firstName = await ask(rl, 'Administrator first name', process.env.ADMIN_FIRST_NAME);
    const lastName = await ask(rl, 'Administrator last name', process.env.ADMIN_LAST_NAME);
    const email = (await ask(rl, 'Administrator email', process.env.ADMIN_EMAIL)).toLowerCase();

    if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error('Administrator email is not valid');

    const suppliedPassword = process.env.ADMIN_PASSWORD?.trim();
    const password = suppliedPassword || generatePassword();

    const school = await prisma.$transaction(async (tx) => {
      const created = await tx.school.create({
        data: {
          name,
          code,
          status: SchoolStatus.ACTIVE,
          // Standalone is owned outright, so the plan fields are inert; they
          // are still filled in so the record is sane if the mode ever changes.
          plan: mode === 'standalone' ? SubscriptionPlan.PREMIUM : SubscriptionPlan.TRIAL,
          planStartsAt: new Date(),
          maxStudents: mode === 'standalone' ? 100_000 : 500,
          storageQuotaMb: mode === 'standalone' ? 1_000_000 : 1024,
        },
      });

      await tx.user.create({
        data: {
          schoolId: created.id,
          email,
          firstName,
          lastName,
          role: Role.ADMIN,
          passwordHash: await argon2.hash(password, { type: argon2.argon2id }),
          // Only force a change when we generated the password ourselves.
          mustChangePassword: !suppliedPassword,
        },
      });

      // Marks cannot be graded without a scale, so ship a sensible default.
      await tx.gradeScale.create({
        data: {
          schoolId: created.id,
          name: 'Default (Tanzania)',
          isDefault: true,
          bands: {
            create: [
              { grade: 'A', minScore: 75, maxScore: 100, points: 5, remark: 'Excellent' },
              { grade: 'B', minScore: 65, maxScore: 74.99, points: 4, remark: 'Very Good' },
              { grade: 'C', minScore: 45, maxScore: 64.99, points: 3, remark: 'Good' },
              { grade: 'D', minScore: 30, maxScore: 44.99, points: 2, remark: 'Satisfactory' },
              { grade: 'F', minScore: 0, maxScore: 29.99, points: 1, remark: 'Fail' },
            ],
          },
        },
      });

      return created;
    });

    console.log(`\n  ${school.name} created (code ${school.code})\n`);
    console.log('  Sign in with:');
    console.log(`    ${email}`);
    console.log(`    ${password}`);
    if (!suppliedPassword) {
      console.log('\n  This password must be changed at first sign-in.');
    }
    console.log('\n  Next: set up the academic year and terms under Academics —');
    console.log('  admissions need a current year before students can be enrolled.\n');
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
