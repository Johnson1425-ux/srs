import { Router } from 'express';
import type { Response } from 'express';
import { InvoiceStatus, PaymentStatus, StudentStatus } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { asyncHandler, validate } from '../../lib/http.js';
import { requirePermission, schoolIdOf } from '../../middleware/auth.js';
import { type Column, csvFilename, toCsv } from '../../lib/csv.js';

/** Module 17 — Reports, with CSV/Excel-compatible export. */
export const reportRouter: Router = Router();

const canRead = requirePermission('reports:read');

/** Returns JSON by default, or a CSV download when `?format=csv`. */
function respond<T>(res: Response, format: string | undefined, name: string, rows: T[], columns: Array<Column<T>>) {
  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${csvFilename(name)}"`);
    res.send(toCsv(rows, columns));
    return;
  }
  res.json({ data: rows, count: rows.length });
}

const formatQuery = z.object({ format: z.enum(['json', 'csv']).default('json') });

// --- Students ---------------------------------------------------------------

reportRouter.get(
  '/students',
  canRead,
  validate(
    formatQuery.extend({ classId: z.string().optional(), status: z.nativeEnum(StudentStatus).optional() }),
    'query',
  ),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as { format: string; classId?: string; status?: StudentStatus };

    const rows = await prisma.student.findMany({
      where: {
        schoolId: schoolIdOf(req),
        status: q.status ?? { not: StudentStatus.ARCHIVED },
        ...(q.classId ? { enrollments: { some: { isActive: true, classId: q.classId } } } : {}),
      },
      orderBy: [{ lastName: 'asc' }],
      include: {
        enrollments: {
          where: { isActive: true },
          include: { schoolClass: true, stream: true },
        },
        guardianLinks: { where: { isPrimary: true }, include: { guardian: true } },
      },
    });

    respond(res, q.format, 'students', rows, [
      { header: 'Admission No', value: (r) => r.admissionNumber },
      { header: 'First Name', value: (r) => r.firstName },
      { header: 'Middle Name', value: (r) => r.middleName },
      { header: 'Last Name', value: (r) => r.lastName },
      { header: 'Gender', value: (r) => r.gender },
      { header: 'Date of Birth', value: (r) => r.dateOfBirth.toISOString().slice(0, 10) },
      { header: 'Class', value: (r) => r.enrollments[0]?.schoolClass.name ?? '' },
      { header: 'Stream', value: (r) => r.enrollments[0]?.stream?.name ?? '' },
      { header: 'Status', value: (r) => r.status },
      {
        header: 'Primary Guardian',
        value: (r) =>
          r.guardianLinks[0]
            ? `${r.guardianLinks[0].guardian.firstName} ${r.guardianLinks[0].guardian.lastName}`
            : '',
      },
      { header: 'Guardian Phone', value: (r) => r.guardianLinks[0]?.guardian.phone ?? '' },
    ]);
  }),
);

// --- Admissions -------------------------------------------------------------

reportRouter.get(
  '/admissions',
  canRead,
  validate(formatQuery.extend({ from: z.coerce.date(), to: z.coerce.date() }), 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as { format: string; from: Date; to: Date };
    const rows = await prisma.student.findMany({
      where: { schoolId: schoolIdOf(req), admissionDate: { gte: q.from, lte: q.to } },
      orderBy: { admissionDate: 'asc' },
      include: { enrollments: { where: { isActive: true }, include: { schoolClass: true } } },
    });

    respond(res, q.format, 'admissions', rows, [
      { header: 'Admission No', value: (r) => r.admissionNumber },
      { header: 'Name', value: (r) => `${r.firstName} ${r.lastName}` },
      { header: 'Gender', value: (r) => r.gender },
      { header: 'Admission Date', value: (r) => r.admissionDate.toISOString().slice(0, 10) },
      { header: 'Class', value: (r) => r.enrollments[0]?.schoolClass.name ?? '' },
      { header: 'Previous School', value: (r) => r.previousSchool ?? '' },
    ]);
  }),
);

// --- Attendance -------------------------------------------------------------

