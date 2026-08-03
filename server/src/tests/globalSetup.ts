import { execSync } from 'node:child_process';

/** Brings the test database up to the current schema before any suite runs. */
export default function setup(): void {
  const databaseUrl =
    process.env.TEST_DATABASE_URL ??
    'postgresql://postgres:postgres@localhost:5432/sms_test?schema=public';

  execSync('npx prisma migrate deploy', {
    stdio: 'inherit',
    // DIRECT_URL is what migrations actually run over; the test database has
    // no pooler in front of it, so both point at the same place.
    env: { ...process.env, DATABASE_URL: databaseUrl, DIRECT_URL: databaseUrl },
  });
}
