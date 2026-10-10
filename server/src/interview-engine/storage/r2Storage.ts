// backend/src/interview-engine/storage/r2Storage.ts
//
// R2 (Cloudflare, S3-compatible) storage scoped to interview artifacts. Mirrors
// the proven client construction in services/FileVaultStorageService.ts but is
// self-contained to the engine and reads creds via interview-engine/config.ts.
//
// Two distinct write paths:
//   1. RECORDINGS are written DIRECTLY by LiveKit Egress (see livekit/egress.ts)
//      using an S3Upload with these same creds — this service does NOT upload
//      them, it only HEADs + presigns them for playback.
//   2. TRANSCRIPTS + REPORTS are written by this service via putObject() and
//      read back via presignGet() / getObjectText().
//
// Key layout (all under the `interviews/` prefix):
//   interviews/<sessionId>/recording.mp4
//   interviews/<sessionId>/transcript.json
//   interviews/<sessionId>/transcript.txt
//   interviews/<sessionId>/report.json

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getEarlierR2Creds, getR2Creds, getR2WriteCreds, INTERVIEW_R2_PREFIX, type R2Creds } from '../config.js';
import { logger } from '../../services/LoggerService.js';

const DEFAULT_PRESIGN_TTL_SEC = 3600; // 1h — playback links for the report page

function clampTtl(seconds: number): number {
  return Math.max(60, Math.min(24 * 3600, Math.floor(seconds)));
}

/**
 * Cache key of an S3 client: endpoint + bucket + access key id (+ region and
 * path style, which also change the client). The bucket name alone is not
 * enough: GoApply may own a bucket of the same name as the shared one on a
 * different store (R2 for the shared stack, a mainland store for GoApply), and
 * reusing the first client would send the other store's objects to the wrong
 * place with the wrong credentials. Two brands on the shared bucket resolve
 * to the same key and share one client. The secret is never part of the key; a
 * rotated secret under the same access key id rebuilds the client (compared
 * separately).
 */
export function r2ClientCacheKey(creds: R2Creds): string {
  return [creds.endpoint ?? '', creds.bucket, creds.accessKeyId, creds.region, creds.forcePathStyle ? 'path' : 'vhost'].join('\u0000');
}

/** One client per store: the shared one and GoApply's own at most, plus a rotation or two. */
const MAX_CACHED_CLIENTS = 8;

export class InterviewR2Storage {
  private readonly clients = new Map<string, { client: S3Client; secret: string }>();

  /** The brand's store can be read and deleted from. */
  isConfigured(): boolean {
    return getR2Creds() !== null;
  }

  /**
   * NEW artifacts of the current brand may be written. The same as
   * `isConfigured`, except for GoApply under CN_RESIDENCY_STRICT without a
   * bucket of its own (config.ts `getR2WriteCreds`): nothing new goes to the
   * shared bucket, while earlier objects there stay readable and deletable.
   */
  canStore(): boolean {
    return getR2WriteCreds() !== null;
  }

  // ── Key builders ──
  recordingKey(sessionId: string, ext = 'mp4'): string {
    return `${INTERVIEW_R2_PREFIX}/${sessionId}/recording.${ext}`;
  }
  transcriptJsonKey(sessionId: string): string {
    return `${INTERVIEW_R2_PREFIX}/${sessionId}/transcript.json`;
  }
  transcriptTextKey(sessionId: string): string {
    return `${INTERVIEW_R2_PREFIX}/${sessionId}/transcript.txt`;
  }
  reportKey(sessionId: string): string {
    return `${INTERVIEW_R2_PREFIX}/${sessionId}/report.json`;
  }