reportRouter.get(
  '/attendance',
  canRead,
  validate(
    formatQuery.extend({ from: z.coerce.date(), to: z.coerce.date(), classId: z.string().optional() }),
    'query',
  ),
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const q = req.query as unknown as { format: string; from: Date; to: Date; classId?: string };

    const students = await prisma.student.findMany({
      where: {
        schoolId,
        status: StudentStatus.ACTIVE,
        ...(q.classId ? { enrollments: { some: { isActive: true, classId: q.classId } } } : {}),
      },
      orderBy: { lastName: 'asc' },
      select: {
        id: true,
        admissionNumber: true,
        firstName: true,
        lastName: true,
        enrollments: {
          where: { isActive: true },
          select: { schoolClass: { select: { name: true } } },
        },
        attendance: {
          where: { date: { gte: q.from, lte: q.to } },
          select: { status: true },
        },
      },
    });

    const rows = students.map((s) => {
      const counts = s.attendance.reduce<Record<string, number>>((acc, a) => {
        acc[a.status] = (acc[a.status] ?? 0) + 1;
        return acc;
      }, {});
      const total = s.attendance.length;
      const present = (counts.PRESENT ?? 0) + (counts.LATE ?? 0);
      return {
        admissionNumber: s.admissionNumber,
        name: `${s.firstName} ${s.lastName}`,
        className: s.enrollments[0]?.schoolClass.name ?? '',
        present: counts.PRESENT ?? 0,
        absent: counts.ABSENT ?? 0,
        late: counts.LATE ?? 0,
        excused: counts.EXCUSED ?? 0,
        sick: counts.SICK ?? 0,
        totalDays: total,
        rate: total ? Number(((present / total) * 100).toFixed(1)) : 0,
      };
    });

    respond(res, q.format, 'attendance', rows, [
      { header: 'Admission No', value: (r) => r.admissionNumber },
      { header: 'Name', value: (r) => r.name },
      { header: 'Class', value: (r) => r.className },
      { header: 'Present', value: (r) => r.present },
      { header: 'Absent', value: (r) => r.absent },
      { header: 'Late', value: (r) => r.late },
      { header: 'Excused', value: (r) => r.excused },
      { header: 'Sick', value: (r) => r.sick },
      { header: 'Days Recorded', value: (r) => r.totalDays },
      { header: 'Attendance %', value: (r) => r.rate },
    ]);
  }),
);

// --- Fee collection ---------------------------------------------------------

reportRouter.get(
  '/fee-collection',
  canRead,
  validate(formatQuery.extend({ from: z.coerce.date(), to: z.coerce.date() }), 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as { format: string; from: Date; to: Date };
    const rows = await prisma.payment.findMany({
      where: {
        schoolId: schoolIdOf(req),
        status: PaymentStatus.CONFIRMED,
        paidAt: { gte: q.from, lte: q.to },
      },
      orderBy: { paidAt: 'asc' },
      include: {
        student: {
          select: {
            admissionNumber: true,
            firstName: true,
            lastName: true,
            enrollments: {
              where: { isActive: true },
              select: { schoolClass: { select: { name: true } } },
            },
          },
        },
      },
    });

    respond(res, q.format, 'fee-collection', rows, [
      { header: 'Receipt No', value: (r) => r.receiptNumber },
      { header: 'Date', value: (r) => r.paidAt.toISOString().slice(0, 10) },
      { header: 'Admission No', value: (r) => r.student.admissionNumber },
      { header: 'Student', value: (r) => `${r.student.firstName} ${r.student.lastName}` },
      { header: 'Class', value: (r) => r.student.enrollments[0]?.schoolClass.name ?? '' },
      { header: 'Method', value: (r) => r.method },
      { header: 'Provider', value: (r) => r.provider ?? '' },
      { header: 'Reference', value: (r) => r.reference ?? '' },
      { header: 'Amount', value: (r) => r.amount.toString() },
    ]);
  }),
);

