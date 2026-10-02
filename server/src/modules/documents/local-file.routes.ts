import { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { prisma } from '../../db/prisma.js';
import { asyncHandler, validate } from '../../lib/http.js';
import { notFound } from '../../lib/errors.js';
import { LocalStorageDriver, activeStorage, verifyLocalSignature } from '../../lib/storage/index.js';

/**
 * Serves objects held by the local storage driver.
 *
 * A bucket serves its own presigned URLs; the filesystem has nothing that can,
 * so this route stands in for one. The signature in the query string is the
 * credential — it names one key and carries its own expiry — which is why this
 * is mounted above `authenticate`, exactly as the texted results links are. No
 * session is involved, so an `<img src>` works without a token in a header.
 *
 * With STORAGE_DRIVER=r2 nothing reaches here: those URLs point at the bucket.
 */
export const localFileRouter: Router = Router();

localFileRouter.get(
  '/',
  validate(
    z.object({
      key: z.string().min(1).max(500),
      expires: z.string().min(1),
      signature: z.string().min(1),
    }),
    'query',
  ),
  asyncHandler(async (req, res) => {
    const driver = activeStorage();
    // Only the local driver mints these URLs, so a request for one under any
    // other driver is answered as if the file were simply not there.
    if (!(driver instanceof LocalStorageDriver)) throw notFound('File');

    const q = req.query as unknown as { key: string; expires: string; signature: string };
    const key = verifyLocalSignature(q);
    if (!key) throw notFound('File');

    // The record carries the type and name to serve it under. Both were
    // settled at upload — the type sniffed from the bytes rather than taken
    // from the uploader's claim — so neither is attacker-chosen here.
    const file = await prisma.storedFile.findUnique({
      where: { key },
      select: { mimeType: true, filename: true, sizeBytes: true },
    });
    if (!file) throw notFound('File');

    let body: Buffer;
    try {
      body = await driver.read(key);
    } catch {
      throw notFound('File');
    }

    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Content-Length', String(body.byteLength));
    // `inline` lets a browser show a photograph or a PDF in place; the quoted
    // filename is what a save produces. Quotes in the name are stripped rather
    // than escaped, so the header cannot be split.
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${file.filename.replace(/["\\\r\n]/g, '')}"`,
    );
    // Private, because the URL is a bearer credential and a shared cache must
    // not keep a copy to hand to the next person who asks for the same path.
    res.setHeader('Cache-Control', `private, max-age=${env.STORAGE_URL_TTL_SECONDS}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(body);
  }),
);
