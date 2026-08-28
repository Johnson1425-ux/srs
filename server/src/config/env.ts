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
  // `required_error` covers the variable being absent; `min(1)` covers it
  // being present but empty. Without both, an unset value reports only the
  // bare word "Required".
  DATABASE_URL: z
    .string({ required_error: 'DATABASE_URL is required' })
    .min(1, 'DATABASE_URL is required'),
  /**
   * Prisma resolves this when it loads the schema, so a missing value fails
   * inside the query engine rather than here. Validating it alongside
   * DATABASE_URL turns that into a named error at boot. Where there is no
   * pooler, it is simply the same connection string.
   */
  DIRECT_URL: z
    .string({
      required_error: 'DIRECT_URL is required — set it to DATABASE_URL when there is no pooler',
    })
    .min(1, 'DIRECT_URL is required — set it to DATABASE_URL when there is no pooler'),
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
  SMS_PROVIDER: z.enum(['none', 'africastalking', 'nextsms']).default('none'),
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

  // NextSMS (messaging-service.co.tz), a Tanzanian gateway.
  //
  // Their dashboard shows a ready-made authorization token, which is what most
  // people reach for; it can be pasted straight into NEXTSMS_AUTH_TOKEN, with
  // or without its `Basic ` prefix. The username and password below are the
  // same credentials in unencoded form and are used only when no token is set.
  NEXTSMS_AUTH_TOKEN: z.string().optional(),
  NEXTSMS_USERNAME: z.string().optional(),
  NEXTSMS_PASSWORD: z.string().optional(),
  /**
   * Sends to their /test path, which validates the request and reports back
   * without delivering anything or spending credit.
   */
  NEXTSMS_TEST_MODE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  NEXTSMS_BASE_URL: z.string().url().optional(),

  // `none` keeps email in the outbox without dispatching, mirroring SMS.
  EMAIL_PROVIDER: z.enum(['none', 'smtp']).default('none'),
  EMAIL_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  /** The From header, e.g. `Mlimani Secondary <no-reply@mlimani.ac.tz>`. */
  SMTP_FROM: z.string().optional(),
  /**
   * Implicit TLS from the first byte, which is port 465. Port 587 starts in
   * the clear and upgrades with STARTTLS, so it wants this off.
   */
  SMTP_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

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
  (env.SMS_PROVIDER === 'africastalking' &&
    Boolean(env.AFRICASTALKING_USERNAME && env.AFRICASTALKING_API_KEY)) ||
  (env.SMS_PROVIDER === 'nextsms' &&
    Boolean(env.NEXTSMS_AUTH_TOKEN || (env.NEXTSMS_USERNAME && env.NEXTSMS_PASSWORD)));

/**
 * Email needs a host to connect to and an address to send from. Credentials
 * are optional — an internal relay on the same network often takes mail
 * without authenticating — but a From header is not, since most receiving
 * servers reject a message that has none.
 */
export const emailConfigured =
  env.EMAIL_PROVIDER === 'smtp' && Boolean(env.SMTP_HOST && env.SMTP_FROM);

/** A single school running its own installation — no plans, no platform admin. */
export const isStandalone = env.DEPLOYMENT_MODE === 'standalone';
/** One deployment serving many schools under subscription. */
export const isSaas = !isStandalone;
