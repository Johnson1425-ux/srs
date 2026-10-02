import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { asyncHandler, paginate, paginationSchema, skipTake, validate } from '../../lib/http.js';
import { requirePermission, schoolIdOf } from '../../middleware/auth.js';
import { audit } from '../../lib/audit.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { allowedMimeTypes, singleFile, verifyUpload } from '../../lib/upload.js';
import {
  deleteStoredFile,
  signedUrlFor,
  storageUsage,
  storeUpload,
} from '../../lib/storage/service.js';
import { maxUploadBytes } from '../../lib/storage/index.js';

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
          storedFile: { select: { id: true, filename: true, mimeType: true, sizeBytes: true } },
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

/**
 * Uploads a file and files it against a student or staff member.
 *
 * The multipart body carries the file on a `file` field and the same metadata
 * the JSON endpoint above takes, as form fields. Size, type and the school's
 * quota are all settled here, server-side, before a byte reaches the bucket.
 */
documentRouter.post(
  '/upload',
  requirePermission('documents:manage'),
  singleFile('file'),
  validate(
    z
      .object({
        studentId: z.string().trim().min(1).optional(),
        staffId: z.string().trim().min(1).optional(),
        docType: z.enum(DOC_TYPES),
        title: z.string().min(2).max(200),
      })
      .refine((v) => Boolean(v.studentId) !== Boolean(v.staffId), {
        message: 'Provide exactly one of studentId or staffId',
        path: ['studentId'],
      }),
  ),
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const body = req.body as {
      studentId?: string;
      staffId?: string;
      docType: string;
      title: string;
    };

    // The subject is confirmed to be this school's before anything is stored,
    // so a failed check cannot leave an object behind.
    if (body.studentId) {
      const student = await prisma.student.findFirst({ where: { id: body.studentId, schoolId } });
      if (!student) throw notFound('Student');
    }
    if (body.staffId) {
      const staff = await prisma.staff.findFirst({ where: { id: body.staffId, schoolId } });
      if (!staff) throw notFound('Staff member');
    }

    const upload = verifyUpload(req.file, allowedMimeTypes);
    const stored = await storeUpload({
      schoolId,
      purpose: 'DOCUMENT',
      upload,
      uploadedById: req.user?.id ?? null,
    });

    let document;
    try {
      document = await prisma.document.create({
        data: {
          schoolId,
          studentId: body.studentId ?? null,
          staffId: body.staffId ?? null,
          docType: body.docType,
          title: body.title,
          storedFileId: stored.id,
          mimeType: stored.mimeType,
          sizeBytes: stored.sizeBytes,
          uploadedById: req.user?.id ?? null,
        },
        include: {
          storedFile: { select: { id: true, filename: true, mimeType: true, sizeBytes: true } },
        },
      });
    } catch (err) {
      // Nothing refers to the object now, so it should not stay — or it would
      // count against the quota for a document that does not exist.
      await deleteStoredFile(stored.id);
      throw err;
    }

    await audit(req, {
      action: 'document.upload',
      entityType: 'Document',
      entityId: document.id,
      metadata: { filename: stored.filename, sizeBytes: stored.sizeBytes, docType: body.docType },
    });
    res.status(201).json(document);
  }),
);

/**
 * A short-lived link to the file itself.
 *
 * The URL is returned rather than the bytes: the browser then fetches straight
 * from the bucket, so a 4MB scan does not travel through the API twice. It
 * expires in minutes, and is scoped to the caller's school on the way out.
 */
documentRouter.get(
  '/:id/file',
  requirePermission('documents:read'),
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const document = await prisma.document.findFirst({
      where: { id: req.params.id as string, schoolId },
      select: { id: true, storedFileId: true, fileUrl: true },
    });
    if (!document) throw notFound('Document');

    // A row from before uploads existed holds a link to somewhere else; there
    // is nothing of ours to sign, so the link itself is the answer.
    if (!document.storedFileId) {
      if (!document.fileUrl) throw notFound('File');
      res.json({ url: document.fileUrl, external: true });
      return;
    }

    const signed = await signedUrlFor(document.storedFileId, schoolId);
    await audit(req, { action: 'document.download', entityType: 'Document', entityId: document.id });
    res.json({ ...signed, external: false });
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
    // The row is gone, so the object has nothing pointing at it. Removing it
    // here is what gives the school its quota back.
    if (document.storedFileId) await deleteStoredFile(document.storedFileId);

    await audit(req, { action: 'document.delete', entityType: 'Document', entityId: id });
    res.status(204).send();
  }),
);

/**
 * Storage usage against the tenant's plan quota (Module 22).
 *
 * Counted from stored objects, so student photographs weigh against the quota
 * alongside filed documents — both occupy the same bucket.
 */
documentRouter.get(
  '/usage',
  requirePermission('documents:read'),
  asyncHandler(async (req, res) => {
    const schoolId = schoolIdOf(req);
    const usage = await storageUsage(schoolId);
    if (usage.quotaMb <= 0) throw badRequest('School storage quota is not configured');

    const documents = await prisma.document.count({ where: { schoolId } });

    res.json({
      ...usage,
      documents,
      maxUploadMb: Math.round(maxUploadBytes() / (1024 * 1024)),
      acceptedTypes: allowedMimeTypes,
    });
  }),
);
