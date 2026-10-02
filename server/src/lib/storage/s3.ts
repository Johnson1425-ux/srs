import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env, s3Endpoint } from '../../config/env.js';
import type { PutInput, StorageDriver, StoredObject } from './types.js';

/**
 * Object storage over the S3 API — Cloudflare R2, or any bucket that speaks
 * the same protocol.
 *
 * R2 needs no special handling beyond its endpoint: it implements the subset
 * used here (PutObject, GetObject, DeleteObject and SigV4 presigning) exactly
 * as S3 does, which is why one driver serves both and `STORAGE_DRIVER` only
 * decides where the endpoint comes from.
 */
export class S3StorageDriver implements StorageDriver {
  readonly name: string;

  private readonly client: S3Client;
  private readonly bucket: string;

  constructor() {
    const endpoint = s3Endpoint();
    if (!endpoint) {
      throw new Error(
        'Object storage is misconfigured: set R2_ACCOUNT_ID (for STORAGE_DRIVER=r2) or S3_ENDPOINT',
      );
    }
    if (!env.R2_BUCKET) throw new Error('Object storage is misconfigured: R2_BUCKET is not set');
    if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) {
      throw new Error(
        'Object storage is misconfigured: R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY are both required',
      );
    }

    this.name = env.STORAGE_DRIVER;
    this.bucket = env.R2_BUCKET;
    this.client = new S3Client({
      region: env.S3_REGION,
      endpoint,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      credentials: {
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      },
    });
  }

  async put(input: PutInput): Promise<StoredObject> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        Body: input.body,
        ContentType: input.mimeType,
        // Recorded on the object so the original name survives even if the
        // database row is lost, and so a direct bucket listing is readable.
        ...(input.filename ? { Metadata: { filename: encodeURIComponent(input.filename) } } : {}),
      }),
    );

    return { key: input.key, sizeBytes: input.body.byteLength, mimeType: input.mimeType };
  }

  async signedUrl(key: string, expiresInSeconds: number): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: expiresInSeconds,
    });
  }

  async remove(key: string): Promise<void> {
    // S3 and R2 both return 204 for a key that was never there, so this is
    // already idempotent without checking first.
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
