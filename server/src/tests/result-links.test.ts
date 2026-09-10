import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { prisma } from '../db/prisma.js';
import { generateToken } from '../modules/exams/result-link.service.js';
import {
  type Fixture,
  app,
  authed,
  createSchoolFixture,
  destroyFixture,
  login,
} from './fixtures.js';

/**
 * The results link is the only way into this system that carries no session,
 * so what it refuses matters as much as what it serves.
 */
describe('no-login results links', () => {
  let fixture: Fixture;
  let adminToken: string;
  let examId: string;
  let studentId: string;

  beforeAll(async () => {
    fixture = await createSchoolFixture();
    adminToken = await login(fixture.users.admin!.email);
    studentId = fixture.students[0]!.id;

    // A guardian with a telephone number, so there is somebody to text.
    const guardian = await prisma.guardian.create({
      data: {
        schoolId: fixture.school.id,
        firstName: 'Neema',
        lastName: 'Mushi',
        phone: '0754999888',
        relationship: 'MOTHER',
      },
    });
    await prisma.studentGuardian.create({
      data: { studentId, guardianId: guardian.id, isFeePayer: true },
    });

    const exam = await request(app)
      .post('/api/v1/exams')
      .set(authed(adminToken))
      .send({
        name: 'Term 1 Exam',
        examType: 'MIDTERM',
        academicYearId: fixture.academicYearId,
        termId: fixture.termId,
        classId: fixture.classId,
        subjects: [{ subjectId: fixture.subjectIds[0]!, maxScore: 100 }],
      });
    expect(exam.status).toBe(201);
    examId = exam.body.id as string;

    const subjectId = exam.body.examSubjects[0].id as string;
    await request(app)
      .post(`/api/v1/exams/subjects/${subjectId}/marks`)
      .set(authed(adminToken))
      .send({ entries: [{ studentId, score: 74 }] });
  });

  afterAll(async () => {
    await destroyFixture(fixture);
    await prisma.$disconnect();
  });

  const publish = () =>
    request(app)
      .post(`/api/v1/exams/${examId}/publish`)
      .set(authed(adminToken))
      .send({ notifyGuardians: true });

  const tokenFor = async () =>
    (await prisma.resultLink.findFirstOrThrow({ where: { examId, studentId } })).token;

  it('mints unguessable tokens that do not collide', () => {
    const tokens = new Set(Array.from({ length: 500 }, () => generateToken()));
    expect(tokens.size).toBe(500);

    const [sample] = tokens;
    expect(sample).toHaveLength(11);
    // No O/0 or I/l/1: somebody will read one of these down a telephone.
    expect(sample).toMatch(/^[A-HJ-NP-Za-km-z2-9]+$/);
  });

  it('puts a working link in the message the parent receives', async () => {
    const res = await publish();
    expect(res.status).toBe(200);

    const message = await prisma.message.findFirstOrThrow({
      where: { schoolId: fixture.school.id, channel: 'SMS' },
    });

    const token = await tokenFor();
    expect(message.body).toContain(`/r/${token}`);

    const page = await request(app).get(`/api/v1/public/results/${token}`);
    expect(page.status).toBe(200);
    expect(page.body.student.name).toContain('');
    expect(page.body.subjects).toHaveLength(1);
    expect(page.body.average).toBe(74);
  });

  it('serves the results without any credentials at all', async () => {
    const token = await tokenFor();
    // No Authorization header, no school context header.
    const res = await request(app).get(`/api/v1/public/results/${token}`);

    expect(res.status).toBe(200);
    expect(res.headers['x-robots-tag']).toContain('noindex');
    expect(res.headers['cache-control']).toContain('no-store');
  });

  it('shows the child and nothing that unlocks anything else', async () => {
    const res = await request(app).get(`/api/v1/public/results/${await tokenFor()}`);

    expect(res.body.student).toBeDefined();
    // An admission number identifies the child elsewhere in the system, so it
    // has no place on a page anyone holding the phone can open.
    expect(JSON.stringify(res.body)).not.toContain(fixture.students[0]!.admissionNumber);
    expect(res.body.student.admissionNumber).toBeUndefined();
    expect(res.body.studentId).toBeUndefined();
  });

  it('refuses an unknown token the same way as an expired one', async () => {
    const unknown = await request(app).get(`/api/v1/public/results/${generateToken()}`);
    expect(unknown.status).toBe(404);

    const token = await tokenFor();
    await prisma.resultLink.update({
      where: { token },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const expired = await request(app).get(`/api/v1/public/results/${token}`);
    expect(expired.status).toBe(404);
    // Identical answers, so the response cannot sort real tokens from invented
    // ones.
    expect(expired.body).toEqual(unknown.body);

    await prisma.resultLink.update({
      where: { token },
      data: { expiresAt: new Date(Date.now() + 86_400_000) },
    });
  });

  it('stops working the moment results are withdrawn', async () => {
    const token = await tokenFor();
    expect((await request(app).get(`/api/v1/public/results/${token}`)).status).toBe(200);

    await request(app).post(`/api/v1/exams/${examId}/unpublish`).set(authed(adminToken));
    expect((await request(app).get(`/api/v1/public/results/${token}`)).status).toBe(404);

    // ...and works again when they are put back, on the same address, because
    // the old one is already in a parent's message thread.
    await publish();
    expect(await tokenFor()).toBe(token);
    expect((await request(app).get(`/api/v1/public/results/${token}`)).status).toBe(200);
  });

  it('counts views, so a link passed around is visible to the school', async () => {
    const token = await tokenFor();
    const before = await prisma.resultLink.findUniqueOrThrow({ where: { token } });

    await request(app).get(`/api/v1/public/results/${token}`);
    await request(app).get(`/api/v1/public/results/${token}`);

    const after = await prisma.resultLink.findUniqueOrThrow({ where: { token } });
    expect(after.views).toBe(before.views + 2);
    expect(after.lastViewedAt).not.toBeNull();
  });

  it('reuses one address per child rather than minting a new one each publish', async () => {
    const before = await prisma.resultLink.count({ where: { examId } });
    await publish();
    await publish();
    expect(await prisma.resultLink.count({ where: { examId } })).toBe(before);
  });

  it('costs a send without minting anything, so previewing is free', async () => {
    const other = fixture.students[1]!;
    const guardian = await prisma.guardian.create({
      data: {
        schoolId: fixture.school.id,
        firstName: 'Asha',
        lastName: 'Juma',
        phone: '0754777666',
        relationship: 'MOTHER',
      },
    });
    await prisma.studentGuardian.create({
      data: { studentId: other.id, guardianId: guardian.id, isFeePayer: true },
    });

    const before = await prisma.resultLink.count({ where: { examId } });

    const res = await request(app)
      .get(`/api/v1/exams/${examId}/notify-preview`)
      .set(authed(adminToken));

    expect(res.status).toBe(200);
    expect(res.body.includesLink).toBe(true);
    // The sample carries a stand-in that opens nothing.
    expect(res.body.sample).toContain('/r/xxxxxxxxxxx');
    expect((await request(app).get('/api/v1/public/results/xxxxxxxxxxx')).status).toBe(404);
    // Previewing a message that may never be sent must not create a credential.
    expect(await prisma.resultLink.count({ where: { examId } })).toBe(before);
  });

  it('leaves links out of a template that does not ask for one', async () => {
    const { buildResultNotices } = await import('../modules/exams/exam.service.js');
    const { notices } = await buildResultNotices(
      fixture.school.id,
      examId,
      '{{schoolName}}: {{studentName}} scored {{average}}%.',
    );

    expect(notices.length).toBeGreaterThan(0);
    for (const notice of notices) expect(notice.body).not.toContain('/r/');
  });
});
