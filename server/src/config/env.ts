import 'dotenv/config';
import { z } from 'zod';

/**
 * An optional URL where a blank value means unset.
 *
 * `.env.example` carries these keys with nothing after the `=`, and a bare
 * `z.string().url().optional()` reads that empty string as a value and refuses
 * it — so copying the example file verbatim would stop the server booting.
 */
const optionalUrl = () =>
  z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().url().optional(),
  );

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
  /**
   * Where the app is reached from outside — the base for the results links
   * texted to parents. Defaults to the first CORS origin, which is already the
   * address the browser uses, so a correct deployment needs no extra setting.
   * Every character here is billed in every message, so a short host is worth
   * having.
   */
  PUBLIC_WEB_URL: optionalUrl(),
  /** How long a texted results link keeps working. */
  RESULT_LINK_TTL_DAYS: z.coerce.number().int().min(1).max(730).default(120),

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
  AFRICASTALKING_BASE_URL: optionalUrl(),

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
  NEXTSMS_BASE_URL: optionalUrl(),

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

  /**
   * Vodacom M-Pesa, used for the fee a school pays to register for the
   * application itself (not for a family paying a student's fees, which is
   * still recorded by hand).
   *
   * Tanzania runs on the M-Pesa *OpenAPI* rather than Safaricom's Daraja, so
   * the credentials are an API key and the market's published RSA public key:
   * the key is encrypted with it to fetch a session, and the session id is
   * encrypted with it again as the bearer for everything after that.
   *
   * `sandbox` is the default so a misconfigured deployment cannot take real
   * money from a real phone.
   */
  MPESA_ENV: z.enum(['sandbox', 'production']).default('sandbox'),
  /** The market path segment. Tanzania is `vodacomTZN`. */
  MPESA_MARKET: z.string().default('vodacomTZN'),
  MPESA_API_KEY: z.string().optional(),
  /** Base64 DER, exactly as the OpenAPI portal shows it, with or without the PEM armour. */
  MPESA_PUBLIC_KEY: z.string().optional(),
  /** The till the money lands in — the portal calls it the service provider code. */
  MPESA_SERVICE_PROVIDER_CODE: z.string().optional(),
  /** Overrides the endpoint derived from MPESA_ENV — for an outbound proxy, or a stub in testing. */
  MPESA_BASE_URL: optionalUrl(),
  /**
   * Shared secret the gateway callback must present. The callback arrives
   * unauthenticated by nature, so without this it is refused outright.
   */
  MPESA_CALLBACK_SECRET: z.string().optional(),
  /**
   * How long to wait on the payment push before answering the sign-up request.
   *
   * The customer has to read a prompt and type a PIN, which takes longer than
   * anyone will hold a browser request open for. The push is left to finish in
   * the background and the result is reconciled on the next status poll.
   */
  MPESA_PUSH_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(8000),

  /**
   * How long the gateway may hold the payment push open.
   *
   * This is not the same thing as the wait above. The push is the only call
   * that blocks on a human being: the gateway answers it when the customer
   * types their PIN or gives up. Cutting it off at the sign-up request's
   * timeout throws that answer away, and the status query is then the only way
   * left to find out what happened — which a portal application that has not
   * enabled it, or will not answer it, makes a dead end. So the request is left
   * open long enough for somebody to find their phone and read a prompt.
   */
  MPESA_PUSH_WAIT_MS: z.coerce.number().int().min(1000).max(300_000).default(110_000),

  /**
   * How long an unpaid registration is kept before it is given up on.
   *
   * A sign-up holds its school code against everyone else, so one abandoned
   * attempt must not cost a school the name it wanted for good. Long enough
   * that somebody can top up their M-Pesa account and come back to it.
   */
  REGISTRATION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(7),

  /**
   * What registering costs, in whole shillings, per plan.
   *
   * Priced here rather than in the request body: the amount a school is
   * charged can never come from the browser. A trial costs nothing and so
   * passes the gate without a payment at all.
   */
  /**
   * Airtel Money Tanzania, the second network a school may pay the
   * registration fee from.
   *
   * Airtel Africa's Open API is nothing like M-Pesa's: the credentials are an
   * OAuth2 client id and secret rather than a key pair, the collection push is
   * answered at once rather than when the customer types their PIN, and the
   * money's fate is read from a transaction status (`TS`/`TF`/`TIP`/`TA`)
   * rather than a response code. Only the shape registration sees is shared.
   *
   * `sandbox` is the default for the same reason as M-Pesa's: a
   * half-configured deployment must not be able to take real money.
   */
  AIRTEL_ENV: z.enum(['sandbox', 'production']).default('sandbox'),
  /** Portal -> your app -> Client ID. */
  AIRTEL_CLIENT_ID: z.string().optional(),
  AIRTEL_CLIENT_SECRET: z.string().optional(),
  /** The market the collection is made in. Tanzania is `TZ`/`TZS`. */
  AIRTEL_COUNTRY: z.string().default('TZ'),
  AIRTEL_CURRENCY: z.string().default('TZS'),
  /** Overrides the endpoint derived from AIRTEL_ENV — a proxy, or a stub in testing. */
  AIRTEL_BASE_URL: optionalUrl(),
  /**
   * Shared secret the Airtel callback must present, for the same reason
   * MPESA_CALLBACK_SECRET exists: the callback arrives unauthenticated.
   */
  AIRTEL_CALLBACK_SECRET: z.string().optional(),
  /**
   * How long any one Airtel call may take.
   *
   * There is no equivalent of MPESA_PUSH_WAIT_MS here, and that is the whole
   * difference between the two gateways: Airtel answers the push as soon as it
   * has queued the prompt, so nothing is gained by holding the request open
   * while the customer finds their phone. The status poll from the sign-up
   * page is what settles the payment.
   */
  AIRTEL_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(15_000),

  MPESA_REGISTRATION_FEE_BASIC: z.coerce.number().int().min(0).default(150_000),
  MPESA_REGISTRATION_FEE_STANDARD: z.coerce.number().int().min(0).default(450_000),
  MPESA_REGISTRATION_FEE_PREMIUM: z.coerce.number().int().min(0).default(950_000),

  /**
   * Where uploaded binaries live.
   *
   * - `local` — the filesystem under STORAGE_LOCAL_PATH. Fine for development
   *             and for a single-server installation with a real disk behind
   *             it; useless the moment a second instance starts, because each
   *             one would only see its own files.
   * - `r2`    — Cloudflare R2, addressed through its S3-compatible API. The
   *             default for a deployment: no egress charge, which matters when
   *             every parent opening a report card pulls a photograph.
   * - `s3`    — any other S3-compatible bucket (AWS, MinIO, Wasabi). Identical
   *             to `r2` apart from needing S3_ENDPOINT and S3_REGION spelled
   *             out, since they cannot be derived from an account id.
   *
   * `azure` was listed here before anything was implemented behind it. It is
   * gone rather than left as a value that boots and then fails on first use.
   */
  STORAGE_DRIVER: z.enum(['local', 'r2', 's3']).default('local'),
  STORAGE_LOCAL_PATH: z.string().default('./uploads'),

  /**
   * The largest single upload accepted, in megabytes.
   *
   * A phone photograph of a birth certificate is comfortably under 5MB; the
   * default leaves room for a multi-page scan without letting one upload fill
   * a school's whole quota.
   */
  STORAGE_MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(100).default(10),

  /**
   * How long a signed read URL stays valid.
   *
   * Long enough for a slow connection to finish fetching the object, short
   * enough that a URL copied out of a browser's history is useless by the time
   * anyone tries it. R2 caps this at seven days; minutes is the right order.
   */
  STORAGE_URL_TTL_SECONDS: z.coerce.number().int().min(30).max(604_800).default(300),

  /** The Cloudflare account that owns the bucket — it forms the R2 endpoint. */
  R2_ACCOUNT_ID: z.string().optional(),
  R2_BUCKET: z.string().optional(),
  /**
   * An R2 API token's Access Key ID and Secret Access Key, from
   * R2 → Manage API tokens in the Cloudflare dashboard. A token scoped to
   * *Object Read & Write* on this one bucket is all the app needs; an
   * account-wide token hands a compromised server far more than it requires.
   */
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),

  /**
   * Overrides the endpoint derived from R2_ACCOUNT_ID. Required for
   * STORAGE_DRIVER=s3, and the seam a test or a local MinIO points at.
   */
  S3_ENDPOINT: optionalUrl(),
  /** R2 ignores the region but the S3 signing algorithm requires one. */
  S3_REGION: z.string().default('auto'),
  /**
   * Addresses the bucket as a path (`endpoint/bucket/key`) rather than a
   * subdomain. R2 and AWS both accept virtual-hosted style; MinIO generally
   * does not, so it wants this on.
   */
  S3_FORCE_PATH_STYLE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
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

