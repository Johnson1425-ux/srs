import { Router } from 'express';
import type { RequestHandler } from 'express';
import { ExamStatus, Role } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { asyncHandler, validate } from '../../lib/http.js';
import { schoolIdOf } from '../../middleware/auth.js';
import { forbidden, notFound } from '../../lib/errors.js';
import { studentBalance } from '../fees/fee.service.js';
import { transcript } from '../exams/exam.service.js';

/**
 * Modules 19, 20 and 21 — parent, student and teacher portals.
 *
 * Every route here resolves the caller's own scope: a parent can only ever
 * reach the children linked to their guardian record, a student only their own
 * data. That check lives in `resolveStudentAccess` rather than in permissions,
 * because these roles hold no school-wide permissions at all.
 */
export const portalRouter: Router = Router();

/** Student IDs the caller is allowed to see. */
async function accessibleStudentIds(req: Parameters<RequestHandler>[0]): Promise<string[]> {
  const user = req.user!;

  if (user.role === Role.STUDENT) {
    return user.studentId ? [user.studentId] : [];
  }
  if (user.role === Role.PARENT) {
    if (!user.guardianId) return [];
    const links = await prisma.studentGuardian.findMany({
      where: { guardianId: user.guardianId },
      select: { studentId: true },
    });
    return links.map((l) => l.studentId);
  }
  // Staff roles use the main API; the portal is for families.
  throw forbidden('This portal is available to students and parents');
}

async function assertAccess(req: Parameters<RequestHandler>[0], studentId: string): Promise<void> {
  const allowed = await accessibleStudentIds(req);
  if (!allowed.includes(studentId)) throw forbidden('You do not have access to this student');
}

/** The children (or self) this portal user can switch between. */
portalRouter.get(
  '/children',
  asyncHandler(async (req, res) => {
    const ids = await accessibleStudentIds(req);
    const data = await prisma.student.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        admissionNumber: true,
        firstName: true,
        middleName: true,
        lastName: true,
        photoUrl: true,
        status: true,
        enrollments: {
          where: { isActive: true },
          select: {
            schoolClass: { select: { id: true, name: true } },
            stream: { select: { id: true, name: true } },
            academicYear: { select: { name: true } },
          },
        },
      },
    });
    res.json({ data });
  }),
);

portalRouter.get(
  '/students/:studentId/overview',
  asyncHandler(async (req, res) => {
    const studentId = req.params.studentId as string;
    await assertAccess(req, studentId);
    const schoolId = schoolIdOf(req);

    const [student, attendance, balance, upcomingHomework] = await Promise.all([
      prisma.student.findFirst({
        where: { id: studentId, schoolId },
        select: {
          id: true,
          admissionNumber: true,
          firstName: true,
          lastName: true,
          photoUrl: true,
          enrollments: {
            where: { isActive: true },
            select: { schoolClass: { select: { id: true, name: true } }, stream: { select: { id: true, name: true } } },
          },
        },
      }),
      prisma.attendanceRecord.groupBy({
        by: ['status'],
        where: { studentId },
        _count: { _all: true },
      }),
      studentBalance(schoolId, studentId),
      prisma.assignment.findMany({
        where: {
          schoolId,
          dueDate: { gte: new Date() },
          schoolClass: { enrollments: { some: { studentId, isActive: true } } },
        },
        orderBy: { dueDate: 'asc' },
        take: 5,
        include: { subject: { select: { name: true } } },
      }),
    ]);

    if (!student) throw notFound('Student');

    const counts = Object.fromEntries(attendance.map((a) => [a.status, a._count._all]));
    const totalDays = Object.values(counts).reduce<number>((a, b) => a + (b as number), 0);
    const present = ((counts.PRESENT as number) ?? 0) + ((counts.LATE as number) ?? 0);

    res.json({
      student,
      attendance: {
        ...counts,
        totalDays,
        rate: totalDays ? Number(((present / totalDays) * 100).toFixed(1)) : null,
      },
      fees: balance.summary,
      upcomingHomework,
    });
  }),
);

