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
import { getR2Creds, INTERVIEW_R2_PREFIX } from '../config.js';
import { logger } from '../../services/LoggerService.js';

const DEFAULT_PRESIGN_TTL_SEC = 3600; // 1h — playback links for the report page

function clampTtl(seconds: number): number {
  return Math.max(60, Math.min(24 * 3600, Math.floor(seconds)));
}

export class InterviewR2Storage {
  private client: S3Client | null = null;
  private bucket: string | null = null;

  isConfigured(): boolean {
    return getR2Creds() !== null;
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
    const { client, bucket } = this.resolve();
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: params.key,
        Body: typeof params.body === 'string' ? Buffer.from(params.body, 'utf8') : params.body,
        ContentType: params.contentType || 'application/octet-stream',
      }),
    );
  }

  /** Best-effort single-object delete. A missing object is a no-op, not an error. */
  async deleteObject(key: string): Promise<void> {
    if (!this.isConfigured()) return;
    try {
      const { client, bucket } = this.resolve();
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    } catch (err) {
      logger.warn('INTERVIEW_ENGINE_R2', 'deleteObject failed', {
        key,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Remove every R2 artifact for a session (recording + transcript json/txt +
   * report). Best-effort per object — a partial failure never throws, so the
   * caller can still delete the DB row. Pass any DB-stored keys (recordingKey /
   * transcriptKey) as `extraKeys` in case they ever diverge from the defaults.
   */
  async deleteSessionArtifacts(sessionId: string, extraKeys: Array<string | null | undefined> = []): Promise<void> {
    if (!this.isConfigured()) return;
    const keys = new Set<string>([
      this.recordingKey(sessionId, 'mp4'),
      this.transcriptJsonKey(sessionId),
      this.transcriptTextKey(sessionId),
      this.reportKey(sessionId),
      ...extraKeys.filter((k): k is string => typeof k === 'string' && k.length > 0),
    ]);
    await Promise.all([...keys].map((k) => this.deleteObject(k)));
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

  private resolve(): { client: S3Client; bucket: string } {
    const creds = getR2Creds();
    if (!creds) throw new Error('Interview Engine R2 storage is not configured (S3_BUCKET / S3 credentials missing)');
    if (!this.client || this.bucket !== creds.bucket) {
      this.client = new S3Client({
        region: creds.region,
        endpoint: creds.endpoint,
        forcePathStyle: creds.forcePathStyle,
        credentials: { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey },
      });
      this.bucket = creds.bucket;
    }
    return { client: this.client, bucket: this.bucket };
  }
}

export const interviewR2Storage = new InterviewR2Storage();
export default interviewR2Storage;
