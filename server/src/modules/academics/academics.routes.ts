import { Router } from 'express';
import { TermStatus } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { asyncHandler, validate } from '../../lib/http.js';
import { requirePermission, schoolIdOf } from '../../middleware/auth.js';
import { audit } from '../../lib/audit.js';
import { badRequest, notFound } from '../../lib/errors.js';

/**
 * Module 3 (school setup) + Module 7 (academic management):
 * academic years, terms, departments, classes, streams, subjects,
 * grading scales, timetable and assignments.
 */
export const academicsRouter: Router = Router();

const canRead = requirePermission('academics:read');
const canManage = requirePermission('academics:manage');

// --- Academic years ---------------------------------------------------------

academicsRouter.get(
  '/years',
  canRead,
  asyncHandler(async (req, res) => {
    const data = await prisma.academicYear.findMany({
      where: { schoolId: schoolIdOf(req) },
      orderBy: { startDate: 'desc' },
      include: { terms: { orderBy: { sequence: 'asc' } } },
    });
    res.json({ data });
  }),
);

const yearSchema = z
  .object({
    name: z.string().min(4).max(20),
    startDate: z.coerce.date(),
    endDate: z.coerce.date(),
    isCurrent: z.boolean().default(false),
  })
  .refine((v) => v.endDate > v.startDate, {
    message: 'endDate must be after startDate',
    path: ['endDate'],
  });

academicsRouter.post(
  '/years',
  canManage,
  validate(yearSchema),
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const body = req.body as z.infer<typeof yearSchema>;

    const year = await prisma.$transaction(async (tx) => {
      if (body.isCurrent) {
        await tx.academicYear.updateMany({ where: { schoolId }, data: { isCurrent: false } });
      }
      return tx.academicYear.create({ data: { ...body, schoolId } });
    });

    await audit(req, { action: 'academic_year.create', entityType: 'AcademicYear', entityId: year.id });
    res.status(201).json(year);
  }),
);

academicsRouter.post(
  '/years/:id/set-current',
  canManage,
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const id = req.params.id as string;
    const year = await prisma.academicYear.findFirst({ where: { id, schoolId } });
    if (!year) throw notFound('Academic year');

    await prisma.$transaction([
      prisma.academicYear.updateMany({ where: { schoolId }, data: { isCurrent: false } }),
      prisma.academicYear.update({ where: { id }, data: { isCurrent: true } }),
    ]);

    await audit(req, { action: 'academic_year.set_current', entityType: 'AcademicYear', entityId: id });
    res.json({ message: 'Current academic year updated' });
  }),
);

// --- Terms ------------------------------------------------------------------

const termSchema = z
  .object({
    academicYearId: z.string().min(1),
    name: z.string().min(1).max(40),
    sequence: z.number().int().min(1).max(6),
    startDate: z.coerce.date(),
    endDate: z.coerce.date(),
    status: z.nativeEnum(TermStatus).default(TermStatus.UPCOMING),
  })
  .refine((v) => v.endDate > v.startDate, {
    message: 'endDate must be after startDate',
    path: ['endDate'],
  });

academicsRouter.post(
  '/terms',
  canManage,
  validate(termSchema),
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const body = req.body as z.infer<typeof termSchema>;

    const year = await prisma.academicYear.findFirst({
      where: { id: body.academicYearId, schoolId },
    });
    if (!year) throw notFound('Academic year');

    const term = await prisma.term.create({ data: body });
    await audit(req, { action: 'term.create', entityType: 'Term', entityId: term.id });
    res.status(201).json(term);
  }),
);

