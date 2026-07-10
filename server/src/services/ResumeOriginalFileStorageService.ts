import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { logger } from './LoggerService.js';

export type ResumeOriginalFileProvider = 'local' | 's3';
type ResumeOriginalFileProviderMode = ResumeOriginalFileProvider | 'none';

export interface StoredResumeOriginalFile {
  provider: ResumeOriginalFileProvider;
  key: string;
  fileName: string;
  mimeType: string;
  size: number;
  checksum: string;
  storedAt: Date;
}

export interface ResumeOriginalFileRef {
  provider?: string | null;
  key?: string | null;
  fileName?: string | null;
  mimeType?: string | null;
}

class ResumeOriginalFileStorageService {
  private readonly providerMode: ResumeOriginalFileProviderMode;
  private readonly prefix: string;
  private readonly localDir: string;
  private readonly s3Bucket: string | null;
  private readonly s3Client: S3Client | null;

  constructor() {
    this.providerMode = this.resolveProviderMode();
    this.prefix = this.resolvePrefix();
    this.localDir = this.resolveLocalDir();
    this.s3Bucket = this.resolveS3Bucket();
    this.s3Client = this.providerMode === 's3' ? this.createS3Client() : null;
  }

  getProviderMode(): ResumeOriginalFileProviderMode {
    return this.providerMode;
  }

  isConfigured(): boolean {
    return this.providerMode !== 'none';
  }

  async saveFile(params: {
    buffer: Buffer;
    fileName: string;
    mimeType: string;
    size: number;
    userId: string;
    requestId?: string;
    /** Override the top-level key prefix. Used by the candidate (RoboApply)
     *  app so its resume originals are stored under a separate keyspace and
     *  never co-mingle with recruiter resume originals. Defaults to the
     *  instance prefix (`resume-originals`). */
    keyspace?: string;
  }): Promise<StoredResumeOriginalFile | null> {
    if (this.providerMode === 'none') {
      return null;
    }

    const fileName = sanitizeStorageFilename(params.fileName);
    const key = this.buildKey(params.userId, fileName, params.keyspace);
    const mimeType = params.mimeType || 'application/octet-stream';
    const storedAt = new Date();
    const checksum = crypto.createHash('sha256').update(params.buffer).digest('hex');

    if (this.providerMode === 'local') {
      const absolutePath = path.join(this.localDir, key);
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, params.buffer);
    } else {
      await this.getS3Client().send(new PutObjectCommand({
        Bucket: this.getS3Bucket(),
        Key: key,
        Body: params.buffer,
        ContentType: mimeType,
      }));
    }

    logger.info('RESUME_STORAGE', 'Stored original resume file', {
      provider: this.providerMode,
      key,
      fileName,
      size: params.size,
      mimeType,
    }, params.requestId);

