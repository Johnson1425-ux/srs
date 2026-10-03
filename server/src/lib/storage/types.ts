/**
 * Object storage, as the rest of the app sees it.
 *
 * Documents, student photographs and staff contracts are binaries that do not
 * belong in PostgreSQL. They live in a bucket, and the database keeps only the
 * key that points at one.
 *
 * Keys are *not* URLs. A bucket is private, so there is no address a browser
 * can simply fetch — a reader is handed a signed URL that expires. Storing the
 * key rather than a URL also means credentials, bucket names and even the
 * provider can change without rewriting a single row.
 */
export interface StoredObject {
  /** The key within the bucket, which is what the database records. */
  key: string;
  sizeBytes: number;
  mimeType: string;
}

export interface PutInput {
  key: string;
  body: Buffer;
  mimeType: string;
  /**
   * The name the file had on the uploader's machine, returned to a browser in
   * `Content-Disposition` so a download is saved under something recognisable
   * rather than the key's random id.
   */
  filename?: string;
}

export interface StorageDriver {
  readonly name: string;

  put(input: PutInput): Promise<StoredObject>;

  /**
   * A time-limited URL that reads the object without credentials.
   *
   * Treat the result as a bearer token: anyone holding it can read that one
   * object until it expires, which is why the TTL is minutes rather than days
   * and why these URLs are never persisted.
   */
  signedUrl(key: string, expiresInSeconds: number): Promise<string>;

  /**
   * Removes the object. Succeeds when the key is already gone — a delete that
   * races another, or retries after a half-finished one, should not fail the
   * row deletion it accompanies.
   */
  remove(key: string): Promise<void>;
}
