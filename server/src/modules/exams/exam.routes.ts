import { Router } from 'express';
import { ExamStatus, ExamType, MessageChannel, StudentStatus } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { asyncHandler, validate } from '../../lib/http.js';
import { requirePermission, schoolIdOf } from '../../middleware/auth.js';
import { audit } from '../../lib/audit.js';
import { badRequest, notFound } from '../../lib/errors.js';
import * as service from './exam.service.js';
import { buildResultNotices } from './exam.service.js';
import { queueMessages, smsSegments } from '../communication/message.service.js';
import { smsConfigured } from '../../config/env.js';

/** Module 9 — Examinations. */
export const examRouter: Router = Router();

examRouter.get(
  '/',
  requirePermission('exams:read'),
  validate(
    z.object({
      academicYearId: z.string().optional(),
      termId: z.string().optional(),
      classId: z.string().optional(),
      status: z.nativeEnum(ExamStatus).optional(),
    }),
    'query',
  ),
  asyncHandler(async (req, res) => {
    const q = req.query as {
      academicYearId?: string;
      termId?: string;
      classId?: string;
      status?: ExamStatus;
    };
    const data = await prisma.exam.findMany({
      where: {
        schoolId: schoolIdOf(req),
        ...(q.academicYearId ? { academicYearId: q.academicYearId } : {}),
        ...(q.termId ? { termId: q.termId } : {}),
        ...(q.classId ? { classId: q.classId } : {}),
        ...(q.status ? { status: q.status } : {}),
      },
      orderBy: { createdAt: 'desc' },
      include: {
        schoolClass: { select: { id: true, name: true } },
        term: { select: { id: true, name: true } },
        academicYear: { select: { id: true, name: true } },
        examSubjects: { include: { subject: { select: { name: true, code: true } } } },
      },
    });
    res.json({ data });
  }),
);

const examSchema = z.object({
  academicYearId: z.string().min(1),
  termId: z.string().nullish(),
  classId: z.string().nullish(),
  gradeScaleId: z.string().nullish(),
  name: z.string().min(2).max(120),
  examType: z.nativeEnum(ExamType),
  weight: z.number().min(0).max(100).default(100),
  startDate: z.coerce.date().nullish(),
  endDate: z.coerce.date().nullish(),
  subjects: z
    .array(
      z.object({
        subjectId: z.string().min(1),
        maxScore: z.number().min(1).max(1000).default(100),
        examDate: z.coerce.date().nullish(),
      }),
    )
    .min(1, 'An exam needs at least one subject'),
});

examRouter.post(
  '/',
  requirePermission('exams:manage'),
  validate(examSchema),
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const { subjects, ...body } = req.body as z.infer<typeof examSchema>;

    const year = await prisma.academicYear.findFirst({
      where: { id: body.academicYearId, schoolId },
    });
    if (!year) throw notFound('Academic year');

    const subjectIds = subjects.map((s) => s.subjectId);
    const owned = await prisma.subject.count({ where: { schoolId, id: { in: subjectIds } } });
    if (owned !== new Set(subjectIds).size) {
      throw badRequest('One or more subjects do not belong to this school');
    }

    const exam = await prisma.exam.create({
      data: {
        ...body,
        schoolId,
        examSubjects: { create: subjects },
      },
      include: { examSubjects: { include: { subject: true } } },
    });

    await audit(req, { action: 'exam.create', entityType: 'Exam', entityId: exam.id });
    res.status(201).json(exam);
  }),
);

examRouter.get(
  '/:id',
  requirePermission('exams:read'),
  asyncHandler(async (req, res) => {
    const exam = await prisma.exam.findFirst({
      where: { id: req.params.id as string, schoolId: schoolIdOf(req) },
      include: {
        examSubjects: { include: { subject: true, _count: { select: { results: true } } } },
        schoolClass: true,
        term: true,
        academicYear: true,
        gradeScale: { include: { bands: { orderBy: { minScore: 'desc' } } } },
      },
    });
    if (!exam) throw notFound('Exam');
    res.json(exam);
  }),
);

/** Marks entry sheet: the class list with any marks already recorded. */
examRouter.get(
  '/subjects/:examSubjectId/marks',
  requirePermission('exams:read', 'exams:enter_marks'),
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const examSubjectId = req.params.examSubjectId as string;

    const examSubject = await prisma.examSubject.findFirst({
      where: { id: examSubjectId, exam: { schoolId } },
      include: { exam: true, subject: true },
    });
    if (!examSubject) throw notFound('Exam subject');

    const students = await prisma.student.findMany({
      where: {
        schoolId,
        status: StudentStatus.ACTIVE,
        ...(examSubject.exam.classId
          ? { enrollments: { some: { isActive: true, classId: examSubject.exam.classId } } }
          : {}),
      },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      select: { id: true, admissionNumber: true, firstName: true, lastName: true },
    });

    const results = await prisma.examResult.findMany({ where: { examSubjectId } });
    const byStudent = new Map(results.map((r) => [r.studentId, r]));

    res.json({
      exam: { id: examSubject.exam.id, name: examSubject.exam.name, status: examSubject.exam.status },
      subject: examSubject.subject,
      maxScore: examSubject.maxScore,
      data: students.map((s) => ({
        ...s,
        result: byStudent.get(s.id) ?? null,
      })),
    });
  }),
);

