import { type Gender, Role, StudentStatus } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { isSaas } from '../../config/env.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { nextAdmissionNumber } from '../../lib/sequence.js';
import { hashPassword, randomToken } from '../../lib/tokens.js';

export interface AdmissionInput {
  admissionNumber?: string;
  firstName: string;
  middleName?: string | null;
  lastName: string;
  gender: Gender;
  dateOfBirth: Date;
  nationality?: string;
  address?: string | null;
  photoUrl?: string | null;
  bloodGroup?: string | null;
  medicalConditions?: string | null;
  previousSchool?: string | null;
  emergencyContactName?: string | null;
  emergencyContactPhone?: string | null;
  admissionDate?: Date;
  classId: string;
  streamId?: string | null;
  academicYearId?: string;
  createPortalAccount?: boolean;
  guardians?: Array<{
    guardianId?: string;
    firstName?: string;
    lastName?: string;
    relationship?: string;
    phone?: string;
    email?: string | null;
    occupation?: string | null;
    address?: string | null;
    isPrimary?: boolean;
    isFeePayer?: boolean;
    createPortalAccount?: boolean;
  }>;
}

export const studentInclude = {
  enrollments: {
    where: { isActive: true },
    include: {
      schoolClass: { select: { id: true, name: true, level: true } },
      stream: { select: { id: true, name: true } },
      academicYear: { select: { id: true, name: true } },
    },
  },
  guardianLinks: { include: { guardian: true } },
  user: { select: { id: true, email: true, status: true } },
} as const;

async function currentAcademicYearId(schoolId: string): Promise<string> {
  const year = await prisma.academicYear.findFirst({ where: { schoolId, isCurrent: true } });
  if (!year) {
    throw badRequest('No current academic year is set. Configure one under school setup first.');
  }
  return year.id;
}

/**
 * Admits a student: creates the record, the enrollment for the academic year,
 * guardian links, and (optionally) portal logins for the student and guardians.
 * All of it in one transaction so a partial admission can never be left behind.
 */
export async function admitStudent(schoolId: string, input: AdmissionInput) {
  const academicYearId = input.academicYearId ?? (await currentAcademicYearId(schoolId));

  const schoolClass = await prisma.schoolClass.findFirst({
    where: { id: input.classId, schoolId },
  });
  if (!schoolClass) throw notFound('Class');

  if (input.streamId) {
    const stream = await prisma.stream.findFirst({
      where: { id: input.streamId, classId: input.classId },
      include: { _count: { select: { enrollments: { where: { isActive: true } } } } },
    });
    if (!stream) throw notFound('Stream');
    if (stream._count.enrollments >= stream.capacity) {
      throw conflict(`Stream ${stream.name} is full (capacity ${stream.capacity})`);
    }
  }

  // Enforce the tenant's student cap from its subscription plan. A standalone
  // installation is owned outright, so there is no plan to cap it against.
  if (isSaas) {
    const school = await prisma.school.findUniqueOrThrow({
      where: { id: schoolId },
      select: { maxStudents: true },
    });
    const activeCount = await prisma.student.count({
      where: { schoolId, status: StudentStatus.ACTIVE },
    });
    if (activeCount >= school.maxStudents) {
      throw conflict(
        `This school has reached its plan limit of ${school.maxStudents} active students.`,
      );
    }
  }

  const credentials: Array<{ role: string; name: string; email: string; password: string }> = [];

  const student = await prisma.$transaction(async (tx) => {
    const admissionNumber =
      input.admissionNumber?.trim() || (await nextAdmissionNumber(schoolId, tx));

    let userId: string | null = null;
    if (input.createPortalAccount) {
      const password = `Sms-${randomToken(4)}`;
      const email = `${admissionNumber.replace(/[^a-zA-Z0-9]/g, '.').toLowerCase()}@students.local`;
      const user = await tx.user.create({
        data: {
          schoolId,
          email,
          firstName: input.firstName,
          lastName: input.lastName,
          role: Role.STUDENT,
          passwordHash: await hashPassword(password),
          mustChangePassword: true,
        },
      });
      userId = user.id;
      credentials.push({
        role: 'STUDENT',
        name: `${input.firstName} ${input.lastName}`,
        email,
        password,
      });
    }

    const created = await tx.student.create({
      data: {
        schoolId,
        userId,
        admissionNumber,
        firstName: input.firstName,
        middleName: input.middleName ?? null,
        lastName: input.lastName,
        gender: input.gender,
        dateOfBirth: input.dateOfBirth,
        nationality: input.nationality ?? 'Tanzanian',
        address: input.address ?? null,
        photoUrl: input.photoUrl ?? null,
        bloodGroup: input.bloodGroup ?? null,
        medicalConditions: input.medicalConditions ?? null,
        previousSchool: input.previousSchool ?? null,
        emergencyContactName: input.emergencyContactName ?? null,
        emergencyContactPhone: input.emergencyContactPhone ?? null,
        admissionDate: input.admissionDate ?? new Date(),
        enrollments: {
          create: {
            academicYearId,
            classId: input.classId,
            streamId: input.streamId ?? null,
          },
        },
      },
    });

    for (const g of input.guardians ?? []) {
      let guardianId = g.guardianId;

      if (!guardianId) {
        if (!g.firstName || !g.lastName || !g.phone || !g.relationship) {
          throw badRequest(
            'A new guardian requires firstName, lastName, relationship and phone',
          );
        }
        // Re-use an existing guardian with the same phone rather than
        // duplicating a parent who already has children at the school.
        const existing = await tx.guardian.findFirst({ where: { schoolId, phone: g.phone } });

        if (existing) {
          guardianId = existing.id;
        } else {
          let guardianUserId: string | null = null;
          if (g.createPortalAccount) {
            const password = `Sms-${randomToken(4)}`;
            const email = g.email ?? `${g.phone.replace(/\D/g, '')}@parents.local`;
            const user = await tx.user.create({
              data: {
                schoolId,
                email: email.toLowerCase(),
                phone: g.phone,
                firstName: g.firstName,
                lastName: g.lastName,
                role: Role.PARENT,
                passwordHash: await hashPassword(password),
                mustChangePassword: true,
              },
            });
            guardianUserId = user.id;
            credentials.push({
              role: 'PARENT',
              name: `${g.firstName} ${g.lastName}`,
              email: email.toLowerCase(),
              password,
            });
          }

          const guardian = await tx.guardian.create({
            data: {
              schoolId,
              userId: guardianUserId,
              firstName: g.firstName,
              lastName: g.lastName,
              relationship: g.relationship,
              phone: g.phone,
              email: g.email ?? null,
              occupation: g.occupation ?? null,
              address: g.address ?? null,
            },
          });
          guardianId = guardian.id;
        }
      }

      await tx.studentGuardian.create({
        data: {
          studentId: created.id,
          guardianId,
          isPrimary: g.isPrimary ?? false,
          isFeePayer: g.isFeePayer ?? false,
        },
      });
    }

    return tx.student.findUniqueOrThrow({ where: { id: created.id }, include: studentInclude });
  });

  return { student, credentials };
}

