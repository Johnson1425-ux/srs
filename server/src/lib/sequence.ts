import type { Tx } from '../db/prisma.js';
import { prisma } from '../db/prisma.js';

function pad(n: number, width = 5): string {
  return String(n).padStart(width, '0');
}

/**
 * Human-readable document numbers scoped per school and year, e.g.
 * `INV-2026-00042`, `RCT-2026-00317`, `ADM/2026/0104`.
 *
 * Uniqueness is ultimately guaranteed by the composite unique indexes on
 * (schoolId, invoiceNumber) / (schoolId, receiptNumber) / (schoolId,
 * admissionNumber); this helper just picks the next free value, and callers
 * retry on the rare collision under concurrency.
 */

export async function nextInvoiceNumber(schoolId: string, tx: Tx = prisma): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `INV-${year}-`;
  const last = await tx.invoice.findFirst({
    where: { schoolId, invoiceNumber: { startsWith: prefix } },
    orderBy: { invoiceNumber: 'desc' },
    select: { invoiceNumber: true },
  });
  const seq = last ? Number(last.invoiceNumber.slice(prefix.length)) + 1 : 1;
  return `${prefix}${pad(seq)}`;
}

export async function nextReceiptNumber(schoolId: string, tx: Tx = prisma): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `RCT-${year}-`;
  const last = await tx.payment.findFirst({
    where: { schoolId, receiptNumber: { startsWith: prefix } },
    orderBy: { receiptNumber: 'desc' },
    select: { receiptNumber: true },
  });
  const seq = last ? Number(last.receiptNumber.slice(prefix.length)) + 1 : 1;
  return `${prefix}${pad(seq)}`;
}

export async function nextAdmissionNumber(schoolId: string, tx: Tx = prisma): Promise<string> {
  const school = await tx.school.findUniqueOrThrow({
    where: { id: schoolId },
    select: { code: true },
  });
  const year = new Date().getFullYear();
  const prefix = `${school.code}/${year}/`;
  const last = await tx.student.findFirst({
    where: { schoolId, admissionNumber: { startsWith: prefix } },
    orderBy: { admissionNumber: 'desc' },
    select: { admissionNumber: true },
  });
  const seq = last ? Number(last.admissionNumber.slice(prefix.length)) + 1 : 1;
  return `${prefix}${pad(seq, 4)}`;
}

export async function nextStaffNumber(schoolId: string, tx: Tx = prisma): Promise<string> {
  const prefix = 'EMP-';
  const last = await tx.staff.findFirst({
    where: { schoolId, staffNumber: { startsWith: prefix } },
    orderBy: { staffNumber: 'desc' },
    select: { staffNumber: true },
  });
  const seq = last ? Number(last.staffNumber.slice(prefix.length)) + 1 : 1;
  return `${prefix}${pad(seq, 4)}`;
}

export async function nextOrderNumber(schoolId: string, tx: Tx = prisma): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `PO-${year}-`;
  const last = await tx.purchaseOrder.findFirst({
    where: { schoolId, orderNumber: { startsWith: prefix } },
    orderBy: { orderNumber: 'desc' },
    select: { orderNumber: true },
  });
  const seq = last ? Number(last.orderNumber.slice(prefix.length)) + 1 : 1;
  return `${prefix}${pad(seq, 4)}`;
}
