import {
  type AdjustmentType,
  InvoiceStatus,
  LedgerEntryType,
  type MobileMoneyProvider,
  type PaymentMethod,
  PaymentStatus,
  Prisma,
  StudentStatus,
} from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import type { Tx } from '../../db/prisma.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { money, round } from '../../lib/money.js';
import { nextInvoiceNumber, nextReceiptNumber } from '../../lib/sequence.js';

function statusFor(total: Prisma.Decimal, paid: Prisma.Decimal): InvoiceStatus {
  if (paid.greaterThanOrEqualTo(total) && total.greaterThan(0)) return InvoiceStatus.PAID;
  if (paid.greaterThan(0)) return InvoiceStatus.PARTIALLY_PAID;
  return InvoiceStatus.ISSUED;
}

/** Recomputes an invoice's derived money columns from its items and payments. */
async function recalculateInvoice(tx: Tx, invoiceId: string) {
  const invoice = await tx.invoice.findUniqueOrThrow({
    where: { id: invoiceId },
    include: { items: true, allocations: true, adjustments: true },
  });

  const subtotal = invoice.items.reduce<Prisma.Decimal>((acc, i) => acc.plus(i.amount), money(0));
  const discountTotal = invoice.adjustments.reduce<Prisma.Decimal>(
    (acc, a) => acc.plus(a.amount),
    money(0),
  );
  const total = round(Prisma.Decimal.max(subtotal.minus(discountTotal), money(0)));
  const amountPaid = round(
    invoice.allocations.reduce<Prisma.Decimal>((acc, a) => acc.plus(a.amount), money(0)),
  );
  const balance = round(Prisma.Decimal.max(total.minus(amountPaid), money(0)));

  return tx.invoice.update({
    where: { id: invoiceId },
    data: {
      subtotal: round(subtotal),
      discountTotal: round(discountTotal),
      total,
      amountPaid,
      balance,
      status:
        invoice.status === InvoiceStatus.CANCELLED
          ? InvoiceStatus.CANCELLED
          : statusFor(total, amountPaid),
    },
  });
}

export interface GenerateInvoicesInput {
  feeStructureId: string;
  studentIds?: string[];
  dueDate: Date;
  note?: string;
}

/**
 * Bills a fee structure to every eligible student (Module 10).
 * Students already invoiced for the same structure period are skipped rather
 * than double-billed, so the operation is safe to re-run after new admissions.
 */
export async function generateInvoices(schoolId: string, input: GenerateInvoicesInput) {
  const structure = await prisma.feeStructure.findFirst({
    where: { id: input.feeStructureId, schoolId },
    include: { items: true },
  });
  if (!structure) throw notFound('Fee structure');
  if (structure.items.length === 0) throw badRequest('This fee structure has no items');

  const students = await prisma.student.findMany({
    where: {
      schoolId,
      status: StudentStatus.ACTIVE,
      ...(input.studentIds?.length ? { id: { in: input.studentIds } } : {}),
      ...(structure.classId
        ? { enrollments: { some: { isActive: true, classId: structure.classId } } }
        : {}),
    },
    select: { id: true },
  });
  if (students.length === 0) throw badRequest('No active students matched this fee structure');

  const existing = await prisma.invoice.findMany({
    where: {
      schoolId,
      academicYearId: structure.academicYearId,
      termId: structure.termId,
      studentId: { in: students.map((s) => s.id) },
      status: { not: InvoiceStatus.CANCELLED },
    },
    select: { studentId: true },
  });
  const alreadyBilled = new Set(existing.map((e) => e.studentId));
  const targets = students.filter((s) => !alreadyBilled.has(s.id));

  const subtotal = round(
    structure.items.reduce<Prisma.Decimal>((acc, i) => acc.plus(i.amount), money(0)),
  );

  const created: string[] = [];
  // Sequential so invoice numbers stay gapless and ordered.
  for (const student of targets) {
    const invoice = await prisma.$transaction(async (tx) => {
      const invoiceNumber = await nextInvoiceNumber(schoolId, tx);
      return tx.invoice.create({
        data: {
          schoolId,
          studentId: student.id,
          academicYearId: structure.academicYearId,
          termId: structure.termId,
          invoiceNumber,
          dueDate: input.dueDate,
          note: input.note ?? structure.name,
          subtotal,
          total: subtotal,
          balance: subtotal,
          status: InvoiceStatus.ISSUED,
          items: {
            create: structure.items.map((i) => ({
              category: i.category,
              name: i.name,
              amount: i.amount,
            })),
          },
        },
      });
    });
    created.push(invoice.id);
  }

  return {
    generated: created.length,
    skipped: alreadyBilled.size,
    invoiceIds: created,
  };
}

