import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { asyncHandler, validate } from '../../lib/http.js';
import { requirePermission, schoolIdOf } from '../../middleware/auth.js';
import { audit } from '../../lib/audit.js';

/** Module 3 — School Setup: profile and school-wide configuration. */
export const schoolRouter: Router = Router();

schoolRouter.get(
  '/school',
  requirePermission('school:read'),
  asyncHandler(async (req, res) => {
    const school = await prisma.school.findUniqueOrThrow({ where: { id: schoolIdOf(req) } });
    res.json(school);
  }),
);

const updateSchoolSchema = z.object({
  name: z.string().min(2).optional(),
  motto: z.string().max(200).nullish(),
  email: z.string().email().nullish(),
  phone: z.string().max(30).nullish(),
  address: z.string().max(300).nullish(),
  city: z.string().max(100).nullish(),
  region: z.string().max(100).nullish(),
  country: z.string().max(100).optional(),
  logoUrl: z.string().url().nullish(),
  registrationNo: z.string().max(60).nullish(),
  rankingEnabled: z.boolean().optional(),
  currency: z.string().length(3).optional(),
  timezone: z.string().optional(),
  smsSenderId: z.string().max(11).nullish(),
});

schoolRouter.patch(
  '/school',
  requirePermission('school:manage'),
  validate(updateSchoolSchema),
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const school = await prisma.school.update({ where: { id: schoolId }, data: req.body });
    await audit(req, { action: 'school.update', entityType: 'School', entityId: schoolId });
    res.json(school);
  }),
);

/** Audit trail viewer (PRD section 6 — Security). */
schoolRouter.get(
  '/audit-logs',
  requirePermission('audit:read'),
  validate(
    z.object({
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(200).default(50),
      action: z.string().optional(),
      userId: z.string().optional(),
    }),
    'query',
  ),
  asyncHandler(async (req, res) => {
    const { page, pageSize, action, userId } = req.query as unknown as {
      page: number;
      pageSize: number;
      action?: string;
      userId?: string;
    };
    const where = {
      schoolId: schoolIdOf(req),
      ...(action ? { action: { contains: action } } : {}),
      ...(userId ? { userId } : {}),
    };
    const [data, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { user: { select: { firstName: true, lastName: true, role: true } } },
      }),
      prisma.auditLog.count({ where }),
    ]);
    res.json({ data, meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) || 1 } });
  }),
);
