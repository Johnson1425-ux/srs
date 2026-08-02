import { Gender, type PrismaClient, Role, StaffType } from '@prisma/client';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../app.js';
import { prisma } from '../db/prisma.js';
import { hashPassword } from '../lib/tokens.js';

export const TEST_PASSWORD = 'Passw0rd!';

export const app: Express = createApp();

let counter = 0;
/** Unique-per-call suffix so parallel fixtures never collide on unique keys. */
export function uid(): string {
  counter += 1;
  return `${Date.now().toString(36)}${counter}`;
}

export interface Fixture {
  school: { id: string; code: string };
  academicYearId: string;
  termId: string;
  classId: string;
  streamId: string;
  subjectIds: string[];
  gradeScaleId: string;
  students: Array<{ id: string; admissionNumber: string }>;
  teacherStaffId: string;
  users: Record<string, { id: string; email: string }>;
}

/**
 * Builds a self-contained school with the setup every module test needs:
 * a current academic year, one class/stream, subjects, a grading scale,
 * three students, and one user per role under test.
 */
export async function createSchoolFixture(db: PrismaClient = prisma): Promise<Fixture> {
  const suffix = uid();
  const code = `T${suffix.slice(-6).toUpperCase()}`;
  const passwordHash = await hashPassword(TEST_PASSWORD);

  const school = await db.school.create({
    data: {
      name: `Test School ${suffix}`,
      code,
      status: 'ACTIVE',
      plan: 'STANDARD',
      maxStudents: 2000,
    },
  });

  const year = await db.academicYear.create({
    data: {
      schoolId: school.id,
      name: `Y${suffix}`,
      startDate: new Date('2026-01-10'),
      endDate: new Date('2026-12-05'),
      isCurrent: true,
      terms: {
        create: [
          { name: 'Term 1', sequence: 1, startDate: new Date('2026-01-10'), endDate: new Date('2026-04-10'), status: 'ACTIVE' },
        ],
      },
    },
    include: { terms: true },
  });

  const gradeScale = await db.gradeScale.create({
    data: {
      schoolId: school.id,
      name: 'Standard',
      isDefault: true,
      bands: {
        create: [
          { grade: 'A', minScore: 75, maxScore: 100, points: 5, remark: 'Excellent' },
          { grade: 'B', minScore: 65, maxScore: 74.99, points: 4, remark: 'Very Good' },
          { grade: 'C', minScore: 45, maxScore: 64.99, points: 3, remark: 'Good' },
          { grade: 'D', minScore: 30, maxScore: 44.99, points: 2, remark: 'Pass' },
          { grade: 'F', minScore: 0, maxScore: 29.99, points: 1, remark: 'Fail' },
        ],
      },
    },
  });

  const schoolClass = await db.schoolClass.create({
    data: {
      schoolId: school.id,
      name: 'Form 1',
      level: 1,
      streams: { create: [{ name: 'A', capacity: 40 }] },
    },
    include: { streams: true },
  });
  const stream = schoolClass.streams[0]!;

  const subjects = await Promise.all(
    [
      { name: 'Mathematics', code: 'MTH' },
      { name: 'English', code: 'ENG' },
    ].map((s) => db.subject.create({ data: { ...s, schoolId: school.id } })),
  );

  // One user per role we exercise in tests.
  const roleSpecs: Array<[string, Role]> = [
    ['admin', Role.ADMIN],
    ['accountant', Role.ACCOUNTANT],
    ['teacher', Role.TEACHER],
    ['owner', Role.SCHOOL_OWNER],
    ['librarian', Role.LIBRARIAN],
  ];

  const users: Fixture['users'] = {};
  for (const [key, role] of roleSpecs) {
    const user = await db.user.create({
      data: {
        schoolId: school.id,
        email: `${key}@${code.toLowerCase()}.test`,
        firstName: key,
        lastName: 'User',
        role,
        passwordHash,
      },
    });
    users[key] = { id: user.id, email: user.email };
  }

  const teacherStaff = await db.staff.create({
    data: {
      schoolId: school.id,
      userId: users.teacher!.id,
      staffNumber: `EMP-${suffix.slice(-4)}`,
      firstName: 'Teacher',
      lastName: 'User',
      gender: Gender.FEMALE,
      staffType: StaffType.TEACHING,
      basicSalary: 900_000,
    },
  });

  const students = [];
  for (let i = 1; i <= 3; i += 1) {
    const student = await db.student.create({
      data: {
        schoolId: school.id,
        admissionNumber: `${code}/2026/000${i}`,
        firstName: `Student${i}`,
        lastName: 'Test',
        gender: i % 2 === 0 ? Gender.FEMALE : Gender.MALE,
        dateOfBirth: new Date('2012-05-14'),
        enrollments: {
          create: { academicYearId: year.id, classId: schoolClass.id, streamId: stream.id },
        },
      },
    });
    students.push({ id: student.id, admissionNumber: student.admissionNumber });
  }

  return {
    school: { id: school.id, code: school.code },
    academicYearId: year.id,
    termId: year.terms[0]!.id,
    classId: schoolClass.id,
    streamId: stream.id,
    subjectIds: subjects.map((s) => s.id),
    gradeScaleId: gradeScale.id,
    students,
    teacherStaffId: teacherStaff.id,
    users,
  };
}

/** Signs in and returns the access token. */
export async function login(email: string, schoolCode?: string): Promise<string> {
  const res = await request(app)
    .post('/api/v1/auth/login')
    .send({ email, password: TEST_PASSWORD, ...(schoolCode ? { schoolCode } : {}) });

  if (res.status !== 200) {
    throw new Error(`Login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.accessToken as string;
}

export function authed(token: string) {
  return { Authorization: `Bearer ${token}` };
}

/** Removes a fixture's school; cascades clear everything beneath it. */
export async function destroyFixture(fixture: Fixture, db: PrismaClient = prisma): Promise<void> {
  await db.school.deleteMany({ where: { id: fixture.school.id } });
}
