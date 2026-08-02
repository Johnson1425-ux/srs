import { Router } from 'express';
import { AttendanceStatus, MessageChannel, StudentStatus } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { asyncHandler, validate } from '../../lib/http.js';
import { requirePermission, schoolIdOf } from '../../middleware/auth.js';
import { audit } from '../../lib/audit.js';
import { badRequest } from '../../lib/errors.js';
import { normalizePhone, queueMessages, renderTemplate } from '../communication/message.service.js';

/** Module 8 — Attendance. */
export const attendanceRouter: Router = Router();

/** Class register for a given day, pre-filled with anything already marked. */
attendanceRouter.get(
  '/register',
  requirePermission('attendance:read'),
  validate(
    z.object({
      date: z.coerce.date(),
      classId: z.string().optional(),
      streamId: z.string().optional(),
    }),
    'query',
  ),
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const { date, classId, streamId } = req.query as unknown as {
      date: Date;
      classId?: string;
      streamId?: string;
    };
    if (!classId && !streamId) throw badRequest('Provide classId or streamId');

    const students = await prisma.student.findMany({
      where: {
        schoolId,
        status: StudentStatus.ACTIVE,
        enrollments: {
          some: {
            isActive: true,
            ...(classId ? { classId } : {}),
            ...(streamId ? { streamId } : {}),
          },
        },
      },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      select: {
        id: true,
        admissionNumber: true,
        firstName: true,
        middleName: true,
        lastName: true,
        photoUrl: true,
      },
    });

    const marks = await prisma.attendanceRecord.findMany({
      where: { schoolId, date, studentId: { in: students.map((s) => s.id) } },
    });
    const byStudent = new Map(marks.map((m) => [m.studentId, m]));

    res.json({
      date,
      total: students.length,
      data: students.map((s) => ({ ...s, attendance: byStudent.get(s.id) ?? null })),
    });
  }),
);

const markSchema = z.object({
  date: z.coerce.date(),
  streamId: z.string().nullish(),
  notifyGuardians: z.boolean().default(false),
  records: z
    .array(
      z.object({
        studentId: z.string().min(1),
        status: z.nativeEnum(AttendanceStatus),
        arrivalTime: z
          .string()
          .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:mm')
          .nullish(),
        note: z.string().max(200).nullish(),
      }),
    )
    .min(1)
    .max(500),
});

attendanceRouter.post(
  '/',
  requirePermission('attendance:record'),
  validate(markSchema),
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const { date, streamId, records, notifyGuardians } = req.body as z.infer<typeof markSchema>;

    const studentIds = [...new Set(records.map((r) => r.studentId))];
    const owned = await prisma.student.count({
      where: { schoolId, id: { in: studentIds } },
    });
    if (owned !== studentIds.length) {
      throw badRequest('One or more students do not belong to this school');
    }

    await prisma.$transaction(
      records.map((r) =>
        prisma.attendanceRecord.upsert({
          where: { studentId_date: { studentId: r.studentId, date } },
          create: {
            schoolId,
            studentId: r.studentId,
            streamId: streamId ?? null,
            date,
            status: r.status,
            arrivalTime: r.arrivalTime ?? null,
            note: r.note ?? null,
            recordedById: req.user?.staffId ?? null,
          },
          update: {
            status: r.status,
            arrivalTime: r.arrivalTime ?? null,
            note: r.note ?? null,
            recordedById: req.user?.staffId ?? null,
          },
        }),
      ),
    );

    // Absentee SMS to guardians (PRD Module 8 — SMS notifications).
    let notified = 0;
    if (notifyGuardians) {
      const absentIds = records
        .filter((r) => r.status === AttendanceStatus.ABSENT)
        .map((r) => r.studentId);

      if (absentIds.length > 0) {
        const links = await prisma.studentGuardian.findMany({
          where: { studentId: { in: absentIds } },
          include: {
            guardian: { select: { phone: true, firstName: true } },
            student: { select: { firstName: true, lastName: true } },
          },
        });

        const school = await prisma.school.findUniqueOrThrow({
          where: { id: schoolId },
          select: { name: true },
        });

        const template =
          'Dear {{guardianName}}, your child {{studentName}} was marked absent at {{schoolName}} on {{date}}. Please contact the school office.';

        const outbound = links
          .filter((l) => l.guardian.phone)
          .map((l) => ({
            channel: MessageChannel.SMS,
            recipient: normalizePhone(l.guardian.phone),
            body: renderTemplate(template, {
              guardianName: l.guardian.firstName,
              studentName: `${l.student.firstName} ${l.student.lastName}`,
              schoolName: school.name,
              date: date.toISOString().slice(0, 10),
            }),
          }));

        const result = await queueMessages(schoolId, outbound);
        notified = result.queued;
      }
    }

    await audit(req, {
      action: 'attendance.record',
      metadata: { date: date.toISOString().slice(0, 10), count: records.length, streamId },
    });

    res.json({ recorded: records.length, guardiansNotified: notified });
  }),
);

