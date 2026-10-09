import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { logger } from './LoggerService.js';
import { brandEnv, type EnvSource } from '../platform/brand/brandEnv.js';
import type { BrandId } from '../platform/brand/registry.js';
import { isMainlandStorageHost } from '../platform/residency/egressPolicy.js';
import { StorageUnavailableError, mayStoreOriginal, resumeUploadPolicy } from '../platform/residency/uploadPolicy.js';
import { WriteBrandUnknownError, resolveWriteBrand } from '../platform/residency/writeBrand.js';

export { StorageUnavailableError, WriteBrandUnknownError };

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

/**
 * Per-brand storage target (TASK_PLAN.md WP-15, CN_TW_LAUNCH_PLAN.md §2.2):
 *   - RoboApply: `S3_*` (or AWS_* credentials), `RESUME_FILE_STORAGE_PROVIDER`
 *     override, local disk outside production — today's behaviour.
 *   - GoApply offshore (CN-0): `discard` — no original file is ever written
 *     (ruling H6); the upload is parsed in memory only.
 *   - GoApply on the mainland stack: `CN_S3_*` only, with no fallback to
 *     `S3_*`/`AWS_*` and no local disk. Missing → `unavailable`: writes throw
 *     `StorageUnavailableError` (503 storage_unavailable) and nothing goes to
 *     the international bucket.
 */
type BrandStorageMode = ResumeOriginalFileProviderMode | 'discard' | 'unavailable';

interface BrandStorageConfig {
  brandId: BrandId;
  mode: BrandStorageMode;
  bucket: string | null;
  endpoint: string | null;
  region: string;
  forcePathStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
}

/** Keys of GoApply objects start with this segment, so reads/deletes route to the CN bucket without a brand context. */
const CN_KEY_PREFIX = 'cn/';

export type S3ClientLike = Pick<S3Client, 'send'>;

export interface ResumeOriginalFileStorageOptions {
  env?: EnvSource;
  /** Tests inject a fake client; production builds a real S3Client per brand. */
  createS3Client?: (config: { region: string; endpoint?: string; forcePathStyle: boolean; credentials: { accessKeyId: string; secretAccessKey: string } }) => S3ClientLike;
}

export class ResumeOriginalFileStorageService {
  private readonly env: EnvSource;
  private readonly prefix: string;
  private readonly localDir: string;
  private readonly clientFactory: NonNullable<ResumeOriginalFileStorageOptions['createS3Client']>;
  private readonly configs = new Map<BrandId, BrandStorageConfig>();
  private readonly clients = new Map<BrandId, S3ClientLike>();

  constructor(options: ResumeOriginalFileStorageOptions = {}) {
    this.env = options.env ?? process.env;
    this.prefix = this.resolvePrefix();
    this.localDir = this.resolveLocalDir();
    this.clientFactory = options.createS3Client ?? ((config) => new S3Client(config));
    // Resolve RoboApply eagerly, as before, so a misconfigured intl bucket shows at boot.
    const intl = this.configFor('roboapply');
    if (intl.mode === 's3') this.clientFor('roboapply');
  }

  /**
   * The brand's mode (default: the brand of the current unit of work).
   * `none` when the brand cannot be known (see `resolveWriteBrand`).
   */
  getProviderMode(brand?: BrandId): BrandStorageMode {
    const id = this.writeBrand(brand);
    return id ? this.configFor(id).mode : 'none';
  }

  /**
   * Whether an original file can be stored for the brand (default: the
   * current brand). False when the brand cannot be known: a residency-critical
   * write never guesses RoboApply.
   */
  isConfigured(brand?: BrandId): boolean {
    const id = this.writeBrand(brand);
    if (!id) return false;
    const mode = this.configFor(id).mode;
    return mode === 'local' || mode === 's3';
  }

