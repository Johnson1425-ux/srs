import multer from 'multer';
import type { RequestHandler } from 'express';
import { AppError, badRequest } from './errors.js';
import { maxUploadBytes } from './storage/index.js';

/**
 * Accepting files from a browser, safely.
 *
 * Uploads are buffered in memory and forwarded to the bucket by the API rather
 * than sent to it directly from the browser. That costs a little bandwidth and
 * buys three things worth more: the size limit, the type allowlist and the
 * school's storage quota are all enforced somewhere a client cannot edit, and
 * the bucket needs no CORS policy or publicly reachable write path at all.
 *
 * It is affordable here because of what these files are — a photograph, a
 * scanned certificate — and it is why the size cap matters: it is also the cap
 * on how much memory one request can take.
 */

/**
 * What a school may upload.
 *
 * Deliberately short. Everything a registrar actually files is a photograph or
 * a scan, and every addition is another parser exposed to a stranger's bytes.
 */
const ALLOWED = new Map<string, { label: string; extensions: string[] }>([
  ['image/jpeg', { label: 'JPEG image', extensions: ['.jpg', '.jpeg'] }],
  ['image/png', { label: 'PNG image', extensions: ['.png'] }],
  ['image/webp', { label: 'WebP image', extensions: ['.webp'] }],
  ['application/pdf', { label: 'PDF', extensions: ['.pdf'] }],
]);

export const allowedMimeTypes = [...ALLOWED.keys()];
export const allowedImageTypes = allowedMimeTypes.filter((m) => m.startsWith('image/'));

/**
 * Identifies the content from its leading bytes.
 *
 * The browser's `Content-Type` is a claim by whoever made the request, so it is
 * checked rather than trusted — otherwise an executable named `report.pdf`
 * passes the allowlist on the strength of its own say-so, and is then handed
 * back to the next person who opens it with the type they were promised.
 */
export function sniffMimeType(buffer: Buffer): string | null {
  if (buffer.byteLength < 12) return null;

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }

  // PDF: %PDF-
  if (buffer.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';

  // WebP: "RIFF" .... "WEBP"
  if (
    buffer.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buffer.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }

  return null;
}

export interface VerifiedUpload {
  buffer: Buffer;
  /** The type the bytes actually are, not the type the request claimed. */
  mimeType: string;
  filename: string;
  sizeBytes: number;
}

/**
 * Validates the file on a request against an allowlist.
 *
 * `accept` narrows it further — a student photograph has no business being a
 * PDF, even though a document may be.
 */
export function verifyUpload(
  file: Express.Multer.File | undefined,
  accept: string[] = allowedMimeTypes,
): VerifiedUpload {
  if (!file) throw badRequest('No file was uploaded — send one as the `file` field');
  if (file.size === 0) throw badRequest('The uploaded file is empty');

  const sniffed = sniffMimeType(file.buffer);
  if (!sniffed) {
    throw badRequest(
      `Unrecognised file type. Accepted: ${accept.map((m) => ALLOWED.get(m)?.label ?? m).join(', ')}`,
    );
  }
  if (!accept.includes(sniffed)) {
    const labels = accept.map((m) => ALLOWED.get(m)?.label ?? m).join(', ');
    throw badRequest(`${ALLOWED.get(sniffed)?.label ?? sniffed} is not accepted here. Use: ${labels}`);
  }

  return {
    buffer: file.buffer,
    mimeType: sniffed,
    // A browser sends the basename, but a crafted request can send anything;
    // the path is stripped so a stored name can never be read as a location.
    filename: (file.originalname || 'upload').split(/[\\/]/).pop()!.slice(0, 200),
    sizeBytes: file.size,
  };
}

/**
 * Accepts a single file on the `file` field.
 *
 * multer reports its own errors (chiefly LIMIT_FILE_SIZE) as a MulterError,
 * which the error handler would otherwise render as a 500; they are translated
 * here into the same 400 shape as every other validation failure.
 */
export function singleFile(field = 'file'): RequestHandler {
  const handler = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxUploadBytes(), files: 1, fields: 20 },
  }).single(field);

  return (req, res, next) => {
    handler(req, res, (err: unknown) => {
      if (!err) return next();
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          const mb = Math.round(maxUploadBytes() / (1024 * 1024));
          return next(badRequest(`That file is too large. The limit is ${mb}MB.`));
        }
        return next(badRequest(`Upload rejected: ${err.message}`));
      }
      return next(err instanceof AppError ? err : badRequest('Upload could not be read'));
    });
  };
}
