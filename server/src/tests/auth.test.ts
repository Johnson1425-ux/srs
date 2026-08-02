import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Role } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { hashPassword } from '../lib/tokens.js';
import {
  type Fixture,
  TEST_PASSWORD,
  app,
  authed,
  createSchoolFixture,
  destroyFixture,
  login,
} from './fixtures.js';

describe('authentication and access control', () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await createSchoolFixture();
  });

  afterAll(async () => {
    await destroyFixture(fixture);
    await prisma.$disconnect();
  });

  it('signs a user in and returns tokens plus their permissions', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: fixture.users.admin!.email, password: TEST_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
    expect(res.body.user.role).toBe('ADMIN');
    expect(res.body.user.permissions).toContain('students:manage');
    // The hash must never leave the server.
    expect(res.body.user.passwordHash).toBeUndefined();
  });

  it('rejects a wrong password without revealing whether the account exists', async () => {
    const wrongPassword = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: fixture.users.admin!.email, password: 'NotThePassword1' });

    const unknownEmail = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@nowhere.test', password: 'NotThePassword1' });

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(wrongPassword.body.error.message).toBe(unknownEmail.body.error.message);
  });

  it('refuses protected routes without a token', async () => {
    const res = await request(app).get('/api/v1/students');
    expect(res.status).toBe(401);
  });

  it('refuses a malformed token', async () => {
    const res = await request(app).get('/api/v1/students').set(authed('not-a-real-token'));
    expect(res.status).toBe(401);
  });

  it('rotates the refresh token and invalidates the old one', async () => {
    const loginRes = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: fixture.users.teacher!.email, password: TEST_PASSWORD });
    const original = loginRes.body.refreshToken as string;

    const refreshed = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: original });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.accessToken).toBeTruthy();

    // Re-using the consumed token must fail.
    const replay = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: original });
    expect(replay.status).toBe(401);
  });

  it('returns the caller profile from /auth/me', async () => {
    const token = await login(fixture.users.teacher!.email);
    const res = await request(app).get('/api/v1/auth/me').set(authed(token));

    expect(res.status).toBe(200);
    expect(res.body.email).toBe(fixture.users.teacher!.email);
    expect(res.body.school.code).toBe(fixture.school.code);
  });

  it('revokes the session on logout', async () => {
    const loginRes = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: fixture.users.librarian!.email, password: TEST_PASSWORD });
    const { accessToken, refreshToken } = loginRes.body;

    await request(app).post('/api/v1/auth/logout').set(authed(accessToken)).send({ refreshToken });

    const res = await request(app).post('/api/v1/auth/refresh').send({ refreshToken });
    expect(res.status).toBe(401);
  });

  it('issues a working password reset token', async () => {
    const forgot = await request(app)
      .post('/api/v1/auth/forgot-password')
      .send({ email: fixture.users.owner!.email, schoolCode: fixture.school.code });

    expect(forgot.status).toBe(200);
    const token = forgot.body.devToken as string;
    expect(token).toBeTruthy();

    const reset = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token, password: 'BrandNewPass9' });
    expect(reset.status).toBe(200);

    const signIn = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: fixture.users.owner!.email, password: 'BrandNewPass9' });
    expect(signIn.status).toBe(200);

    // The token is single-use.
    const replay = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token, password: 'AnotherPass9' });
    expect(replay.status).toBe(400);
  });

  it('does not reveal whether an unknown address is registered', async () => {
    const res = await request(app)
      .post('/api/v1/auth/forgot-password')
      .send({ email: 'ghost@nowhere.test' });

    expect(res.status).toBe(200);
    expect(res.body.devToken).toBeNull();
  });

  it('enforces password strength on reset', async () => {
    const res = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token: 'irrelevant', password: 'weak' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });
});

describe('role-based permissions', () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await createSchoolFixture();
  });

  afterAll(async () => {
    await destroyFixture(fixture);
  });

  it('lets an administrator admit a student', async () => {
    const token = await login(fixture.users.admin!.email);
    const res = await request(app)
      .post('/api/v1/students')
      .set(authed(token))
      .send({
        firstName: 'New',
        lastName: 'Admission',
        gender: 'MALE',
        dateOfBirth: '2013-03-02',
        classId: fixture.classId,
        streamId: fixture.streamId,
      });

    expect(res.status).toBe(201);
    expect(res.body.student.admissionNumber).toContain(fixture.school.code);
  });

  it('blocks a teacher from admitting a student but allows reading them', async () => {
    const token = await login(fixture.users.teacher!.email);

    const write = await request(app)
      .post('/api/v1/students')
      .set(authed(token))
      .send({
        firstName: 'Should',
        lastName: 'Fail',
        gender: 'FEMALE',
        dateOfBirth: '2013-03-02',
        classId: fixture.classId,
      });
    expect(write.status).toBe(403);

    const read = await request(app).get('/api/v1/students').set(authed(token));
    expect(read.status).toBe(200);
  });

  it('gives the school owner read access but no write access', async () => {
    const token = await login(fixture.users.owner!.email);

    const read = await request(app).get('/api/v1/students').set(authed(token));
    expect(read.status).toBe(200);

    const write = await request(app)
      .post('/api/v1/academics/classes')
      .set(authed(token))
      .send({ name: 'Form 9', level: 9 });
    expect(write.status).toBe(403);
  });

  it('keeps the accountant out of academic write operations', async () => {
    const token = await login(fixture.users.accountant!.email);

    const marks = await request(app)
      .post('/api/v1/exams')
      .set(authed(token))
      .send({
        academicYearId: fixture.academicYearId,
        name: 'Nope',
        examType: 'MIDTERM',
        subjects: [{ subjectId: fixture.subjectIds[0]!, maxScore: 100 }],
      });

    expect(marks.status).toBe(403);
  });

  /**
   * Several roles never touch academics directly but cannot do their own job
   * without reading classes and terms — an accountant billing a class, a
   * receptionist choosing a class at admission. Regression guard for a bug
   * where those screens 403'd on their own dropdowns.
   */
  it('lets support roles read the academic structure they depend on', async () => {
    for (const key of ['accountant', 'librarian'] as const) {
      const token = await login(fixture.users[key]!.email);

      const classes = await request(app).get('/api/v1/academics/classes').set(authed(token));
      expect(classes.status, `${key} should read classes`).toBe(200);

      const years = await request(app).get('/api/v1/academics/years').set(authed(token));
      expect(years.status, `${key} should read academic years`).toBe(200);
    }
  });

  it('still blocks those roles from changing the academic structure', async () => {
    const token = await login(fixture.users.accountant!.email);
    const res = await request(app)
      .post('/api/v1/academics/classes')
      .set(authed(token))
      .send({ name: 'Form 8', level: 8 });

    expect(res.status).toBe(403);
  });

  it('denies platform administration to school-level roles', async () => {
    const token = await login(fixture.users.admin!.email);
    const res = await request(app).get('/api/v1/platform/schools').set(authed(token));
    expect(res.status).toBe(403);
  });
});

