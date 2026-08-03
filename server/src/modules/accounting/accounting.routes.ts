import { Router } from 'express';
import { EmploymentStatus, LedgerEntryType, Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { asyncHandler, paginate, paginationSchema, skipTake, validate } from '../../lib/http.js';
import { requirePermission, schoolIdOf } from '../../middleware/auth.js';
import { audit } from '../../lib/audit.js';
import { formatMoney, money, round } from '../../lib/money.js';
import { badRequest, notFound } from '../../lib/errors.js';

/** Module 11 — Accounting: ledger, budgets, payroll and financial statements. */
export const accountingRouter: Router = Router();

// --- General ledger ---------------------------------------------------------

accountingRouter.get(
  '/ledger',
  requirePermission('accounting:read'),
  validate(
    paginationSchema.extend({
      entryType: z.nativeEnum(LedgerEntryType).optional(),
      category: z.string().optional(),
      from: z.coerce.date().optional(),
      to: z.coerce.date().optional(),
    }),
    'query',
  ),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as {
      page: number;
      pageSize: number;
      entryType?: LedgerEntryType;
      category?: string;
      from?: Date;
      to?: Date;
    };
    const where = {
      schoolId: schoolIdOf(req),
      ...(q.entryType ? { entryType: q.entryType } : {}),
      ...(q.category ? { category: q.category } : {}),
      ...(q.from || q.to
        ? { entryDate: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } }
        : {}),
    };

    const [data, total] = await Promise.all([
      prisma.ledgerEntry.findMany({
        where,
        ...skipTake(q.page, q.pageSize),
        orderBy: { entryDate: 'desc' },
      }),
      prisma.ledgerEntry.count({ where }),
    ]);

    res.json(paginate(data, total, q.page, q.pageSize));
  }),
);

accountingRouter.post(
  '/ledger',
  requirePermission('accounting:manage'),
  validate(
    z.object({
      entryType: z.nativeEnum(LedgerEntryType),
      category: z.string().min(2).max(60),
      description: z.string().min(2).max(300),
      amount: z.number().positive(),
      entryDate: z.coerce.date(),
      reference: z.string().max(80).nullish(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const entry = await prisma.ledgerEntry.create({
      data: { ...req.body, schoolId: schoolIdOf(req), recordedById: req.user?.id ?? null },
    });
    await audit(req, {
      action: `ledger.${String(req.body.entryType).toLowerCase()}`,
      entityType: 'LedgerEntry',
      entityId: entry.id,
      metadata: { amount: req.body.amount },
    });
    res.status(201).json(entry);
  }),
);

/** Profit & loss for a period (Module 11 — financial statements). */
accountingRouter.get(
  '/profit-loss',
  requirePermission('accounting:read', 'reports:read'),
  validate(z.object({ from: z.coerce.date(), to: z.coerce.date() }), 'query'),
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const { from, to } = req.query as unknown as { from: Date; to: Date };

    const grouped = await prisma.ledgerEntry.groupBy({
      by: ['entryType', 'category'],
      where: { schoolId, entryDate: { gte: from, lte: to } },
      _sum: { amount: true },
    });

    const income = grouped
      .filter((g) => g.entryType === LedgerEntryType.INCOME)
      .map((g) => ({ category: g.category, amount: g._sum.amount?.toString() ?? '0' }));
    const expenses = grouped
      .filter((g) => g.entryType === LedgerEntryType.EXPENSE)
      .map((g) => ({ category: g.category, amount: g._sum.amount?.toString() ?? '0' }));

    const totalIncome = income.reduce<Prisma.Decimal>((acc, i) => acc.plus(money(i.amount)), money(0));
    const totalExpenses = expenses.reduce<Prisma.Decimal>(
      (acc, i) => acc.plus(money(i.amount)),
      money(0),
    );

    res.json({
      period: { from, to },
      income,
      expenses,
      totals: {
        income: round(totalIncome).toString(),
        expenses: round(totalExpenses).toString(),
        netSurplus: round(totalIncome.minus(totalExpenses)).toString(),
      },
    });
  }),
);