    return {
      provider: this.providerMode,
      key,
      fileName: params.fileName,
      mimeType,
      size: params.size,
      checksum,
      storedAt,
    };
  }

  async readFile(ref: ResumeOriginalFileRef, requestId?: string): Promise<{ buffer: Buffer; fileName: string; mimeType: string }> {
    const provider = normalizeProvider(ref.provider);
    const key = ref.key?.trim();
    if (!provider || !key) {
      throw new Error('Stored original file reference is incomplete');
    }

    const fileName = ref.fileName?.trim() || 'resume';
    const mimeType = ref.mimeType?.trim() || 'application/octet-stream';

    if (provider === 'local') {
      const buffer = await fs.readFile(path.join(this.localDir, key));
      return { buffer, fileName, mimeType };
    }

    const response = await this.getS3Client().send(new GetObjectCommand({
      Bucket: this.getS3Bucket(),
      Key: key,
    }));

    if (!response.Body) {
      throw new Error('Stored original file response body was empty');
    }

    return {
      buffer: await bodyToBuffer(response.Body),
      fileName,
      mimeType: response.ContentType || mimeType,
    };
  }

  /**
   * HEAD the stored object to confirm existence + return metadata without
   * downloading the bytes. Returns null when the object doesn't exist (404)
   * so callers can distinguish "missing" from "service error". Used by the
   * admin diagnostic endpoint to detect DB↔R2 drift.
   */
  async headFile(ref: ResumeOriginalFileRef, requestId?: string): Promise<{
    exists: boolean;
    size: number | null;
    contentType: string | null;
    lastModified: Date | null;
    etag: string | null;
  } | null> {
    const provider = normalizeProvider(ref.provider);
    const key = ref.key?.trim();
    if (!provider || !key) return null;

    if (provider === 'local') {
      try {
        const stat = await fs.stat(path.join(this.localDir, key));
        return {
          exists: true,
          size: stat.size,
          contentType: ref.mimeType ?? null,
          lastModified: stat.mtime,
          etag: null,
        };
      } catch (err: any) {
        if (err?.code === 'ENOENT') return { exists: false, size: null, contentType: null, lastModified: null, etag: null };
        throw err;
      }
    }

    try {
      const r = await this.getS3Client().send(new HeadObjectCommand({
        Bucket: this.getS3Bucket(),
        Key: key,
      }));
      return {
        exists: true,
        size: typeof r.ContentLength === 'number' ? r.ContentLength : null,
        contentType: r.ContentType ?? ref.mimeType ?? null,
        lastModified: r.LastModified ?? null,
        etag: r.ETag ?? null,
      };
    } catch (err: any) {
      // S3/R2 returns 404 with name "NotFound" or http status 404. Both treat as "not in bucket".
      const status = err?.$metadata?.httpStatusCode;
      if (err?.name === 'NotFound' || err?.Code === 'NoSuchKey' || status === 404) {
        return { exists: false, size: null, contentType: null, lastModified: null, etag: null };
      }
      logger.warn('RESUME_STORAGE', 'HEAD failed against S3 original resume file', {
        key, status, error: err instanceof Error ? err.message : String(err),
      }, requestId);
      throw err;
    }
  }

  /**
   * Mint a short-lived (default 10 min) pre-signed GET URL for direct
   * browser/CLI download of the stored object. Only valid for the s3
   * provider — local-disk objects can't be signed; caller falls back to
   * the streaming /original-file endpoint in that case.
   */
  async getPresignedDownloadUrl(
    ref: ResumeOriginalFileRef,
    expiresInSeconds: number = 600,
  ): Promise<string | null> {
    const provider = normalizeProvider(ref.provider);
    const key = ref.key?.trim();
    if (!provider || !key) return null;
    if (provider !== 's3') return null;

    const cmd = new GetObjectCommand({
      Bucket: this.getS3Bucket(),
      Key: key,
      // Force inline rendering when the stored MIME is sensible — keeps the
      // admin's browser preview behavior identical to the existing
      // /original-file streaming path.
      ResponseContentType: ref.mimeType ?? undefined,
      ResponseContentDisposition: ref.fileName
        ? `inline; filename="${ref.fileName.replace(/"/g, '')}"`
        : undefined,
    });
    return getSignedUrl(this.getS3Client(), cmd, { expiresIn: Math.max(60, Math.min(3600, expiresInSeconds)) });
  }

  /**
   * Stream every object in the configured bucket. Yields pages so callers
   * (the admin inventory CSV export) can compose row-by-row without buffering
   * the whole listing into memory. Only supports the `s3` provider.
   *
   * Each yielded object has key, size (bytes), lastModified.
   */
  async *listAllObjects(): AsyncGenerator<{ key: string; size: number; lastModified: Date | null }> {
    if (this.providerMode !== 's3') return;
    const client = this.getS3Client();
    const Bucket = this.getS3Bucket();
    let token: string | undefined;
    do {
      const r = await client.send(new ListObjectsV2Command({
        Bucket,
        ContinuationToken: token,
        MaxKeys: 1000,
      }));
      for (const o of r.Contents || []) {
        if (!o.Key) continue;
        yield {
          key: o.Key,
          size: typeof o.Size === 'number' ? o.Size : 0,
          lastModified: o.LastModified ?? null,
        };
      }
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
  }

  /**
   * Inspect the configured bucket without exposing the keys. Used by the
   * admin endpoint to surface what's reachable: bucket name, endpoint,
   * provider mode. Never returns credentials.
   */
  describeStorageProvider(): { mode: ResumeOriginalFileProviderMode; bucket: string | null; endpoint: string | null; prefix: string } {
    return {
      mode: this.providerMode,
      bucket: this.s3Bucket,
      endpoint: (process.env.S3_ENDPOINT || '').trim() || null,
      prefix: this.prefix,
    };
  }

  /**
   * Best-effort delete of a stored original. Never throws. Returns true when
   * the object is confirmed gone (deleted, already missing, or nothing was
   * ever stored) and false when a live key could not be removed — the
   * account-purge sweep keeps the DB row in that case so the pointer to the
   * object survives for a retry.
   */
  async deleteFile(ref: ResumeOriginalFileRef, requestId?: string): Promise<boolean> {
    const key = ref.key?.trim();
    if (!key) {
      return true; // no stored object referenced — vacuously clean
    }
    const provider = normalizeProvider(ref.provider);
    if (!provider) {
      logger.warn('RESUME_STORAGE', 'Cannot delete original resume file: unknown provider', {
        key,
        provider: ref.provider ?? null,
      }, requestId);
      return false;
    }

    if (provider === 'local') {
      try {
        await fs.rm(path.join(this.localDir, key), { force: true });
        return true;
      } catch (error) {
        logger.warn('RESUME_STORAGE', 'Failed to remove local original resume file', {
          key,
          error: error instanceof Error ? error.message : String(error),
        }, requestId);
        return false;
      }
    }

    try {
      await this.getS3Client().send(new DeleteObjectCommand({
        Bucket: this.getS3Bucket(),
        Key: key,
      }));
      return true;
    } catch (error) {
      logger.warn('RESUME_STORAGE', 'Failed to remove S3 original resume file', {
        key,
        error: error instanceof Error ? error.message : String(error),
      }, requestId);
      return false;
    }
  }

  private resolveProviderMode(): ResumeOriginalFileProviderMode {
    const explicit = (process.env.RESUME_FILE_STORAGE_PROVIDER || '').trim().toLowerCase();
    if (explicit === 's3' || explicit === 'local' || explicit === 'none') {
      return explicit;
    }

    const hasS3Credentials = Boolean(this.resolveS3Bucket())
      && Boolean(process.env.S3_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID)
      && Boolean(process.env.S3_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY);
    if (hasS3Credentials) {
      return 's3';
    }

    return process.env.NODE_ENV === 'production' ? 'none' : 'local';
  }

  private resolvePrefix(): string {
    const raw = (process.env.RESUME_FILE_STORAGE_PREFIX || 'resume-originals')
      .trim()
      .replace(/^\/+|\/+$/g, '');
    return raw || 'resume-originals';
  }

  private resolveLocalDir(): string {
    const configured = (process.env.RESUME_FILE_STORAGE_LOCAL_DIR || '').trim();
    if (configured) {
      return path.resolve(configured);
    }

    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    return path.resolve(__dirname, '..', '..', 'storage');
  }

  private resolveS3Bucket(): string | null {
    return (process.env.S3_BUCKET || '').trim() || null;
  }

  private createS3Client(): S3Client {
    const accessKeyId = (process.env.S3_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID || '').trim();
    const secretAccessKey = (process.env.S3_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY || '').trim();
    const region = (process.env.S3_REGION || process.env.AWS_REGION || 'auto').trim();
    const endpoint = (process.env.S3_ENDPOINT || '').trim() || undefined;
    const forcePathStyle = ['true', '1', 'yes'].includes((process.env.S3_FORCE_PATH_STYLE || '').trim().toLowerCase());

    if (!this.s3Bucket || !accessKeyId || !secretAccessKey) {
      throw new Error('S3 original-file storage is selected but bucket/credentials are missing');
    }

    return new S3Client({
      region,
      endpoint,
      forcePathStyle,
      credentials: { accessKeyId, secretAccessKey },
    });
  }

  private getS3Client(): S3Client {
    if (!this.s3Client) {
      throw new Error('S3 original-file storage is not configured');
    }
    return this.s3Client;
  }

  private getS3Bucket(): string {
    if (!this.s3Bucket) {
      throw new Error('S3 bucket is not configured');
    }
    return this.s3Bucket;
  }

  private buildKey(userId: string, fileName: string, keyspace?: string): string {
    const prefix = (keyspace || this.prefix).replace(/^\/+|\/+$/g, '') || this.prefix;
    const ownerSegment = userId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'user';
    const dateSegment = new Date().toISOString().slice(0, 10);
    return `${prefix}/${ownerSegment}/${dateSegment}/${crypto.randomUUID()}-${fileName}`;
  }
}

function sanitizeStorageFilename(fileName: string): string {
  const ext = path.extname(fileName || '').toLowerCase().slice(0, 16);
  const base = path.basename(fileName || 'resume', ext)
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80) || 'resume';
  return `${base}${ext}`;
}

function normalizeProvider(provider?: string | null): ResumeOriginalFileProvider | null {
  if (provider === 'local' || provider === 's3') {
    return provider;
  }
  return null;
}

async function bodyToBuffer(body: unknown): Promise<Buffer> {
  if (Buffer.isBuffer(body)) {
    return body;
  }

  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }

  if (body && typeof body === 'object' && 'transformToByteArray' in body && typeof (body as any).transformToByteArray === 'function') {
    const bytes = await (body as any).transformToByteArray();
    return Buffer.from(bytes);
  }

  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array | Buffer | string>) {
    if (typeof chunk === 'string') {
      chunks.push(Buffer.from(chunk));
    } else {
      chunks.push(Buffer.from(chunk));
    }
  }
  return Buffer.concat(chunks);
}

export const resumeOriginalFileStorageService = new ResumeOriginalFileStorageService();