academicsRouter.patch(
  '/terms/:id',
  canManage,
  validate(
    z.object({
      name: z.string().min(1).optional(),
      startDate: z.coerce.date().optional(),
      endDate: z.coerce.date().optional(),
      status: z.nativeEnum(TermStatus).optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const id = req.params.id as string;
    const term = await prisma.term.findFirst({
      where: { id, academicYear: { schoolId } },
    });
    if (!term) throw notFound('Term');

    const updated = await prisma.term.update({ where: { id }, data: req.body });
    await audit(req, { action: 'term.update', entityType: 'Term', entityId: id });
    res.json(updated);
  }),
);

// --- Departments ------------------------------------------------------------

academicsRouter.get(
  '/departments',
  canRead,
  asyncHandler(async (req, res) => {
    const data = await prisma.department.findMany({
      where: { schoolId: schoolIdOf(req) },
      orderBy: { name: 'asc' },
      include: { _count: { select: { staff: true, subjects: true } } },
    });
    res.json({ data });
  }),
);

academicsRouter.post(
  '/departments',
  canManage,
  validate(z.object({ name: z.string().min(2).max(80), headId: z.string().optional() })),
  asyncHandler(async (req, res) => {
    const department = await prisma.department.create({
      data: { ...req.body, schoolId: schoolIdOf(req) },
    });
    res.status(201).json(department);
  }),
);

// --- Classes and streams ----------------------------------------------------

academicsRouter.get(
  '/classes',
  canRead,
  asyncHandler(async (req, res) => {
    const data = await prisma.schoolClass.findMany({
      where: { schoolId: schoolIdOf(req) },
      orderBy: { level: 'asc' },
      include: {
        streams: {
          orderBy: { name: 'asc' },
          include: {
            classTeacher: { select: { id: true, firstName: true, lastName: true } },
            _count: { select: { enrollments: { where: { isActive: true } } } },
          },
        },
        _count: { select: { enrollments: { where: { isActive: true } } } },
      },
    });
    res.json({ data });
  }),
);

academicsRouter.post(
  '/classes',
  canManage,
  validate(z.object({ name: z.string().min(1).max(50), level: z.number().int().min(1).max(20) })),
  asyncHandler(async (req, res) => {
    const schoolClass = await prisma.schoolClass.create({
      data: { ...req.body, schoolId: schoolIdOf(req) },
    });
    await audit(req, { action: 'class.create', entityType: 'SchoolClass', entityId: schoolClass.id });
    res.status(201).json(schoolClass);
  }),
);

academicsRouter.post(
  '/classes/:classId/streams',
  canManage,
  validate(
    z.object({
      name: z.string().min(1).max(30),
      capacity: z.number().int().min(1).max(200).default(40),
      classTeacherId: z.string().nullish(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const classId = req.params.classId as string;
    const exists = await prisma.schoolClass.findFirst({ where: { id: classId, schoolId } });
    if (!exists) throw notFound('Class');

    const stream = await prisma.stream.create({ data: { ...req.body, classId } });
    res.status(201).json(stream);
  }),
);

academicsRouter.patch(
  '/streams/:id',
  canManage,
  validate(
    z.object({
      name: z.string().min(1).max(30).optional(),
      capacity: z.number().int().min(1).max(200).optional(),
      classTeacherId: z.string().nullish(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const id = req.params.id as string;
    const stream = await prisma.stream.findFirst({ where: { id, schoolClass: { schoolId } } });
    if (!stream) throw notFound('Stream');

    res.json(await prisma.stream.update({ where: { id }, data: req.body }));
  }),
);

// --- Subjects ---------------------------------------------------------------

academicsRouter.get(
  '/subjects',
  canRead,
  asyncHandler(async (req, res) => {
    const data = await prisma.subject.findMany({
      where: { schoolId: schoolIdOf(req) },
      orderBy: { name: 'asc' },
      include: { department: { select: { id: true, name: true } } },
    });
    res.json({ data });
  }),
);

academicsRouter.post(
  '/subjects',
  canManage,
  validate(
    z.object({
      name: z.string().min(2).max(80),
      code: z.string().min(2).max(20).transform((v) => v.toUpperCase()),
      departmentId: z.string().nullish(),
      isCore: z.boolean().default(true),
      passMark: z.number().int().min(0).max(100).default(40),
    }),
  ),
  asyncHandler(async (req, res) => {
    const subject = await prisma.subject.create({
      data: { ...req.body, schoolId: schoolIdOf(req) },
    });
    await audit(req, { action: 'subject.create', entityType: 'Subject', entityId: subject.id });
    res.status(201).json(subject);
  }),
);

/** Attach a subject to a class and (optionally) assign the teacher. */
academicsRouter.post(
  '/classes/:classId/subjects',
  canManage,
  validate(z.object({ subjectId: z.string().min(1), teacherId: z.string().nullish() })),
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const classId = req.params.classId as string;

    const [schoolClass, subject] = await Promise.all([
      prisma.schoolClass.findFirst({ where: { id: classId, schoolId } }),
      prisma.subject.findFirst({ where: { id: req.body.subjectId, schoolId } }),
    ]);
    if (!schoolClass) throw notFound('Class');
    if (!subject) throw notFound('Subject');

    const link = await prisma.classSubject.upsert({
      where: { classId_subjectId: { classId, subjectId: req.body.subjectId } },
      create: { classId, subjectId: req.body.subjectId, teacherId: req.body.teacherId ?? null },
      update: { teacherId: req.body.teacherId ?? null },
      include: {
        subject: true,
        teacher: { select: { id: true, firstName: true, lastName: true } },
      },
    });
    res.status(201).json(link);
  }),
);

academicsRouter.get(
  '/classes/:classId/subjects',
  canRead,
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const data = await prisma.classSubject.findMany({
      where: { classId: req.params.classId as string, schoolClass: { schoolId } },
      include: {
        subject: true,
        teacher: { select: { id: true, firstName: true, lastName: true } },
      },
    });
    res.json({ data });
  }),
);

// --- Grading scales ---------------------------------------------------------

academicsRouter.get(
  '/grade-scales',
  canRead,
  asyncHandler(async (req, res) => {
    const data = await prisma.gradeScale.findMany({
      where: { schoolId: schoolIdOf(req) },
      include: { bands: { orderBy: { minScore: 'desc' } } },
    });
    res.json({ data });
  }),
);

const gradeScaleSchema = z.object({
  name: z.string().min(2).max(60),
  isDefault: z.boolean().default(false),
  bands: z
    .array(
      z.object({
        grade: z.string().min(1).max(5),
        minScore: z.number().min(0).max(100),
        maxScore: z.number().min(0).max(100),
        points: z.number().min(0).max(10).default(0),
        remark: z.string().max(60).optional(),
      }),
    )
    .min(1),
});

academicsRouter.post(
  '/grade-scales',
  canManage,
  validate(gradeScaleSchema),
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const body = req.body as z.infer<typeof gradeScaleSchema>;

    for (const band of body.bands) {
      if (band.minScore > band.maxScore) {
        throw badRequest(`Grade ${band.grade}: minScore cannot exceed maxScore`);
      }
    }

    const scale = await prisma.$transaction(async (tx) => {
      if (body.isDefault) {
        await tx.gradeScale.updateMany({ where: { schoolId }, data: { isDefault: false } });
      }
      return tx.gradeScale.create({
        data: {
          schoolId,
          name: body.name,
          isDefault: body.isDefault,
          bands: { create: body.bands },
        },
        include: { bands: true },
      });
    });

    await audit(req, { action: 'grade_scale.create', entityType: 'GradeScale', entityId: scale.id });
    res.status(201).json(scale);
  }),
);

