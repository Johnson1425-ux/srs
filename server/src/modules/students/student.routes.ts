import { Router } from 'express';
import { Gender, StudentStatus } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { asyncHandler, paginate, paginationSchema, skipTake, validate } from '../../lib/http.js';
import { requirePermission, schoolIdOf } from '../../middleware/auth.js';
import { audit } from '../../lib/audit.js';
import * as service from './student.service.js';

/** Module 4 — Student Management. */
export const studentRouter: Router = Router();

const listQuery = paginationSchema.extend({
  search: z.string().trim().optional(),
  classId: z.string().optional(),
  streamId: z.string().optional(),
  status: z.nativeEnum(StudentStatus).optional(),
  gender: z.nativeEnum(Gender).optional(),
});

studentRouter.get(
  '/',
  requirePermission('students:read'),
  validate(listQuery, 'query'),
  asyncHandler(async (req, res) => {
    const { page, pageSize, search, classId, streamId, status, gender } =
      req.query as unknown as z.infer<typeof listQuery>;

    const where = {
      schoolId: schoolIdOf(req),
      // Default view hides archived records, matching the admissions register.
      status: status ?? { not: StudentStatus.ARCHIVED },
      ...(gender ? { gender } : {}),
      ...(classId || streamId
        ? {
            enrollments: {
              some: {
                isActive: true,
                ...(classId ? { classId } : {}),
                ...(streamId ? { streamId } : {}),
              },
            },
          }
        : {}),
      ...(search
        ? {
            OR: [
              { firstName: { contains: search, mode: 'insensitive' as const } },
              { lastName: { contains: search, mode: 'insensitive' as const } },
              { middleName: { contains: search, mode: 'insensitive' as const } },
              { admissionNumber: { contains: search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    const [data, total] = await Promise.all([
      prisma.student.findMany({
        where,
        ...skipTake(page, pageSize),
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
        include: service.studentInclude,
      }),
      prisma.student.count({ where }),
    ]);

    res.json(paginate(data, total, page, pageSize));
  }),
);

studentRouter.get(
  '/:id',
  requirePermission('students:read'),
  asyncHandler(async (req, res) => {
    res.json(await service.getStudent(schoolIdOf(req), req.params.id as string));
  }),
);

const guardianInput = z.object({
  guardianId: z.string().optional(),
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  relationship: z.string().min(2).max(40).optional(),
  phone: z.string().min(7).max(30).optional(),
  email: z.string().email().nullish(),
  occupation: z.string().max(80).nullish(),
  address: z.string().max(300).nullish(),
  isPrimary: z.boolean().default(false),
  isFeePayer: z.boolean().default(false),
  createPortalAccount: z.boolean().default(false),
});

const admissionSchema = z.object({
  admissionNumber: z.string().max(40).optional(),
  firstName: z.string().min(1).max(60),
  middleName: z.string().max(60).nullish(),
  lastName: z.string().min(1).max(60),
  gender: z.nativeEnum(Gender),
  dateOfBirth: z.coerce.date().refine((d) => d < new Date(), 'Date of birth must be in the past'),
  nationality: z.string().max(60).optional(),
  address: z.string().max(300).nullish(),
  photoUrl: z.string().url().nullish(),
  bloodGroup: z.string().max(5).nullish(),
  medicalConditions: z.string().max(1000).nullish(),
  previousSchool: z.string().max(150).nullish(),
  emergencyContactName: z.string().max(120).nullish(),
  emergencyContactPhone: z.string().max(30).nullish(),
  admissionDate: z.coerce.date().optional(),
  classId: z.string().min(1),
  streamId: z.string().nullish(),
  academicYearId: z.string().optional(),
  createPortalAccount: z.boolean().default(false),
  guardians: z.array(guardianInput).max(4).optional(),
});

studentRouter.post(
  '/',
  requirePermission('students:manage'),
  validate(admissionSchema),
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const result = await service.admitStudent(schoolId, req.body);
    await audit(req, {
      action: 'student.admit',
      entityType: 'Student',
      entityId: result.student.id,
      metadata: { admissionNumber: result.student.admissionNumber },
    });
    res.status(201).json(result);
  }),
);

const updateSchema = admissionSchema
  .omit({ classId: true, streamId: true, academicYearId: true, guardians: true, createPortalAccount: true })
  .partial();

studentRouter.patch(
  '/:id',
  requirePermission('students:manage'),
  validate(updateSchema),
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const id = req.params.id as string;
    await service.getStudent(schoolId, id); // 404s if it belongs to another tenant

    const student = await prisma.student.update({
      where: { id },
      data: req.body,
      include: service.studentInclude,
    });
    await audit(req, { action: 'student.update', entityType: 'Student', entityId: id });
    res.json(student);
  }),
);

/** Suspend / graduate / archive / reinstate — PRD Module 4 functions. */
studentRouter.post(
  '/:id/status',
  requirePermission('students:manage'),
  validate(
    z.object({
      status: z.nativeEnum(StudentStatus),
      reason: z.string().max(300).optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const id = req.params.id as string;
    const student = await service.setStatus(
      schoolIdOf(req),
      id,
      req.body.status,
      req.body.reason,
    );
    await audit(req, {
      action: `student.status.${String(req.body.status).toLowerCase()}`,
      entityType: 'Student',
      entityId: id,
      metadata: { reason: req.body.reason },
    });
    res.json(student);
  }),
);

studentRouter.post(
  '/promote',
  requirePermission('students:promote'),
  validate(
    z.object({
      fromClassId: z.string().min(1),
      toClassId: z.string().min(1),
      toAcademicYearId: z.string().min(1),
      toStreamId: z.string().nullish(),
      studentIds: z.array(z.string()).optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const result = await service.promoteStudents(schoolIdOf(req), req.body);
    await audit(req, {
      action: 'student.promote',
      entityType: 'SchoolClass',
      entityId: req.body.fromClassId,
      metadata: { promoted: result.promotedCount, skipped: result.skippedCount },
    });
    res.json(result);
  }),
);

/** Link an existing guardian to a student. */
studentRouter.post(
  '/:id/guardians',
  requirePermission('students:manage', 'guardians:manage'),
  validate(
    z.object({
      guardianId: z.string().min(1),
      isPrimary: z.boolean().default(false),
      isFeePayer: z.boolean().default(false),
    }),
  ),
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const studentId = req.params.id as string;
    await service.getStudent(schoolId, studentId);

    const link = await prisma.studentGuardian.upsert({
      where: { studentId_guardianId: { studentId, guardianId: req.body.guardianId } },
      create: { studentId, ...req.body },
      update: { isPrimary: req.body.isPrimary, isFeePayer: req.body.isFeePayer },
      include: { guardian: true },
    });
    res.status(201).json(link);
  }),
);
