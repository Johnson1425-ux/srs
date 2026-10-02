import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { env, storageConfigured } from '../../config/env.js';
import { badRequest } from '../errors.js';
import { LocalStorageDriver } from './local.js';
import { S3StorageDriver } from './s3.js';
import type { StorageDriver } from './types.js';

export type { PutInput, StorageDriver, StoredObject } from './types.js';
export { verifyLocalSignature } from './local.js';
export { LocalStorageDriver } from './local.js';

let driver: StorageDriver | null = null;

/** Swappable for tests, and the seam a third provider would slot into. */
export function setStorageDriver(next: StorageDriver | null): void {
  driver = next;
}

/**
 * The configured driver, constructed on first use.
 *
 * Built lazily rather than at import time so that a deployment with no storage
 * configured still boots and serves every other module — only the upload
 * endpoints refuse.
 */
export function activeStorage(): StorageDriver | null {
  if (driver) return driver;
  if (!storageConfigured) return null;
  driver = env.STORAGE_DRIVER === 'local' ? new LocalStorageDriver() : new S3StorageDriver();
  return driver;
}

/** The driver, or a 400 explaining that uploads are not set up. */
export function requireStorage(): StorageDriver {
  const active = activeStorage();
  if (!active) {
    throw badRequest(
      'File storage is not configured on this installation. Set STORAGE_DRIVER and the bucket credentials.',
    );
  }
  return active;
}

export const maxUploadBytes = () => env.STORAGE_MAX_UPLOAD_MB * 1024 * 1024;

/**
 * Trims an uploaded filename down to something safe to put in a key.
 *
 * Only the extension is really kept — the name itself is recorded in the
 * database, and reproducing a parent's `Scan 12/08 (copy).pdf` in a key buys
 * nothing and invites both traversal and encoding trouble.
 */
export function safeExtension(filename: string): string {
  const ext = path.extname(filename).toLowerCase().slice(0, 10);
  return /^\.[a-z0-9]{1,9}$/.test(ext) ? ext : '';
}

/**
 * Builds the key an object is stored under.
 *
 * Every key begins with the school, which is what makes one bucket safe to
 * share between tenants: a scoped R2 token, a lifecycle rule or a bulk delete
 * can address exactly one school's objects by prefix, and a key from the wrong
 * tenant is visibly wrong rather than merely unauthorised.
 *
 * The random id defeats guessing and means re-uploading never overwrites the
 * previous version by accident.
 */
export function storageKey(
  schoolId: string,
  folder: 'documents' | 'photos',
  filename: string,
): string {
  return `schools/${schoolId}/${folder}/${randomUUID()}${safeExtension(filename)}`;
}

/** Whether a key belongs to the given school — the guard on every read. */
export function keyBelongsToSchool(key: string, schoolId: string): boolean {
  return key.startsWith(`schools/${schoolId}/`);
}
