import { Router } from 'express';
import { EmploymentStatus, Gender, LeaveStatus, Role, StaffType } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { asyncHandler, paginate, paginationSchema, skipTake, validate } from '../../lib/http.js';
import { requirePermission, schoolIdOf } from '../../middleware/auth.js';
import { hashPassword, randomToken } from '../../lib/tokens.js';
import { nextStaffNumber } from '../../lib/sequence.js';
import { audit } from '../../lib/audit.js';
import { badRequest, notFound } from '../../lib/errors.js';

/** Module 6 — Staff Management (teachers + non-teaching staff). */
export const staffRouter: Router = Router();

const listQuery = paginationSchema.extend({
  search: z.string().trim().optional(),
  staffType: z.nativeEnum(StaffType).optional(),
  departmentId: z.string().optional(),
  employmentStatus: z.nativeEnum(EmploymentStatus).optional(),
});

staffRouter.get(
  '/',
  requirePermission('staff:read'),
  validate(listQuery, 'query'),
  asyncHandler(async (req, res) => {
    const { page, pageSize, search, staffType, departmentId, employmentStatus } =
      req.query as unknown as z.infer<typeof listQuery>;

    const where = {
      schoolId: schoolIdOf(req),
      ...(staffType ? { staffType } : {}),
      ...(departmentId ? { departmentId } : {}),
      ...(employmentStatus ? { employmentStatus } : {}),
      ...(search
        ? {
            OR: [
              { firstName: { contains: search, mode: 'insensitive' as const } },
              { lastName: { contains: search, mode: 'insensitive' as const } },
              { staffNumber: { contains: search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    const [data, total] = await Promise.all([
      prisma.staff.findMany({
        where,
        ...skipTake(page, pageSize),
        orderBy: { lastName: 'asc' },
        include: {
          department: { select: { id: true, name: true } },
          user: { select: { id: true, email: true, role: true, status: true } },
        },
      }),
      prisma.staff.count({ where }),
    ]);

    res.json(paginate(data, total, page, pageSize));
  }),
);

staffRouter.get(
  '/:id',
  requirePermission('staff:read'),
  asyncHandler(async (req, res) => {
    const staff = await prisma.staff.findFirst({
      where: { id: req.params.id as string, schoolId: schoolIdOf(req) },
      include: {
        department: true,
        user: { select: { id: true, email: true, role: true, status: true } },
        classSubjects: {
          include: {
            subject: { select: { name: true, code: true } },
            schoolClass: { select: { name: true } },
          },
        },
        streamsLed: { include: { schoolClass: { select: { name: true } } } },
      },
    });
    if (!staff) throw notFound('Staff member');
    res.json(staff);
  }),
);

const staffSchema = z.object({
  staffNumber: z.string().max(30).optional(),
  firstName: z.string().min(1).max(60),
  lastName: z.string().min(1).max(60),
  gender: z.nativeEnum(Gender),
  dateOfBirth: z.coerce.date().nullish(),
  phone: z.string().max(30).nullish(),
  email: z.string().email().nullish(),
  address: z.string().max(300).nullish(),
  nationalId: z.string().max(40).nullish(),
  staffType: z.nativeEnum(StaffType).default(StaffType.TEACHING),
  jobTitle: z.string().max(80).nullish(),
  departmentId: z.string().nullish(),
  qualification: z.string().max(120).nullish(),
  hireDate: z.coerce.date().optional(),
  basicSalary: z.number().nonnegative().nullish(),
  bankName: z.string().max(80).nullish(),
  bankAccount: z.string().max(40).nullish(),
  createPortalAccount: z.boolean().default(true),
  portalRole: z
    .enum(['TEACHER', 'ACCOUNTANT', 'LIBRARIAN', 'DRIVER', 'RECEPTIONIST', 'TRANSPORT_OFFICER', 'ADMIN'])
    .default('TEACHER'),
});

staffRouter.post(
  '/',
  requirePermission('staff:manage'),
  validate(staffSchema),
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const { createPortalAccount, portalRole, ...data } = req.body as z.infer<typeof staffSchema>;

    if (createPortalAccount && !data.email) {
      throw badRequest('An email address is required to create a portal account');
    }

    let temporaryPassword: string | undefined;
    const staff = await prisma.$transaction(async (tx) => {
      const staffNumber = data.staffNumber?.trim() || (await nextStaffNumber(schoolId, tx));

      let userId: string | null = null;
      if (createPortalAccount && data.email) {
        temporaryPassword = `Sms-${randomToken(4)}`;
        const user = await tx.user.create({
          data: {
            schoolId,
            email: data.email.toLowerCase(),
            phone: data.phone ?? null,
            firstName: data.firstName,
            lastName: data.lastName,
            role: portalRole as Role,
            passwordHash: await hashPassword(temporaryPassword),
            mustChangePassword: true,
          },
        });
        userId = user.id;
      }

      return tx.staff.create({ data: { ...data, staffNumber, schoolId, userId } });
    });

    await audit(req, { action: 'staff.create', entityType: 'Staff', entityId: staff.id });
    res.status(201).json({ ...staff, temporaryPassword });
  }),
);

staffRouter.patch(
  '/:id',
  requirePermission('staff:manage'),
  validate(
    staffSchema
      .omit({ createPortalAccount: true, portalRole: true })
      .extend({ employmentStatus: z.nativeEnum(EmploymentStatus).optional() })
      .partial(),
  ),
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const id = req.params.id as string;
    const existing = await prisma.staff.findFirst({ where: { id, schoolId } });
    if (!existing) throw notFound('Staff member');

    const staff = await prisma.staff.update({ where: { id }, data: req.body });
    await audit(req, { action: 'staff.update', entityType: 'Staff', entityId: id });
    res.json(staff);
  }),
);

// --- Staff attendance (Module 8) -------------------------------------------

staffRouter.post(
  '/attendance',
  requirePermission('attendance:record'),
  validate(
    z.object({
      date: z.coerce.date(),
      records: z
        .array(
          z.object({
            staffId: z.string().min(1),
            status: z.enum(['PRESENT', 'ABSENT', 'LATE', 'EXCUSED', 'SICK']),
            checkIn: z.coerce.date().nullish(),
            checkOut: z.coerce.date().nullish(),
            note: z.string().max(200).nullish(),
          }),
        )
        .min(1),
    }),
  ),
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const { date, records } = req.body as {
      date: Date;
      records: Array<{
        staffId: string;
        status: 'PRESENT' | 'ABSENT' | 'LATE' | 'EXCUSED' | 'SICK';
        checkIn?: Date | null;
        checkOut?: Date | null;
        note?: string | null;
      }>;
    };

    const ids = records.map((r) => r.staffId);
    const valid = await prisma.staff.count({ where: { schoolId, id: { in: ids } } });
    if (valid !== new Set(ids).size) throw badRequest('One or more staff members do not belong to this school');

    await prisma.$transaction(
      records.map((r) =>
        prisma.staffAttendance.upsert({
          where: { staffId_date: { staffId: r.staffId, date } },
          create: {
            schoolId,
            staffId: r.staffId,
            date,
            status: r.status,
            checkIn: r.checkIn ?? null,
            checkOut: r.checkOut ?? null,
            note: r.note ?? null,
          },
          update: {
            status: r.status,
            checkIn: r.checkIn ?? null,
            checkOut: r.checkOut ?? null,
            note: r.note ?? null,
          },
        }),
      ),
    );

    await audit(req, { action: 'staff_attendance.record', metadata: { count: records.length } });
    res.json({ recorded: records.length });
  }),
);

