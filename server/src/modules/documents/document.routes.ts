import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { asyncHandler, paginate, paginationSchema, skipTake, validate } from '../../lib/http.js';
import { requirePermission, schoolIdOf } from '../../middleware/auth.js';
import { audit } from '../../lib/audit.js';
import { badRequest, notFound } from '../../lib/errors.js';

/** Module 18 — Document Management. */
export const documentRouter: Router = Router();

const DOC_TYPES = [
  'BIRTH_CERTIFICATE',
  'LEAVING_CERTIFICATE',
  'MEDICAL_REPORT',
  'CONTRACT',
  'ID_COPY',
  'RESULT_SLIP',
  'OTHER',
] as const;

documentRouter.get(
  '/',
  requirePermission('documents:read'),
  validate(
    paginationSchema.extend({
      studentId: z.string().optional(),
      staffId: z.string().optional(),
      docType: z.enum(DOC_TYPES).optional(),
    }),
    'query',
  ),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as {
      page: number;
      pageSize: number;
      studentId?: string;
      staffId?: string;
      docType?: string;
    };
    const where = {
      schoolId: schoolIdOf(req),
      ...(q.studentId ? { studentId: q.studentId } : {}),
      ...(q.staffId ? { staffId: q.staffId } : {}),
      ...(q.docType ? { docType: q.docType } : {}),
    };

    const [data, total] = await Promise.all([
      prisma.document.findMany({
        where,
        ...skipTake(q.page, q.pageSize),
        orderBy: { createdAt: 'desc' },
        include: {
          student: { select: { admissionNumber: true, firstName: true, lastName: true } },
          staff: { select: { staffNumber: true, firstName: true, lastName: true } },
        },
      }),
      prisma.document.count({ where }),
    ]);

    res.json(paginate(data, total, q.page, q.pageSize));
  }),
);

/**
 * Registers a document against a student or staff member.
 *
 * The binary itself lives in object storage (S3 / Azure Blob per PRD section
 * 8); this endpoint records the metadata and the resulting URL.
 */
documentRouter.post(
  '/',
  requirePermission('documents:manage'),
  validate(
    z
      .object({
        studentId: z.string().nullish(),
        staffId: z.string().nullish(),
        docType: z.enum(DOC_TYPES),
        title: z.string().min(2).max(200),
        fileUrl: z.string().url(),
        mimeType: z.string().max(100).nullish(),
        sizeBytes: z.number().int().nonnegative().nullish(),
      })
      .refine((v) => Boolean(v.studentId) !== Boolean(v.staffId), {
        message: 'Provide exactly one of studentId or staffId',
        path: ['studentId'],
      }),
  ),
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const body = req.body as {
      studentId?: string | null;
      staffId?: string | null;
      docType: string;
      title: string;
      fileUrl: string;
    };

    if (body.studentId) {
      const student = await prisma.student.findFirst({ where: { id: body.studentId, schoolId } });
      if (!student) throw notFound('Student');
    }
    if (body.staffId) {
      const staff = await prisma.staff.findFirst({ where: { id: body.staffId, schoolId } });
      if (!staff) throw notFound('Staff member');
    }

    const document = await prisma.document.create({
      data: { ...req.body, schoolId, uploadedById: req.user?.id ?? null },
    });
    await audit(req, { action: 'document.create', entityType: 'Document', entityId: document.id });
    res.status(201).json(document);
  }),
);

documentRouter.delete(
  '/:id',
  requirePermission('documents:manage'),
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const id = req.params.id as string;
    const document = await prisma.document.findFirst({ where: { id, schoolId } });
    if (!document) throw notFound('Document');

    await prisma.document.delete({ where: { id } });
    await audit(req, { action: 'document.delete', entityType: 'Document', entityId: id });
    res.status(204).send();
  }),
);

/** Storage usage against the tenant's plan quota (Module 22). */
documentRouter.get(
  '/usage',
  requirePermission('documents:read'),
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const [agg, school] = await Promise.all([
      prisma.document.aggregate({ where: { schoolId }, _sum: { sizeBytes: true }, _count: true }),
      prisma.school.findUniqueOrThrow({
        where: { id: schoolId },
        select: { storageQuotaMb: true },
      }),
    ]);

    const usedMb = Number(((agg._sum.sizeBytes ?? 0) / (1024 * 1024)).toFixed(2));
    if (school.storageQuotaMb <= 0) throw badRequest('School storage quota is not configured');

    res.json({
      documents: agg._count,
      usedMb,
      quotaMb: school.storageQuotaMb,
      percentUsed: Number(((usedMb / school.storageQuotaMb) * 100).toFixed(1)),
    });
  }),
);