/** Cash-flow style monthly movement over a period. */
accountingRouter.get(
  '/cash-flow',
  requirePermission('accounting:read', 'reports:read'),
  validate(z.object({ from: z.coerce.date(), to: z.coerce.date() }), 'query'),
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const { from, to } = req.query as unknown as { from: Date; to: Date };

    const rows = await prisma.$queryRaw<
      Array<{ month: string; entry_type: string; total: Prisma.Decimal }>
    >`
      SELECT to_char("entryDate", 'YYYY-MM') AS month,
             "entryType"::text               AS entry_type,
             SUM(amount)                     AS total
      FROM "LedgerEntry"
      WHERE "schoolId" = ${schoolId}
        AND "entryDate" BETWEEN ${from} AND ${to}
      GROUP BY 1, 2
      ORDER BY 1 ASC
    `;

    const byMonth = new Map<string, { month: string; income: string; expenses: string }>();
    for (const row of rows) {
      const entry = byMonth.get(row.month) ?? { month: row.month, income: '0', expenses: '0' };
      if (row.entry_type === 'INCOME') entry.income = row.total.toString();
      else entry.expenses = row.total.toString();
      byMonth.set(row.month, entry);
    }

    res.json({ period: { from, to }, data: [...byMonth.values()] });
  }),
);

// --- Payroll ----------------------------------------------------------------

/**
 * PAYE bands and NSSF rate are simplified placeholders. A school's finance
 * officer configures the real figures; the calculation is isolated here so it
 * can be swapped without touching the payroll workflow.
 */
const NSSF_RATE = 0.1;

function payeFor(gross: Prisma.Decimal): Prisma.Decimal {
  const g = gross.toNumber();
  if (g <= 270_000) return money(0);
  if (g <= 520_000) return round(money((g - 270_000) * 0.08));
  if (g <= 760_000) return round(money(20_000 + (g - 520_000) * 0.2));
  if (g <= 1_000_000) return round(money(68_000 + (g - 760_000) * 0.25));
  return round(money(128_000 + (g - 1_000_000) * 0.3));
}

accountingRouter.get(
  '/payroll',
  requirePermission('payroll:read'),
  asyncHandler(async (req, res) => {
    const data = await prisma.payrollRun.findMany({
      where: { schoolId: schoolIdOf(req) },
      orderBy: { period: 'desc' },
      include: { _count: { select: { payslips: true } } },
    });
    res.json({ data });
  }),
);

