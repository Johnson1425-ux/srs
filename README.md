# School Management System (SMS)

A multi-tenant, web-based school management platform for private and public schools
in Tanzania, built to the SMS Product Requirements Document v1.0.

It replaces paper registers and spreadsheets with one system covering admissions,
attendance, examinations, fees, accounting, library, inventory, transport and
parent communication — with role-scoped portals for staff, parents and students.

---

## Contents

- [Quick start](#quick-start)
- [Architecture](#architecture)
- [Roles and permissions](#roles-and-permissions)
- [API reference](#api-reference)
- [Demo data and logins](#demo-data-and-logins)
- [Testing](#testing)
- [Deployment](#deployment)
- [PRD coverage](#prd-coverage)
- [Deviations from the PRD](#deviations-from-the-prd)

---

## Quick start

### With Docker (recommended)

Docker Desktop, or Docker Engine with the Compose plugin, is all you need —
no Node.js and no PostgreSQL on the host.

```bash
cp .env.example .env
# Fill in POSTGRES_PASSWORD, JWT_ACCESS_SECRET and JWT_REFRESH_SECRET.
# Generate secrets with: openssl rand -base64 48

docker compose up --build
```

That starts PostgreSQL, Redis, the API and nginx, and applies migrations on
API start-up. The app is served at <http://localhost:8080>.

**The database starts empty, so nothing can sign in yet.** Choose one:

```bash
# A. The demonstration school — 144 students, staff, fees, results, timetable.
#    Best for evaluating the system. Prints the sign-in details when it finishes.
docker compose --profile demo run --rm seed

# B. An empty school with one administrator, for a real installation.
docker compose exec api node dist/scripts/bootstrap.js

# C. SaaS only — the first platform administrator, who onboards the schools.
docker compose exec api node dist/scripts/bootstrap-platform.js
```

Option A runs from the image's build stage, because the seed is TypeScript and
the production image deliberately drops the tooling that runs it. Re-running it
resets the demo school and leaves any other school alone.

Option B prompts for the school name, code and administrator, or takes them as
`SCHOOL_NAME`, `SCHOOL_CODE`, `ADMIN_EMAIL` and the rest for an unattended
install. It generates a password if you do not supply one.

Option C is for a SaaS deployment and is needed **once**. A platform
administrator belongs to no school, so nothing inside a school can create one
and platform administration is itself closed to anyone who is not already a
super admin — which would leave a new installation with no way in. Afterwards,
further administrators are added under Schools → Administrators, where the
action is recorded against whoever took it. The script refuses to run a second
time for that reason.

Useful while testing:

```bash
docker compose logs -f api        # follow the API log
docker compose ps                 # what is running, and whether it is healthy
docker compose down               # stop, keeping the database
docker compose down -v            # stop and delete the database as well
```

The API is not published to the host — only nginx is, on 8080, and it proxies
`/api` through. To call the API directly, add `ports: ['4000:4000']` to the
`api` service.

#### If the first start says the database is unhealthy

```
dependency failed to start: container sms-db-1 is unhealthy
```

Check the `db` logs. If they end with `database system is ready to accept
connections`, Postgres is fine — the health check simply ran out of retries
while the cluster was still being created, which on a slow disk takes longer
than it looks (a single checkpoint sync can run for fifteen seconds).

Just start it again:

```bash
docker compose up
```

The volume now exists, so this start skips initialisation and comes up in
seconds. Do **not** use `down -v` here — that deletes the cluster and puts you
back on the slow path. The health check allows a two-minute start-up window,
so this should not recur.

#### If the API cannot reach the database

```
FATAL: password authentication failed for user "sms"
Error: P1000: Authentication failed against database server at `db`
```

`POSTGRES_PASSWORD` is read **only when the database volume is first created**.
If a volume already exists from an earlier run, Postgres keeps whatever
password it was built with and ignores the new one, so the API's URL no longer
matches. Delete the volume and start again:

```bash
docker compose down -v      # -v deletes the database as well
docker compose up --build
```

If it persists, check the password itself. It is interpolated straight into a
connection URL, so a `/` makes that URL invalid, and `@` or `#` will be read as
the start of the host or a comment. Letters, digits, hyphens and underscores
are always safe — `openssl rand -hex 32` produces one.

### Local development

Requires Node.js 20+ and a PostgreSQL 14+ server.

```bash
npm install

# API
cd server
cp .env.example .env          # point DATABASE_URL at your PostgreSQL instance
npm run db:migrate            # create the schema
npm run db:seed               # load the demo school
npm run dev                   # http://localhost:4000

# Frontend (in a second terminal)
cd web
npm run dev                   # http://localhost:5173
```

The Vite dev server proxies `/api` to `localhost:4000`, so the browser stays on
one origin and no CORS configuration is needed in development.

---

## Architecture

```
srs/
├── server/                  Express + TypeScript REST API
│   ├── prisma/
│   │   ├── schema.prisma    45+ models covering every PRD module
│   │   ├── migrations/      Versioned SQL migrations
│   │   └── seed.ts          Demo school with realistic Tanzanian data
│   └── src/
│       ├── config/          Environment parsing, validated at boot
│       ├── lib/             Tokens, permissions, money, CSV, audit, sequences
│       ├── middleware/      Authentication, RBAC, tenancy, error handling
│       ├── modules/         One folder per domain (routes + service + tests)
│       └── tests/           Integration tests against a real PostgreSQL database
├── web/                     React 18 + TypeScript + Vite SPA
│   └── src/
│       ├── components/      Layout and the shared UI kit
│       ├── lib/             API client, auth context, formatters, types
│       └── pages/           One screen per module, plus the family portal
├── nginx/                   Reverse proxy and SPA hosting config
└── docker-compose.yml       Postgres + Redis + API + web
```

### Stack

| Layer     | Choice                                                   |
| --------- | -------------------------------------------------------- |
| Frontend  | React 18, TypeScript, Tailwind CSS, TanStack Query, React Hook Form, React Router |
| Backend   | Node.js 22, Express, TypeScript, Zod                     |
| ORM       | Prisma                                                    |
| Database  | PostgreSQL 16                                             |
| Auth      | JWT access tokens + rotating refresh tokens, Argon2id hashing |
| Cache     | Redis (provisioned in compose, ready for session/report caching) |
| Deploy    | Docker, nginx, Ubuntu                                     |

### Design decisions worth knowing

**Multi-tenancy.** Every operational table carries `schoolId`, and each request
resolves its tenant in `schoolIdOf(req)`. A user is pinned to their own school;
only `SUPER_ADMIN` may target another via the `X-School-Id` header. Cross-tenant
reads return `404`, not `403`, so one school cannot probe another's record IDs.

**Money.** All amounts use PostgreSQL `DECIMAL(14,2)` and Prisma's `Decimal`
type end to end — never floats. Invoice totals are *derived*: `recalculateInvoice`
recomputes subtotal, discounts, paid and balance from the underlying items,
adjustments and payment allocations, so those columns cannot drift.

**Payments.** A payment settles the oldest invoices first unless the cashier
allocates it explicitly. Overpayment is recorded as unallocated credit rather
than a negative balance. Reversals never delete history: allocations are removed,
the receipt is marked `REVERSED`, and a contra entry keeps the ledger balanced.

**Grading.** Grades and GPA points are always derived server-side from the
school's grading scale, so a teacher cannot enter an inconsistent grade by hand.
Scores are normalised to a percentage first, so a paper marked out of 40 grades
the same as one out of 100. Absent papers are excluded from the average rather
than counted as zero — a missed exam is not a failed one.

**Portals.** Parents and students hold no school-wide permissions at all. Their
routes live under `/portal/*` and resolve access from the caller's own guardian
or student record, so a parent can only ever reach their own children.

---

## Roles and permissions

Permissions are `resource:action` strings; roles map to sets of them in
`server/src/lib/permissions.ts`. `SUPER_ADMIN` implicitly holds everything.

| Role              | Scope                                                              |
| ----------------- | ------------------------------------------------------------------ |
| Super Admin       | Full platform access across all schools                            |
| School Owner      | Read-only across the whole school (all `*:read` permissions)        |
| Administrator     | Full school management                                              |
| Accountant        | Fees, payments, accounting, payroll; reads students and academics   |
| Teacher           | Attendance, marks entry, assignments; reads students and academics  |
| Receptionist      | Admissions, guardian records, documents                             |
| Librarian         | Library catalogue and lending                                       |
| Transport Officer | Vehicles, routes, student allocation                                |
| Driver            | Read-only transport                                                 |
| Parent            | Own children only, via `/portal/*`                                  |
| Student           | Own records only, via `/portal/*`                                   |

The frontend hides what a role cannot use, but every route is enforced
server-side — the UI is a convenience, not the control.

---

## API reference

REST, JSON, versioned under `/api/v1`, grouped by resource per PRD section 9.

| Group | Endpoints |
| ----- | --------- |
| `/auth` | `login`, `logout`, `refresh`, `me`, `sessions`, `forgot-password`, `reset-password`, `change-password` |
| `/students` | list/search, admit, update, `:id/status`, `promote`, `:id/guardians` |
| `/parents` | list, create, update, `:id/fee-statement` |
| `/staff` | list, create, update, `attendance`, `attendance/register`, `leave/requests` |
| `/academics` | `years`, `terms`, `classes`, `streams`, `subjects`, `departments`, `grade-scales`, `timetable`, `assignments` |
| `/attendance` | `register`, record, `student/:id`, `exceptions`, `summary` |
| `/exams` | list, create, `subjects/:id/marks`, `publish`, `unpublish`, `notify-preview` |
| `/results` | `exam/:id`, `exam/:id/report-card/:studentId`, `transcript/:studentId` |
| `/fees` | `structures`, `generate-invoices`, `adjustments`, `outstanding`, `students/:id/balance` |
| `/invoices` | list, get, `cancel` |
| `/payments` | list, record, `:id/receipt`, `:id/reverse` |
| `/accounting` | `ledger`, `profit-loss`, `cash-flow`, `payroll` |
| `/library` | `books`, `loans`, `loans/:id/return`, `overdue` |
| `/inventory` | `items`, `movements`, `suppliers`, `purchase-orders` |
| `/transport` | `vehicles`, `routes`, `allocations`, `manifest`, `fuel`, `maintenance` |
| `/hostel` | hostels, `rooms`, `allocate`, `release` |
| `/notifications` | `announcements`, `templates`, `messages/bulk`, `inbox` |
| `/documents` | list, register, delete, `usage` |
| `/reports` | students, admissions, attendance, fee collection, outstanding, academic and teacher performance, library, inventory, payroll |
| `/dashboard` | widgets, `enrollment-by-class`, `collection-trend` |
| `/portal` | `children`, and per-student overview, attendance, results, fees, homework, timetable |
| `/platform` | schools, subscriptions, usage, support tickets (super admin) |
| `/settings` | `school`, `audit-logs` |

Errors are uniform:

```json
{ "error": { "code": "BAD_REQUEST", "message": "Validation failed", "details": [] } }
```

Every list endpoint accepts `page` and `pageSize` and returns
`{ data, meta: { page, pageSize, total, totalPages } }`. Report endpoints accept
`?format=csv` for an Excel-compatible download.

---

## Demo data and logins

`npm run db:seed` creates **Mlimani Secondary School** (code `MLM`) in
Dar es Salaam with 144 students across Forms 1–4, 13 staff, a full timetable,
2,880 attendance records, published Term 1 results, Term 2 invoicing with
realistic partial payments, library loans, inventory, a bus route and hostels.

All demo accounts use the password **`Passw0rd!`**

| Role          | Email |
| ------------- | ----- |
| Super Admin   | `superadmin@sms.co.tz` |
| School Owner  | `owner@mlimani.ac.tz` |
| Administrator | `daniel.mwakalinga@mlimani.ac.tz` |
| Accountant    | `regina.kessy@mlimani.ac.tz` |
| Teacher       | `anna.shirima@mlimani.ac.tz` |
| Librarian     | `yusuf.ally@mlimani.ac.tz` |
| Parent        | `parent.1a@mlimani.ac.tz` |
| Student       | `student.1a@mlimani.ac.tz` |

Seeding is idempotent: it resets the demo school and rebuilds it, leaving any
other tenant untouched.

**Signing in as the super admin** lands you on platform administration rather
than a school dashboard, because platform staff belong to no school. Use the
**Working in** switcher in the sidebar to open a tenant's records — that sends
`X-School-Id` on every request, which the API honours only for `SUPER_ADMIN`.
Clearing the selection returns you to the platform view.

---

## Testing

```bash
cd server
npm test
```

73 tests run against a real PostgreSQL database (`TEST_DATABASE_URL`), covering:

- **Authentication** — login, token rotation and refresh-token replay, logout,
  password reset single-use tokens, account-enumeration resistance
- **Authorisation** — each role's reach and, importantly, its limits
- **Tenant isolation** — cross-school reads, writes and foreign-key smuggling
- **Fees** — invoice generation and double-billing, partial payment, overpayment
  credit, discounts, reversal restoring balance, receipt formatting, ledger posting
- **Examinations** — grade derivation, score bounds, absent handling, ranking with
  ties, publish locking, transcripts
- **Attendance** — register upsert, correction without duplication, rate calculation
- **Student lifecycle** — admission with guardians, guardian de-duplication,
  status transitions, class promotion
- **Portals** — a parent reaching another family's child, unpublished results

---

## Deployment modes

The same codebase is sold two ways, switched by one environment variable:

```
DEPLOYMENT_MODE=saas        # default
DEPLOYMENT_MODE=standalone
```

| | `saas` | `standalone` |
| --- | --- | --- |
| Schools per deployment | many | one |
| Platform administration (`/platform`) | mounted | **not mounted** — the routes do not exist |
| Subscription plans and student caps | enforced | not applied |
| Subscription card in Settings | shown | hidden |
| First school created by | `POST /platform/schools` | `npm run bootstrap` |

The data model is identical either way — a standalone install is simply a
tenant of one, so a school can be migrated between the two without a schema
change. Only the behaviours above differ, which is why this is a flag rather
than a fork.

### Setting up a standalone installation

```bash
DEPLOYMENT_MODE=standalone npm run bootstrap --workspace=server
```

Prompts for the school name, code and first administrator, then creates the
school, an `ADMIN` account with a one-time password, and a default grading
scale. Values can be supplied as environment variables
(`SCHOOL_NAME`, `SCHOOL_CODE`, `ADMIN_EMAIL`, `ADMIN_FIRST_NAME`,
`ADMIN_LAST_NAME`, `ADMIN_PASSWORD`) for unattended installs. It refuses to run
twice unless passed `--force`, since a standalone install should hold exactly
one school.

Standalone deployments should not have a `SUPER_ADMIN` account at all — the
school's own administrator is the highest role.

## Deployment

`docker compose up --build` brings up PostgreSQL, Redis, the API and an nginx
container serving the built SPA and proxying `/api`.

### Vercel (frontend) + Render (backend)

`web/vercel.json` is committed and covers the SPA fallback, security headers and
asset caching — the jobs nginx does in the self-hosted setup.

**Vercel** — Root Directory `web`, environment variable
`VITE_API_URL=https://your-api.onrender.com`.

**Render** — create the service by hand: **New → Web Service**, connect this
repository, and choose the **Node** runtime. Prefer it over the Dockerfile; both
work, but the native runtime needs no container build.

Leave **Root Directory blank**. Render `cd`s into it and runs npm there, and
`npm ci` fails inside `server/` because npm workspaces keep a single lockfile at
the repository root. Address the workspace by flag instead:

| Field | Value |
| --- | --- |
| Root Directory | *(blank)* |
| Runtime | `Node` |
| Build Command | `npm ci --workspace=server --include-workspace-root --include=dev && npm run build --workspace=server && npm run db:deploy --workspace=server` |
| Start Command | `node server/dist/index.js` |
| Health Check Path | `/health` |

Then add the environment variables:

| Variable | Value |
| --- | --- |
| `NODE_VERSION` | `22` |
| `NODE_ENV` | `production` |
| `DATABASE_URL` | pooled connection — see below |
| `DIRECT_URL` | direct connection — see below |
| `CORS_ORIGIN` | `https://your-app.vercel.app`, comma-separated for more than one |
| `JWT_ACCESS_SECRET` | `openssl rand -base64 48` |
| `JWT_REFRESH_SECRET` | a *different* `openssl rand -base64 48` |
| `DEPLOYMENT_MODE` | `saas` or `standalone` |

Leave `PORT` alone — Render injects it and the app reads it. Everything else has
a working default: SMS and email stay in the outbox until configured, so the
list above is the whole of what a first deploy needs.

**Why `--include=dev`.** npm omits `devDependencies` whenever `NODE_ENV` is
`production`, and the build genuinely needs them — `typescript` and
`@types/node` are both dev dependencies, so without the flag `tsc` stops at

```
error TS2688: Cannot find type definition file for 'node'.
```

The flag is explicit rather than relying on `NODE_ENV`, because Render applies
the same environment to the build and to the running service. The compiled
output in `server/dist` does not use any of it.

**Where migrations run.** `prisma migrate deploy` is the last step of the build
command rather than a Pre-Deploy Command, because Pre-Deploy is a paid feature —
on a free instance the field is not there to fill in, and the API would boot
against an unmigrated database. The build environment already has the database
variables, so it works there. Migrations therefore apply once per *build*. On a
paid plan — and certainly before running more than one instance — move that last
step into the Pre-Deploy Command, where it runs once per deploy with no chance
of two builds racing:

```
npm run db:deploy --workspace=server
```

Putting it last means a compile error stops the deploy before it touches the
database.

**Free instances sleep.** A free web service spins down after 15 minutes idle and
takes a few seconds to answer the request that wakes it; a free Neon database
autosuspends much the same way. The first login after a quiet spell is slow, and
that is the plan working as sold, not a bug.

#### Connecting to a pooled database

`DIRECT_URL` exists because migrations issue statements a transaction-mode
pooler cannot carry. With no pooler, set it to the same value as
`DATABASE_URL`. Behind one:

| Provider | `DATABASE_URL` | `DIRECT_URL` |
| --- | --- | --- |
| **Neon** | `-pooler` host, `?sslmode=require&pgbouncer=true` | same host **without** `-pooler`, `?sslmode=require` |
| **Supabase** | port `6543`, `?pgbouncer=true` | port `5432` |
| **Render / plain Postgres** | Internal URL | the same URL |

Do not include `channel_binding=require` in a Neon connection string — Prisma's
connector does not support SCRAM channel binding and the connection will drop
with `Error { kind: Closed }`. Neon's dashboard includes it by default, so the
string you copy needs editing before it is pasted into Render. In full, a Neon
pair looks like this — the two differ only in the host and the query string:

```
DATABASE_URL=postgresql://user:pass@ep-xxx-pooler.eu-central-1.aws.neon.tech/sms?sslmode=require&pgbouncer=true
DIRECT_URL=postgresql://user:pass@ep-xxx.eu-central-1.aws.neon.tech/sms?sslmode=require
```

Both are validated at boot, so a forgotten `DIRECT_URL` is reported by name in
the Render logs rather than surfacing later as a migration failure.

Note that the API calls `prisma.$connect()` before it listens, so an
unreachable database means the process exits rather than serving errors. If the
frontend reports a network failure and the logs never print
`SMS API listening`, the connection string is the place to look.

#### Creating the first account

Migrations leave an empty database, and nobody can sign in to a deployment with
no users. `npm run bootstrap` creates the first school and its administrator.

Render's Shell is a paid feature, so on a free instance there is no terminal on
the server to run it in — but there does not need to be. A hosted database
(Neon, Supabase) is reachable from anywhere, so run the script from your own
machine, pointed at production:

```bash
npm ci --workspace=server --include-workspace-root --include=dev
npm run db:generate --workspace=server        # bootstrap needs the Prisma client

export DATABASE_URL="postgresql://…-pooler…/sms?sslmode=require&pgbouncer=true"
export DIRECT_URL="postgresql://…/sms?sslmode=require"
npm run bootstrap --workspace=server
```

It prompts for the school name, a short code, and the administrator's name and
email, then prints the generated password. The account is flagged
`mustChangePassword`, so the first sign-in forces a new one. Nothing about the
Render service changes, and the script is not part of any deploy.

Only reach for the build command if the database is *not* reachable from your
machine — Render Postgres over its Internal URL, or a private network. In that
case set `SCHOOL_NAME`, `SCHOOL_CODE`, `ADMIN_FIRST_NAME`, `ADMIN_LAST_NAME` and
`ADMIN_EMAIL` on the service, append `&& npm run bootstrap --workspace=server`
to the Build Command, deploy once, and read the password from the build log.
The script takes those variables instead of prompting when no terminal is
attached. **Then remove the appended command**, or the next deploy fails with
`School code … is already in use`.

Do **not** use `npm run db:seed` for this. It builds the demo school with
hundreds of fictional students and well-known passwords (`Passw0rd!`), which is
a fine sandbox and a bad production database.

#### Optional: proxy `/api` through Vercel

Two annoyances come with the split-origin setup above: preview deployments get
unique URLs that a fixed `CORS_ORIGIN` will reject, and `VITE_API_URL` is
inlined at build time so changing it means rebuilding the frontend.

Both disappear if Vercel proxies the API instead. Add this **above** the
existing catch-all in `web/vercel.json` — order matters, or the catch-all
swallows it — and replace the host with your own:

```json
{ "source": "/api/:path*", "destination": "https://your-api.onrender.com/api/:path*" }
```

Then **leave `VITE_API_URL` unset**. The client falls back to same-origin
`/api/v1`, so there is no CORS at all and nothing is baked into the bundle.
This is not the default only because a placeholder URL committed to the repo
would break every deployment that forgot to edit it.

### Production notes

1. Terminate TLS at a load balancer or with certbot in front of nginx; the app
   assumes HTTPS everywhere (PRD section 6). Vercel and Render do this for you.
2. Set strong `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` values. Rotating them
   invalidates all sessions.
3. Configure SMS and email (both below). Left at their `none` defaults, messages
   are recorded with status `QUEUED` and nothing is dispatched.
4. Schedule `pg_dump` for the daily backups the PRD requires.
5. The API is stateless, so it scales horizontally behind the proxy.

### SMS

Two gateways are supported. Pick one with `SMS_PROVIDER`; the rest of the system
does not care which is in use.

| | Africa's Talking | NextSMS |
| --- | --- | --- |
| Credentials | username + API key | dashboard authorization token, or the username + password it encodes |
| Reach | pan-African | Tanzania |
| Dry run | `AFRICASTALKING_SANDBOX=true` (separate account) | `NEXTSMS_TEST_MODE=true` (same account) |
| Personalised batch | one request per recipient | one request for the whole batch |

That last row matters when results are published: NextSMS's `text/multi`
endpoint carries a different body per parent in a single call, so notifying four
hundred families is one HTTP request rather than four hundred.

#### Africa's Talking

```
SMS_PROVIDER=africastalking
AFRICASTALKING_USERNAME=your-username     # "sandbox" against the sandbox
AFRICASTALKING_API_KEY=your-api-key
AFRICASTALKING_SANDBOX=false
SMS_SENDER_ID=SCHOOL                      # deployment default
SMS_MAX_ATTEMPTS=3
```

`SMS_PROVIDER=none` is the default, so a development machine records messages
without spending credit or texting a real parent. Both a username and an API key
must be present or the provider counts as unconfigured — half-configured is
treated as off rather than failing at the first send.

**Sender ID.** Each school can set its own under Settings, which overrides
`SMS_SENDER_ID`. A live alphanumeric sender ID has to be registered with Africa's
Talking first; leave it blank to fall back to the account default.

`AFRICASTALKING_BASE_URL` overrides the endpoint, for an outbound proxy or a
stub during testing.

> **The sandbox rejects sender IDs entirely.** With `AFRICASTALKING_SANDBOX=true`,
> set `SMS_SENDER_ID=` and clear the school's own sender ID under Settings, or
> every send fails with `InvalidSenderId`. The Message log warns about this
> before you send.

#### NextSMS

```
SMS_PROVIDER=nextsms
NEXTSMS_AUTH_TOKEN=your-authorization-token
NEXTSMS_TEST_MODE=false                   # true validates without sending
SMS_SENDER_ID=SCHOOL                      # must be registered with NextSMS
SMS_MAX_ATTEMPTS=3
```

**Authentication.** NextSMS's dashboard shows a ready-made authorization token;
paste it into `NEXTSMS_AUTH_TOKEN` exactly as shown, with or without its
`Basic ` prefix — a bare token is assumed to be `Basic`, which is what it
encodes.

That token is base64 of `username:password`, so the same credentials unencoded
work just as well if that is what you have:

```
NEXTSMS_USERNAME=your-dashboard-username
NEXTSMS_PASSWORD=your-dashboard-password
```

Set one form or the other. If both are present the token wins, on the grounds
that it is the credential someone deliberately copied. With neither, the
provider counts as unconfigured and nothing is dispatched.

Numbers are converted to the bare digits the gateway expects
(`255754123456`), so schools can keep storing them however they like.

**Test mode** points every request at NextSMS's `/test` path, which checks the
credentials, sender ID and numbers and replies exactly as a real send would —
without delivering anything or spending credit. Unlike Africa's Talking's sandbox
it uses your live account, so a dry run tells you whether your real sender ID
works. Turn it off before going live or nothing reaches a parent.

`NEXTSMS_BASE_URL` overrides the endpoint, for an outbound proxy or a stub.

#### When a send is rejected

A gateway that answers `Invalid Request` says nothing about which part it
objected to, and the outbox only ever shows you the reply. The probe prints both
halves of the exchange:

```
npm run sms:probe --workspace server -- 0754123456       # from a checkout
docker compose exec api node dist/scripts/sms-probe.js 0754123456   # under Docker
```

Run it wherever the API itself runs, so it reads the same credentials the real
sends use — inside the container under Docker, not on the host.

```
Mode:       test — validated, not delivered, not billed
URL:        POST https://messaging-service.co.tz/api/sms/v1/test/text/single
Auth:       Basic bWxp...M= (24 chars)
Sender ID:  MLIMANI
Recipient:  0754123456 normalised to 255754123456
Body sent:  {"from":"MLIMANI","to":"255754123456","text":"Test message ..."}

Status:     500 Internal Server Error
Reply:      {"message":"Invalid Request"}
```

It builds the request exactly as the provider does, so it cannot pass while real
sends fail. **Nothing is delivered and no credit is spent** unless you add
`--live`, so it is safe to run against a production account. The authorization
header is abbreviated, so the output can be pasted into a support ticket as it
stands.

The first line says which `.env` was read. If that is not the file your server
uses, the probe is testing the wrong settings — run it from the same place the
server runs.

#### Both gateways

**How sending works.** Queueing a message nudges a dispatcher that runs outside
the request, so a bulk send to several hundred parents does not hold the HTTP
response open. A worker also sweeps every 60 seconds to pick up retries. Messages
are claimed before the request goes out, so overlapping sweeps cannot send the
same message twice — a crash mid-flight leaves a message `FAILED` rather than
silently re-sent, which is the safer way round for something that costs money and
reaches a parent's phone.

**Retries.** Failures are separated by whether repeating the request could ever
help. An invalid number or unregistered sender ID fails immediately; a timeout,
routing error or empty balance is requeued until `SMS_MAX_ATTEMPTS` is reached.
After fixing whatever caused a batch to fail, **Retry failed** on the Message log
puts them back in the queue.

**Batching.** Recipients sharing an identical body are always sent in one
request, so a school-wide announcement is a single call on either gateway. Where
every body differs — a result notice naming each child — Africa's Talking needs
one request per parent, while NextSMS carries the whole batch in one. Delivery
status, the gateway's message id and its reported cost are stored per message.

**Cost.** SMS is billed per 160-character segment, but a single character outside
the GSM 03.38 alphabet forces the whole message into UCS-2, where a segment holds
only 70 — so one em dash or curly quote can double the bill. Outbound SMS bodies
are folded to the plain equivalents (`—` to `-`, `"` to `"`, `…` to `...`) before
they are stored and sent. What a send will actually be billed as is shown before
you confirm it.

### Email over SMTP

```
EMAIL_PROVIDER=smtp
SMTP_HOST=smtp.your-provider.com
SMTP_PORT=587                              # 465 needs SMTP_SECURE=true
SMTP_SECURE=false
SMTP_USER=                                 # optional on an internal relay
SMTP_PASSWORD=
SMTP_FROM="School System <no-reply@yourdomain.ac.tz>"
EMAIL_MAX_ATTEMPTS=3
```

`EMAIL_PROVIDER=none` is the default. A host without a `SMTP_FROM` counts as
unconfigured, because most receiving servers reject a message with no From.

**Whose address it sends from.** Every school sends from the one configured
`SMTP_FROM` address, because that is what the relay is authorised to use and
what SPF and DKIM are aligned to — putting each school's own address there
would get the mail rejected or filed as spam. What *is* per school is the
display name and the reply address:

```
From:     "Mlimani Secondary School" <no-reply@yourdomain.ac.tz>
Reply-To: info@mlimani.ac.tz          # the school's address, from Settings
```

A parent replying reaches the school, not the platform. A school with no email
address set gets no `Reply-To`, and the Message log says so.

**Sending and retries** work exactly as they do for SMS: queueing nudges a
dispatcher outside the request, a worker sweeps every 60 seconds, and messages
are claimed before they go out so overlapping sweeps cannot send twice. A
mail server's reply code decides whether a failure is worth repeating — 5xx
("no such mailbox") fails immediately, 4xx ("try later") and dropped
connections are requeued until `EMAIL_MAX_ATTEMPTS`. Bad credentials (`EAUTH`)
count as permanent, since retrying cannot fix them.

Connections are pooled, so a bulk send opens a handful rather than one per
parent. Messages go out one at a time: mail servers rate-limit a burst from a
single client more readily than a steady stream.

### Texting results to parents

Publishing an exam can text every family their own child's summary, which is
what most parents will actually read — expecting them to find the portal, recover
a password and navigate to a report card is expecting too much of a channel that
competes with a message arriving on the phone by itself.

```
Mlimani Secondary School: Amina Mushi - Term 1 Exam results.
Average 57.9%, position 22 of 36. Full report: https://your-school.ac.tz/r/9CgCQHWi84i
```

**The link needs no password.** It opens one page: that child's marks, grades,
average and position, on a phone. A parent who has to find the portal, recover a
password and navigate to a report card mostly will not, and results nobody reads
may as well not have been published.

The address itself is the credential, so it is treated as one. The token is 11
random characters — about 64 bits, in an alphabet with no `O`/`0` or `I`/`l`/`1`
so it survives being read down a telephone. Lookups are rate limited to 20 a
minute per address, which makes working through the space hopeless. Links expire
after `RESULT_LINK_TTL_DAYS` (120 by default) and stop working the moment an exam
is unpublished, so withdrawing results withdraws the links with them. Republishing
reuses the same address rather than stranding the one already in a parent's
message thread. The page carries no admission number and nothing else that
identifies the child elsewhere in the system, and it is served `noindex` and
`no-store`.

What it cannot do is tell one holder of the phone from another. Anyone with the
message can read that child's results — which is the trade being made, and the
publish dialog says so before anything is sent. Views are counted per link, so a
school can see when one has been passed around.

`PUBLIC_WEB_URL` sets the address the links are built on; it defaults to the
first `CORS_ORIGIN`, which is already where parents reach the app.

**One parent per child, not all of them.** Guardians are ranked fee payer >
primary contact > anyone with a phone number, and only the first is texted.
Texting three guardians for one child triples the bill for the same information.
Siblings still get one message each, because each names a different child.

**Nothing is sent without confirmation.** `POST /exams/:id/publish` only notifies
when passed `{ "notifyGuardians": true }`, and the Examinations page asks first,
showing:

- how many parents would be texted,
- **how many segments that is billed as** — not the same number, since a long
  school name or exam title pushes a message past 160 characters into two,
- the exact message a parent will receive,
- which students have no reachable guardian, so the office can chase the numbers,
- a warning if no gateway is configured, in which case the messages sit in the
  outbox as `QUEUED` and nothing is sent.

`GET /exams/:id/notify-preview` returns the same figures without publishing.

Results are still published to the portal either way; the texts are additional.

**What it costs.** Measured against the demonstration school — 36 parents, one
Form 1 exam:

| | Segments billed |
| --- | --- |
| Exam named "Term 1 Terminal Examination — Form 1" (36 chars) | 72 |
| The same, renamed "Term 1 Exam" | 37 |

The link adds roughly 40 characters to every message, which is what pushes the
first row over 160 and into two segments each. But the names cost more than the
link does: the exam name and the school name appear in every message, and
shortening the exam name alone halves the bill. The publish dialog shows the
segment count before anything is sent, so the effect of a rename can be seen
before it is paid for.

---

## PRD coverage

| # | Module | Status |
| - | ------ | ------ |
| 1 | Authentication | Login, logout, forgot/reset password, RBAC, session management, account lockout. 2FA fields are modelled but the TOTP flow is not implemented. |
| 2 | Dashboard | All widgets: students, teachers, staff, fee collection, outstanding fees, today's attendance, upcoming exams, announcements, enrolment and collection charts |
| 3 | School Setup | Profile, academic years, terms, classes, streams, subjects, departments, grading scales |
| 4 | Student Management | Admission with all PRD fields, search, edit, promote, suspend, graduate, archive |
| 5 | Parent Management | Portal, multiple children, contacts, fee statements, notifications |
| 6 | Staff Management | Teaching and non-teaching, departments, employment records, attendance, leave, salary |
| 7 | Academic Management | Classes, subjects, timetable with clash detection, assignments, homework, promotion |
| 8 | Attendance | Daily student, staff, reports, late arrivals, absentees, guardian SMS |
| 9 | Examinations | All five exam types, marks entry, grading, GPA, configurable ranking, report cards, transcripts, results texted to guardians on publication |
| 10 | Fee Management | All nine categories, structures, invoices, receipts, discounts, scholarships, waivers, history, balances, reversals; all five payment methods incl. the four mobile-money providers |
| 11 | Accounting | Income, expenses, payroll with PAYE/NSSF, general ledger, P&L, cash flow |
| 12 | Library | Books, categories, borrowing, returns, late fees, barcode field, inventory |
| 13 | Inventory | Assets, stationery, lab equipment, furniture, stock movements, suppliers, purchase orders |
| 14 | Transport | Buses, routes, drivers, fuel logs, maintenance, student allocation, manifests |
| 15 | Hostel | Rooms, beds, occupancy, boarders, allocation with gender and capacity rules |
| 16 | Communication | Email/SMS/in-app channels via Africa's Talking, NextSMS or SMTP; announcements, templates with placeholders, bulk messaging by audience, retries and per-message delivery status |
| 17 | Reports | All listed reports with CSV/Excel export; PDF via the print-optimised receipt and report-card views |
| 18 | Document Management | Metadata registry for all listed document types, plus storage-quota tracking |
| 19 | Parent Portal | Attendance, results, homework, timetable, fees, announcements |
| 20 | Student Portal | Assignments with submission, attendance, results, timetable, announcements |
| 21 | Teacher Portal | Attendance, marks, assignments, student performance, communication |
| 22 | Super Admin | Manage schools, subscriptions, plans, storage, usage statistics, activation, suspension, support tickets |

Non-functional requirements: HTTPS-ready, Argon2id password hashing, RBAC,
audit logs, encryption-ready schema, multi-tenant, cloud-ready, horizontally
scalable, responsive mobile-first UI with WCAG 2.1 AA considerations
(semantic landmarks, labelled controls, visible focus rings, ARIA on the
register and marks grids).

---

## Deviations from the PRD

Stated plainly, with reasons:

1. **Backend framework.** The PRD suggests ASP.NET Core "or Laravel if
   preferred". This implementation uses **Node.js + Express + TypeScript** with
   Prisma instead. The layered architecture, REST contract, JWT model and
   PostgreSQL schema all follow the PRD, so the design ports to .NET if you
   prefer that stack. Everything else in section 8 — React, TypeScript, Tailwind,
   TanStack Query, React Hook Form, PostgreSQL, Redis, Docker, nginx — is as
   specified.

2. **PDF generation.** QuestPDF and FastReport are .NET libraries. Receipts,
   report cards and result sheets are instead print-optimised HTML views that
   produce clean PDFs through the browser's print dialog; tabular reports export
   as CSV, which opens directly in Excel. A server-side PDF renderer can be added
   behind the existing report endpoints without changing them.

3. **Two-factor authentication.** The PRD marks this optional. The schema carries
   `twoFactorEnabled` and `twoFactorSecret`, but the TOTP enrolment and
   verification flow is not built.

4. **Payment gateway integration.** Mobile-money payments are recorded with
   provider and transaction reference, but no live M-Pesa/Airtel/Mixx/HaloPesa
   API calls are made and there is no webhook endpoint — both need merchant
   credentials. The PRD places this in Phase 3. Nor is there any billing for
   the subscriptions themselves: a plan is set by platform staff, not paid for
   online.

   SMS and email **are** wired up — Africa's Talking and SMTP respectively.
   See the deployment section.

5. **File uploads.** The document module records metadata and a storage URL; the
   binary upload path to S3/Azure Blob is not wired up, so `STORAGE_DRIVER` is
   currently a placeholder.

6. **Payroll tax bands.** The PAYE bands and 10% NSSF rate in
   `accounting.routes.ts` are illustrative placeholders isolated in one function.
   Confirm the current TRA figures with your finance officer before going live.

7. **WhatsApp Business API** is listed as a future enhancement in the PRD and is
   not implemented.