/**
 * Platform staff belong to no school, so school-scoped routes have no tenant to
 * infer until they name one. The UI drives this with a school switcher; these
 * tests pin down the contract it depends on.
 */
describe('super admin school context', () => {
  let fixture: Fixture;
  let token: string;

  beforeAll(async () => {
    fixture = await createSchoolFixture();
    const passwordHash = await hashPassword(TEST_PASSWORD);
    await prisma.user.create({
      data: {
        schoolId: null,
        email: `root@${fixture.school.code.toLowerCase()}.test`,
        firstName: 'Platform',
        lastName: 'Admin',
        role: Role.SUPER_ADMIN,
        passwordHash,
      },
    });
    token = await login(`root@${fixture.school.code.toLowerCase()}.test`);
  });

  afterAll(async () => {
    await prisma.user.deleteMany({
      where: { email: `root@${fixture.school.code.toLowerCase()}.test` },
    });
    await destroyFixture(fixture);
  });

  it('reaches platform routes without naming a school', async () => {
    const res = await request(app).get('/api/v1/platform/schools').set(authed(token));
    expect(res.status).toBe(200);
  });

  it('refuses school-scoped routes until a school is chosen', async () => {
    const res = await request(app).get('/api/v1/students').set(authed(token));

    expect(res.status).toBe(403);
    expect(res.body.error.message).toContain('X-School-Id');
  });

  it('works inside a school once the header names one', async () => {
    const res = await request(app)
      .get('/api/v1/students')
      .set(authed(token))
      .set('X-School-Id', fixture.school.id);

    expect(res.status).toBe(200);
    const ids = res.body.data.map((s: { id: string }) => s.id);
    expect(ids).toEqual(expect.arrayContaining(fixture.students.map((s) => s.id)));
  });

  it('ignores the header for anyone who is not platform staff', async () => {
    const other = await createSchoolFixture();
    const schoolToken = await login(fixture.users.admin!.email);

    // A school admin pointing at another tenant stays pinned to their own.
    const res = await request(app)
      .get('/api/v1/students?pageSize=100')
      .set(authed(schoolToken))
      .set('X-School-Id', other.school.id);

    expect(res.status).toBe(200);
    const ids = res.body.data.map((s: { id: string }) => s.id);
    for (const student of other.students) {
      expect(ids).not.toContain(student.id);
    }

    await destroyFixture(other);
  });
});

describe('tenant isolation', () => {
  let schoolA: Fixture;
  let schoolB: Fixture;

  beforeAll(async () => {
    schoolA = await createSchoolFixture();
    schoolB = await createSchoolFixture();
  });

  afterAll(async () => {
    await destroyFixture(schoolA);
    await destroyFixture(schoolB);
  });

  it('shows a school only its own students', async () => {
    const token = await login(schoolA.users.admin!.email);
    const res = await request(app).get('/api/v1/students?pageSize=100').set(authed(token));

    expect(res.status).toBe(200);
    const ids = res.body.data.map((s: { id: string }) => s.id);
    expect(ids).toEqual(expect.arrayContaining(schoolA.students.map((s) => s.id)));
    for (const student of schoolB.students) {
      expect(ids).not.toContain(student.id);
    }
  });

  it('returns 404 when reaching for another school\'s student by id', async () => {
    const token = await login(schoolA.users.admin!.email);
    const res = await request(app)
      .get(`/api/v1/students/${schoolB.students[0]!.id}`)
      .set(authed(token));

    expect(res.status).toBe(404);
  });

  it('refuses to record a payment against another school\'s student', async () => {
    const token = await login(schoolA.users.accountant!.email);
    const res = await request(app)
      .post('/api/v1/payments')
      .set(authed(token))
      .send({ studentId: schoolB.students[0]!.id, amount: 10_000, method: 'CASH' });

    expect(res.status).toBe(404);
  });

  it('will not attach a class from another school to an exam', async () => {
    const token = await login(schoolA.users.admin!.email);
    const res = await request(app)
      .post('/api/v1/exams')
      .set(authed(token))
      .send({
        academicYearId: schoolA.academicYearId,
        classId: schoolA.classId,
        name: 'Cross-tenant subject',
        examType: 'MIDTERM',
        subjects: [{ subjectId: schoolB.subjectIds[0]!, maxScore: 100 }],
      });

    expect(res.status).toBe(400);
  });
});