// --- Timetable (Module 7) ---------------------------------------------------

academicsRouter.get(
  '/timetable',
  canRead,
  validate(
    z.object({
      classId: z.string().optional(),
      streamId: z.string().optional(),
      teacherId: z.string().optional(),
      academicYearId: z.string().optional(),
    }),
    'query',
  ),
  asyncHandler(async (req, res) => {
    const q = req.query as { classId?: string; streamId?: string; teacherId?: string; academicYearId?: string };
    const data = await prisma.timetableSlot.findMany({
      where: {
        schoolId: schoolIdOf(req),
        ...(q.classId ? { classId: q.classId } : {}),
        ...(q.streamId ? { streamId: q.streamId } : {}),
        ...(q.teacherId ? { teacherId: q.teacherId } : {}),
        ...(q.academicYearId ? { academicYearId: q.academicYearId } : {}),
      },
      orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }],
      include: {
        subject: { select: { id: true, name: true, code: true } },
        teacher: { select: { id: true, firstName: true, lastName: true } },
        schoolClass: { select: { id: true, name: true } },
        stream: { select: { id: true, name: true } },
      },
    });
    res.json({ data });
  }),
);

const timeString = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:mm');

const slotSchema = z
  .object({
    academicYearId: z.string().min(1),
    classId: z.string().min(1),
    streamId: z.string().nullish(),
    subjectId: z.string().min(1),
    teacherId: z.string().nullish(),
    dayOfWeek: z.number().int().min(1).max(7),
    startTime: timeString,
    endTime: timeString,
    room: z.string().max(40).nullish(),
  })
  .refine((v) => v.endTime > v.startTime, {
    message: 'endTime must be after startTime',
    path: ['endTime'],
  });

