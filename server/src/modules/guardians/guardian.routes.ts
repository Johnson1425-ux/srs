import { Router } from 'express';
import { Role } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { asyncHandler, paginate, paginationSchema, skipTake, validate } from '../../lib/http.js';
import { requirePermission, schoolIdOf } from '../../middleware/auth.js';
import { hashPassword, randomToken } from '../../lib/tokens.js';
import { audit } from '../../lib/audit.js';
import { conflict, notFound } from '../../lib/errors.js';

/** Module 5 — Parent Management (exposed at /parents per PRD section 9). */
export const guardianRouter: Router = Router();

const listQuery = paginationSchema.extend({ search: z.string().trim().optional() });

guardianRouter.get(
  '/',
  requirePermission('guardians:read'),
  validate(listQuery, 'query'),
  asyncHandler(async (req, res) => {
    const { page, pageSize, search } = req.query as unknown as z.infer<typeof listQuery>;
    const where = {
      schoolId: schoolIdOf(req),
      ...(search
        ? {
            OR: [
              { firstName: { contains: search, mode: 'insensitive' as const } },
              { lastName: { contains: search, mode: 'insensitive' as const } },
              { phone: { contains: search } },
              { email: { contains: search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    const [data, total] = await Promise.all([
      prisma.guardian.findMany({
        where,
        ...skipTake(page, pageSize),
        orderBy: { lastName: 'asc' },
        include: {
          user: { select: { id: true, email: true, status: true } },
          studentLinks: {
            include: {
              student: {
                select: { id: true, firstName: true, lastName: true, admissionNumber: true },
              },
            },
          },
        },
      }),
      prisma.guardian.count({ where }),
    ]);

    res.json(paginate(data, total, page, pageSize));
  }),
);

guardianRouter.get(
  '/:id',
  requirePermission('guardians:read'),
  asyncHandler(async (req, res) => {
    const guardian = await prisma.guardian.findFirst({
      where: { id: req.params.id as string, schoolId: schoolIdOf(req) },
      include: {
        user: { select: { id: true, email: true, status: true } },
        studentLinks: { include: { student: { include: { enrollments: { where: { isActive: true }, include: { schoolClass: true, stream: true } } } } } },
      },
    });
    if (!guardian) throw notFound('Parent');
    res.json(guardian);
  }),
);

const guardianSchema = z.object({
  firstName: z.string().min(1).max(60),
  lastName: z.string().min(1).max(60),
  relationship: z.string().min(2).max(40),
  phone: z.string().min(7).max(30),
  altPhone: z.string().max(30).nullish(),
  email: z.string().email().nullish(),
  occupation: z.string().max(80).nullish(),
  address: z.string().max(300).nullish(),
  nationalId: z.string().max(40).nullish(),
  createPortalAccount: z.boolean().default(false),
});

guardianRouter.post(
  '/',
  requirePermission('guardians:manage'),
  validate(guardianSchema),
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const { createPortalAccount, ...data } = req.body as z.infer<typeof guardianSchema>;

    const duplicate = await prisma.guardian.findFirst({ where: { schoolId, phone: data.phone } });
    if (duplicate) {
      throw conflict('A parent with this phone number already exists', {
        guardianId: duplicate.id,
      });
    }

    let temporaryPassword: string | undefined;
    const guardian = await prisma.$transaction(async (tx) => {
      let userId: string | null = null;
      if (createPortalAccount) {
        temporaryPassword = `Sms-${randomToken(4)}`;
        const email = data.email ?? `${data.phone.replace(/\D/g, '')}@parents.local`;
        const user = await tx.user.create({
          data: {
            schoolId,
            email: email.toLowerCase(),
            phone: data.phone,
            firstName: data.firstName,
            lastName: data.lastName,
            role: Role.PARENT,
            passwordHash: await hashPassword(temporaryPassword),
            mustChangePassword: true,
          },
        });
        userId = user.id;
      }
      return tx.guardian.create({ data: { ...data, schoolId, userId } });
    });

    await audit(req, { action: 'guardian.create', entityType: 'Guardian', entityId: guardian.id });
    res.status(201).json({ ...guardian, temporaryPassword });
  }),
);

guardianRouter.patch(
  '/:id',
  requirePermission('guardians:manage'),
  validate(guardianSchema.omit({ createPortalAccount: true }).partial()),
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const id = req.params.id as string;
    const existing = await prisma.guardian.findFirst({ where: { id, schoolId } });
    if (!existing) throw notFound('Parent');

    const guardian = await prisma.guardian.update({ where: { id }, data: req.body });
    await audit(req, { action: 'guardian.update', entityType: 'Guardian', entityId: id });
    res.json(guardian);
  }),
);

/** Fee statement across every child of this parent (Module 5). */
guardianRouter.get(
  '/:id/fee-statement',
  requirePermission('guardians:read', 'fees:read'),
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const id = req.params.id as string;

    const guardian = await prisma.guardian.findFirst({
      where: { id, schoolId },
      include: { studentLinks: { select: { studentId: true } } },
    });
    if (!guardian) throw notFound('Parent');

    const studentIds = guardian.studentLinks.map((l) => l.studentId);
    const invoices = await prisma.invoice.findMany({
      where: { studentId: { in: studentIds }, status: { not: 'CANCELLED' } },
      include: {
        items: true,
        student: { select: { id: true, firstName: true, lastName: true, admissionNumber: true } },
        term: { select: { name: true } },
      },
      orderBy: { issueDate: 'desc' },
    });

    const totalBilled = invoices.reduce((acc, i) => acc + Number(i.total), 0);
    const totalPaid = invoices.reduce((acc, i) => acc + Number(i.amountPaid), 0);

    res.json({
      guardian: { id: guardian.id, firstName: guardian.firstName, lastName: guardian.lastName },
      summary: { totalBilled, totalPaid, balance: totalBilled - totalPaid },
      invoices,
    });
  }),
);