staffRouter.get(
  '/attendance/register',
  requirePermission('attendance:read'),
  validate(z.object({ date: z.coerce.date() }), 'query'),
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const { date } = req.query as unknown as { date: Date };

    const staff = await prisma.staff.findMany({
      where: { schoolId, employmentStatus: EmploymentStatus.ACTIVE },
      orderBy: { lastName: 'asc' },
      select: { id: true, staffNumber: true, firstName: true, lastName: true, staffType: true },
    });
    const marks = await prisma.staffAttendance.findMany({ where: { schoolId, date } });
    const byStaff = new Map(marks.map((m) => [m.staffId, m]));

    res.json({
      date,
      data: staff.map((s) => ({ ...s, attendance: byStaff.get(s.id) ?? null })),
    });
  }),
);

// --- Leave management (Module 6) -------------------------------------------

staffRouter.get(
  '/leave/requests',
  requirePermission('staff:read'),
  validate(z.object({ status: z.nativeEnum(LeaveStatus).optional() }), 'query'),
  asyncHandler(async (req, res) => {
    const { status } = req.query as { status?: LeaveStatus };
    const data = await prisma.leaveRequest.findMany({
      where: { schoolId: schoolIdOf(req), ...(status ? { status } : {}) },
      orderBy: { createdAt: 'desc' },
      include: { staff: { select: { id: true, firstName: true, lastName: true, staffNumber: true } } },
    });
    res.json({ data });
  }),
);

staffRouter.post(
  '/leave/requests',
  requirePermission('staff:read'),
  validate(
    z
      .object({
        staffId: z.string().optional(),
        leaveType: z.string().min(2).max(40),
        startDate: z.coerce.date(),
        endDate: z.coerce.date(),
        reason: z.string().max(500).nullish(),
      })
      .refine((v) => v.endDate >= v.startDate, {
        message: 'endDate must be on or after startDate',
        path: ['endDate'],
      }),
  ),
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    // Staff apply for themselves; managers may file on someone's behalf.
    const staffId = req.body.staffId ?? req.user?.staffId;
    if (!staffId) throw badRequest('staffId is required');

    const staff = await prisma.staff.findFirst({ where: { id: staffId, schoolId } });
    if (!staff) throw notFound('Staff member');

    const leave = await prisma.leaveRequest.create({
      data: { ...req.body, staffId, schoolId },
    });
    res.status(201).json(leave);
  }),
);

staffRouter.post(
  '/leave/requests/:id/decision',
  requirePermission('staff:manage'),
  validate(z.object({ status: z.enum(['APPROVED', 'REJECTED']) })),
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const id = req.params.id as string;
    const leave = await prisma.leaveRequest.findFirst({ where: { id, schoolId } });
    if (!leave) throw notFound('Leave request');
    if (leave.status !== LeaveStatus.PENDING) throw badRequest('This request has already been decided');

    const updated = await prisma.leaveRequest.update({
      where: { id },
      data: {
        status: req.body.status as LeaveStatus,
        decidedById: req.user?.id ?? null,
        decidedAt: new Date(),
      },
    });

    // An approved leave shows up immediately on the staff register.
    if (req.body.status === 'APPROVED') {
      await prisma.staff.update({
        where: { id: leave.staffId },
        data: { employmentStatus: EmploymentStatus.ON_LEAVE },
      });
    }

    await audit(req, { action: `leave.${String(req.body.status).toLowerCase()}`, entityType: 'LeaveRequest', entityId: id });
    res.json(updated);
  }),
);
