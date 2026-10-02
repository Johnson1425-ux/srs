import { env } from '../../config/env.js';
import { prisma } from '../../db/prisma.js';
import { badRequest, notFound } from '../errors.js';
import type { VerifiedUpload } from '../upload.js';
import { keyBelongsToSchool, requireStorage, storageKey } from './index.js';

/**
 * Storage as the modules use it: an upload that is accounted for, and a
 * download that cannot cross a tenant boundary.
 */

export type StoragePurpose = 'DOCUMENT' | 'STUDENT_PHOTO';

const FOLDER: Record<StoragePurpose, 'documents' | 'photos'> = {
  DOCUMENT: 'documents',
  STUDENT_PHOTO: 'photos',
};

export interface StorageUsage {
  files: number;
  usedBytes: number;
  usedMb: number;
  quotaMb: number;
  percentUsed: number;
  remainingBytes: number;
}

/**
 * What a school is using, against what it is allowed.
 *
 * Summed from StoredFile, which is every object the app has ever put in the
 * bucket for this tenant — so a photograph counts the same as a certificate,
 * and the figure cannot drift from reality by one module forgetting to report.
 */
export async function storageUsage(schoolId: string): Promise<StorageUsage> {
  const [agg, school] = await Promise.all([
    prisma.storedFile.aggregate({
      where: { schoolId },
      _sum: { sizeBytes: true },
      _count: true,
    }),
    prisma.school.findUniqueOrThrow({
      where: { id: schoolId },
      select: { storageQuotaMb: true },
    }),
  ]);

  const usedBytes = agg._sum.sizeBytes ?? 0;
  const quotaBytes = school.storageQuotaMb * 1024 * 1024;

  return {
    files: agg._count,
    usedBytes,
    usedMb: Number((usedBytes / (1024 * 1024)).toFixed(2)),
    quotaMb: school.storageQuotaMb,
    percentUsed:
      quotaBytes > 0 ? Number(((usedBytes / quotaBytes) * 100).toFixed(1)) : 0,
    remainingBytes: Math.max(0, quotaBytes - usedBytes),
  };
}

/**
 * Stores an uploaded file and records it against the school.
 *
 * The quota is checked immediately before the upload rather than afterwards,
 * so a school that is already full is told so instead of being billed for the
 * transfer and then refused. Two simultaneous uploads can still both pass that
 * check and land slightly over — the alternative is locking the table on every
 * upload, which is a poor trade for a limit whose purpose is to bound growth,
 * not to be exact to the byte.
 */
export async function storeUpload(options: {
  schoolId: string;
  purpose: StoragePurpose;
  upload: VerifiedUpload;
  uploadedById?: string | null;
}) {
  const { schoolId, purpose, upload, uploadedById } = options;
  const storage = requireStorage();

  const usage = await storageUsage(schoolId);
  if (usage.quotaMb <= 0) {
    throw badRequest('This school has no storage quota. Ask your provider to set one.');
  }
  if (upload.sizeBytes > usage.remainingBytes) {
    const remainingMb = (usage.remainingBytes / (1024 * 1024)).toFixed(1);
    throw badRequest(
      `Not enough storage left — ${remainingMb}MB of ${usage.quotaMb}MB free. Delete some files or ask for a larger quota.`,
    );
  }

  const key = storageKey(schoolId, FOLDER[purpose], upload.filename);
  await storage.put({
    key,
    body: upload.buffer,
    mimeType: upload.mimeType,
    filename: upload.filename,
  });

  try {
    return await prisma.storedFile.create({
      data: {
        schoolId,
        key,
        filename: upload.filename,
        mimeType: upload.mimeType,
        sizeBytes: upload.sizeBytes,
        purpose,
        uploadedById: uploadedById ?? null,
      },
    });
  } catch (err) {
    // The object is in the bucket but nothing refers to it. Take it back out
    // rather than leaving a tenant paying for storage they cannot see.
    await storage.remove(key).catch(() => undefined);
    throw err;
  }
}

/**
 * Deletes an object and its record.
 *
 * The row goes first: if the bucket then fails, the result is an object nobody
 * refers to, which a sweep can find from the bucket side. The other order
 * risks a row pointing at nothing, which looks to a user like a file that
 * exists and will not open.
 */
export async function deleteStoredFile(fileId: string): Promise<void> {
  const file = await prisma.storedFile.findUnique({ where: { id: fileId } });
  if (!file) return;

  await prisma.storedFile.delete({ where: { id: fileId } });

  try {
    await requireStorage().remove(file.key);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[storage] orphaned object left in the bucket: ${file.key}`, err);
  }
}

/**
 * A signed URL for reading a stored file, checked against the caller's school.
 *
 * The tenant check is on the key's own prefix as well as the row, because the
 * key is what is about to be signed: belt and braces on the one operation that
 * hands out direct access to a bucket.
 */
export async function signedUrlFor(fileId: string, schoolId: string): Promise<{
  url: string;
  filename: string;
  mimeType: string;
  expiresInSeconds: number;
}> {
  const file = await prisma.storedFile.findFirst({ where: { id: fileId, schoolId } });
  if (!file) throw notFound('File');
  if (!keyBelongsToSchool(file.key, schoolId)) throw notFound('File');

  const url = await requireStorage().signedUrl(file.key, env.STORAGE_URL_TTL_SECONDS);
  return {
    url,
    filename: file.filename,
    mimeType: file.mimeType,
    expiresInSeconds: env.STORAGE_URL_TTL_SECONDS,
  };
}