reportRouter.get(
  '/outstanding-fees',
  canRead,
  validate(formatQuery.extend({ classId: z.string().optional() }), 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as { format: string; classId?: string };
    const rows = await prisma.invoice.findMany({
      where: {
        schoolId: schoolIdOf(req),
        status: { in: [InvoiceStatus.ISSUED, InvoiceStatus.PARTIALLY_PAID] },
        balance: { gt: 0 },
        ...(q.classId ? { student: { enrollments: { some: { isActive: true, classId: q.classId } } } } : {}),
      },
      orderBy: { dueDate: 'asc' },
      include: {
        student: {
          select: {
            admissionNumber: true,
            firstName: true,
            lastName: true,
            enrollments: {
              where: { isActive: true },
              select: { schoolClass: { select: { name: true } } },
            },
            guardianLinks: { where: { isFeePayer: true }, include: { guardian: true } },
          },
        },
      },
    });

    respond(res, q.format, 'outstanding-fees', rows, [
      { header: 'Invoice No', value: (r) => r.invoiceNumber },
      { header: 'Admission No', value: (r) => r.student.admissionNumber },
      { header: 'Student', value: (r) => `${r.student.firstName} ${r.student.lastName}` },
      { header: 'Class', value: (r) => r.student.enrollments[0]?.schoolClass.name ?? '' },
      { header: 'Billed', value: (r) => r.total.toString() },
      { header: 'Paid', value: (r) => r.amountPaid.toString() },
      { header: 'Balance', value: (r) => r.balance.toString() },
      { header: 'Due Date', value: (r) => r.dueDate.toISOString().slice(0, 10) },
      { header: 'Fee Payer Phone', value: (r) => r.student.guardianLinks[0]?.guardian.phone ?? '' },
    ]);
  }),
);

// --- Academic performance ---------------------------------------------------

reportRouter.get(
  '/academic-performance',
  canRead,
  validate(formatQuery.extend({ examId: z.string().min(1) }), 'query'),
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const q = req.query as unknown as { format: string; examId: string };

    // Per-subject averages and pass rates for one exam.
    const examSubjects = await prisma.examSubject.findMany({
      where: { examId: q.examId, exam: { schoolId } },
      include: { subject: true, results: true },
    });

    const rows = examSubjects.map((es) => {
      const sat = es.results.filter((r) => !r.isAbsent && r.score !== null);
      const total = sat.reduce((acc, r) => acc + (r.score ?? 0), 0);
      const passed = sat.filter(
        (r) => ((r.score ?? 0) / es.maxScore) * 100 >= es.subject.passMark,
      ).length;
      return {
        subject: es.subject.name,
        code: es.subject.code,
        entered: es.results.length,
        sat: sat.length,
        absent: es.results.filter((r) => r.isAbsent).length,
        average: sat.length ? Number((total / sat.length).toFixed(2)) : 0,
        highest: sat.length ? Math.max(...sat.map((r) => r.score ?? 0)) : 0,
        lowest: sat.length ? Math.min(...sat.map((r) => r.score ?? 0)) : 0,
        passRate: sat.length ? Number(((passed / sat.length) * 100).toFixed(1)) : 0,
      };
    });

    respond(res, q.format, 'academic-performance', rows, [
      { header: 'Subject', value: (r) => r.subject },
      { header: 'Code', value: (r) => r.code },
      { header: 'Sat', value: (r) => r.sat },
      { header: 'Absent', value: (r) => r.absent },
      { header: 'Average', value: (r) => r.average },
      { header: 'Highest', value: (r) => r.highest },
      { header: 'Lowest', value: (r) => r.lowest },
      { header: 'Pass Rate %', value: (r) => r.passRate },
    ]);
  }),
);

