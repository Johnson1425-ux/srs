import { Router } from 'express';
import { Role, SchoolStatus, SubscriptionPlan, StudentStatus } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { asyncHandler, paginate, paginationSchema, skipTake, validate } from '../../lib/http.js';
import { requireRole } from '../../middleware/auth.js';
import { hashPassword, randomToken } from '../../lib/tokens.js';
import { audit } from '../../lib/audit.js';
import { notFound } from '../../lib/errors.js';

/** Module 22 — Super Admin (multi-school SaaS administration). */
export const platformRouter: Router = Router();

// Everything here is platform staff only.
platformRouter.use(requireRole(Role.SUPER_ADMIN));

const PLAN_LIMITS: Record<SubscriptionPlan, { maxStudents: number; storageQuotaMb: number }> = {
  TRIAL: { maxStudents: 100, storageQuotaMb: 512 },
  BASIC: { maxStudents: 500, storageQuotaMb: 2048 },
  STANDARD: { maxStudents: 2000, storageQuotaMb: 10240 },
  PREMIUM: { maxStudents: 5000, storageQuotaMb: 51200 },
};

platformRouter.get(
  '/schools',
  validate(
    paginationSchema.extend({
      search: z.string().optional(),
      status: z.nativeEnum(SchoolStatus).optional(),
    }),
    'query',
  ),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as {
      page: number;
      pageSize: number;
      search?: string;
      status?: SchoolStatus;
    };
    const where = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.search
        ? {
            OR: [
              { name: { contains: q.search, mode: 'insensitive' as const } },
              { code: { contains: q.search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    const [data, total] = await Promise.all([
      prisma.school.findMany({
        where,
        ...skipTake(q.page, q.pageSize),
        orderBy: { createdAt: 'desc' },
        include: {
          _count: { select: { users: true, students: true, staff: true } },
        },
      }),
      prisma.school.count({ where }),
    ]);

    res.json(paginate(data, total, q.page, q.pageSize));
  }),
);

const createSchoolSchema = z.object({
  name: z.string().min(2).max(150),
  code: z
    .string()
    .min(2)
    .max(12)
    .regex(/^[A-Za-z0-9]+$/, 'Code must be alphanumeric')
    .transform((v) => v.toUpperCase()),
  email: z.string().email().nullish(),
  phone: z.string().max(30).nullish(),
  address: z.string().max(300).nullish(),
  city: z.string().max(100).nullish(),
  region: z.string().max(100).nullish(),
  plan: z.nativeEnum(SubscriptionPlan).default(SubscriptionPlan.TRIAL),
  admin: z.object({
    firstName: z.string().min(1),
    lastName: z.string().min(1),
    email: z.string().email(),
    phone: z.string().max(30).optional(),
  }),
});

/** Onboards a new tenant along with its first administrator account. */
platformRouter.post(
  '/schools',
  validate(createSchoolSchema),
  asyncHandler(async (req, res) => {
    const { admin, plan, ...schoolData } = req.body as z.infer<typeof createSchoolSchema>;
    const limits = PLAN_LIMITS[plan];
    const temporaryPassword = `Sms-${randomToken(5)}`;

    const school = await prisma.$transaction(async (tx) => {
      const created = await tx.school.create({
        data: {
          ...schoolData,
          plan,
          status: plan === SubscriptionPlan.TRIAL ? SchoolStatus.TRIAL : SchoolStatus.ACTIVE,
          planStartsAt: new Date(),
          planEndsAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
          maxStudents: limits.maxStudents,
          storageQuotaMb: limits.storageQuotaMb,
        },
      });

      await tx.user.create({
        data: {
          schoolId: created.id,
          email: admin.email.toLowerCase(),
          phone: admin.phone ?? null,
          firstName: admin.firstName,
          lastName: admin.lastName,
          role: Role.ADMIN,
          passwordHash: await hashPassword(temporaryPassword),
          mustChangePassword: true,
        },
      });

      // Sensible defaults so a new school can start work immediately.
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

    await audit(req, { action: 'platform.school_create', entityType: 'School', entityId: school.id });
    res.status(201).json({
      school,
      administrator: { email: admin.email.toLowerCase(), temporaryPassword },
    });
  }),
);

platformRouter.patch(
  '/schools/:id',
  validate(
    z.object({
      status: z.nativeEnum(SchoolStatus).optional(),
      plan: z.nativeEnum(SubscriptionPlan).optional(),
      planEndsAt: z.coerce.date().optional(),
      maxStudents: z.number().int().positive().optional(),
      storageQuotaMb: z.number().int().positive().optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const id = req.params.id as string;
    const existing = await prisma.school.findUnique({ where: { id } });
    if (!existing) throw notFound('School');

    const body = req.body as {
      plan?: SubscriptionPlan;
      maxStudents?: number;
      storageQuotaMb?: number;
      status?: SchoolStatus;
    };

    // Changing plan moves the quotas with it unless explicitly overridden.
    const limits = body.plan ? PLAN_LIMITS[body.plan] : null;

    const school = await prisma.school.update({
      where: { id },
      data: {
        ...body,
        ...(limits
          ? {
              maxStudents: body.maxStudents ?? limits.maxStudents,
              storageQuotaMb: body.storageQuotaMb ?? limits.storageQuotaMb,
            }
          : {}),
      },
    });

    // Suspending a tenant terminates its live sessions immediately.
    if (body.status === SchoolStatus.SUSPENDED) {
      await prisma.session.updateMany({
        where: { user: { schoolId: id }, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }

    await audit(req, {
      action: 'platform.school_update',
      entityType: 'School',
      entityId: id,
      metadata: body,
    });
    res.json(school);
  }),
);

/** Usage statistics across all tenants. */
platformRouter.get(
  '/usage',
  asyncHandler(async (_req, res) => {
    const [schools, byStatus, byPlan, totalStudents, totalUsers, storage] = await Promise.all([
      prisma.school.count(),
      prisma.school.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.school.groupBy({ by: ['plan'], _count: { _all: true } }),
      prisma.student.count({ where: { status: StudentStatus.ACTIVE } }),
      prisma.user.count(),
      prisma.document.aggregate({ _sum: { sizeBytes: true } }),
    ]);

    res.json({
      schools,
      byStatus: Object.fromEntries(byStatus.map((s) => [s.status, s._count._all])),
      byPlan: Object.fromEntries(byPlan.map((p) => [p.plan, p._count._all])),
      totalActiveStudents: totalStudents,
      totalUsers,
      storageUsedMb: Number(((storage._sum.sizeBytes ?? 0) / (1024 * 1024)).toFixed(2)),
    });
  }),
);

/** Per-school usage against plan limits — the SaaS billing view. */
platformRouter.get(
  '/schools/:id/usage',
  asyncHandler(async (req, res) => {
    const id = req.params.id as string;
    const school = await prisma.school.findUnique({ where: { id } });
    if (!school) throw notFound('School');

    const [students, users, staff, storage, payments] = await Promise.all([
      prisma.student.count({ where: { schoolId: id, status: StudentStatus.ACTIVE } }),
      prisma.user.count({ where: { schoolId: id } }),
      prisma.staff.count({ where: { schoolId: id } }),
      prisma.document.aggregate({ where: { schoolId: id }, _sum: { sizeBytes: true } }),
      prisma.payment.aggregate({ where: { schoolId: id }, _sum: { amount: true }, _count: true }),
    ]);

    const storageUsedMb = Number(((storage._sum.sizeBytes ?? 0) / (1024 * 1024)).toFixed(2));

    res.json({
      school: { id: school.id, name: school.name, code: school.code, plan: school.plan, status: school.status },
      limits: { maxStudents: school.maxStudents, storageQuotaMb: school.storageQuotaMb },
      usage: {
        students,
        users,
        staff,
        storageUsedMb,
        studentsPercent: Number(((students / school.maxStudents) * 100).toFixed(1)),
        storagePercent: Number(((storageUsedMb / school.storageQuotaMb) * 100).toFixed(1)),
      },
      lifetimeFeeCollection: {
        amount: payments._sum.amount?.toString() ?? '0',
        transactions: payments._count,
      },
    });
  }),
);

// --- Support tickets --------------------------------------------------------

platformRouter.get(
  '/tickets',
  validate(z.object({ status: z.string().optional() }), 'query'),
  asyncHandler(async (req, res) => {
    const { status } = req.query as { status?: string };
    const data = await prisma.supportTicket.findMany({
      where: status ? { status } : {},
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { school: { select: { name: true, code: true } } },
    });
    res.json({ data });
  }),
);

platformRouter.patch(
  '/tickets/:id',
  validate(
    z.object({
      status: z.enum(['OPEN', 'IN_PROGRESS', 'RESOLVED']).optional(),
      priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const id = req.params.id as string;
    const ticket = await prisma.supportTicket.findUnique({ where: { id } });
    if (!ticket) throw notFound('Ticket');
    res.json(await prisma.supportTicket.update({ where: { id }, data: req.body }));
  }),
);
