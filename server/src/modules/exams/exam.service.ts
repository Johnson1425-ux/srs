import { ExamStatus, StudentStatus } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { type Band, aggregate, gradeFor, rank } from './grading.js';

async function bandsForExam(examId: string, schoolId: string): Promise<Band[]> {
  const exam = await prisma.exam.findFirst({
    where: { id: examId, schoolId },
    include: { gradeScale: { include: { bands: { orderBy: { minScore: 'desc' } } } } },
  });
  if (!exam) throw notFound('Exam');

  if (exam.gradeScale) {
    return exam.gradeScale.bands.map((b) => ({
      grade: b.grade,
      minScore: b.minScore,
      maxScore: b.maxScore,
      points: b.points,
      remark: b.remark,
    }));
  }

  const fallback = await prisma.gradeScale.findFirst({
    where: { schoolId, isDefault: true },
    include: { bands: { orderBy: { minScore: 'desc' } } },
  });
  if (!fallback) {
    throw badRequest('No grading scale is configured. Set one up under school setup.');
  }
  return fallback.bands.map((b) => ({
    grade: b.grade,
    minScore: b.minScore,
    maxScore: b.maxScore,
    points: b.points,
    remark: b.remark,
  }));
}

export interface MarkEntry {
  studentId: string;
  score?: number | null;
  isAbsent?: boolean;
  remark?: string | null;
}

/**
 * Records marks for one exam subject. Grades and GPA points are derived
 * server-side from the exam's grading scale, so a teacher can never enter an
 * inconsistent grade by hand.
 */
export async function enterMarks(
  schoolId: string,
  examSubjectId: string,
  entries: MarkEntry[],
  enteredById: string | null,
) {
  const examSubject = await prisma.examSubject.findFirst({
    where: { id: examSubjectId, exam: { schoolId } },
    include: { exam: true },
  });
  if (!examSubject) throw notFound('Exam subject');

  if (examSubject.exam.status === ExamStatus.PUBLISHED) {
    throw badRequest('Results are published; unpublish the exam before editing marks');
  }

  const bands = await bandsForExam(examSubject.examId, schoolId);

  for (const entry of entries) {
    if (entry.isAbsent) continue;
    if (entry.score === null || entry.score === undefined) {
      throw badRequest(`A score is required for student ${entry.studentId} unless marked absent`);
    }
    if (entry.score < 0 || entry.score > examSubject.maxScore) {
      throw badRequest(
        `Score ${entry.score} is outside the valid range 0-${examSubject.maxScore}`,
      );
    }
  }

  const studentIds = [...new Set(entries.map((e) => e.studentId))];
  const owned = await prisma.student.count({ where: { schoolId, id: { in: studentIds } } });
  if (owned !== studentIds.length) {
    throw badRequest('One or more students do not belong to this school');
  }

  await prisma.$transaction(
    entries.map((entry) => {
      const outcome = entry.isAbsent
        ? { grade: null, points: null, remark: null }
        : gradeFor(entry.score ?? 0, examSubject.maxScore, bands);

      const data = {
        score: entry.isAbsent ? null : (entry.score ?? null),
        isAbsent: entry.isAbsent ?? false,
        grade: outcome.grade,
        points: outcome.points,
        remark: entry.remark ?? outcome.remark,
        enteredById,
      };

      return prisma.examResult.upsert({
        where: { examSubjectId_studentId: { examSubjectId, studentId: entry.studentId } },
        create: {
          examId: examSubject.examId,
          examSubjectId,
          studentId: entry.studentId,
          ...data,
        },
        update: data,
      });
    }),
  );

  // Move the exam out of DRAFT the moment real marks start arriving.
  if (examSubject.exam.status === ExamStatus.DRAFT) {
    await prisma.exam.update({
      where: { id: examSubject.examId },
      data: { status: ExamStatus.MARKS_ENTRY },
    });
  }

  return { saved: entries.length };
}

export interface ReportCardRow {
  subject: string;
  code: string;
  score: number | null;
  maxScore: number;
  grade: string | null;
  points: number | null;
  remark: string | null;
  isAbsent: boolean;
}

/**
 * Builds the full result sheet for an exam: one row per student with their
 * subject breakdown, aggregate and (when the school enables it) class position.
 */
