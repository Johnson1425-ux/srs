import { Router } from 'express';
import {
  AttendanceStatus,
  EmploymentStatus,
  ExamStatus,
  InvoiceStatus,
  PaymentStatus,
  StaffType,
  StudentStatus,
} from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { asyncHandler, validate } from '../../lib/http.js';
import { schoolIdOf } from '../../middleware/auth.js';

/** Module 2 — Dashboard widgets. */
export const dashboardRouter: Router = Router();

function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

dashboardRouter.get(
  '/',
  validate(z.object({ date: z.coerce.date().optional() }), 'query'),
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const today = startOfDay((req.query as { date?: Date }).date ?? new Date());
    const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));

    const [
      totalStudents,
      teacherCount,
      nonTeachingCount,
      attendanceToday,
      collectedThisMonth,
      outstanding,
      upcomingExams,
      recentPayments,
      announcements,
      newAdmissions,
    ] = await Promise.all([
      prisma.student.count({ where: { schoolId, status: StudentStatus.ACTIVE } }),
      prisma.staff.count({
        where: { schoolId, staffType: StaffType.TEACHING, employmentStatus: EmploymentStatus.ACTIVE },
      }),
      prisma.staff.count({
        where: {
          schoolId,
          staffType: StaffType.NON_TEACHING,
          employmentStatus: EmploymentStatus.ACTIVE,
        },
      }),
      prisma.attendanceRecord.groupBy({
        by: ['status'],
        where: { schoolId, date: today },
        _count: { _all: true },
      }),
      prisma.payment.aggregate({
        where: { schoolId, status: PaymentStatus.CONFIRMED, paidAt: { gte: monthStart } },
        _sum: { amount: true },
        _count: true,
      }),
      prisma.invoice.aggregate({
        where: {
          schoolId,
          status: { in: [InvoiceStatus.ISSUED, InvoiceStatus.PARTIALLY_PAID] },
          balance: { gt: 0 },
        },
        _sum: { balance: true },
        _count: true,
      }),
      prisma.exam.findMany({
        where: {
          schoolId,
          status: { not: ExamStatus.PUBLISHED },
          startDate: { gte: today },
        },
        orderBy: { startDate: 'asc' },
        take: 5,
        select: {
          id: true,
          name: true,
          examType: true,
          startDate: true,
          schoolClass: { select: { name: true } },
        },
      }),
      prisma.payment.findMany({
        where: { schoolId, status: PaymentStatus.CONFIRMED },
        orderBy: { paidAt: 'desc' },
        take: 5,
        select: {
          id: true,
          receiptNumber: true,
          amount: true,
          method: true,
          paidAt: true,
          student: { select: { firstName: true, lastName: true, admissionNumber: true } },
        },
      }),
      prisma.announcement.findMany({
        where: { schoolId, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
        orderBy: [{ isPinned: 'desc' }, { publishedAt: 'desc' }],
        take: 5,
        select: { id: true, title: true, body: true, publishedAt: true, isPinned: true },
      }),
      prisma.student.count({ where: { schoolId, admissionDate: { gte: monthStart } } }),
    ]);

    const attendanceCounts = Object.fromEntries(
      attendanceToday.map((a) => [a.status, a._count._all]),
    ) as Partial<Record<AttendanceStatus, number>>;
    const marked = Object.values(attendanceCounts).reduce<number>((a, b) => a + (b ?? 0), 0);
    const present = (attendanceCounts.PRESENT ?? 0) + (attendanceCounts.LATE ?? 0);

    res.json({
      date: today,
      widgets: {
        totalStudents,
        totalTeachers: teacherCount,
        totalStaff: teacherCount + nonTeachingCount,
        newAdmissionsThisMonth: newAdmissions,
        feeCollection: {
          thisMonth: collectedThisMonth._sum.amount?.toString() ?? '0',
          paymentCount: collectedThisMonth._count,
        },
        outstandingFees: {
          total: outstanding._sum.balance?.toString() ?? '0',
          invoiceCount: outstanding._count,
        },
        attendanceToday: {
          marked,
          notMarked: Math.max(totalStudents - marked, 0),
          present: attendanceCounts.PRESENT ?? 0,
          absent: attendanceCounts.ABSENT ?? 0,
          late: attendanceCounts.LATE ?? 0,
          rate: marked ? Number(((present / marked) * 100).toFixed(1)) : null,
        },
      },
      upcomingExams,
      recentPayments,
      announcements,
    });
  }),
);

/** Enrolment split by class, for the dashboard charts. */
dashboardRouter.get(
  '/enrollment-by-class',
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const classes = await prisma.schoolClass.findMany({
      where: { schoolId },
      orderBy: { level: 'asc' },
      select: {
        id: true,
        name: true,
        _count: { select: { enrollments: { where: { isActive: true } } } },
      },
    });

    const genderSplit = await prisma.student.groupBy({
      by: ['gender'],
      where: { schoolId, status: StudentStatus.ACTIVE },
      _count: { _all: true },
    });

    res.json({
      byClass: classes.map((c) => ({ id: c.id, name: c.name, students: c._count.enrollments })),
      byGender: Object.fromEntries(genderSplit.map((g) => [g.gender, g._count._all])),
    });
  }),
);

/** Fee collection trend for the last 6 months. */
dashboardRouter.get(
  '/collection-trend',
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const since = new Date();
    since.setUTCMonth(since.getUTCMonth() - 5, 1);
    since.setUTCHours(0, 0, 0, 0);

    const rows = await prisma.$queryRaw<Array<{ month: string; total: string }>>`
      SELECT to_char("paidAt", 'YYYY-MM') AS month, SUM(amount)::text AS total
      FROM "Payment"
      WHERE "schoolId" = ${schoolId}
        AND status = 'CONFIRMED'
        AND "paidAt" >= ${since}
      GROUP BY 1
      ORDER BY 1 ASC
    `;

    res.json({ data: rows });
  }),
);
