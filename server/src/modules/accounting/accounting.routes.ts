import { Router } from 'express';
import { EmploymentStatus, LedgerEntryType, Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { asyncHandler, paginate, paginationSchema, skipTake, validate } from '../../lib/http.js';
import { requirePermission, schoolIdOf } from '../../middleware/auth.js';
import { audit } from '../../lib/audit.js';
import { money, round } from '../../lib/money.js';
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
    });
    if (staff.length === 0) throw badRequest('No staff have a basic salary configured');

    const payslips = staff.map((s) => {
      const basic = money(s.basicSalary ?? 0);
      const gross = round(basic.plus(allowances));
      const nssf = round(gross.times(NSSF_RATE));
      const paye = payeFor(gross.minus(nssf));
      const net = round(gross.minus(nssf).minus(paye));
      return {
        staffId: s.id,
        basicSalary: round(basic),
        allowances: round(money(allowances)),
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

    const run = await prisma.$transaction(async (tx) => {
      const created = await tx.payrollRun.create({
        data: {
          schoolId,
          period,
          grossTotal,
          netTotal,
          payslips: { create: payslips },
        },
        include: { payslips: { include: { staff: { select: { firstName: true, lastName: true, staffNumber: true } } } } },
      });

      // Salaries hit the ledger so the P&L reflects staff cost.
      await tx.ledgerEntry.create({
        data: {
          schoolId,
          entryType: LedgerEntryType.EXPENSE,
          category: 'Salaries',
          description: `Payroll ${period}`,
          amount: grossTotal,
          entryDate: new Date(`${period}-01T00:00:00.000Z`),
          reference: `PAYROLL-${period}`,
          recordedById: req.user?.id ?? null,
        },
      });

      return created;
    });

    await audit(req, { action: 'payroll.run', entityType: 'PayrollRun', entityId: run.id, metadata: { period } });
    res.status(201).json(run);
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
          include: { staff: { select: { firstName: true, lastName: true, staffNumber: true, bankName: true, bankAccount: true } } },
        },
      },
    });
    if (!run) throw notFound('Payroll run');
    res.json(run);
  }),
);
