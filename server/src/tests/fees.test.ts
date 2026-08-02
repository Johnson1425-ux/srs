import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { prisma } from '../db/prisma.js';
import {
  type Fixture,
  app,
  authed,
  createSchoolFixture,
  destroyFixture,
  login,
} from './fixtures.js';

describe('fee management', () => {
  let fixture: Fixture;
  let token: string;
  let structureId: string;

  beforeAll(async () => {
    fixture = await createSchoolFixture();
    token = await login(fixture.users.accountant!.email);

    const res = await request(app)
      .post('/api/v1/fees/structures')
      .set(authed(token))
      .send({
        academicYearId: fixture.academicYearId,
        termId: fixture.termId,
        classId: fixture.classId,
        name: 'Form 1 — Term 1',
        items: [
          { category: 'TUITION', name: 'Tuition', amount: 400_000 },
          { category: 'MEALS', name: 'Lunch', amount: 100_000 },
        ],
      });
    expect(res.status).toBe(201);
    structureId = res.body.id;
  });

  afterAll(async () => {
    await destroyFixture(fixture);
    await prisma.$disconnect();
  });

  it('bills every student in the class exactly once', async () => {
    const first = await request(app)
      .post(`/api/v1/fees/structures/${structureId}/generate-invoices`)
      .set(authed(token))
      .send({ dueDate: '2026-03-01' });

    expect(first.status).toBe(201);
    expect(first.body.generated).toBe(fixture.students.length);

    // Re-running must not double-bill anyone.
    const second = await request(app)
      .post(`/api/v1/fees/structures/${structureId}/generate-invoices`)
      .set(authed(token))
      .send({ dueDate: '2026-03-01' });

    expect(second.body.generated).toBe(0);
    expect(second.body.skipped).toBe(fixture.students.length);
  });

  it('totals the invoice from its line items', async () => {
    const res = await request(app)
      .get(`/api/v1/invoices?studentId=${fixture.students[0]!.id}`)
      .set(authed(token));

    expect(res.status).toBe(200);
    const invoice = res.body.data[0];
    expect(Number(invoice.subtotal)).toBe(500_000);
    expect(Number(invoice.total)).toBe(500_000);
    expect(Number(invoice.balance)).toBe(500_000);
    expect(invoice.status).toBe('ISSUED');
  });

  it('applies a partial payment and leaves the correct balance', async () => {
    const studentId = fixture.students[0]!.id;

    const res = await request(app)
      .post('/api/v1/payments')
      .set(authed(token))
      .send({
        studentId,
        amount: 200_000,
        method: 'MOBILE_MONEY',
        provider: 'MPESA',
        reference: 'QWE123456',
        payerName: 'Guardian One',
      });

    expect(res.status).toBe(201);
    expect(res.body.payment.receiptNumber).toMatch(/^RCT-\d{4}-\d{5}$/);
    expect(Number(res.body.allocated)).toBe(200_000);
    expect(Number(res.body.unallocated)).toBe(0);

    const balance = await request(app)
      .get(`/api/v1/fees/students/${studentId}/balance`)
      .set(authed(token));

    expect(Number(balance.body.summary.totalBilled)).toBe(500_000);
    expect(Number(balance.body.summary.totalPaid)).toBe(200_000);
    expect(Number(balance.body.summary.balance)).toBe(300_000);
    expect(balance.body.invoices[0].status).toBe('PARTIALLY_PAID');
  });

  it('marks the invoice paid once settled in full', async () => {
    const studentId = fixture.students[0]!.id;

    await request(app)
      .post('/api/v1/payments')
      .set(authed(token))
      .send({ studentId, amount: 300_000, method: 'BANK', reference: 'SLIP-77' });

    const balance = await request(app)
      .get(`/api/v1/fees/students/${studentId}/balance`)
      .set(authed(token));

    expect(Number(balance.body.summary.balance)).toBe(0);
    expect(balance.body.invoices[0].status).toBe('PAID');
  });

  it('records overpayment as unallocated credit rather than a negative balance', async () => {
    const studentId = fixture.students[1]!.id;

    const res = await request(app)
      .post('/api/v1/payments')
      .set(authed(token))
      .send({ studentId, amount: 600_000, method: 'CASH' });

    expect(res.status).toBe(201);
    expect(Number(res.body.allocated)).toBe(500_000);
    expect(Number(res.body.unallocated)).toBe(100_000);

    const balance = await request(app)
      .get(`/api/v1/fees/students/${studentId}/balance`)
      .set(authed(token));
    expect(Number(balance.body.summary.balance)).toBe(0);
  });

  it('rejects a zero or negative payment', async () => {
    const res = await request(app)
      .post('/api/v1/payments')
      .set(authed(token))
      .send({ studentId: fixture.students[2]!.id, amount: 0, method: 'CASH' });

    expect(res.status).toBe(400);
  });

  it('rejects an allocation larger than the invoice balance', async () => {
    const studentId = fixture.students[2]!.id;
    const invoices = await request(app)
      .get(`/api/v1/invoices?studentId=${studentId}`)
      .set(authed(token));
    const invoiceId = invoices.body.data[0].id;

    const res = await request(app)
      .post('/api/v1/payments')
      .set(authed(token))
      .send({
        studentId,
        amount: 900_000,
        method: 'CASH',
        allocations: [{ invoiceId, amount: 900_000 }],
      });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('exceeds');
  });

  it('reduces the invoice total when a discount is applied', async () => {
    const studentId = fixture.students[2]!.id;
    const invoices = await request(app)
      .get(`/api/v1/invoices?studentId=${studentId}`)
      .set(authed(token));
    const invoiceId = invoices.body.data[0].id;

    const res = await request(app)
      .post('/api/v1/fees/adjustments')
      .set(authed(token))
      .send({
        studentId,
        invoiceId,
        type: 'SCHOLARSHIP',
        reason: 'Academic merit award',
        amount: 150_000,
      });
    expect(res.status).toBe(201);

    const invoice = await request(app).get(`/api/v1/invoices/${invoiceId}`).set(authed(token));
    expect(Number(invoice.body.discountTotal)).toBe(150_000);
    expect(Number(invoice.body.total)).toBe(350_000);
    expect(Number(invoice.body.balance)).toBe(350_000);
  });

  it('restores the balance when a payment is reversed', async () => {
    const studentId = fixture.students[2]!.id;

    const payment = await request(app)
      .post('/api/v1/payments')
      .set(authed(token))
      .send({ studentId, amount: 350_000, method: 'CASH' });
    expect(payment.status).toBe(201);

    const settled = await request(app)
      .get(`/api/v1/fees/students/${studentId}/balance`)
      .set(authed(token));
    expect(Number(settled.body.summary.balance)).toBe(0);

    const reversal = await request(app)
      .post(`/api/v1/payments/${payment.body.payment.id}/reverse`)
      .set(authed(token))
      .send({ reason: 'Cheque bounced' });
    expect(reversal.status).toBe(200);
    expect(reversal.body.status).toBe('REVERSED');

    const after = await request(app)
      .get(`/api/v1/fees/students/${studentId}/balance`)
      .set(authed(token));
    expect(Number(after.body.summary.balance)).toBe(350_000);
  });

  it('will not reverse the same payment twice', async () => {
    const payment = await request(app)
      .post('/api/v1/payments')
      .set(authed(token))
      .send({ studentId: fixture.students[2]!.id, amount: 50_000, method: 'CASH' });

    const first = await request(app)
      .post(`/api/v1/payments/${payment.body.payment.id}/reverse`)
      .set(authed(token))
      .send({ reason: 'Duplicate entry' });
    expect(first.status).toBe(200);

    const second = await request(app)
      .post(`/api/v1/payments/${payment.body.payment.id}/reverse`)
      .set(authed(token))
      .send({ reason: 'Duplicate entry' });
    expect(second.status).toBe(409);
  });

  it('produces a printable receipt', async () => {
    const payment = await request(app)
      .post('/api/v1/payments')
      .set(authed(token))
      .send({ studentId: fixture.students[2]!.id, amount: 25_000, method: 'CASH' });

    const res = await request(app)
      .get(`/api/v1/payments/${payment.body.payment.id}/receipt`)
      .set(authed(token));

    expect(res.status).toBe(200);
    expect(res.body.receipt.number).toBe(payment.body.payment.receiptNumber);
    expect(res.body.receipt.amountFormatted).toBe('TZS 25,000.00');
    expect(res.body.student.admissionNumber).toBe(fixture.students[2]!.admissionNumber);
    expect(res.body.school.name).toContain('Test School');
  });

  it('posts fee income to the general ledger', async () => {
    const adminToken = await login(fixture.users.admin!.email);
    const res = await request(app)
      .get('/api/v1/accounting/ledger?entryType=INCOME&pageSize=100')
      .set(authed(adminToken));

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.data.every((e: { category: string }) => e.category === 'Fees')).toBe(true);
  });

  it('lists outstanding balances with a school-wide total', async () => {
    const res = await request(app).get('/api/v1/fees/outstanding').set(authed(token));

    expect(res.status).toBe(200);
    expect(Number(res.body.totalOutstanding)).toBeGreaterThan(0);
  });

  it('exports fee collection as CSV', async () => {
    const res = await request(app)
      .get('/api/v1/reports/fee-collection?from=2026-01-01&to=2026-12-31&format=csv')
      .set(authed(token));

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text).toContain('Receipt No,Date,Admission No');
  });
});
