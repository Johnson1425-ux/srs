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

/**
 * The portal is the one place where non-staff users read school data, so these
 * tests pin down exactly whose records each caller can reach.
 */
describe('parent and student portals', () => {
  let fixture: Fixture;
  let parentEmail: string;
  let studentEmail: string;
  /** The child linked to the parent, and one that is not. */
  let ownChildId: string;
  let otherChildId: string;

  beforeAll(async () => {
    fixture = await createSchoolFixture();
    const passwordHash = await hashPassword(TEST_PASSWORD);
    const code = fixture.school.code.toLowerCase();

    ownChildId = fixture.students[0]!.id;
    otherChildId = fixture.students[1]!.id;

    parentEmail = `parent@${code}.test`;
    const parentUser = await prisma.user.create({
      data: {
        schoolId: fixture.school.id,
        email: parentEmail,
        firstName: 'Parent',
        lastName: 'User',
        role: Role.PARENT,
        passwordHash,
      },
    });
    const guardian = await prisma.guardian.create({
      data: {
        schoolId: fixture.school.id,
        userId: parentUser.id,
        firstName: 'Parent',
        lastName: 'User',
        relationship: 'Father',
        phone: '0755000111',
      },
    });
    await prisma.studentGuardian.create({
      data: { studentId: ownChildId, guardianId: guardian.id, isPrimary: true, isFeePayer: true },
    });

    studentEmail = `learner@${code}.test`;
    const studentUser = await prisma.user.create({
      data: {
        schoolId: fixture.school.id,
        email: studentEmail,
        firstName: 'Student1',
        lastName: 'Test',
        role: Role.STUDENT,
        passwordHash,
      },
    });
    await prisma.student.update({
      where: { id: ownChildId },
      data: { userId: studentUser.id },
    });
  });

  afterAll(async () => {
    await destroyFixture(fixture);
    await prisma.$disconnect();
  });

  it('lists only the children linked to the parent', async () => {
    const token = await login(parentEmail);
    const res = await request(app).get('/api/v1/portal/children').set(authed(token));

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe(ownChildId);
  });

  it('lets a parent open their own child\'s overview', async () => {
    const token = await login(parentEmail);
    const res = await request(app)
      .get(`/api/v1/portal/students/${ownChildId}/overview`)
      .set(authed(token));

    expect(res.status).toBe(200);
    expect(res.body.student.id).toBe(ownChildId);
    expect(res.body.fees).toBeDefined();
    expect(res.body.attendance).toBeDefined();
  });

  it('blocks a parent from another family\'s child', async () => {
    const token = await login(parentEmail);

    for (const path of ['overview', 'attendance', 'fees', 'results', 'homework']) {
      const res = await request(app)
        .get(`/api/v1/portal/students/${otherChildId}/${path}`)
        .set(authed(token));
      expect(res.status).toBe(403);
    }
  });

  it('restricts a student to their own record', async () => {
    const token = await login(studentEmail);

    const own = await request(app)
      .get(`/api/v1/portal/students/${ownChildId}/overview`)
      .set(authed(token));
    expect(own.status).toBe(200);

    const other = await request(app)
      .get(`/api/v1/portal/students/${otherChildId}/overview`)
      .set(authed(token));
    expect(other.status).toBe(403);
  });

  it('keeps a parent out of school-wide admin endpoints', async () => {
    const token = await login(parentEmail);

    const students = await request(app).get('/api/v1/students').set(authed(token));
    expect(students.status).toBe(403);

    const payments = await request(app)
      .post('/api/v1/payments')
      .set(authed(token))
      .send({ studentId: ownChildId, amount: 1000, method: 'CASH' });
    expect(payments.status).toBe(403);

    const outstanding = await request(app).get('/api/v1/fees/outstanding').set(authed(token));
    expect(outstanding.status).toBe(403);
  });

  it('hides unpublished results from families', async () => {
    const adminToken = await login(fixture.users.admin!.email);
    const teacherToken = await login(fixture.users.teacher!.email);

    const exam = await request(app)
      .post('/api/v1/exams')
      .set(authed(adminToken))
      .send({
        academicYearId: fixture.academicYearId,
        classId: fixture.classId,
        gradeScaleId: fixture.gradeScaleId,
        name: 'Draft exam',
        examType: 'MIDTERM',
        subjects: [{ subjectId: fixture.subjectIds[0]!, maxScore: 100 }],
      });
    const examId = exam.body.id as string;
    const examSubjectId = exam.body.examSubjects[0].id as string;

    await request(app)
      .post(`/api/v1/exams/subjects/${examSubjectId}/marks`)
      .set(authed(teacherToken))
      .send({ entries: [{ studentId: ownChildId, score: 88 }] });

    const parentToken = await login(parentEmail);

    const blocked = await request(app)
      .get(`/api/v1/portal/students/${ownChildId}/report-card/${examId}`)
      .set(authed(parentToken));
    expect(blocked.status).toBe(403);

    // The transcript only ever contains published exams.
    const transcript = await request(app)
      .get(`/api/v1/portal/students/${ownChildId}/results`)
      .set(authed(parentToken));
    expect(transcript.status).toBe(200);
    expect(transcript.body.exams).toHaveLength(0);

    await request(app).post(`/api/v1/exams/${examId}/publish`).set(authed(adminToken));

    const allowed = await request(app)
      .get(`/api/v1/portal/students/${ownChildId}/report-card/${examId}`)
      .set(authed(parentToken));
    expect(allowed.status).toBe(200);
    expect(allowed.body.student.subjects[0].score).toBe(88);
  });

  it('turns away staff from the family portal', async () => {
    const token = await login(fixture.users.teacher!.email);
    const res = await request(app).get('/api/v1/portal/children').set(authed(token));
    expect(res.status).toBe(403);
  });
});