/**
 * The address parents reach the app on, without a trailing slash. CORS_ORIGIN
 * may list several; the first is the canonical one.
 */
export const publicWebUrl = (
  env.PUBLIC_WEB_URL ?? env.CORS_ORIGIN.split(',')[0]!.trim()
).replace(/\/+$/, '');

/**
 * Object storage needs somewhere to put things before the app offers to.
 *
 * `local` is always ready — a directory is created on demand. A bucket is not:
 * it needs an endpoint, a name and a key pair, and a half-filled set is treated
 * as unconfigured so the failure is one clear message at boot rather than a
 * signing error on the first parent to upload a birth certificate.
 */
export const storageConfigured =
  env.STORAGE_DRIVER === 'local' ||
  Boolean(
    env.R2_BUCKET &&
      env.R2_ACCESS_KEY_ID &&
      env.R2_SECRET_ACCESS_KEY &&
      (env.S3_ENDPOINT || env.R2_ACCOUNT_ID),
  );

/**
 * The S3 endpoint for the configured bucket.
 *
 * R2 derives it from the account id and ignores the region; everything else
 * has to be told. Returns null when storage is not configured as a bucket.
 */
export const s3Endpoint = (): string | null => {
  if (env.S3_ENDPOINT) return env.S3_ENDPOINT;
  if (env.STORAGE_DRIVER === 'r2' && env.R2_ACCOUNT_ID) {
    return `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  }
  return null;
};

/**
 * M-Pesa needs a key pair and a till before the app offers to take money.
 *
 * A half-filled set is treated as unconfigured, matching `smsConfigured` and
 * `storageConfigured`: sign-up then records the school as unpaid and says so,
 * rather than failing while signing a request nobody can honour.
 */
export const mpesaConfigured = Boolean(
  env.MPESA_API_KEY && env.MPESA_PUBLIC_KEY && env.MPESA_SERVICE_PROVIDER_CODE,
);

/**
 * Airtel Money needs an OAuth2 client before the app offers to take money
 * through it. Same rule as `mpesaConfigured`: a half-filled set is
 * unconfigured, and the provider is simply not offered.
 */
export const airtelConfigured = Boolean(env.AIRTEL_CLIENT_ID && env.AIRTEL_CLIENT_SECRET);

/** The Airtel Open API root for the configured environment, with a trailing slash. */
export const airtelBaseUrl = (): string => {
  const base =
    env.AIRTEL_BASE_URL ??
    (env.AIRTEL_ENV === 'production'
      ? 'https://openapi.airtel.africa'
      : 'https://openapiuat.airtel.africa');
  return base.replace(/\/+$/, '') + '/';
};

/** The gateway root for the configured market, with a trailing slash. */
export const mpesaBaseUrl = (): string => {
  const base =
    env.MPESA_BASE_URL ??
    `https://openapi.m-pesa.com/${env.MPESA_ENV}/ipg/v2/${env.MPESA_MARKET}`;
  return base.replace(/\/+$/, '') + '/';
};

/**
 * What the given plan costs to register, in whole shillings.
 *
 * TRIAL is zero: the trial is how a school looks at the app before paying for
 * it, so charging for it would leave nothing to try.
 */
export const registrationFee = (plan: 'TRIAL' | 'BASIC' | 'STANDARD' | 'PREMIUM'): number => {
  switch (plan) {
    case 'BASIC':
      return env.MPESA_REGISTRATION_FEE_BASIC;
    case 'STANDARD':
      return env.MPESA_REGISTRATION_FEE_STANDARD;
    case 'PREMIUM':
      return env.MPESA_REGISTRATION_FEE_PREMIUM;
    case 'TRIAL':
      return 0;
  }
};

/** A single school running its own installation — no plans, no platform admin. */
export const isStandalone = env.DEPLOYMENT_MODE === 'standalone';
/** One deployment serving many schools under subscription. */
export const isSaas = !isStandalone;