portalRouter.get(
  '/students/:studentId/attendance',
  validate(z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() }), 'query'),
  asyncHandler(async (req, res) => {
    const studentId = req.params.studentId as string;
    await assertAccess(req, studentId);
    const { from, to } = req.query as unknown as { from?: Date; to?: Date };

    const data = await prisma.attendanceRecord.findMany({
      where: {
        studentId,
        schoolId: schoolIdOf(req),
        ...(from || to ? { date: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
      },
      orderBy: { date: 'desc' },
      take: 120,
    });
    res.json({ data });
  }),
);

/** Only published results are visible to families. */
portalRouter.get(
  '/students/:studentId/results',
  asyncHandler(async (req, res) => {
    const studentId = req.params.studentId as string;
    await assertAccess(req, studentId);
    res.json(await transcript(schoolIdOf(req), studentId));
  }),
);

portalRouter.get(
  '/students/:studentId/fees',
  asyncHandler(async (req, res) => {
    const studentId = req.params.studentId as string;
    await assertAccess(req, studentId);
    res.json(await studentBalance(schoolIdOf(req), studentId));
  }),
);

portalRouter.get(
  '/students/:studentId/homework',
  asyncHandler(async (req, res) => {
    const studentId = req.params.studentId as string;
    await assertAccess(req, studentId);

    const data = await prisma.assignment.findMany({
      where: {
        schoolId: schoolIdOf(req),
        schoolClass: { enrollments: { some: { studentId, isActive: true } } },
      },
      orderBy: { dueDate: 'desc' },
      take: 50,
      include: {
        subject: { select: { name: true, code: true } },
        teacher: { select: { firstName: true, lastName: true } },
        submissions: { where: { studentId } },
      },
    });
    res.json({ data });
  }),
);

portalRouter.get(
  '/students/:studentId/timetable',
  asyncHandler(async (req, res) => {
    const studentId = req.params.studentId as string;
    await assertAccess(req, studentId);

    const enrollment = await prisma.enrollment.findFirst({
      where: { studentId, isActive: true },
      select: { classId: true, streamId: true, academicYearId: true },
    });
    if (!enrollment) return res.json({ data: [] });

    const data = await prisma.timetableSlot.findMany({
      where: {
        schoolId: schoolIdOf(req),
        classId: enrollment.classId,
        academicYearId: enrollment.academicYearId,
        ...(enrollment.streamId ? { OR: [{ streamId: enrollment.streamId }, { streamId: null }] } : {}),
      },
      orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }],
      include: {
        subject: { select: { name: true, code: true } },
        teacher: { select: { firstName: true, lastName: true } },
      },
    });
    return res.json({ data });
  }),
);

/** Report card for one published exam. */
portalRouter.get(
  '/students/:studentId/report-card/:examId',
  asyncHandler(async (req, res) => {
    const studentId = req.params.studentId as string;
    const examId = req.params.examId as string;
    await assertAccess(req, studentId);
    const schoolId = schoolIdOf(req);

    const exam = await prisma.exam.findFirst({ where: { id: examId, schoolId } });
    if (!exam) throw notFound('Exam');
    if (exam.status !== ExamStatus.PUBLISHED) {
      throw forbidden('Results for this exam have not been published yet');
    }

    const { reportCard } = await import('../exams/exam.service.js');
    res.json(await reportCard(schoolId, examId, studentId));
  }),
);

/** Submit homework from the student portal. */
portalRouter.post(
  '/students/:studentId/homework/:assignmentId/submit',
  validate(
    z.object({
      content: z.string().max(5000).nullish(),
      attachmentUrl: z.string().url().nullish(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const studentId = req.params.studentId as string;
    const assignmentId = req.params.assignmentId as string;

    if (req.user!.role !== Role.STUDENT) throw forbidden('Only students can submit homework');
    await assertAccess(req, studentId);

    const assignment = await prisma.assignment.findFirst({
      where: { id: assignmentId, schoolId: schoolIdOf(req) },
    });
    if (!assignment) throw notFound('Assignment');

    const submission = await prisma.assignmentSubmission.upsert({
      where: { assignmentId_studentId: { assignmentId, studentId } },
      create: { assignmentId, studentId, ...req.body },
      update: { ...req.body, submittedAt: new Date() },
    });
    res.status(201).json(submission);
  }),
);