/** Per-student attendance history with a summary. */
attendanceRouter.get(
  '/student/:studentId',
  requirePermission('attendance:read'),
  validate(
    z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() }),
    'query',
  ),
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const { from, to } = req.query as unknown as { from?: Date; to?: Date };

    const records = await prisma.attendanceRecord.findMany({
      where: {
        schoolId,
        studentId: req.params.studentId as string,
        ...(from || to ? { date: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
      },
      orderBy: { date: 'desc' },
    });

    const summary = records.reduce<Record<string, number>>((acc, r) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1;
      return acc;
    }, {});
    const present = (summary.PRESENT ?? 0) + (summary.LATE ?? 0);

    res.json({
      data: records,
      summary: {
        ...summary,
        totalDays: records.length,
        attendanceRate: records.length ? Number(((present / records.length) * 100).toFixed(1)) : 0,
      },
    });
  }),
);

/** Daily absentee and late-arrival list (Module 8 reports). */
attendanceRouter.get(
  '/exceptions',
  requirePermission('attendance:read'),
  validate(z.object({ date: z.coerce.date() }), 'query'),
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const { date } = req.query as unknown as { date: Date };

    const records = await prisma.attendanceRecord.findMany({
      where: {
        schoolId,
        date,
        status: { in: [AttendanceStatus.ABSENT, AttendanceStatus.LATE, AttendanceStatus.SICK] },
      },
      include: {
        student: {
          select: {
            id: true,
            admissionNumber: true,
            firstName: true,
            lastName: true,
            enrollments: {
              where: { isActive: true },
              select: { schoolClass: { select: { name: true } }, stream: { select: { name: true } } },
            },
          },
        },
      },
      orderBy: { status: 'asc' },
    });

    res.json({
      date,
      absent: records.filter((r) => r.status === AttendanceStatus.ABSENT),
      late: records.filter((r) => r.status === AttendanceStatus.LATE),
      sick: records.filter((r) => r.status === AttendanceStatus.SICK),
    });
  }),
);

/** Attendance rate per class over a period, for the reports module. */
attendanceRouter.get(
  '/summary',
  requirePermission('attendance:read', 'reports:read'),
  validate(z.object({ from: z.coerce.date(), to: z.coerce.date() }), 'query'),
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const { from, to } = req.query as unknown as { from: Date; to: Date };

    const grouped = await prisma.attendanceRecord.groupBy({
      by: ['status'],
      where: { schoolId, date: { gte: from, lte: to } },
      _count: { _all: true },
    });

    const counts = Object.fromEntries(grouped.map((g) => [g.status, g._count._all]));
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const present = (counts.PRESENT ?? 0) + (counts.LATE ?? 0);

    res.json({
      period: { from, to },
      counts,
      total,
      attendanceRate: total ? Number(((present / total) * 100).toFixed(1)) : 0,
    });
  }),
);
