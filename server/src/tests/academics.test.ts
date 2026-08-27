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

describe('attendance', () => {
  let fixture: Fixture;
  let teacherToken: string;

  beforeAll(async () => {
    fixture = await createSchoolFixture();
    teacherToken = await login(fixture.users.teacher!.email);
  });

  afterAll(async () => {
    await destroyFixture(fixture);
    await prisma.$disconnect();
  });

  it('returns an empty register before anything is marked', async () => {
    const res = await request(app)
      .get(`/api/v1/attendance/register?date=2026-02-10&classId=${fixture.classId}`)
      .set(authed(teacherToken));

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(fixture.students.length);
    expect(res.body.data.every((r: { attendance: unknown }) => r.attendance === null)).toBe(true);
  });

  it('records a class register', async () => {
    const res = await request(app)
      .post('/api/v1/attendance')
      .set(authed(teacherToken))
      .send({
        date: '2026-02-10',
        streamId: fixture.streamId,
        records: [
          { studentId: fixture.students[0]!.id, status: 'PRESENT' },
          { studentId: fixture.students[1]!.id, status: 'ABSENT' },
          { studentId: fixture.students[2]!.id, status: 'LATE', arrivalTime: '08:25' },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.recorded).toBe(3);
  });

  it('overwrites rather than duplicates when the register is corrected', async () => {
    await request(app)
      .post('/api/v1/attendance')
      .set(authed(teacherToken))
      .send({
        date: '2026-02-10',
        records: [{ studentId: fixture.students[1]!.id, status: 'EXCUSED', note: 'Medical appointment' }],
      });

    const count = await prisma.attendanceRecord.count({
      where: { studentId: fixture.students[1]!.id, date: new Date('2026-02-10') },
    });
    expect(count).toBe(1);

    const register = await request(app)
      .get(`/api/v1/attendance/register?date=2026-02-10&classId=${fixture.classId}`)
      .set(authed(teacherToken));
    const row = register.body.data.find(
      (r: { id: string }) => r.id === fixture.students[1]!.id,
    );
    expect(row.attendance.status).toBe('EXCUSED');
  });

  it('computes a per-student attendance rate, counting late as present', async () => {
    const res = await request(app)
      .get(`/api/v1/attendance/student/${fixture.students[2]!.id}`)
      .set(authed(teacherToken));

    expect(res.status).toBe(200);
    expect(res.body.summary.totalDays).toBe(1);
    expect(res.body.summary.attendanceRate).toBe(100);
  });

  it('lists absentees and late arrivals for the day', async () => {
    const res = await request(app)
      .get('/api/v1/attendance/exceptions?date=2026-02-10')
      .set(authed(teacherToken));

    expect(res.status).toBe(200);
    expect(res.body.late).toHaveLength(1);
    expect(res.body.absent).toHaveLength(0); // the absence was corrected to EXCUSED
  });

  it('refuses to mark a student from another school', async () => {
    const other = await createSchoolFixture();
    const res = await request(app)
      .post('/api/v1/attendance')
      .set(authed(teacherToken))
      .send({
        date: '2026-02-11',
        records: [{ studentId: other.students[0]!.id, status: 'PRESENT' }],
      });

    expect(res.status).toBe(400);
    await destroyFixture(other);
  });
});

describe('timetable', () => {
  let fixture: Fixture;
  let token: string;

  beforeAll(async () => {
    fixture = await createSchoolFixture();
    token = await login(fixture.users.admin!.email);
  });

  afterAll(async () => {
    await destroyFixture(fixture);
  });

  const slot = (over: Record<string, unknown> = {}) => ({
    academicYearId: fixture.academicYearId,
    classId: fixture.classId,
    subjectId: fixture.subjectIds[0]!,
    dayOfWeek: 1,
    startTime: '08:00',
    endTime: '08:40',
    ...over,
  });

  it('creates a lesson', async () => {
    const res = await request(app).post('/api/v1/academics/timetable').set(authed(token)).send(slot());
    expect(res.status).toBe(201);
    expect(res.body.startTime).toBe('08:00');
    expect(res.body.endTime).toBe('08:40');
  });

  it('rejects a lesson that ends before it starts', async () => {
    const res = await request(app)
      .post('/api/v1/academics/timetable')
      .set(authed(token))
      .send(slot({ startTime: '08:40', endTime: '08:20' }));

    expect(res.status).toBe(400);
  });

  it('rejects a lesson with no duration', async () => {
    const res = await request(app)
      .post('/api/v1/academics/timetable')
      .set(authed(token))
      .send(slot({ startTime: '09:00', endTime: '09:00' }));

    expect(res.status).toBe(400);
  });

  it('will not double-book a teacher across two classes', async () => {
    const otherClass = await prisma.schoolClass.create({
      data: { schoolId: fixture.school.id, name: 'Form 3', level: 3 },
    });

    const first = await request(app)
      .post('/api/v1/academics/timetable')
      .set(authed(token))
      .send(slot({ dayOfWeek: 2, startTime: '10:00', endTime: '10:40', teacherId: fixture.teacherStaffId }));
    expect(first.status).toBe(201);

    // Overlaps by ten minutes, in a different class.
    const clash = await request(app)
      .post('/api/v1/academics/timetable')
      .set(authed(token))
      .send(
        slot({
          classId: otherClass.id,
          dayOfWeek: 2,
          startTime: '10:30',
          endTime: '11:10',
          teacherId: fixture.teacherStaffId,
        }),
      );

    expect(clash.status).toBe(400);
    expect(clash.body.error.message).toContain('already has a lesson');
  });

  it('removes a lesson', async () => {
    const created = await request(app)
      .post('/api/v1/academics/timetable')
      .set(authed(token))
      .send(slot({ dayOfWeek: 4, startTime: '14:00', endTime: '14:40' }));

    const removed = await request(app)
      .delete(`/api/v1/academics/timetable/${created.body.id}`)
      .set(authed(token));
    expect(removed.status).toBe(204);

    const list = await request(app)
      .get(`/api/v1/academics/timetable?classId=${fixture.classId}`)
      .set(authed(token));
    const ids = list.body.data.map((s: { id: string }) => s.id);
    expect(ids).not.toContain(created.body.id);
  });
});

describe('examinations', () => {
  let fixture: Fixture;
  let adminToken: string;
  let teacherToken: string;
  let examId: string;
  let examSubjectIds: string[];

  beforeAll(async () => {
    fixture = await createSchoolFixture();
    adminToken = await login(fixture.users.admin!.email);
    teacherToken = await login(fixture.users.teacher!.email);

    const res = await request(app)
      .post('/api/v1/exams')
      .set(authed(adminToken))
      .send({
        academicYearId: fixture.academicYearId,
        termId: fixture.termId,
        classId: fixture.classId,
        gradeScaleId: fixture.gradeScaleId,
        name: 'Term 1 Terminal',
        examType: 'TERMINAL',
        subjects: fixture.subjectIds.map((id) => ({ subjectId: id, maxScore: 100 })),
      });
    expect(res.status).toBe(201);
    examId = res.body.id;
    examSubjectIds = res.body.examSubjects.map((es: { id: string }) => es.id);
  });

  afterAll(async () => {
    await destroyFixture(fixture);
  });

  it('derives grades and GPA points from the school grading scale', async () => {
    const res = await request(app)
      .post(`/api/v1/exams/subjects/${examSubjectIds[0]}/marks`)
      .set(authed(teacherToken))
      .send({
        entries: [
          { studentId: fixture.students[0]!.id, score: 82 },
          { studentId: fixture.students[1]!.id, score: 51 },
          { studentId: fixture.students[2]!.id, isAbsent: true },
        ],
      });

    expect(res.status).toBe(200);

    const sheet = await request(app)
      .get(`/api/v1/exams/subjects/${examSubjectIds[0]}/marks`)
      .set(authed(teacherToken));

    const byId = new Map(
      sheet.body.data.map((r: { id: string; result: { grade: string; points: number } | null }) => [
        r.id,
        r.result,
      ]),
    );
    expect(byId.get(fixture.students[0]!.id)).toMatchObject({ grade: 'A', points: 5 });
    expect(byId.get(fixture.students[1]!.id)).toMatchObject({ grade: 'C', points: 3 });
    expect(byId.get(fixture.students[2]!.id)).toMatchObject({ isAbsent: true, grade: null });
  });

  it('rejects a score above the paper maximum', async () => {
    const res = await request(app)
      .post(`/api/v1/exams/subjects/${examSubjectIds[0]}/marks`)
      .set(authed(teacherToken))
      .send({ entries: [{ studentId: fixture.students[0]!.id, score: 140 }] });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('outside the valid range');
  });

  it('requires a score unless the student is marked absent', async () => {
    const res = await request(app)
      .post(`/api/v1/exams/subjects/${examSubjectIds[0]}/marks`)
      .set(authed(teacherToken))
      .send({ entries: [{ studentId: fixture.students[0]!.id }] });

    expect(res.status).toBe(400);
  });

  it('moves the exam into marks entry once marks arrive', async () => {
    const res = await request(app).get(`/api/v1/exams/${examId}`).set(authed(adminToken));
    expect(res.body.status).toBe('MARKS_ENTRY');
  });

  it('builds a ranked result sheet excluding absent papers from the average', async () => {
    // Second subject so aggregates span more than one paper.
    await request(app)
      .post(`/api/v1/exams/subjects/${examSubjectIds[1]}/marks`)
      .set(authed(teacherToken))
      .send({
        entries: [
          { studentId: fixture.students[0]!.id, score: 70 },
          { studentId: fixture.students[1]!.id, score: 61 },
          { studentId: fixture.students[2]!.id, score: 40 },
        ],
      });

    const res = await request(app).get(`/api/v1/results/exam/${examId}`).set(authed(adminToken));
    expect(res.status).toBe(200);

    const rows = res.body.data as Array<{
      studentId: string;
      average: number;
      position: number;
      subjects: unknown[];
    }>;

    const first = rows.find((r) => r.studentId === fixture.students[0]!.id)!;
    const third = rows.find((r) => r.studentId === fixture.students[2]!.id)!;

    expect(first.average).toBe(76); // (82 + 70) / 200
    expect(first.position).toBe(1);
    // Only the paper actually sat counts towards the average.
    expect(third.average).toBe(40);
    expect(res.body.summary.rankingEnabled).toBe(true);
  });

  it('reports nobody reachable when no guardian has a telephone number', async () => {
    const res = await request(app)
      .get(`/api/v1/exams/${examId}/notify-preview`)
      .set(authed(adminToken));

    expect(res.status).toBe(200);
    expect(res.body.recipients).toBe(0);
    // Every student is named, so the office knows who to telephone instead.
    expect(res.body.withoutContact.length).toBe(fixture.students.length);
    expect(res.body.sample).toBeNull();
  });

  it('publishes without telling anyone unless asked to', async () => {
    const before = await prisma.message.count({ where: { schoolId: fixture.school.id } });

    const res = await request(app)
      .post(`/api/v1/exams/${examId}/publish`)
      .set(authed(adminToken))
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.notified).toBeNull();
    expect(await prisma.message.count({ where: { schoolId: fixture.school.id } })).toBe(before);
  });

  it('queues one result message per student, to whoever pays the fees', async () => {
    // Two guardians on one student: the fee payer must be the one told, so the
    // school is not billed twice for the same child.
    const student = fixture.students[0]!;
    const [payer, other] = await Promise.all([
      prisma.guardian.create({
        data: {
          schoolId: fixture.school.id,
          firstName: 'Fee',
          lastName: 'Payer',
          phone: '0754111222',
          relationship: 'FATHER',
        },
      }),
      prisma.guardian.create({
        data: {
          schoolId: fixture.school.id,
          firstName: 'Other',
          lastName: 'Guardian',
          phone: '0754333444',
          relationship: 'MOTHER',
        },
      }),
    ]);
    await prisma.studentGuardian.createMany({
      data: [
        { studentId: student.id, guardianId: payer.id, isFeePayer: true },
        { studentId: student.id, guardianId: other.id, isPrimary: true },
      ],
    });

    await prisma.message.deleteMany({ where: { schoolId: fixture.school.id } });

    const res = await request(app)
      .post(`/api/v1/exams/${examId}/publish`)
      .set(authed(adminToken))
      .send({ notifyGuardians: true });

    expect(res.status).toBe(200);
    expect(res.body.notified.queued).toBe(1);

    const messages = await prisma.message.findMany({
      where: { schoolId: fixture.school.id, channel: 'SMS' },
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]!.recipient).toBe('+255754111222');
    const named = await prisma.student.findUniqueOrThrow({ where: { id: student.id } });
    expect(messages[0]!.body).toContain(named.firstName);
    expect(messages[0]!.body).toContain('Average');

    // The students with no guardian on file are reported, not silently dropped.
    expect(res.body.notified.withoutContact.length).toBeGreaterThan(0);
  });

  it('counts the reachable parents once they have telephone numbers', async () => {
    const res = await request(app)
      .get(`/api/v1/exams/${examId}/notify-preview`)
      .set(authed(adminToken));

    expect(res.status).toBe(200);
    expect(res.body.recipients).toBe(1);
    // Billed per 160-character segment, so this is what the school pays for.
    expect(res.body.segments).toBeGreaterThanOrEqual(1);
    expect(res.body.sample).toMatch(/Average \d/);
  });

  it('keeps result notifications away from a teacher', async () => {
    const res = await request(app)
      .get(`/api/v1/exams/${examId}/notify-preview`)
      .set(authed(teacherToken));

    expect(res.status).toBe(403);
  });

  it('refuses to publish an exam with no marks', async () => {
    const empty = await request(app)
      .post('/api/v1/exams')
      .set(authed(adminToken))
      .send({
        academicYearId: fixture.academicYearId,
        classId: fixture.classId,
        name: 'Unmarked mock',
        examType: 'MOCK',
        subjects: [{ subjectId: fixture.subjectIds[0]!, maxScore: 100 }],
      });

    const res = await request(app)
      .post(`/api/v1/exams/${empty.body.id}/publish`)
      .set(authed(adminToken));

    expect(res.status).toBe(400);
  });

  it('locks marks once results are published', async () => {
    const publish = await request(app)
      .post(`/api/v1/exams/${examId}/publish`)
      .set(authed(adminToken));
    expect(publish.status).toBe(200);

    const res = await request(app)
      .post(`/api/v1/exams/subjects/${examSubjectIds[0]}/marks`)
      .set(authed(teacherToken))
      .send({ entries: [{ studentId: fixture.students[0]!.id, score: 99 }] });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('published');
  });

  it('produces a report card for one student', async () => {
    const res = await request(app)
      .get(`/api/v1/results/exam/${examId}/report-card/${fixture.students[0]!.id}`)
      .set(authed(adminToken));

    expect(res.status).toBe(200);
    expect(res.body.student.subjects).toHaveLength(2);
    expect(res.body.student.position).toBe(1);
    expect(res.body.exam.name).toBe('Term 1 Terminal');
  });

  it('includes only published exams in a transcript', async () => {
    const res = await request(app)
      .get(`/api/v1/results/transcript/${fixture.students[0]!.id}`)
      .set(authed(adminToken));

    expect(res.status).toBe(200);
    expect(res.body.exams).toHaveLength(1);
    expect(res.body.exams[0].exam.name).toBe('Term 1 Terminal');
  });

  it('omits ranking when the school turns it off', async () => {
    await prisma.school.update({
      where: { id: fixture.school.id },
      data: { rankingEnabled: false },
    });

    const res = await request(app).get(`/api/v1/results/exam/${examId}`).set(authed(adminToken));
    expect(res.body.summary.rankingEnabled).toBe(false);
    expect(res.body.data[0].position).toBeNull();

    await prisma.school.update({
      where: { id: fixture.school.id },
      data: { rankingEnabled: true },
    });
  });
});

describe('student lifecycle', () => {
  let fixture: Fixture;
  let token: string;

  beforeAll(async () => {
    fixture = await createSchoolFixture();
    token = await login(fixture.users.admin!.email);
  });

  afterAll(async () => {
    await destroyFixture(fixture);
  });

  it('admits a student with a guardian and portal accounts in one call', async () => {
    const res = await request(app)
      .post('/api/v1/students')
      .set(authed(token))
      .send({
        firstName: 'Neema',
        lastName: 'Mushi',
        gender: 'FEMALE',
        dateOfBirth: '2012-08-19',
        classId: fixture.classId,
        streamId: fixture.streamId,
        createPortalAccount: true,
        guardians: [
          {
            firstName: 'Joyce',
            lastName: 'Mushi',
            relationship: 'Mother',
            phone: '0754111222',
            isPrimary: true,
            isFeePayer: true,
            createPortalAccount: true,
          },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.student.guardianLinks).toHaveLength(1);
    expect(res.body.credentials).toHaveLength(2);
    expect(res.body.credentials.map((c: { role: string }) => c.role).sort()).toEqual([
      'PARENT',
      'STUDENT',
    ]);
  });

  it('re-uses an existing guardian rather than duplicating them', async () => {
    const res = await request(app)
      .post('/api/v1/students')
      .set(authed(token))
      .send({
        firstName: 'Baraka',
        lastName: 'Mushi',
        gender: 'MALE',
        dateOfBirth: '2014-01-11',
        classId: fixture.classId,
        guardians: [
          { firstName: 'Joyce', lastName: 'Mushi', relationship: 'Mother', phone: '0754111222' },
        ],
      });

    expect(res.status).toBe(201);

    const guardians = await prisma.guardian.count({
      where: { schoolId: fixture.school.id, phone: '0754111222' },
    });
    expect(guardians).toBe(1);

    const links = await prisma.studentGuardian.count({
      where: { guardian: { schoolId: fixture.school.id, phone: '0754111222' } },
    });
    expect(links).toBe(2);
  });

  it('links an existing parent to a student admitted without one', async () => {
    const student = await request(app)
      .post('/api/v1/students')
      .set(authed(token))
      .send({
        firstName: 'Orphaned',
        lastName: 'Record',
        gender: 'MALE',
        dateOfBirth: '2013-06-06',
        classId: fixture.classId,
      });
    expect(student.body.student.guardianLinks).toHaveLength(0);

    const parent = await request(app)
      .post('/api/v1/parents')
      .set(authed(token))
      .send({
        firstName: 'Later',
        lastName: 'Guardian',
        relationship: 'Father',
        phone: '0788222333',
      });
    expect(parent.status).toBe(201);

    const link = await request(app)
      .post(`/api/v1/students/${student.body.student.id}/guardians`)
      .set(authed(token))
      .send({ guardianId: parent.body.id, isPrimary: true, isFeePayer: true });

    expect(link.status).toBe(201);

    const after = await request(app)
      .get(`/api/v1/students/${student.body.student.id}`)
      .set(authed(token));
    expect(after.body.guardianLinks).toHaveLength(1);
    expect(after.body.guardianLinks[0].guardian.phone).toBe('0788222333');
  });

  it('moves the primary flag rather than allowing two', async () => {
    const studentId = fixture.students[2]!.id;

    const [first, second] = await Promise.all([
      request(app).post('/api/v1/parents').set(authed(token)).send({
        firstName: 'First', lastName: 'Contact', relationship: 'Mother', phone: '0788300001',
      }),
      request(app).post('/api/v1/parents').set(authed(token)).send({
        firstName: 'Second', lastName: 'Contact', relationship: 'Father', phone: '0788300002',
      }),
    ]);

    for (const parent of [first, second]) {
      const res = await request(app)
        .post(`/api/v1/students/${studentId}/guardians`)
        .set(authed(token))
        .send({ guardianId: parent.body.id, isPrimary: true });
      expect(res.status).toBe(201);
    }

    const after = await request(app).get(`/api/v1/students/${studentId}`).set(authed(token));
    const primaries = after.body.guardianLinks.filter((l: { isPrimary: boolean }) => l.isPrimary);
    expect(primaries).toHaveLength(1);
    expect(primaries[0].guardian.phone).toBe('0788300002');
  });

  it('unlinks a parent attached by mistake', async () => {
    const studentId = fixture.students[0]!.id;

    const parent = await request(app).post('/api/v1/parents').set(authed(token)).send({
      firstName: 'Wrong', lastName: 'Parent', relationship: 'Guardian', phone: '0788400001',
    });

    await request(app)
      .post(`/api/v1/students/${studentId}/guardians`)
      .set(authed(token))
      .send({ guardianId: parent.body.id });

    const removed = await request(app)
      .delete(`/api/v1/students/${studentId}/guardians/${parent.body.id}`)
      .set(authed(token));
    expect(removed.status).toBe(204);

    const after = await request(app).get(`/api/v1/students/${studentId}`).set(authed(token));
    const ids = after.body.guardianLinks.map((l: { guardian: { id: string } }) => l.guardian.id);
    expect(ids).not.toContain(parent.body.id);

    // The parent record itself survives — only the relationship was removed.
    const stillThere = await request(app)
      .get(`/api/v1/parents/${parent.body.id}`)
      .set(authed(token));
    expect(stillThere.status).toBe(200);
  });

  it('refuses to link a parent belonging to another school', async () => {
    const other = await createSchoolFixture();
    const otherToken = await login(other.users.admin!.email);

    const foreignParent = await request(app)
      .post('/api/v1/parents')
      .set(authed(otherToken))
      .send({
        firstName: 'Foreign', lastName: 'Parent', relationship: 'Mother', phone: '0788500001',
      });
    expect(foreignParent.status).toBe(201);

    const res = await request(app)
      .post(`/api/v1/students/${fixture.students[0]!.id}/guardians`)
      .set(authed(token))
      .send({ guardianId: foreignParent.body.id });

    expect(res.status).toBe(404);
    await destroyFixture(other);
  });

  it('rejects a date of birth in the future', async () => {
    const res = await request(app)
      .post('/api/v1/students')
      .set(authed(token))
      .send({
        firstName: 'Time',
        lastName: 'Traveller',
        gender: 'MALE',
        dateOfBirth: '2030-01-01',
        classId: fixture.classId,
      });

    expect(res.status).toBe(400);
  });

  it('suspends and reinstates a student', async () => {
    const id = fixture.students[0]!.id;

    const suspend = await request(app)
      .post(`/api/v1/students/${id}/status`)
      .set(authed(token))
      .send({ status: 'SUSPENDED', reason: 'Disciplinary review' });
    expect(suspend.status).toBe(200);
    expect(suspend.body.status).toBe('SUSPENDED');

    const reinstate = await request(app)
      .post(`/api/v1/students/${id}/status`)
      .set(authed(token))
      .send({ status: 'ACTIVE' });
    expect(reinstate.body.status).toBe('ACTIVE');
  });

  it('ends the enrolment when a student graduates', async () => {
    const id = fixture.students[1]!.id;

    const res = await request(app)
      .post(`/api/v1/students/${id}/status`)
      .set(authed(token))
      .send({ status: 'GRADUATED' });

    expect(res.status).toBe(200);
    expect(res.body.graduatedAt).toBeTruthy();

    const active = await prisma.enrollment.count({ where: { studentId: id, isActive: true } });
    expect(active).toBe(0);
  });

  it('promotes a class into the next academic year', async () => {
    const nextYear = await prisma.academicYear.create({
      data: {
        schoolId: fixture.school.id,
        name: `Next-${fixture.school.code}`,
        startDate: new Date('2027-01-10'),
        endDate: new Date('2027-12-05'),
      },
    });
    const nextClass = await prisma.schoolClass.create({
      data: { schoolId: fixture.school.id, name: 'Form 2', level: 2 },
    });

    const res = await request(app)
      .post('/api/v1/students/promote')
      .set(authed(token))
      .send({
        fromClassId: fixture.classId,
        toClassId: nextClass.id,
        toAcademicYearId: nextYear.id,
      });

    expect(res.status).toBe(200);
    expect(res.body.promotedCount).toBeGreaterThan(0);

    // Re-running is a no-op: nobody is enrolled twice in the same year.
    const repeat = await request(app)
      .post('/api/v1/students/promote')
      .set(authed(token))
      .send({
        fromClassId: fixture.classId,
        toClassId: nextClass.id,
        toAcademicYearId: nextYear.id,
      });
    expect(repeat.status).toBe(400);
  });
});