export async function buildResultSheet(schoolId: string, examId: string) {
  const exam = await prisma.exam.findFirst({
    where: { id: examId, schoolId },
    include: {
      examSubjects: { include: { subject: true } },
      schoolClass: true,
      term: true,
      academicYear: true,
    },
  });
  if (!exam) throw notFound('Exam');

  const school = await prisma.school.findUniqueOrThrow({
    where: { id: schoolId },
    select: { name: true, rankingEnabled: true, logoUrl: true, motto: true },
  });

  const students = await prisma.student.findMany({
    where: {
      schoolId,
      status: StudentStatus.ACTIVE,
      ...(exam.classId
        ? { enrollments: { some: { isActive: true, classId: exam.classId } } }
        : {}),
    },
    orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    select: {
      id: true,
      admissionNumber: true,
      firstName: true,
      middleName: true,
      lastName: true,
      enrollments: {
        where: { isActive: true },
        select: { schoolClass: { select: { name: true } }, stream: { select: { name: true } } },
      },
    },
  });

  const results = await prisma.examResult.findMany({ where: { examId } });
  const byStudent = new Map<string, typeof results>();
  for (const r of results) {
    const list = byStudent.get(r.studentId) ?? [];
    list.push(r);
    byStudent.set(r.studentId, list);
  }

  const rows = students.map((student) => {
    const studentResults = byStudent.get(student.id) ?? [];

    const subjects: ReportCardRow[] = exam.examSubjects.map((es) => {
      const result = studentResults.find((r) => r.examSubjectId === es.id);
      return {
        subject: es.subject.name,
        code: es.subject.code,
        score: result?.score ?? null,
        maxScore: es.maxScore,
        grade: result?.grade ?? null,
        points: result?.points ?? null,
        remark: result?.remark ?? null,
        isAbsent: result?.isAbsent ?? false,
      };
    });

    const totals = aggregate(
      subjects.map((s) => ({
        score: s.score,
        maxScore: s.maxScore,
        points: s.points,
        isAbsent: s.isAbsent,
      })),
    );

    return {
      studentId: student.id,
      admissionNumber: student.admissionNumber,
      name: [student.firstName, student.middleName, student.lastName].filter(Boolean).join(' '),
      className: student.enrollments[0]?.schoolClass.name ?? null,
      streamName: student.enrollments[0]?.stream?.name ?? null,
      subjects,
      ...totals,
    };
  });

  // Position ranking is configurable per school (PRD Module 9).
  const ranked = school.rankingEnabled
    ? rank(rows.map((r) => ({ ...r, average: r.average })))
    : rows.map((r) => ({ ...r, position: null as number | null }));

  const classAverage = rows.length
    ? Number((rows.reduce((acc, r) => acc + r.average, 0) / rows.length).toFixed(2))
    : 0;

  return {
    exam: {
      id: exam.id,
      name: exam.name,
      examType: exam.examType,
      status: exam.status,
      className: exam.schoolClass?.name ?? null,
      term: exam.term?.name ?? null,
      academicYear: exam.academicYear.name,
    },
    school,
    summary: {
      studentCount: rows.length,
      classAverage,
      rankingEnabled: school.rankingEnabled,
    },
    // Restore alphabetical order; `position` carries the ranking.
    data: ranked.sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export async function reportCard(schoolId: string, examId: string, studentId: string) {
  const sheet = await buildResultSheet(schoolId, examId);
  const row = sheet.data.find((r) => r.studentId === studentId);
  if (!row) throw notFound('Result for this student');

  return {
    exam: sheet.exam,
    school: sheet.school,
    student: row,
    classSummary: sheet.summary,
  };
}

/**
 * A student's transcript: every published exam they have sat, newest first.
 */
export async function transcript(schoolId: string, studentId: string) {
  const student = await prisma.student.findFirst({
    where: { id: studentId, schoolId },
    select: { id: true, admissionNumber: true, firstName: true, middleName: true, lastName: true },
  });
  if (!student) throw notFound('Student');

  const results = await prisma.examResult.findMany({
    where: { studentId, exam: { schoolId, status: ExamStatus.PUBLISHED } },
    include: {
      examSubject: { include: { subject: { select: { name: true, code: true } } } },
      exam: {
        select: {
          id: true,
          name: true,
          examType: true,
          publishedAt: true,
          term: { select: { name: true } },
          academicYear: { select: { name: true } },
        },
      },
    },
  });

  const byExam = new Map<string, typeof results>();
  for (const r of results) {
    const list = byExam.get(r.examId) ?? [];
    list.push(r);
    byExam.set(r.examId, list);
  }

  const exams = [...byExam.values()].map((list) => {
    const first = list[0]!;
    const totals = aggregate(
      list.map((r) => ({
        score: r.score,
        maxScore: r.examSubject.maxScore,
        points: r.points,
        isAbsent: r.isAbsent,
      })),
    );
    return {
      exam: first.exam,
      subjects: list.map((r) => ({
        subject: r.examSubject.subject.name,
        code: r.examSubject.subject.code,
        score: r.score,
        maxScore: r.examSubject.maxScore,
        grade: r.grade,
        points: r.points,
      })),
      ...totals,
    };
  });

  return { student, exams };
}