/** Teacher workload and marks-entry completeness (Module 17). */
reportRouter.get(
  '/teacher-performance',
  canRead,
  validate(formatQuery, 'query'),
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const q = req.query as unknown as { format: string };

    const teachers = await prisma.staff.findMany({
      where: { schoolId, staffType: 'TEACHING' },
      orderBy: { lastName: 'asc' },
      include: {
        classSubjects: { include: { subject: true, schoolClass: true } },
        _count: { select: { attendanceTaken: true, assignments: true, timetableSlots: true } },
      },
    });

    const rows = teachers.map((t) => ({
      staffNumber: t.staffNumber,
      name: `${t.firstName} ${t.lastName}`,
      subjects: t.classSubjects.map((cs) => `${cs.subject.code} (${cs.schoolClass.name})`).join('; '),
      lessonsPerWeek: t._count.timetableSlots,
      attendanceRecorded: t._count.attendanceTaken,
      assignmentsSet: t._count.assignments,
    }));

    respond(res, q.format, 'teacher-performance', rows, [
      { header: 'Staff No', value: (r) => r.staffNumber },
      { header: 'Teacher', value: (r) => r.name },
      { header: 'Subjects', value: (r) => r.subjects },
      { header: 'Lessons/Week', value: (r) => r.lessonsPerWeek },
      { header: 'Attendance Records', value: (r) => r.attendanceRecorded },
      { header: 'Assignments Set', value: (r) => r.assignmentsSet },
    ]);
  }),
);

// --- Library & inventory ----------------------------------------------------

reportRouter.get(
  '/library',
  canRead,
  validate(formatQuery, 'query'),
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const q = req.query as unknown as { format: string };
    const rows = await prisma.book.findMany({
      where: { schoolId },
      orderBy: { title: 'asc' },
      include: { _count: { select: { loans: true } } },
    });

    respond(res, q.format, 'library', rows, [
      { header: 'Title', value: (r) => r.title },
      { header: 'Author', value: (r) => r.author ?? '' },
      { header: 'ISBN', value: (r) => r.isbn ?? '' },
      { header: 'Category', value: (r) => r.category ?? '' },
      { header: 'Total Copies', value: (r) => r.totalCopies },
      { header: 'Available', value: (r) => r.availableCopies },
      { header: 'Times Borrowed', value: (r) => r._count.loans },
    ]);
  }),
);

reportRouter.get(
  '/inventory',
  canRead,
  validate(formatQuery, 'query'),
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const q = req.query as unknown as { format: string };
    const rows = await prisma.inventoryItem.findMany({
      where: { schoolId },
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
    });

    respond(res, q.format, 'inventory', rows, [
      { header: 'Item', value: (r) => r.name },
      { header: 'Category', value: (r) => r.category },
      { header: 'SKU', value: (r) => r.sku ?? '' },
      { header: 'Quantity', value: (r) => r.quantity },
      { header: 'Unit', value: (r) => r.unit },
      { header: 'Reorder Level', value: (r) => r.reorderLevel },
      { header: 'Unit Cost', value: (r) => r.unitCost?.toString() ?? '' },
      { header: 'Location', value: (r) => r.location ?? '' },
    ]);
  }),
);

reportRouter.get(
  '/payroll',
  requirePermission('payroll:read'),
  validate(formatQuery.extend({ period: z.string().regex(/^\d{4}-\d{2}$/) }), 'query'),
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const q = req.query as unknown as { format: string; period: string };

    const run = await prisma.payrollRun.findUnique({
      where: { schoolId_period: { schoolId, period: q.period } },
      include: { payslips: { include: { staff: true } } },
    });
    const rows = run?.payslips ?? [];

    respond(res, q.format, `payroll-${q.period}`, rows, [
      { header: 'Staff No', value: (r) => r.staff.staffNumber },
      { header: 'Name', value: (r) => `${r.staff.firstName} ${r.staff.lastName}` },
      { header: 'Basic', value: (r) => r.basicSalary.toString() },
      { header: 'Allowances', value: (r) => r.allowances.toString() },
      { header: 'Gross', value: (r) => r.grossPay.toString() },
      { header: 'NSSF', value: (r) => r.nssf.toString() },
      { header: 'PAYE', value: (r) => r.payeTax.toString() },
      { header: 'Net Pay', value: (r) => r.netPay.toString() },
      { header: 'Bank', value: (r) => r.staff.bankName ?? '' },
      { header: 'Account', value: (r) => r.staff.bankAccount ?? '' },
    ]);
  }),
);
