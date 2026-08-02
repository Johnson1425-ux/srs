import { Router } from 'express';
import {
  AdjustmentType,
  FeeCategory,
  InvoiceStatus,
  MobileMoneyProvider,
  PaymentMethod,
  PaymentStatus,
} from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { asyncHandler, paginate, paginationSchema, skipTake, validate } from '../../lib/http.js';
import { requirePermission, schoolIdOf } from '../../middleware/auth.js';
import { audit } from '../../lib/audit.js';
import { formatMoney } from '../../lib/money.js';
import { notFound } from '../../lib/errors.js';
import * as service from './fee.service.js';

/** Module 10 — Fee Management: structures. */
export const feeRouter: Router = Router();

feeRouter.get(
  '/structures',
  requirePermission('fees:read'),
  validate(z.object({ academicYearId: z.string().optional() }), 'query'),
  asyncHandler(async (req, res) => {
    const { academicYearId } = req.query as { academicYearId?: string };
    const data = await prisma.feeStructure.findMany({
      where: {
        schoolId: schoolIdOf(req),
        ...(academicYearId ? { academicYearId } : {}),
      },
      include: {
        items: true,
        schoolClass: { select: { id: true, name: true } },
        term: { select: { id: true, name: true } },
        academicYear: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ data });
  }),
);

const structureSchema = z.object({
  academicYearId: z.string().min(1),
  termId: z.string().nullish(),
  classId: z.string().nullish(),
  name: z.string().min(2).max(120),
  items: z
    .array(
      z.object({
        category: z.nativeEnum(FeeCategory),
        name: z.string().min(2).max(120),
        amount: z.number().nonnegative(),
        isMandatory: z.boolean().default(true),
      }),
    )
    .min(1),
});

feeRouter.post(
  '/structures',
  requirePermission('fees:manage'),
  validate(structureSchema),
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const { items, ...body } = req.body as z.infer<typeof structureSchema>;

    const year = await prisma.academicYear.findFirst({
      where: { id: body.academicYearId, schoolId },
    });
    if (!year) throw notFound('Academic year');

    const structure = await prisma.feeStructure.create({
      data: { ...body, schoolId, items: { create: items } },
      include: { items: true },
    });
    await audit(req, { action: 'fee_structure.create', entityType: 'FeeStructure', entityId: structure.id });
    res.status(201).json(structure);
  }),
);