export async function getStudent(schoolId: string, id: string) {
  const student = await prisma.student.findFirst({
    where: { id, schoolId },
    include: studentInclude,
  });
  if (!student) throw notFound('Student');
  return student;
}

export async function setStatus(
  schoolId: string,
  id: string,
  status: StudentStatus,
  reason?: string,
) {
  const student = await prisma.student.findFirst({ where: { id, schoolId } });
  if (!student) throw notFound('Student');

  if (student.status === status) {
    throw conflict(`Student is already ${status.toLowerCase()}`);
  }
  if (student.status === StudentStatus.ARCHIVED) {
    throw conflict('Archived students cannot change status');
  }

  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const updated = await tx.student.update({
      where: { id },
      data: {
        status,
        statusReason: reason ?? null,
        graduatedAt: status === StudentStatus.GRADUATED ? now : student.graduatedAt,
        archivedAt: status === StudentStatus.ARCHIVED ? now : student.archivedAt,
      },
    });

    // Leaving the school ends the active enrollment and any portal access.
    if (
      status === StudentStatus.GRADUATED ||
      status === StudentStatus.ARCHIVED ||
      status === StudentStatus.TRANSFERRED
    ) {
      await tx.enrollment.updateMany({
        where: { studentId: id, isActive: true },
        data: { isActive: false },
      });
      if (student.userId) {
        await tx.user.update({ where: { id: student.userId }, data: { status: 'DISABLED' } });
        await tx.session.updateMany({
          where: { userId: student.userId, revokedAt: null },
          data: { revokedAt: now },
        });
      }
    }

    return updated;
  });
}

export interface PromotionInput {
  fromClassId: string;
  toClassId: string;
  toAcademicYearId: string;
  toStreamId?: string | null;
  studentIds?: string[];
}

/**
 * Class promotion (Module 7). Students keep their history: the old enrollment
 * is deactivated and a new one is created for the target year.
 */
export async function promoteStudents(schoolId: string, input: PromotionInput) {
  const [fromClass, toClass, year] = await Promise.all([
    prisma.schoolClass.findFirst({ where: { id: input.fromClassId, schoolId } }),
    prisma.schoolClass.findFirst({ where: { id: input.toClassId, schoolId } }),
    prisma.academicYear.findFirst({ where: { id: input.toAcademicYearId, schoolId } }),
  ]);
  if (!fromClass) throw notFound('Source class');
  if (!toClass) throw notFound('Target class');
  if (!year) throw notFound('Academic year');

  const candidates = await prisma.enrollment.findMany({
    where: {
      classId: input.fromClassId,
      isActive: true,
      student: {
        schoolId,
        status: StudentStatus.ACTIVE,
        ...(input.studentIds?.length ? { id: { in: input.studentIds } } : {}),
      },
    },
    select: { id: true, studentId: true },
  });

  if (candidates.length === 0) {
    throw badRequest('No active students matched the promotion criteria');
  }

  const results = await prisma.$transaction(async (tx) => {
    const promoted: string[] = [];
    const skipped: Array<{ studentId: string; reason: string }> = [];

    for (const enrollment of candidates) {
      const already = await tx.enrollment.findUnique({
        where: {
          studentId_academicYearId: {
            studentId: enrollment.studentId,
            academicYearId: input.toAcademicYearId,
          },
        },
      });
      if (already) {
        skipped.push({
          studentId: enrollment.studentId,
          reason: 'Already enrolled for the target academic year',
        });
        continue;
      }

      await tx.enrollment.update({ where: { id: enrollment.id }, data: { isActive: false } });
      await tx.enrollment.create({
        data: {
          studentId: enrollment.studentId,
          academicYearId: input.toAcademicYearId,
          classId: input.toClassId,
          streamId: input.toStreamId ?? null,
        },
      });
      promoted.push(enrollment.studentId);
    }

    return { promoted, skipped };
  });

  return {
    promotedCount: results.promoted.length,
    skippedCount: results.skipped.length,
    ...results,
  };
}
