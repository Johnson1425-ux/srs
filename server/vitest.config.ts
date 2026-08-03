import { config } from 'dotenv';
import { defineConfig } from 'vitest/config';

config();

// Integration tests run against a dedicated database so a test run can never
// touch development data.
const testDatabaseUrl =
  process.env.TEST_DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/sms_test?schema=public';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['src/**/*.test.ts'],
    globalSetup: ['./src/tests/globalSetup.ts'],
    // Shared database: run suites sequentially so fixtures don't collide.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: testDatabaseUrl,
      // No pooler in front of the test database, so the direct connection is
      // the same one. Prisma requires it regardless.
      DIRECT_URL: testDatabaseUrl,
      JWT_ACCESS_SECRET: 'test-access-secret-at-least-16-chars',
      JWT_REFRESH_SECRET: 'test-refresh-secret-at-least-16-chars',
    },
  },
});