feeRouter.post(
  '/structures/:id/generate-invoices',
  requirePermission('fees:manage'),
  validate(
    z.object({
      dueDate: z.coerce.date(),
      studentIds: z.array(z.string()).optional(),
      note: z.string().max(200).optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const result = await service.generateInvoices(schoolIdOf(req), {
      feeStructureId: req.params.id as string,
      ...req.body,
    });
    await audit(req, {
      action: 'invoice.bulk_generate',
      entityType: 'FeeStructure',
      entityId: req.params.id as string,
      metadata: { generated: result.generated, skipped: result.skipped },
    });
    res.status(201).json(result);
  }),
);

feeRouter.post(
  '/adjustments',
  requirePermission('fees:manage'),
  validate(
    z.object({
      studentId: z.string().min(1),
      invoiceId: z.string().nullish(),
      type: z.nativeEnum(AdjustmentType),
      reason: z.string().min(3).max(300),
      amount: z.number().positive(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const adjustment = await service.applyAdjustment(
      schoolIdOf(req),
      req.body,
      req.user?.id ?? null,
    );
    await audit(req, {
      action: 'fee.adjustment',
      entityType: 'FeeAdjustment',
      entityId: adjustment.id,
      metadata: { type: req.body.type, amount: req.body.amount },
    });
    res.status(201).json(adjustment);
  }),
);

feeRouter.get(
  '/students/:studentId/balance',
  requirePermission('fees:read'),
  asyncHandler(async (req, res) => {
    res.json(await service.studentBalance(schoolIdOf(req), req.params.studentId as string));
  }),
);

/** Outstanding balances across the school (Module 17 report). */
feeRouter.get(
  '/outstanding',
  requirePermission('fees:read', 'reports:read'),
  validate(paginationSchema.extend({ classId: z.string().optional() }), 'query'),
  asyncHandler(async (req, res) => {
    const { page, pageSize, classId } = req.query as unknown as {
      page: number;
      pageSize: number;
      classId?: string;
    };
    const where = {
      schoolId: schoolIdOf(req),
      status: { in: [InvoiceStatus.ISSUED, InvoiceStatus.PARTIALLY_PAID] },
      balance: { gt: 0 },
      ...(classId
        ? { student: { enrollments: { some: { isActive: true, classId } } } }
        : {}),
    };

    const [data, total, totals] = await Promise.all([
      prisma.invoice.findMany({
        where,
        ...skipTake(page, pageSize),
        orderBy: { dueDate: 'asc' },
        include: {
          student: {
            select: {
              id: true,
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
      }),
      prisma.invoice.count({ where }),
      prisma.invoice.aggregate({ where, _sum: { balance: true } }),
    ]);

    res.json({
      ...paginate(data, total, page, pageSize),
      totalOutstanding: totals._sum.balance?.toString() ?? '0',
    });
  }),
);

// --- Invoices ---------------------------------------------------------------

export const invoiceRouter: Router = Router();

invoiceRouter.get(
  '/',
  requirePermission('fees:read'),
  validate(
    paginationSchema.extend({
      studentId: z.string().optional(),
      status: z.nativeEnum(InvoiceStatus).optional(),
      termId: z.string().optional(),
    }),
    'query',
  ),
  asyncHandler(async (req, res) => {
    const { page, pageSize, studentId, status, termId } = req.query as unknown as {
      page: number;
      pageSize: number;
      studentId?: string;
      status?: InvoiceStatus;
      termId?: string;
    };
    const where = {
      schoolId: schoolIdOf(req),
      ...(studentId ? { studentId } : {}),
      ...(status ? { status } : {}),
      ...(termId ? { termId } : {}),
    };

    const [data, total] = await Promise.all([
      prisma.invoice.findMany({
        where,
        ...skipTake(page, pageSize),
        orderBy: { issueDate: 'desc' },
        include: {
          items: true,
          student: { select: { id: true, admissionNumber: true, firstName: true, lastName: true } },
        },
      }),
      prisma.invoice.count({ where }),
    ]);

    res.json(paginate(data, total, page, pageSize));
  }),
);

invoiceRouter.get(
  '/:id',
  requirePermission('fees:read'),
  asyncHandler(async (req, res) => {
    const invoice = await prisma.invoice.findFirst({
      where: { id: req.params.id as string, schoolId: schoolIdOf(req) },
      include: {
        items: true,
        adjustments: true,
        allocations: { include: { payment: true } },
        student: true,
        term: true,
        academicYear: true,
      },
    });
    if (!invoice) throw notFound('Invoice');
    res.json(invoice);
  }),
);

invoiceRouter.post(
  '/:id/cancel',
  requirePermission('fees:manage'),
  validate(z.object({ reason: z.string().min(3).max(300) })),
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const id = req.params.id as string;
    const invoice = await prisma.invoice.findFirst({ where: { id, schoolId } });
    if (!invoice) throw notFound('Invoice');

    const updated = await prisma.invoice.update({
      where: { id },
      data: { status: InvoiceStatus.CANCELLED, note: req.body.reason },
    });
    await audit(req, { action: 'invoice.cancel', entityType: 'Invoice', entityId: id });
    res.json(updated);
  }),
);

// --- Payments ---------------------------------------------------------------

export const paymentRouter: Router = Router();

paymentRouter.get(
  '/',
  requirePermission('payments:read'),
  validate(
    paginationSchema.extend({
      studentId: z.string().optional(),
      method: z.nativeEnum(PaymentMethod).optional(),
      status: z.nativeEnum(PaymentStatus).optional(),
      from: z.coerce.date().optional(),
      to: z.coerce.date().optional(),
    }),
    'query',
  ),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as {
      page: number;
      pageSize: number;
      studentId?: string;
      method?: PaymentMethod;
      status?: PaymentStatus;
      from?: Date;
      to?: Date;
    };
    const where = {
      schoolId: schoolIdOf(req),
      ...(q.studentId ? { studentId: q.studentId } : {}),
      ...(q.method ? { method: q.method } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.from || q.to
        ? { paidAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } }
        : {}),
    };

    const [data, total, sum] = await Promise.all([
      prisma.payment.findMany({
        where,
        ...skipTake(q.page, q.pageSize),
        orderBy: { paidAt: 'desc' },
        include: {
          student: { select: { id: true, admissionNumber: true, firstName: true, lastName: true } },
          allocations: { include: { invoice: { select: { invoiceNumber: true } } } },
        },
      }),
      prisma.payment.count({ where }),
      prisma.payment.aggregate({
        where: { ...where, status: PaymentStatus.CONFIRMED },
        _sum: { amount: true },
      }),
    ]);

    res.json({
      ...paginate(data, total, q.page, q.pageSize),
      totalCollected: sum._sum.amount?.toString() ?? '0',
    });
  }),
);

const paymentSchema = z.object({
  studentId: z.string().min(1),
  amount: z.number().positive(),
  method: z.nativeEnum(PaymentMethod),
  provider: z.nativeEnum(MobileMoneyProvider).nullish(),
  reference: z.string().max(80).nullish(),
  payerName: z.string().max(120).nullish(),
  paidAt: z.coerce.date().optional(),
  note: z.string().max(300).nullish(),
  allocations: z
    .array(z.object({ invoiceId: z.string().min(1), amount: z.number().positive() }))
    .optional(),
});

paymentRouter.post(
  '/',
  requirePermission('payments:create'),
  validate(paymentSchema),
  asyncHandler(async (req, res) => {
    const result = await service.recordPayment(schoolIdOf(req), req.body, req.user?.id ?? null);
    await audit(req, {
      action: 'payment.record',
      entityType: 'Payment',
      entityId: result.payment.id,
      metadata: { receiptNumber: result.payment.receiptNumber, amount: req.body.amount },
    });
    res.status(201).json(result);
  }),
);

/** Printable receipt payload (PRD KPI: generated in under 10 seconds). */
paymentRouter.get(
  '/:id/receipt',
  requirePermission('payments:read'),
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const payment = await prisma.payment.findFirst({
      where: { id: req.params.id as string, schoolId },
      include: {
        student: {
          select: {
            admissionNumber: true,
            firstName: true,
            middleName: true,
            lastName: true,
            enrollments: {
              where: { isActive: true },
              select: { schoolClass: { select: { name: true } }, stream: { select: { name: true } } },
            },
          },
        },
        allocations: {
          include: { invoice: { select: { invoiceNumber: true, total: true, balance: true } } },
        },
      },
    });
    if (!payment) throw notFound('Payment');

    const school = await prisma.school.findUniqueOrThrow({
      where: { id: schoolId },
      select: { name: true, address: true, phone: true, email: true, logoUrl: true, currency: true },
    });

    const balance = await service.studentBalance(schoolId, payment.studentId);

    res.json({
      school,
      receipt: {
        number: payment.receiptNumber,
        date: payment.paidAt,
        method: payment.method,
        provider: payment.provider,
        reference: payment.reference,
        payerName: payment.payerName,
        amount: payment.amount.toString(),
        amountFormatted: formatMoney(payment.amount, school.currency),
        status: payment.status,
      },
      student: {
        name: [payment.student.firstName, payment.student.middleName, payment.student.lastName]
          .filter(Boolean)
          .join(' '),
        admissionNumber: payment.student.admissionNumber,
        className: payment.student.enrollments[0]?.schoolClass.name ?? null,
        streamName: payment.student.enrollments[0]?.stream?.name ?? null,
      },
      allocations: payment.allocations.map((a) => ({
        invoiceNumber: a.invoice.invoiceNumber,
        amount: a.amount.toString(),
        invoiceBalance: a.invoice.balance.toString(),
      })),
      outstandingAfter: balance.summary.balance,
    });
  }),
);

paymentRouter.post(
  '/:id/reverse',
  requirePermission('payments:reverse'),
  validate(z.object({ reason: z.string().min(3).max(300) })),
  asyncHandler(async (req, res) => {
    const payment = await service.reversePayment(
      schoolIdOf(req),
      req.params.id as string,
      req.body.reason,
    );
    await audit(req, {
      action: 'payment.reverse',
      entityType: 'Payment',
      entityId: payment.id,
      metadata: { reason: req.body.reason },
    });
    res.json(payment);
  }),
);