accountingRouter.post(
  '/payroll',
  requirePermission('payroll:manage'),
  validate(
    z.object({
      period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM'),
      allowances: z.number().nonnegative().default(0),
    }),
  ),
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const { period, allowances } = req.body as { period: string; allowances: number };

    const existing = await prisma.payrollRun.findUnique({
      where: { schoolId_period: { schoolId, period } },
    });
    if (existing) throw badRequest(`Payroll for ${period} has already been run`);

    const staff = await prisma.staff.findMany({
      where: {
        schoolId,
        employmentStatus: { in: [EmploymentStatus.ACTIVE, EmploymentStatus.ON_LEAVE] },
        basicSalary: { not: null },
      },
      include: { allowances: { where: { isActive: true }, orderBy: { name: 'asc' } } },
    });
    if (staff.length === 0) throw badRequest('No staff have a basic salary configured');

    const payslips = staff.map((s) => {
      const basic = money(s.basicSalary ?? 0);

      // Each person's own recurring allowances, plus anything applied to the
      // whole run (a one-off across-the-board payment, say).
      const breakdown = s.allowances.map((a) => ({
        name: a.name,
        amount: round(a.amount).toString(),
      }));
      if (allowances > 0) {
        breakdown.push({ name: 'General allowance', amount: round(allowances).toString() });
      }

      const allowanceTotal = round(
        s.allowances
          .reduce<Prisma.Decimal>((acc, a) => acc.plus(a.amount), money(0))
          .plus(allowances),
      );

      const gross = round(basic.plus(allowanceTotal));
      const nssf = round(gross.times(NSSF_RATE));
      const paye = payeFor(gross.minus(nssf));
      const net = round(gross.minus(nssf).minus(paye));

      return {
        staffId: s.id,
        basicSalary: round(basic),
        allowances: allowanceTotal,
        allowanceBreakdown: breakdown as unknown as Prisma.InputJsonValue,
        grossPay: gross,
        payeTax: paye,
        nssf,
        otherDeductions: money(0),
        netPay: net,
      };
    });

    const grossTotal = round(
      payslips.reduce<Prisma.Decimal>((acc, p) => acc.plus(p.grossPay), money(0)),
    );
    const netTotal = round(payslips.reduce<Prisma.Decimal>((acc, p) => acc.plus(p.netPay), money(0)));

    // A draft posts nothing to the ledger — it is a proposal, and may be
    // discarded. The salary expense is booked when the run is approved.
    const run = await prisma.payrollRun.create({
      data: {
        schoolId,
        period,
        grossTotal,
        netTotal,
        preparedById: req.user?.id ?? null,
        payslips: { create: payslips },
      },
      include: {
        payslips: {
          include: { staff: { select: { firstName: true, lastName: true, staffNumber: true } } },
        },
      },
    });

    await audit(req, { action: 'payroll.run', entityType: 'PayrollRun', entityId: run.id, metadata: { period } });
    res.status(201).json(run);
  }),
);

/** Sign off a draft. This is the point the salary expense reaches the ledger. */
accountingRouter.post(
  '/payroll/:id/approve',
  requirePermission('payroll:manage'),
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const id = req.params.id as string;

    const run = await prisma.payrollRun.findFirst({ where: { id, schoolId } });
    if (!run) throw notFound('Payroll run');
    if (run.status !== 'DRAFT') throw badRequest(`This run is already ${run.status.toLowerCase()}`);

    const approved = await prisma.$transaction(async (tx) => {
      const updated = await tx.payrollRun.update({
        where: { id },
        data: {
          status: 'APPROVED',
          approvedById: req.user?.id ?? null,
          approvedAt: new Date(),
        },
      });

      await tx.ledgerEntry.create({
        data: {
          schoolId,
          entryType: LedgerEntryType.EXPENSE,
          category: 'Salaries',
          description: `Payroll ${run.period}`,
          amount: run.grossTotal,
          entryDate: new Date(`${run.period}-01T00:00:00.000Z`),
          reference: `PAYROLL-${run.period}`,
          recordedById: req.user?.id ?? null,
        },
      });

      return updated;
    });

    await audit(req, {
      action: 'payroll.approve',
      entityType: 'PayrollRun',
      entityId: id,
      metadata: { period: run.period, grossTotal: run.grossTotal.toString() },
    });
    res.json(approved);
  }),
);

/** Record that the money actually left the bank. */
accountingRouter.post(
  '/payroll/:id/mark-paid',
  requirePermission('payroll:manage'),
  validate(z.object({ paymentNote: z.string().max(300).optional() })),
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const id = req.params.id as string;

    const run = await prisma.payrollRun.findFirst({ where: { id, schoolId } });
    if (!run) throw notFound('Payroll run');
    if (run.status === 'DRAFT') throw badRequest('Approve the run before marking it paid');
    if (run.status === 'PAID') throw badRequest('This run is already marked paid');

    const paid = await prisma.payrollRun.update({
      where: { id },
      data: { status: 'PAID', paidAt: new Date(), paymentNote: req.body.paymentNote ?? null },
    });

    await audit(req, { action: 'payroll.mark_paid', entityType: 'PayrollRun', entityId: id });
    res.json(paid);
  }),
);

