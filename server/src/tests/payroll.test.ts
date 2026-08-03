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

/**
 * Payroll moves DRAFT -> APPROVED -> PAID. The important property is that a
 * draft is only a proposal: it must not touch the ledger until someone signs
 * it off, or an abandoned run would overstate salary cost in the P&L.
 */
describe('payroll approval workflow', () => {
  let fixture: Fixture;
  let token: string;

  const salaryEntries = () =>
    prisma.ledgerEntry.count({
      where: { schoolId: fixture.school.id, category: 'Salaries' },
    });

  beforeAll(async () => {
    fixture = await createSchoolFixture();
    token = await login(fixture.users.accountant!.email);
  });

  afterAll(async () => {
    await destroyFixture(fixture);
    await prisma.$disconnect();
  });

  it('creates a draft that posts nothing to the ledger', async () => {
    expect(await salaryEntries()).toBe(0);

    const res = await request(app)
      .post('/api/v1/accounting/payroll')
      .set(authed(token))
      .send({ period: '2026-03', allowances: 0 });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('DRAFT');
    // The fixture has one salaried staff member.
    expect(res.body.payslips).toHaveLength(1);

    expect(await salaryEntries()).toBe(0);
  });

  it('computes gross, NSSF, PAYE and net for a payslip', async () => {
    const runs = await request(app).get('/api/v1/accounting/payroll').set(authed(token));
    const runId = runs.body.data[0].id;

    const detail = await request(app)
      .get(`/api/v1/accounting/payroll/${runId}`)
      .set(authed(token));

    const slip = detail.body.payslips[0];
    // basic 900,000, no allowance -> NSSF 10%, PAYE on the remainder.
    expect(Number(slip.basicSalary)).toBe(900_000);
    expect(Number(slip.grossPay)).toBe(900_000);
    expect(Number(slip.nssf)).toBe(90_000);
    expect(Number(slip.payeTax)).toBe(80_500);
    expect(Number(slip.netPay)).toBe(729_500);
    // Net is exactly gross less every deduction.
    expect(Number(slip.netPay)).toBe(
      Number(slip.grossPay) - Number(slip.nssf) - Number(slip.payeTax) - Number(slip.otherDeductions),
    );
  });

  it('refuses to mark a draft as paid', async () => {
    const runs = await request(app).get('/api/v1/accounting/payroll').set(authed(token));
    const runId = runs.body.data[0].id;

    const res = await request(app)
      .post(`/api/v1/accounting/payroll/${runId}/mark-paid`)
      .set(authed(token))
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('Approve');
  });

  it('posts the salary expense on approval, once', async () => {
    const runs = await request(app).get('/api/v1/accounting/payroll').set(authed(token));
    const runId = runs.body.data[0].id;

    const res = await request(app)
      .post(`/api/v1/accounting/payroll/${runId}/approve`)
      .set(authed(token));

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('APPROVED');
    expect(res.body.approvedAt).toBeTruthy();
    expect(await salaryEntries()).toBe(1);

    // Approving again must not double-book the expense.
    const again = await request(app)
      .post(`/api/v1/accounting/payroll/${runId}/approve`)
      .set(authed(token));
    expect(again.status).toBe(400);
    expect(await salaryEntries()).toBe(1);
  });

  it('marks an approved run as paid', async () => {
    const runs = await request(app).get('/api/v1/accounting/payroll').set(authed(token));
    const runId = runs.body.data[0].id;

    const res = await request(app)
      .post(`/api/v1/accounting/payroll/${runId}/mark-paid`)
      .set(authed(token))
      .send({ paymentNote: 'CRDB bulk transfer' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('PAID');
    expect(res.body.paidAt).toBeTruthy();
  });

  it('will not discard a run that has been approved', async () => {
    const runs = await request(app).get('/api/v1/accounting/payroll').set(authed(token));
    const runId = runs.body.data[0].id;

    const res = await request(app)
      .delete(`/api/v1/accounting/payroll/${runId}`)
      .set(authed(token));

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('draft');
  });

  it('discards a draft and leaves the ledger untouched', async () => {
    const before = await salaryEntries();

    const draft = await request(app)
      .post('/api/v1/accounting/payroll')
      .set(authed(token))
      .send({ period: '2026-04', allowances: 50_000 });
    expect(draft.status).toBe(201);

    const removed = await request(app)
      .delete(`/api/v1/accounting/payroll/${draft.body.id}`)
      .set(authed(token));
    expect(removed.status).toBe(204);

    expect(await salaryEntries()).toBe(before);

    const runs = await request(app).get('/api/v1/accounting/payroll').set(authed(token));
    expect(runs.body.data.map((r: { period: string }) => r.period)).not.toContain('2026-04');
  });

  it('serves a single payslip with its earnings and deductions', async () => {
    const runs = await request(app).get('/api/v1/accounting/payroll').set(authed(token));
    const runId = runs.body.data[0].id;
    const detail = await request(app)
      .get(`/api/v1/accounting/payroll/${runId}`)
      .set(authed(token));
    const payslipId = detail.body.payslips[0].id;

    const res = await request(app)
      .get(`/api/v1/accounting/payroll/${runId}/payslips/${payslipId}`)
      .set(authed(token));

    expect(res.status).toBe(200);
    expect(res.body.school.name).toContain('Test School');
    expect(res.body.staff.staffNumber).toBeTruthy();
    expect(res.body.earnings.map((e: { label: string }) => e.label)).toContain('Basic salary');
    expect(res.body.deductions.map((d: { label: string }) => d.label)).toEqual(
      expect.arrayContaining(['NSSF', 'PAYE']),
    );
    expect(res.body.totals.netFormatted).toContain('TZS');
  });

  it('keeps payroll away from roles without the permission', async () => {
    const teacherToken = await login(fixture.users.teacher!.email);

    const read = await request(app).get('/api/v1/accounting/payroll').set(authed(teacherToken));
    expect(read.status).toBe(403);

    const runs = await request(app).get('/api/v1/accounting/payroll').set(authed(token));
    const approve = await request(app)
      .post(`/api/v1/accounting/payroll/${runs.body.data[0].id}/approve`)
      .set(authed(teacherToken));
    expect(approve.status).toBe(403);
  });
});