export interface PaymentInput {
  studentId: string;
  amount: number;
  method: PaymentMethod;
  provider?: MobileMoneyProvider | null;
  reference?: string | null;
  payerName?: string | null;
  paidAt?: Date;
  note?: string | null;
  /** Explicit allocation; when omitted the payment settles oldest invoices first. */
  allocations?: Array<{ invoiceId: string; amount: number }>;
}

/**
 * Records a fee payment, allocates it across invoices, issues a receipt number
 * and posts the income to the ledger — all in one transaction.
 */
export async function recordPayment(
  schoolId: string,
  input: PaymentInput,
  receivedById: string | null,
) {
  const amount = round(input.amount);
  if (amount.lessThanOrEqualTo(0)) throw badRequest('Payment amount must be greater than zero');

  const student = await prisma.student.findFirst({
    where: { id: input.studentId, schoolId },
    select: { id: true, firstName: true, lastName: true, admissionNumber: true },
  });
  if (!student) throw notFound('Student');

  return prisma.$transaction(async (tx) => {
    // Outstanding invoices, oldest due date first.
    const outstanding = await tx.invoice.findMany({
      where: {
        studentId: student.id,
        status: { in: [InvoiceStatus.ISSUED, InvoiceStatus.PARTIALLY_PAID] },
      },
      orderBy: { dueDate: 'asc' },
    });

    let plan: Array<{ invoiceId: string; amount: Prisma.Decimal }> = [];

    if (input.allocations?.length) {
      const requested = round(
        input.allocations.reduce<Prisma.Decimal>((acc, a) => acc.plus(money(a.amount)), money(0)),
      );
      if (requested.greaterThan(amount)) {
        throw badRequest('Allocations exceed the payment amount');
      }
      for (const alloc of input.allocations) {
        const invoice = outstanding.find((i) => i.id === alloc.invoiceId);
        if (!invoice) {
          throw badRequest(`Invoice ${alloc.invoiceId} is not an outstanding invoice for this student`);
        }
        const value = round(alloc.amount);
        if (value.greaterThan(invoice.balance)) {
          throw badRequest(
            `Allocation of ${value.toString()} exceeds the ${invoice.balance.toString()} balance on ${invoice.invoiceNumber}`,
          );
        }
        plan.push({ invoiceId: invoice.id, amount: value });
      }
    } else {
      let remaining = amount;
      for (const invoice of outstanding) {
        if (remaining.lessThanOrEqualTo(0)) break;
        const applied = Prisma.Decimal.min(remaining, invoice.balance);
        if (applied.greaterThan(0)) {
          plan.push({ invoiceId: invoice.id, amount: round(applied) });
          remaining = remaining.minus(applied);
        }
      }
      // Anything left over stays on the account as credit; it is recorded on
      // the payment but not tied to an invoice.
      plan = plan.filter((p) => p.amount.greaterThan(0));
    }

    const receiptNumber = await nextReceiptNumber(schoolId, tx);

    const payment = await tx.payment.create({
      data: {
        schoolId,
        studentId: student.id,
        receiptNumber,
        amount,
        method: input.method,
        provider: input.provider ?? null,
        reference: input.reference ?? null,
        payerName: input.payerName ?? null,
        paidAt: input.paidAt ?? new Date(),
        note: input.note ?? null,
        receivedById,
        status: PaymentStatus.CONFIRMED,
        allocations: { create: plan.map((p) => ({ invoiceId: p.invoiceId, amount: p.amount })) },
      },
    });

    for (const p of plan) {
      await recalculateInvoice(tx, p.invoiceId);
    }

    // Fee income posts straight to the ledger (Module 11).
    await tx.ledgerEntry.create({
      data: {
        schoolId,
        entryType: LedgerEntryType.INCOME,
        category: 'Fees',
        description: `Fee payment ${receiptNumber} — ${student.firstName} ${student.lastName}`,
        amount,
        entryDate: input.paidAt ?? new Date(),
        reference: receiptNumber,
        paymentId: payment.id,
        recordedById: receivedById,
      },
    });

    const allocated = plan.reduce<Prisma.Decimal>((acc, p) => acc.plus(p.amount), money(0));

    return {
      payment,
      student,
      allocated: round(allocated),
      unallocated: round(amount.minus(allocated)),
    };
  });
}