/**
 * Discard a draft. Only drafts can go: once approved the expense is on the
 * ledger and the run is part of the financial record.
 */
accountingRouter.delete(
  '/payroll/:id',
  requirePermission('payroll:manage'),
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const id = req.params.id as string;

    const run = await prisma.payrollRun.findFirst({ where: { id, schoolId } });
    if (!run) throw notFound('Payroll run');
    if (run.status !== 'DRAFT') {
      throw badRequest(`Only a draft can be discarded; this run is ${run.status.toLowerCase()}`);
    }

    await prisma.payrollRun.delete({ where: { id } });
    await audit(req, {
      action: 'payroll.discard_draft',
      entityType: 'PayrollRun',
      entityId: id,
      metadata: { period: run.period },
    });
    res.status(204).send();
  }),
);

accountingRouter.get(
  '/payroll/:id',
  requirePermission('payroll:read'),
  asyncHandler(async (req, res) => {
    const run = await prisma.payrollRun.findFirst({
      where: { id: req.params.id as string, schoolId: schoolIdOf(req) },
      include: {
        payslips: {
          orderBy: { staff: { lastName: 'asc' } },
          include: {
            staff: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                staffNumber: true,
                jobTitle: true,
                bankName: true,
                bankAccount: true,
              },
            },
          },
        },
      },
    });
    if (!run) throw notFound('Payroll run');
    res.json(run);
  }),
);

/** A single payslip, with everything needed to hand one to a staff member. */
accountingRouter.get(
  '/payroll/:id/payslips/:payslipId',
  requirePermission('payroll:read'),
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);

    const payslip = await prisma.payslip.findFirst({
      where: {
        id: req.params.payslipId as string,
        payrollRunId: req.params.id as string,
        payrollRun: { schoolId },
      },
      include: {
        payrollRun: { select: { period: true, status: true, runDate: true, paidAt: true } },
        staff: {
          select: {
            firstName: true,
            lastName: true,
            staffNumber: true,
            jobTitle: true,
            bankName: true,
            bankAccount: true,
            department: { select: { name: true } },
          },
        },
      },
    });
    if (!payslip) throw notFound('Payslip');

    const school = await prisma.school.findUniqueOrThrow({
      where: { id: schoolId },
      select: { name: true, address: true, phone: true, email: true, currency: true },
    });

    // Itemise from the snapshot taken at run time, so a payslip issued months
    // ago still shows the rates that actually applied then.
    const itemised = Array.isArray(payslip.allowanceBreakdown)
      ? (payslip.allowanceBreakdown as Array<{ name: string; amount: string }>)
      : [];

    const earnings = [
      { label: 'Basic salary', amount: payslip.basicSalary.toString() },
      ...(itemised.length > 0
        ? itemised.map((a) => ({ label: a.name, amount: a.amount }))
        : [{ label: 'Allowances', amount: payslip.allowances.toString() }]),
    ];
    const deductions = [
      { label: 'NSSF', amount: payslip.nssf.toString() },
      { label: 'PAYE', amount: payslip.payeTax.toString() },
      { label: 'Other deductions', amount: payslip.otherDeductions.toString() },
    ];

    res.json({
      school,
      period: payslip.payrollRun.period,
      status: payslip.payrollRun.status,
      paidAt: payslip.payrollRun.paidAt,
      staff: payslip.staff,
      earnings,
      deductions,
      totals: {
        gross: payslip.grossPay.toString(),
        grossFormatted: formatMoney(payslip.grossPay, school.currency),
        totalDeductions: round(
          money(payslip.nssf).plus(payslip.payeTax).plus(payslip.otherDeductions),
        ).toString(),
        net: payslip.netPay.toString(),
        netFormatted: formatMoney(payslip.netPay, school.currency),
      },
    });
  }),
);