  /**
   * Throws `StorageUnavailableError` (503) when the brand's storage is required
   * but missing (GoApply on the mainland stack without `CN_S3_*`). Upload
   * routes call it before accepting a file.
   */
  assertAvailable(brand?: BrandId): void {
    const id = this.writeBrand(brand);
    if (!id) throw new WriteBrandUnknownError('Resume upload');
    if (this.configFor(id).mode === 'unavailable') throw new StorageUnavailableError(id);
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
    /** Brand that owns the file (default: the current unit of work's brand). */
    brand?: BrandId;
  }): Promise<StoredResumeOriginalFile | null> {
    // Fail closed without a brand: never fall back to RoboApply's bucket.
    const brandId = this.writeBrand(params.brand);
    if (!brandId) {
      logger.error('RESUME_STORAGE', 'Refusing to store an original: no brand for this write', { size: params.size }, params.requestId);
      throw new WriteBrandUnknownError('Original resume file');
    }
    const config = this.configFor(brandId);

    if (config.mode === 'unavailable') {
      logger.warn('RESUME_STORAGE', 'Refusing to store an original: the brand bucket is not configured', { brand: brandId }, params.requestId);
      throw new StorageUnavailableError(brandId);
    }
    if (config.mode === 'discard') {
      logger.info('RESUME_STORAGE', 'Original file not kept (brand storage rule)', { brand: brandId, size: params.size }, params.requestId);
      return null;
    }
    if (config.mode === 'none') {
      return null;
    }

    const fileName = sanitizeStorageFilename(params.fileName);
    const key = this.buildKey(params.userId, fileName, params.keyspace, brandId);
    const mimeType = params.mimeType || 'application/octet-stream';
    const storedAt = new Date();
    const checksum = crypto.createHash('sha256').update(params.buffer).digest('hex');

    if (config.mode === 'local') {
      const absolutePath = path.join(this.localDir, key);
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, params.buffer);
    } else {
      await this.clientFor(brandId).send(new PutObjectCommand({
        Bucket: this.bucketFor(brandId),
        Key: key,
        Body: params.buffer,
        ContentType: mimeType,
      }));
    }

    logger.info('RESUME_STORAGE', 'Stored original resume file', {
      provider: config.mode,
      brand: brandId,
      key,
      fileName,
      size: params.size,
      mimeType,
    }, params.requestId);

    return {
      provider: config.mode,
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

    const brandId = brandOfKey(key);
    const response = await this.clientFor(brandId).send(new GetObjectCommand({
      Bucket: this.bucketFor(brandId),
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

    const brandId = brandOfKey(key);
    try {
      const r = await this.clientFor(brandId).send(new HeadObjectCommand({
        Bucket: this.bucketFor(brandId),
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

    const brandId = brandOfKey(key);
    const cmd = new GetObjectCommand({
      Bucket: this.bucketFor(brandId),
      Key: key,
      // Force inline rendering when the stored MIME is sensible — keeps the
      // admin's browser preview behavior identical to the existing
      // /original-file streaming path.
      ResponseContentType: ref.mimeType ?? undefined,
      ResponseContentDisposition: ref.fileName
        ? `inline; filename="${ref.fileName.replace(/"/g, '')}"`
        : undefined,
    });
    return getSignedUrl(this.clientFor(brandId) as S3Client, cmd, { expiresIn: Math.max(60, Math.min(3600, expiresInSeconds)) });
  }

  /**
   * Stream every object in the brand's bucket (default RoboApply). Yields
   * pages so callers (the admin inventory CSV export) can compose row-by-row
   * without buffering the whole listing into memory. Only supports the `s3`
   * provider.
   *
   * Each yielded object has key, size (bytes), lastModified.
   */
  async *listAllObjects(brand: BrandId = 'roboapply'): AsyncGenerator<{ key: string; size: number; lastModified: Date | null }> {
    if (this.configFor(brand).mode !== 's3') return;
    const client = this.clientFor(brand);
    const Bucket = this.bucketFor(brand);
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
   * Inspect the brand's bucket (default RoboApply) without exposing the keys.
   * Used by the admin endpoint to surface what's reachable: bucket name,
   * endpoint, provider mode. Never returns credentials.
   */
  describeStorageProvider(brand: BrandId = 'roboapply'): { mode: BrandStorageMode; bucket: string | null; endpoint: string | null; prefix: string } {
    const config = this.configFor(brand);
    return {
      mode: config.mode,
      bucket: config.bucket,
      endpoint: config.endpoint,
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
      const brandId = brandOfKey(key);
      await this.clientFor(brandId).send(new DeleteObjectCommand({
        Bucket: this.bucketFor(brandId),
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

  private writeBrand(explicit?: BrandId): BrandId | null {
    return resolveWriteBrand(explicit, this.env);
  }

  private configFor(brandId: BrandId): BrandStorageConfig {
    const cached = this.configs.get(brandId);
    if (cached) return cached;
    const config = brandId === 'goapply' ? this.resolveCnConfig() : this.resolveIntlConfig();
    this.configs.set(brandId, config);
    return config;
  }

  /** RoboApply: unchanged from before the brand split. */
  private resolveIntlConfig(): BrandStorageConfig {
    const env = this.env;
    const bucket = (env.S3_BUCKET || '').trim() || null;
    const accessKeyId = (env.S3_ACCESS_KEY_ID || env.AWS_ACCESS_KEY_ID || '').trim();
    const secretAccessKey = (env.S3_SECRET_ACCESS_KEY || env.AWS_SECRET_ACCESS_KEY || '').trim();
    const base = {
      brandId: 'roboapply' as BrandId,
      bucket,
      endpoint: (env.S3_ENDPOINT || '').trim() || null,
      region: (env.S3_REGION || env.AWS_REGION || 'auto').trim(),
      forcePathStyle: ['true', '1', 'yes'].includes((env.S3_FORCE_PATH_STYLE || '').trim().toLowerCase()),
      accessKeyId,
      secretAccessKey,
    };
    const explicit = (env.RESUME_FILE_STORAGE_PROVIDER || '').trim().toLowerCase();
    if (explicit === 's3' || explicit === 'local' || explicit === 'none') {
      return { ...base, mode: explicit };
    }
    if (bucket && accessKeyId && secretAccessKey) return { ...base, mode: 's3' };
    return { ...base, mode: env.NODE_ENV === 'production' ? 'none' : 'local' };
  }

  /** GoApply: CN-0 keeps nothing; on the mainland only `CN_S3_*`, never a fallback. */
  private resolveCnConfig(): BrandStorageConfig {
    const env = this.env;
    const cn = (name: string) => brandEnv('goapply', name, env) ?? '';
    const base = {
      brandId: 'goapply' as BrandId,
      bucket: cn('S3_BUCKET') || null,
      endpoint: cn('S3_ENDPOINT') || null,
      region: cn('S3_REGION') || 'auto',
      forcePathStyle: ['true', '1', 'yes'].includes(cn('S3_FORCE_PATH_STYLE').toLowerCase()),
      accessKeyId: cn('S3_ACCESS_KEY_ID'),
      secretAccessKey: cn('S3_SECRET_ACCESS_KEY'),
    };
    if (!mayStoreOriginal('goapply', env)) {
      const policy = resumeUploadPolicy('goapply', env);
      return { ...base, mode: policy.originals === 'discard' ? 'discard' : 'unavailable' };
    }
    // The endpoint must be mainland object storage (an `oss-cn-*` / COS
    // mainland / OBS `cn-*` region, a private host, or
    // CN_ALLOWED_STORAGE_HOST_SUFFIXES) and never the intl bucket. Being set
    // in CN_S3_ENDPOINT is not enough: an AWS us-east-1 endpoint is refused.
    if (!isMainlandStorageHost(base.endpoint, env)) {
      logger.error('RESUME_STORAGE', 'CN_S3_ENDPOINT is not a mainland storage host; refusing to store GoApply files there', { endpoint: base.endpoint });
      return { ...base, mode: 'unavailable' };
    }
    return { ...base, mode: 's3' };
  }

  private resolvePrefix(): string {
    const raw = (this.env.RESUME_FILE_STORAGE_PREFIX || 'resume-originals')
      .trim()
      .replace(/^\/+|\/+$/g, '');
    return raw || 'resume-originals';
  }

  private resolveLocalDir(): string {
    const configured = (this.env.RESUME_FILE_STORAGE_LOCAL_DIR || '').trim();
    if (configured) {
      return path.resolve(configured);
    }

    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    return path.resolve(__dirname, '..', '..', 'storage');
  }

  private clientFor(brandId: BrandId): S3ClientLike {
    const existing = this.clients.get(brandId);
    if (existing) return existing;
    const config = this.configFor(brandId);
    if (config.mode === 'unavailable' || config.mode === 'discard') {
      throw new StorageUnavailableError(brandId);
    }
    if (config.mode !== 's3') {
      throw new Error('S3 original-file storage is not configured');
    }
    if (!config.bucket || !config.accessKeyId || !config.secretAccessKey) {
      throw new Error('S3 original-file storage is selected but bucket/credentials are missing');
    }
    const client = this.clientFactory({
      region: config.region,
      endpoint: config.endpoint ?? undefined,
      forcePathStyle: config.forcePathStyle,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    });
    this.clients.set(brandId, client);
    return client;
  }

  private bucketFor(brandId: BrandId): string {
    const bucket = this.configFor(brandId).bucket;
    if (!bucket) {
      if (brandId === 'goapply') throw new StorageUnavailableError(brandId);
      throw new Error('S3 bucket is not configured');
    }
    return bucket;
  }

  private buildKey(userId: string, fileName: string, keyspace: string | undefined, brandId: BrandId): string {
    const prefix = (keyspace || this.prefix).replace(/^\/+|\/+$/g, '') || this.prefix;
    const ownerSegment = userId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'user';
    const dateSegment = new Date().toISOString().slice(0, 10);
    const brandSegment = brandId === 'goapply' ? CN_KEY_PREFIX : '';
    return `${brandSegment}${prefix}/${ownerSegment}/${dateSegment}/${crypto.randomUUID()}-${fileName}`;
  }
}

/** The brand an object key belongs to (GoApply keys carry the `cn/` segment). */
export function brandOfKey(key: string): BrandId {
  return key.startsWith(CN_KEY_PREFIX) ? 'goapply' : 'roboapply';
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
