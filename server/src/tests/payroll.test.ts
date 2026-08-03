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

  it('adds each person\'s own allowances and itemises them on the payslip', async () => {
    const adminToken = await login(fixture.users.admin!.email);

    for (const [name, amount] of [
      ['Housing', 200_000],
      ['Transport', 60_000],
    ] as const) {
      const res = await request(app)
        .post(`/api/v1/staff/${fixture.teacherStaffId}/allowances`)
        .set(authed(token))
        .send({ name, amount });
      expect(res.status).toBe(201);
    }

    const listed = await request(app)
      .get(`/api/v1/staff/${fixture.teacherStaffId}/allowances`)
      .set(authed(adminToken));
    expect(Number(listed.body.monthlyAllowanceTotal)).toBe(260_000);

    const run = await request(app)
      .post('/api/v1/accounting/payroll')
      .set(authed(token))
      .send({ period: '2026-05', allowances: 0 });
    expect(run.status).toBe(201);

    const slip = run.body.payslips[0];
    // 900,000 basic + 260,000 allowances.
    expect(Number(slip.allowances)).toBe(260_000);
    expect(Number(slip.grossPay)).toBe(1_160_000);

    const detail = await request(app)
      .get(`/api/v1/accounting/payroll/${run.body.id}/payslips/${slip.id}`)
      .set(authed(token));
    const labels = detail.body.earnings.map((e: { label: string }) => e.label);
    expect(labels).toEqual(expect.arrayContaining(['Basic salary', 'Housing', 'Transport']));

    await request(app).delete(`/api/v1/accounting/payroll/${run.body.id}`).set(authed(token));
  });

  it('keeps a payslip itemised at the rates that applied when it was run', async () => {
    const run = await request(app)
      .post('/api/v1/accounting/payroll')
      .set(authed(token))
      .send({ period: '2026-06', allowances: 0 });
    const slipId = run.body.payslips[0].id;

    // Change the rate after the run.
    await request(app)
      .post(`/api/v1/staff/${fixture.teacherStaffId}/allowances`)
      .set(authed(token))
      .send({ name: 'Housing', amount: 999_000 });

    const detail = await request(app)
      .get(`/api/v1/accounting/payroll/${run.body.id}/payslips/${slipId}`)
      .set(authed(token));

    const housing = detail.body.earnings.find((e: { label: string }) => e.label === 'Housing');
    expect(Number(housing.amount)).toBe(200_000);

    await request(app).delete(`/api/v1/accounting/payroll/${run.body.id}`).set(authed(token));
  });

  it('drops terminated staff from later payroll runs', async () => {
    const adminToken = await login(fixture.users.admin!.email);

    const res = await request(app)
      .post(`/api/v1/staff/${fixture.teacherStaffId}/status`)
      .set(authed(adminToken))
      .send({ employmentStatus: 'TERMINATED', reason: 'Resigned' });
    expect(res.status).toBe(200);

    const run = await request(app)
      .post('/api/v1/accounting/payroll')
      .set(authed(token))
      .send({ period: '2026-07', allowances: 0 });

    // The only salaried staff member has left, so there is nobody to pay.
    expect(run.status).toBe(400);
    expect(run.body.error.message).toContain('basic salary');
  });

  it('closes system access when a staff member is terminated', async () => {
    const staff = await prisma.staff.findUniqueOrThrow({
      where: { id: fixture.teacherStaffId },
      select: { userId: true, employmentStatus: true, statusReason: true },
    });
    expect(staff.employmentStatus).toBe('TERMINATED');
    expect(staff.statusReason).toBe('Resigned');

    const user = await prisma.user.findUniqueOrThrow({ where: { id: staff.userId! } });
    expect(user.status).toBe('DISABLED');

    // And the login no longer works.
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: fixture.users.teacher!.email, password: 'Passw0rd!' });
    expect(res.status).toBe(403);
  });

  it('keeps payroll away from roles without the permission', async () => {
    // Deliberately not the teacher: an earlier test terminates them, which
    // disables the login. The librarian is equally without payroll rights.
    const librarianToken = await login(fixture.users.librarian!.email);

    const read = await request(app).get('/api/v1/accounting/payroll').set(authed(librarianToken));
    expect(read.status).toBe(403);

    const runs = await request(app).get('/api/v1/accounting/payroll').set(authed(token));
    const approve = await request(app)
      .post(`/api/v1/accounting/payroll/${runs.body.data[0].id}/approve`)
      .set(authed(librarianToken));
    expect(approve.status).toBe(403);

    const allowance = await request(app)
      .post(`/api/v1/staff/${fixture.teacherStaffId}/allowances`)
      .set(authed(librarianToken))
      .send({ name: 'Sneaky', amount: 1_000_000 });
    expect(allowance.status).toBe(403);
  });
});
