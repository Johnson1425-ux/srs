import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env, publicWebUrl } from '../../config/env.js';
import type { PutInput, StorageDriver, StoredObject } from './types.js';

/**
 * Object storage on the local filesystem.
 *
 * This exists so that development, the test suite and a single-server
 * installation all work without a bucket or any credentials. It is deliberately
 * not suitable for more than one API instance: two containers would each hold
 * half the uploads and disagree about which existed.
 */

/** A key may only ever be these characters, in segments, with no `..`. */
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

function assertSafeKey(key: string): void {
  if (!SAFE_KEY.test(key) || key.split('/').includes('..')) {
    throw new Error(`Unsafe storage key: ${key}`);
  }
}


/**
 * Stands in for S3's presigning.
 *
 * A bucket proves a URL's authenticity with SigV4 over the request; there is no
 * bucket here, so the signature is an HMAC over the key and its expiry, read
 * back by the `/storage/local` route. Same property either way: the URL is a
 * bearer credential for one object until it expires, and it cannot be edited to
 * point at another object or to last longer.
 */
/**
 * Prefixed so that this signature and a session token can never be mistaken
 * for one another, even though both are HMAC-SHA256 under the same secret.
 */
const SIGNATURE_DOMAIN = 'sms.storage.local.v1';

function sign(key: string, expiresAt: number): string {
  return createHmac('sha256', env.JWT_ACCESS_SECRET)
    .update(`${SIGNATURE_DOMAIN}\n${key}\n${expiresAt}`)
    .digest('base64url');
}

export interface LocalSignature {
  key: string;
  expires: string;
  signature: string;
}

/**
 * Checks a signed local URL and returns the key it grants.
 *
 * Returns null for anything that does not verify, so the caller cannot
 * accidentally treat a tampered key as valid.
 */
export function verifyLocalSignature(input: LocalSignature): string | null {
  const expiresAt = Number(input.expires);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return null;
  if (!SAFE_KEY.test(input.key) || input.key.split('/').includes('..')) return null;

  const expected = Buffer.from(sign(input.key, expiresAt));
  const given = Buffer.from(input.signature);
  // Compared with a constant-time check, and only when the lengths match —
  // timingSafeEqual throws on a mismatch rather than returning false.
  if (expected.byteLength !== given.byteLength || !timingSafeEqual(expected, given)) return null;

  return input.key;
}

export class LocalStorageDriver implements StorageDriver {
  readonly name = 'local';

  private readonly root: string;

  /**
   * `root` is taken as an argument rather than read from the environment on
   * each call, because the parsed config is fixed at boot — a test that wants
   * its own directory has to be able to say so.
   */
  constructor(root: string = env.STORAGE_LOCAL_PATH) {
    this.root = path.resolve(root);
  }

  /** Resolves a key under the storage root, refusing anything that escapes it. */
  private resolveKey(key: string): string {
    assertSafeKey(key);
    const full = path.resolve(this.root, key);
    const prefix = this.root + path.sep;
    if (full !== this.root && !full.startsWith(prefix)) {
      throw new Error(`Unsafe storage key: ${key}`);
    }
    return full;
  }

  async put(input: PutInput): Promise<StoredObject> {
    const full = this.resolveKey(input.key);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, input.body);
    return { key: input.key, sizeBytes: input.body.byteLength, mimeType: input.mimeType };
  }

  async signedUrl(key: string, expiresInSeconds: number): Promise<string> {
    assertSafeKey(key);
    const expiresAt = Date.now() + expiresInSeconds * 1000;
    const query = new URLSearchParams({
      key,
      expires: String(expiresAt),
      signature: sign(key, expiresAt),
    });
    return `${publicWebUrl}/api/v1/storage/local?${query.toString()}`;
  }

  async remove(key: string): Promise<void> {
    // `force` makes a missing file a no-op, matching the bucket drivers.
    await rm(this.resolveKey(key), { force: true });
  }

  /** Reads an object back. Used by the route that serves signed local URLs. */
  async read(key: string): Promise<Buffer> {
    return readFile(this.resolveKey(key));
  }
}
