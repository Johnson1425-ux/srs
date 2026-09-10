import { randomBytes } from 'node:crypto';
import { ExamStatus } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { env, publicWebUrl } from '../../config/env.js';
import { notFound } from '../../lib/errors.js';
import { reportCard } from './exam.service.js';

/**
 * No-login access to one child's results.
 *
 * A parent gets a link in the results text rather than a password to remember,
 * because the alternative — find the portal, recover a password, navigate to a
 * report card — is more than most will do, and a result nobody reads may as
 * well not have been published.
 *
 * The token is the only thing standing between the address and the results, so
 * it is treated as a credential: random, of a length that cannot be worked
 * through, expiring, and revoked the moment the exam stops being published.
 */

/**
 * Unambiguous on a handset and in handwriting: no O/0, no I/l/1. Someone will
 * read one of these down a telephone line to a parent whose message did not
 * arrive, so the alphabet matters more than the extra bit or two of entropy.
 */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

/**
 * 11 characters over this alphabet is about 64 bits. Guessing one is not worth
 * anyone's time, and every character is billed in every message, so it is not
 * longer than it needs to be either.
 */
const TOKEN_LENGTH = 11;

export function generateToken(length = TOKEN_LENGTH): string {
  // Rejection sampling: taking a byte modulo the alphabet would favour the
  // first few characters, and a skewed token is a smaller search space.
  const max = Math.floor(256 / ALPHABET.length) * ALPHABET.length;
  let out = '';
  while (out.length < length) {
    for (const byte of randomBytes(length)) {
      if (byte >= max) continue;
      out += ALPHABET[byte % ALPHABET.length];
      if (out.length === length) break;
    }
  }
  return out;
}

export const resultLinkUrl = (token: string): string => `${publicWebUrl}/r/${token}`;

/**
 * A link of exactly the real length, for costing a send without minting a
 * credential for it. Every token is the same length, so this is not an
 * estimate — the segment count it produces is the one the school will be
 * billed for.
 */
export const sampleResultLinkUrl = (): string => resultLinkUrl('x'.repeat(TOKEN_LENGTH));

/**
 * Mints a link per student, reusing any that already exists.
 *
 * Publishing an exam twice must not invalidate the address already sitting in
 * a parent's message thread, so the token survives; only its expiry is pushed
 * out. Returns the URL per student id.
 */
export async function issueResultLinks(
  schoolId: string,
  examId: string,
  studentIds: string[],
): Promise<Map<string, string>> {
  if (studentIds.length === 0) return new Map();

  const expiresAt = new Date(Date.now() + env.RESULT_LINK_TTL_DAYS * 86_400_000);

  const existing = await prisma.resultLink.findMany({
    where: { examId, studentId: { in: studentIds } },
    select: { studentId: true, token: true },
  });
  const tokens = new Map(existing.map((l) => [l.studentId, l.token]));

  const missing = studentIds.filter((id) => !tokens.has(id));
  if (missing.length > 0) {
    const fresh = missing.map((studentId) => ({
      schoolId,
      examId,
      studentId,
      token: generateToken(),
      expiresAt,
    }));
    // Two publishes racing would otherwise fail the whole batch on the unique
    // key; skipping duplicates leaves the first one's token in place, which is
    // the one already texted.
    await prisma.resultLink.createMany({ data: fresh, skipDuplicates: true });
    for (const link of fresh) tokens.set(link.studentId, link.token);
  }

  if (existing.length > 0) {
    await prisma.resultLink.updateMany({
      where: { examId, studentId: { in: existing.map((l) => l.studentId) } },
      data: { expiresAt },
    });
  }

  return new Map([...tokens].map(([studentId, token]) => [studentId, resultLinkUrl(token)]));
}

export interface PublicResult {
  school: { name: string; logoUrl: string | null; motto: string | null };
  exam: { name: string; term: string | null; academicYear: string; className: string | null };
  student: { name: string; className: string | null; streamName: string | null };
  subjects: Array<{
    subject: string;
    score: number | null;
    maxScore: number;
    grade: string | null;
    isAbsent: boolean;
    remark: string | null;
  }>;
  average: number;
  totalScore: number;
  totalMax: number;
  gpa: number | null;
  position: number | null;
  outOf: number | null;
  classAverage: number;
}

/**
 * Resolves a token to the one child's results it addresses.
 *
 * Every reason to refuse — unknown token, expired, exam withdrawn — answers
 * the same "not found", so the response cannot be used to tell a real token
 * from an expired one, or to confirm that a school uses the system at all.
 */
export async function resultForToken(token: string): Promise<PublicResult> {
  const link = await prisma.resultLink.findUnique({
    where: { token },
    include: { exam: { select: { status: true } } },
  });

  if (!link || link.expiresAt < new Date() || link.exam.status !== ExamStatus.PUBLISHED) {
    throw notFound('Results link');
  }

  const card = await reportCard(link.schoolId, link.examId, link.studentId);

  // Best effort: a failed counter must not deny a parent their results.
  await prisma.resultLink
    .update({
      where: { id: link.id },
      data: { views: { increment: 1 }, lastViewedAt: new Date() },
    })
    .catch(() => undefined);

  return {
    school: {
      name: card.school.name,
      logoUrl: card.school.logoUrl,
      motto: card.school.motto,
    },
    exam: {
      name: card.exam.name,
      term: card.exam.term,
      academicYear: card.exam.academicYear,
      className: card.exam.className,
    },
    // Deliberately narrower than the signed-in report card: no admission
    // number, no identifiers that unlock anything else in the system.
    student: {
      name: card.student.name,
      className: card.student.className,
      streamName: card.student.streamName,
    },
    subjects: card.student.subjects.map((s) => ({
      subject: s.subject,
      score: s.score,
      maxScore: s.maxScore,
      grade: s.grade,
      isAbsent: s.isAbsent,
      remark: s.remark,
    })),
    average: card.student.average,
    totalScore: card.student.totalScore,
    totalMax: card.student.totalMax,
    gpa: card.student.gpa,
    position: card.student.position,
    outOf: card.classSummary.rankingEnabled ? card.classSummary.studentCount : null,
    classAverage: card.classSummary.classAverage,
  };
}
