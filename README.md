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

```bash
cp .env.example .env
# Fill in POSTGRES_PASSWORD, JWT_ACCESS_SECRET and JWT_REFRESH_SECRET.
# Generate secrets with: openssl rand -base64 48

docker compose up --build
```

The app is served at <http://localhost:8080>. Migrations run automatically on
API start-up. To load the demo school:

```bash
docker compose exec api npx tsx prisma/seed.ts
```

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
| `/exams` | list, create, `subjects/:id/marks`, `publish`, `unpublish` |
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

**Render** — leave Root Directory **blank**. Render `cd`s into it and runs npm
there, and `npm ci` fails inside `server/` because npm workspaces keep a single
lockfile at the repository root. Address the workspace by flag instead:

| Field | Value |
| --- | --- |
| Build Command | `npm ci && npm run build --workspace=server` |
| Pre-Deploy Command | `npx prisma migrate deploy --schema server/prisma/schema.prisma` |
| Start Command | `node server/dist/index.js` |
| Health Check Path | `/health` |

Set `DATABASE_URL`, `DIRECT_URL`, both `JWT_*` secrets and
`CORS_ORIGIN=https://your-app.vercel.app`. Leave `PORT` alone — Render injects
it. Prefer Render's native Node runtime over the Dockerfile; both work, but the
native runtime needs no container build.

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
with `Error { kind: Closed }`.

Note that the API calls `prisma.$connect()` before it listens, so an
unreachable database means the process exits rather than serving errors. If the
frontend reports a network failure and the logs never print
`SMS API listening`, the connection string is the place to look.

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
3. Configure `SMS_GATEWAY_*` and `SMTP_*`. **Left blank, messages are recorded in
   the outbox with status `QUEUED` and nothing is dispatched** — the school keeps
   a full history, and wiring a provider later means implementing one `deliver`
   function without touching any caller.
4. Schedule `pg_dump` for the daily backups the PRD requires.
5. The API is stateless, so it scales horizontally behind the proxy.

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
| 9 | Examinations | All five exam types, marks entry, grading, GPA, configurable ranking, report cards, transcripts |
| 10 | Fee Management | All nine categories, structures, invoices, receipts, discounts, scholarships, waivers, history, balances, reversals; all five payment methods incl. the four mobile-money providers |
| 11 | Accounting | Income, expenses, payroll with PAYE/NSSF, general ledger, P&L, cash flow |
| 12 | Library | Books, categories, borrowing, returns, late fees, barcode field, inventory |
| 13 | Inventory | Assets, stationery, lab equipment, furniture, stock movements, suppliers, purchase orders |
| 14 | Transport | Buses, routes, drivers, fuel logs, maintenance, student allocation, manifests |
| 15 | Hostel | Rooms, beds, occupancy, boarders, allocation with gender and capacity rules |
| 16 | Communication | Email/SMS/in-app channels, announcements, templates with placeholders, bulk messaging by audience |
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
   provider and transaction reference, and the schema and webhook secret are in
   place, but no live M-Pesa/Airtel/Mixx/HaloPesa API calls are made — those need
   merchant credentials. The PRD places this in Phase 3.

5. **File uploads.** The document module records metadata and a storage URL; the
   binary upload path to S3/Azure Blob is not wired up, so `STORAGE_DRIVER` is
   currently a placeholder.

6. **Payroll tax bands.** The PAYE bands and 10% NSSF rate in
   `accounting.routes.ts` are illustrative placeholders isolated in one function.
   Confirm the current TRA figures with your finance officer before going live.

7. **WhatsApp Business API** is listed as a future enhancement in the PRD and is
   not implemented.