examRouter.post(
  '/subjects/:examSubjectId/marks',
  requirePermission('exams:enter_marks'),
  validate(
    z.object({
      entries: z
        .array(
          z.object({
            studentId: z.string().min(1),
            score: z.number().min(0).nullish(),
            isAbsent: z.boolean().default(false),
            remark: z.string().max(200).nullish(),
          }),
        )
        .min(1)
        .max(500),
    }),
  ),
  asyncHandler(async (req, res) => {
    const result = await service.enterMarks(
      schoolIdOf(req),
      req.params.examSubjectId as string,
      req.body.entries,
      req.user?.id ?? null,
    );
    await audit(req, {
      action: 'exam.marks_entry',
      entityType: 'ExamSubject',
      entityId: req.params.examSubjectId as string,
      metadata: { count: result.saved },
    });
    res.json(result);
  }),
);

examRouter.post(
  '/:id/publish',
  requirePermission('exams:publish'),
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const id = req.params.id as string;

    const exam = await prisma.exam.findFirst({
      where: { id, schoolId },
      include: { _count: { select: { results: true } } },
    });
    if (!exam) throw notFound('Exam');
    if (exam._count.results === 0) throw badRequest('Cannot publish an exam with no marks entered');

    const updated = await prisma.exam.update({
      where: { id },
      data: { status: ExamStatus.PUBLISHED, publishedAt: new Date() },
    });
    await audit(req, { action: 'exam.publish', entityType: 'Exam', entityId: id });

    // Publishing only makes results visible in the portal. Most parents never
    // sign in, so telling them is a separate, deliberate step — it costs the
    // school SMS credit, and the school decides when to spend it.
    let notified: { queued: number; withoutContact: string[] } | null = null;
    if ((req.body as { notifyGuardians?: boolean }).notifyGuardians) {
      const { notices, withoutContact } = await buildResultNotices(schoolId, id);
      const { queued } = await queueMessages(
        schoolId,
        notices.map((n) => ({
          channel: MessageChannel.SMS,
          recipient: n.phone,
          subject: null,
          body: n.body,
        })),
      );
      await audit(req, {
        action: 'exam.notify_guardians',
        entityType: 'Exam',
        entityId: id,
        metadata: { queued, missed: withoutContact.length },
      });
      notified = { queued, withoutContact };
    }

    res.json({ ...updated, notified });
  }),
);

/**
 * What notifying parents would cost, before committing to it.
 *
 * Shown on the publish dialog so the office sees how many messages it is about
 * to send, roughly what they will be billed as, and which families have no
 * telephone number on file and will have to be told another way.
 */
examRouter.get(
  '/:id/notify-preview',
  requirePermission('exams:publish'),
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const id = req.params.id as string;

    const { notices, withoutContact } = await buildResultNotices(schoolId, id);
    const sample = notices[0]?.body ?? null;

    res.json({
      recipients: notices.length,
      withoutContact,
      sample,
      // Gateways bill per 160-character segment, and a long school or student
      // name can quietly push a message into a second one.
      segments: notices.reduce((total, n) => total + smsSegments(n.body), 0),
      configured: smsConfigured,
    });
  }),
);

examRouter.post(
  '/:id/unpublish',
  requirePermission('exams:publish'),
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const id = req.params.id as string;
    const exam = await prisma.exam.findFirst({ where: { id, schoolId } });
    if (!exam) throw notFound('Exam');

    const updated = await prisma.exam.update({
      where: { id },
      data: { status: ExamStatus.MARKS_ENTRY, publishedAt: null },
    });
    await audit(req, { action: 'exam.unpublish', entityType: 'Exam', entityId: id });
    res.json(updated);
  }),
);

/** Results and report cards — mounted at /results per PRD section 9. */
export const resultRouter: Router = Router();

resultRouter.get(
  '/exam/:examId',
  requirePermission('exams:read'),
  asyncHandler(async (req, res) => {
    res.json(await service.buildResultSheet(schoolIdOf(req), req.params.examId as string));
  }),
);

resultRouter.get(
  '/exam/:examId/report-card/:studentId',
  requirePermission('exams:read'),
  asyncHandler(async (req, res) => {
    res.json(
      await service.reportCard(
        schoolIdOf(req),
        req.params.examId as string,
        req.params.studentId as string,
      ),
    );
  }),
);

resultRouter.get(
  '/transcript/:studentId',
  requirePermission('exams:read'),
  asyncHandler(async (req, res) => {
    res.json(await service.transcript(schoolIdOf(req), req.params.studentId as string));
  }),
);
