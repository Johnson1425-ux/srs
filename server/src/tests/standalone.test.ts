/**
 * Standalone-mode behaviour.
 *
 * The mode is read once when the config module loads, so this suite sets it
 * before importing anything and relies on vitest isolating the module registry
 * per test file. Everything here is therefore imported dynamically.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Gender, PrismaClient, Role, StudentStatus } from '@prisma/client';
import argon2 from 'argon2';

process.env.DEPLOYMENT_MODE = 'standalone';

const { createApp } = await import('../app.js');
const app = createApp();

const prisma = new PrismaClient();
const PASSWORD = 'Passw0rd!';

let schoolId: string;
let adminEmail: string;
let classId: string;
let token: string;

beforeAll(async () => {
  const suffix = Date.now().toString(36);
  const code = `SA${suffix.slice(-6).toUpperCase()}`;
  adminEmail = `owner@${code.toLowerCase()}.test`;

  const school = await prisma.school.create({
    data: {
      name: `Standalone School ${suffix}`,
      code,
      status: 'ACTIVE',
      // Deliberately tiny: in SaaS mode this would block the second admission.
      maxStudents: 1,
    },
  });
  schoolId = school.id;

  await prisma.academicYear.create({
    data: {
      schoolId,
      name: `Y${suffix}`,
      startDate: new Date('2026-01-10'),
      endDate: new Date('2026-12-05'),
      isCurrent: true,
    },
  });

  const schoolClass = await prisma.schoolClass.create({
    data: { schoolId, name: 'Form 1', level: 1 },
  });
  classId = schoolClass.id;

  await prisma.user.create({
    data: {
      schoolId,
      email: adminEmail,
      firstName: 'Owner',
      lastName: 'Admin',
      role: Role.ADMIN,
      passwordHash: await argon2.hash(PASSWORD, { type: argon2.argon2id }),
    },
  });

  const res = await request(app)
    .post('/api/v1/auth/login')
    .send({ email: adminEmail, password: PASSWORD });
  expect(res.status).toBe(200);
  token = res.body.accessToken;
});

afterAll(async () => {
  await prisma.school.deleteMany({ where: { id: schoolId } });
  await prisma.$disconnect();
});

const authed = () => ({ Authorization: `Bearer ${token}` });

describe('standalone deployment mode', () => {
  it('does not mount platform administration at all', async () => {
    const res = await request(app).get('/api/v1/platform/schools').set(authed());

    // Not 403 — the routes genuinely do not exist in this build.
    expect(res.status).toBe(404);
  });

  it('reports the mode on the profile so the UI can adapt', async () => {
    const res = await request(app).get('/api/v1/auth/me').set(authed());

    expect(res.status).toBe(200);
    expect(res.body.deploymentMode).toBe('standalone');
  });

  it('ignores the subscription student cap', async () => {
    // maxStudents is 1, so a second admission would be refused under SaaS.
    for (const n of [1, 2, 3]) {
      const res = await request(app)
        .post('/api/v1/students')
        .set(authed())
        .send({
          firstName: `Learner${n}`,
          lastName: 'Standalone',
          gender: Gender.MALE,
          dateOfBirth: '2013-04-04',
          classId,
        });

      expect(res.status, `admission ${n} should succeed`).toBe(201);
    }

    const count = await prisma.student.count({
      where: { schoolId, status: StudentStatus.ACTIVE },
    });
    expect(count).toBe(3);
  });

  it('still enforces ordinary school-level permissions', async () => {
    // Relaxing plan limits must not relax role checks.
    const teacherEmail = `teacher@${adminEmail.split('@')[1]}`;
    await prisma.user.create({
      data: {
        schoolId,
        email: teacherEmail,
        firstName: 'Teacher',
        lastName: 'Standalone',
        role: Role.TEACHER,
        passwordHash: await argon2.hash(PASSWORD, { type: argon2.argon2id }),
      },
    });

    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: teacherEmail, password: PASSWORD });

    const res = await request(app)
      .post('/api/v1/students')
      .set({ Authorization: `Bearer ${login.body.accessToken}` })
      .send({
        firstName: 'Should',
        lastName: 'Fail',
        gender: Gender.FEMALE,
        dateOfBirth: '2013-04-04',
        classId,
      });

    expect(res.status).toBe(403);
  });
});