academicsRouter.post(
  '/timetable',
  canManage,
  validate(slotSchema),
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const body = req.body as z.infer<typeof slotSchema>;

    // A teacher cannot be in two rooms at once — reject overlapping slots.
    if (body.teacherId) {
      const clash = await prisma.timetableSlot.findFirst({
        where: {
          schoolId,
          teacherId: body.teacherId,
          dayOfWeek: body.dayOfWeek,
          academicYearId: body.academicYearId,
          startTime: { lt: body.endTime },
          endTime: { gt: body.startTime },
        },
        include: { schoolClass: { select: { name: true } } },
      });
      if (clash) {
        throw badRequest(
          `Teacher already has a lesson for ${clash.schoolClass.name} at ${clash.startTime}-${clash.endTime}`,
        );
      }
    }

    const slot = await prisma.timetableSlot.create({ data: { ...body, schoolId } });
    res.status(201).json(slot);
  }),
);

academicsRouter.delete(
  '/timetable/:id',
  canManage,
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const id = req.params.id as string;
    const slot = await prisma.timetableSlot.findFirst({ where: { id, schoolId } });
    if (!slot) throw notFound('Timetable slot');
    await prisma.timetableSlot.delete({ where: { id } });
    res.status(204).send();
  }),
);

// --- Assignments / homework (Module 7) --------------------------------------

academicsRouter.get(
  '/assignments',
  canRead,
  validate(
    z.object({ classId: z.string().optional(), subjectId: z.string().optional() }),
    'query',
  ),
  asyncHandler(async (req, res) => {
    const q = req.query as { classId?: string; subjectId?: string };
    const data = await prisma.assignment.findMany({
      where: {
        schoolId: schoolIdOf(req),
        ...(q.classId ? { classId: q.classId } : {}),
        ...(q.subjectId ? { subjectId: q.subjectId } : {}),
      },
      orderBy: { dueDate: 'desc' },
      include: {
        subject: { select: { name: true, code: true } },
        schoolClass: { select: { name: true } },
        teacher: { select: { firstName: true, lastName: true } },
        _count: { select: { submissions: true } },
      },
    });
    res.json({ data });
  }),
);

academicsRouter.post(
  '/assignments',
  requirePermission('academics:manage', 'exams:enter_marks'),
  validate(
    z.object({
      classId: z.string().min(1),
      streamId: z.string().nullish(),
      subjectId: z.string().min(1),
      title: z.string().min(2).max(200),
      instructions: z.string().max(5000).nullish(),
      attachmentUrl: z.string().url().nullish(),
      maxScore: z.number().min(1).max(1000).default(100),
      dueDate: z.coerce.date(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const assignment = await prisma.assignment.create({
      data: {
        ...req.body,
        schoolId: schoolIdOf(req),
        teacherId: req.user?.staffId ?? null,
      },
    });
    await audit(req, { action: 'assignment.create', entityType: 'Assignment', entityId: assignment.id });
    res.status(201).json(assignment);
  }),
);