/** Reverses a payment (bounced cheque, duplicate entry, refund). */
export async function reversePayment(schoolId: string, paymentId: string, reason: string) {
  const payment = await prisma.payment.findFirst({
    where: { id: paymentId, schoolId },
    include: { allocations: true },
  });
  if (!payment) throw notFound('Payment');
  if (payment.status === PaymentStatus.REVERSED) throw conflict('This payment is already reversed');

  return prisma.$transaction(async (tx) => {
    const invoiceIds = payment.allocations.map((a) => a.invoiceId);

    await tx.paymentAllocation.deleteMany({ where: { paymentId } });
    const updated = await tx.payment.update({
      where: { id: paymentId },
      data: { status: PaymentStatus.REVERSED, reversedAt: new Date(), reversalReason: reason },
    });

    for (const invoiceId of invoiceIds) {
      await recalculateInvoice(tx, invoiceId);
    }

    // Contra entry keeps the ledger balanced instead of deleting history.
    await tx.ledgerEntry.create({
      data: {
        schoolId,
        entryType: LedgerEntryType.EXPENSE,
        category: 'Fee Reversal',
        description: `Reversal of receipt ${payment.receiptNumber}: ${reason}`,
        amount: payment.amount,
        entryDate: new Date(),
        reference: payment.receiptNumber,
        paymentId: payment.id,
      },
    });

    return updated;
  });
}

/** Discounts, scholarships and waivers (Module 10). */
export async function applyAdjustment(
  schoolId: string,
  input: {
    studentId: string;
    invoiceId?: string | null;
    type: AdjustmentType;
    reason: string;
    amount: number;
  },
  approvedById: string | null,
) {
  const amount = round(input.amount);
  if (amount.lessThanOrEqualTo(0)) throw badRequest('Adjustment amount must be greater than zero');

  const student = await prisma.student.findFirst({ where: { id: input.studentId, schoolId } });
  if (!student) throw notFound('Student');

  if (input.invoiceId) {
    const invoice = await prisma.invoice.findFirst({
      where: { id: input.invoiceId, schoolId, studentId: input.studentId },
    });
    if (!invoice) throw notFound('Invoice');
    if (amount.greaterThan(invoice.subtotal)) {
      throw badRequest('Adjustment cannot exceed the invoice subtotal');
    }
  }

  return prisma.$transaction(async (tx) => {
    const adjustment = await tx.feeAdjustment.create({
      data: {
        studentId: input.studentId,
        invoiceId: input.invoiceId ?? null,
        type: input.type,
        reason: input.reason,
        amount,
        approvedById,
      },
    });
    if (input.invoiceId) await recalculateInvoice(tx, input.invoiceId);
    return adjustment;
  });
}

/** Outstanding balance across all of a student's invoices. */
export async function studentBalance(schoolId: string, studentId: string) {
  const invoices = await prisma.invoice.findMany({
    where: { schoolId, studentId, status: { not: InvoiceStatus.CANCELLED } },
    include: { items: true, term: { select: { name: true } } },
    orderBy: { issueDate: 'desc' },
  });

  const billed = invoices.reduce<Prisma.Decimal>((acc, i) => acc.plus(i.total), money(0));
  const paid = invoices.reduce<Prisma.Decimal>((acc, i) => acc.plus(i.amountPaid), money(0));

  const payments = await prisma.payment.findMany({
    where: { schoolId, studentId, status: PaymentStatus.CONFIRMED },
    orderBy: { paidAt: 'desc' },
  });

  return {
    summary: {
      totalBilled: round(billed).toString(),
      totalPaid: round(paid).toString(),
      balance: round(billed.minus(paid)).toString(),
      invoiceCount: invoices.length,
    },
    invoices,
    payments,
  };
}