  async putObject(params: { key: string; body: Buffer | string; contentType: string }): Promise<void> {
    const creds = getR2WriteCreds();
    if (!creds) throw new Error('Interview Engine R2 storage is not available for new objects (not configured, or CN_RESIDENCY_STRICT without CN_S3_BUCKET)');
    const { client, bucket } = this.resolve(creds);
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: params.key,
        Body: typeof params.body === 'string' ? Buffer.from(params.body, 'utf8') : params.body,
        ContentType: params.contentType || 'application/octet-stream',
      }),
    );
  }

  /**
   * Best-effort single-object delete. A missing object is a no-op, not an
   * error (S3 delete is idempotent). Returns false — never throws — when the
   * delete could not be confirmed (unconfigured storage or a request error),
   * so sweeps can hold DB rows that still point at live objects.
   *
   * The object is deleted from the brand's store and from any store its
   * earlier sessions wrote to (GoApply after it got a bucket of its own:
   * `getEarlierR2Creds`), so a session created on the shared bucket is still
   * cleaned up once CN_S3_BUCKET is set.
   */
  async deleteObject(key: string): Promise<boolean> {
    const current = getR2Creds();
    if (!current) return false;
    const seen = new Set<string>();
    let ok = true;
    for (const creds of [current, ...getEarlierR2Creds()]) {
      const id = r2ClientCacheKey(creds);
      if (seen.has(id)) continue;
      seen.add(id);
      try {
        const { client, bucket } = this.resolve(creds);
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      } catch (err) {
        ok = false;
        logger.warn('INTERVIEW_ENGINE_R2', 'deleteObject failed', {
          key,
          earlierStore: creds === current ? undefined : true,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return ok;
  }

  /**
   * Remove every R2 artifact for a session (recording + transcript json/txt +
   * report). Best-effort per object — a partial failure never throws, so a
   * user-initiated delete can still drop the DB row. Returns per-object
   * counts; the account-purge sweep treats failed > 0 as "keep the DB row and
   * retry next run" instead. Pass any DB-stored keys (recordingKey /
   * transcriptKey) as `extraKeys` in case they ever diverge from the defaults.
   */
  async deleteSessionArtifacts(
    sessionId: string,
    extraKeys: Array<string | null | undefined> = [],
  ): Promise<{ attempted: number; failed: number }> {
    if (!this.isConfigured()) return { attempted: 0, failed: 0 };
    const keys = new Set<string>([
      this.recordingKey(sessionId, 'mp4'),
      this.transcriptJsonKey(sessionId),
      this.transcriptTextKey(sessionId),
      this.reportKey(sessionId),
      ...extraKeys.filter((k): k is string => typeof k === 'string' && k.length > 0),
    ]);
    const results = await Promise.all([...keys].map((k) => this.deleteObject(k)));
    return { attempted: keys.size, failed: results.filter((ok) => !ok).length };
  }

  async getObjectText(key: string): Promise<string | null> {
    try {
      const { client, bucket } = this.resolve();
      const r = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!r.Body) return null;
      return await r.Body.transformToString('utf8');
    } catch (err) {
      logger.warn('INTERVIEW_ENGINE_R2', 'getObjectText failed', {
        key,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /** HEAD probe — size/contentType/lastModified, or null if missing. */
  async headObject(key: string): Promise<{ size: number | null; contentType: string | null; lastModified: Date | null } | null> {
    try {
      const { client, bucket } = this.resolve();
      const r = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return {
        size: typeof r.ContentLength === 'number' ? r.ContentLength : null,
        contentType: r.ContentType ?? null,
        lastModified: r.LastModified ?? null,
      };
    } catch (err: any) {
      const status = err?.$metadata?.httpStatusCode;
      if (err?.name === 'NotFound' || err?.Code === 'NoSuchKey' || status === 404) return null;
      logger.warn('INTERVIEW_ENGINE_R2', 'headObject failed', {
        key,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /** Mint a short-lived presigned GET URL for inline playback / download. */
  async presignGet(params: {
    key: string;
    fileName?: string;
    contentType?: string;
    asAttachment?: boolean;
    expiresInSec?: number;
  }): Promise<string | null> {
    if (!this.isConfigured()) return null;
    const { client, bucket } = this.resolve();
    const disposition = (() => {
      const original = params.fileName || 'file';
      const safe = original.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '') || 'file';
      const encoded = encodeURIComponent(original);
      const dispo = params.asAttachment ? 'attachment' : 'inline';
      return `${dispo}; filename="${safe}"; filename*=UTF-8''${encoded}`;
    })();
    const cmd = new GetObjectCommand({
      Bucket: bucket,
      Key: params.key,
      ResponseContentType: params.contentType ?? undefined,
      ResponseContentDisposition: disposition,
    });
    return getSignedUrl(client, cmd, { expiresIn: clampTtl(params.expiresInSec ?? DEFAULT_PRESIGN_TTL_SEC) });
  }

  /** The cached client for the current brand's store (test seam: client identity per store). */
  clientForCurrentBrand(): S3Client {
    return this.resolve().client;
  }

  private resolve(given?: R2Creds): { client: S3Client; bucket: string } {
    const creds = given ?? getR2Creds();
    if (!creds) throw new Error('Interview Engine R2 storage is not configured (S3_BUCKET / S3 credentials missing)');
    const key = r2ClientCacheKey(creds);
    let entry = this.clients.get(key);
    if (!entry || entry.secret !== creds.secretAccessKey) {
      entry?.client.destroy();
      if (!entry && this.clients.size >= MAX_CACHED_CLIENTS) {
        const oldest = this.clients.keys().next().value as string;
        this.clients.get(oldest)?.client.destroy();
        this.clients.delete(oldest);
      }
      entry = {
        client: new S3Client({
          region: creds.region,
          endpoint: creds.endpoint,
          forcePathStyle: creds.forcePathStyle,
          credentials: { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey },
        }),
        secret: creds.secretAccessKey,
      };
      this.clients.set(key, entry);
    }
    return { client: entry.client, bucket: creds.bucket };
  }
}

export const interviewR2Storage = new InterviewR2Storage();
export default interviewR2Storage;
