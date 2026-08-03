import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  /**
   * How this installation is sold and run.
   *
   * - `saas`       — one deployment serving many schools, with platform
   *                  administration, subscription plans and their limits.
   * - `standalone` — one school that owns its installation outright. Platform
   *                  administration is not mounted at all and plan limits do
   *                  not apply, because there is no plan.
   *
   * The data model is identical either way; only these behaviours differ.
   */
  DEPLOYMENT_MODE: z.enum(['saas', 'standalone']).default('saas'),

  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  TEST_DATABASE_URL: z.string().optional(),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),

  JWT_ACCESS_SECRET: z.string().min(16, 'JWT_ACCESS_SECRET must be at least 16 characters'),
  JWT_REFRESH_SECRET: z.string().min(16, 'JWT_REFRESH_SECRET must be at least 16 characters'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().positive().default(30),
  MAX_FAILED_LOGINS: z.coerce.number().int().positive().default(5),
  ACCOUNT_LOCK_MINUTES: z.coerce.number().int().positive().default(15),

  // `none` keeps SMS in the outbox without dispatching — the default, so a
  // development machine never spends real credit or texts real parents.
  SMS_PROVIDER: z.enum(['none', 'africastalking']).default('none'),
  SMS_SENDER_ID: z.string().default('SCHOOL'),
  /** How many delivery attempts before a message is left FAILED. */
  SMS_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),

  AFRICASTALKING_USERNAME: z.string().optional(),
  AFRICASTALKING_API_KEY: z.string().optional(),
  // The sandbox has its own host and expects the username "sandbox".
  AFRICASTALKING_SANDBOX: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /** Overrides the gateway endpoint — for an outbound proxy, or a stub in testing. */
  AFRICASTALKING_BASE_URL: z.string().url().optional(),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM: z.string().optional(),

  STORAGE_DRIVER: z.enum(['local', 's3', 'azure']).default('local'),
  STORAGE_LOCAL_PATH: z.string().default('./uploads'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  // Fail loudly at boot rather than at the first request that needs the value.
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

export const env = parsed.data;

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

/**
 * SMS only dispatches when a provider is named *and* its credentials are
 * present. Half-configured is treated as unconfigured, so a missing key fails
 * loudly at boot-time reasoning rather than silently at 3am.
 */
export const smsConfigured =
  env.SMS_PROVIDER === 'africastalking' &&
  Boolean(env.AFRICASTALKING_USERNAME && env.AFRICASTALKING_API_KEY);

/** A single school running its own installation — no plans, no platform admin. */
export const isStandalone = env.DEPLOYMENT_MODE === 'standalone';
/** One deployment serving many schools under subscription. */
export const isSaas = !isStandalone;
