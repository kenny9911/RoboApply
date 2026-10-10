// @vitest-environment node
//
// WP-93 (WP-63a R9): the account purge deletes each interview session's
// stored artifacts inside the SESSION's brand. A GoApply session's recording
// and transcript are deleted from the CN_S3_* store; RoboApply's bucket is
// never asked for them. The real interview storage service runs here against
// a fake S3 client that records which endpoint, credentials and bucket every
// delete used. No network, no database.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeClientConfig {
  region?: string;
  endpoint?: string;
  credentials?: { accessKeyId: string; secretAccessKey: string };
}

const h = vi.hoisted(() => ({
  db: null as unknown,
  /** One entry per S3 DeleteObject: the client it went through and the object. */
  deletes: [] as Array<{ endpoint: string | undefined; accessKeyId: string | undefined; bucket: string; key: string }>,
  failBuckets: new Set<string>(),
}));

vi.mock('../../lib/prisma.js', async () => {
  const { createFakePrisma } = await import('../../test/fakePrisma.js');
  const db = createFakePrisma();
  h.db = db;
  return { default: db, prisma: db };
});
vi.mock('../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../services/ResumeOriginalFileStorageService.js', () => ({
  resumeOriginalFileStorageService: { deleteFile: vi.fn(async () => true) },
}));
vi.mock('../../features/growth/index.js', () => ({ growthService: { deleteEventsForUser: vi.fn(async () => ({ deleted: 0 })) } }));
vi.mock('../../features/auth/tokens.js', () => ({ purgeAuthTokens: vi.fn(async () => 0) }));
vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: vi.fn(async () => 'https://signed.invalid') }));
vi.mock('@aws-sdk/client-s3', () => {
  class Command {
    constructor(public input: { Bucket: string; Key: string }) {}
  }
  class DeleteObjectCommand extends Command {}
  class GetObjectCommand extends Command {}
  class HeadObjectCommand extends Command {}
  class PutObjectCommand extends Command {}
  class S3Client {
    constructor(public config: FakeClientConfig) {}
    async send(command: Command): Promise<Record<string, never>> {
      if (!(command instanceof DeleteObjectCommand)) throw new Error('only deletes are expected in a purge');
      if (h.failBuckets.has(command.input.Bucket)) throw new Error('storage unavailable');
      h.deletes.push({
        endpoint: this.config.endpoint,
        accessKeyId: this.config.credentials?.accessKeyId,
        bucket: command.input.Bucket,
        key: command.input.Key,
      });
      return {};
    }
  }
  return { S3Client, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand };
});

import type { createFakePrisma } from '../../test/fakePrisma.js';
import { purgeAccountNow, runAccountPurgeSweep, sessionArtifactBrand } from './SeekerAccountPurgeService.js';

type Fake = ReturnType<typeof createFakePrisma>;
const db = (): Fake => h.db as Fake;

const INTL = { bucket: 'ra-interviews-intl', endpoint: 'https://r2.intl.example', key: 'INTL_KEY' };
const CN = { bucket: 'ga-interviews-cn', endpoint: 'https://oss-cn-shanghai.example', key: 'CN_KEY' };

function configureIntl(): void {
  vi.stubEnv('S3_BUCKET', INTL.bucket);
  vi.stubEnv('S3_ENDPOINT', INTL.endpoint);
  vi.stubEnv('S3_ACCESS_KEY_ID', INTL.key);
  vi.stubEnv('S3_SECRET_ACCESS_KEY', 'intl-secret');
}
function configureCn(): void {
  vi.stubEnv('CN_S3_BUCKET', CN.bucket);
  vi.stubEnv('CN_S3_ENDPOINT', CN.endpoint);
  vi.stubEnv('CN_S3_ACCESS_KEY_ID', CN.key);
  vi.stubEnv('CN_S3_SECRET_ACCESS_KEY', 'cn-secret');
}

const CLOSED = new Date('2026-08-01T00:00:00.000Z');
const NOW = new Date('2026-10-10T00:00:00.000Z');

/** A closed seeker account. The fake does not model relations, so the profile row carries the `user` it selects. */
async function closedAccount(userId: string, brand: 'roboapply' | 'goapply'): Promise<void> {
  const user = { id: userId, role: 'seeker', roles: ['seeker'], brand };
  await db().user.create({ data: user });
  await db().seekerProfile.create({ data: { id: `sp_${userId}`, userId, deletedAt: CLOSED, user } });
}

async function session(row: { id: string; userId: string; brand?: string | null; liveMetrics?: unknown; recordingKey?: string | null }): Promise<void> {
  await db().interviewSession.create({
    data: { brand: null, liveMetrics: null, recordingKey: null, transcriptKey: null, ...row },
  });
}

const deletesFor = (sessionId: string) => h.deletes.filter((d) => d.key.includes(`/${sessionId}/`) || d.key.endsWith(`${sessionId}.custom`));

beforeEach(async () => {
  h.deletes.length = 0;
  h.failBuckets.clear();
  for (const model of ['user', 'seekerProfile', 'interviewSession', 'rAResumeVariant', 'rAApplicationArtifact', 'rAOnboardingSession', 'rAWorkItem']) {
    await (db() as unknown as Record<string, { deleteMany: (a: object) => Promise<unknown> }>)[model]!.deleteMany({});
  }
  for (const name of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'CN_AWS_ACCESS_KEY_ID', 'CN_AWS_SECRET_ACCESS_KEY', 'S3_BUCKET', 'CN_S3_BUCKET', 'S3_ACCESS_KEY_ID', 'CN_S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'CN_S3_SECRET_ACCESS_KEY', 'S3_ENDPOINT', 'CN_S3_ENDPOINT']) {
    vi.stubEnv(name, '');
  }
});

afterEach(() => vi.unstubAllEnvs());

describe('sessionArtifactBrand', () => {
  it('uses InterviewSession.brand when the row has it', () => {
    expect(sessionArtifactBrand({ brand: 'goapply', liveMetrics: null }, 'roboapply')).toBe('goapply');
    expect(sessionArtifactBrand({ brand: 'roboapply', liveMetrics: { voiceSeam: { v: 1, brand: 'goapply', provider: 'livekit_cloud' } } }, 'goapply')).toBe('roboapply');
  });

  it('else the voice seam stored at create', () => {
    expect(sessionArtifactBrand({ brand: null, liveMetrics: { voiceSeam: { v: 1, brand: 'goapply', provider: 'livekit_selfhosted' } } }, 'roboapply')).toBe('goapply');
    expect(sessionArtifactBrand({ liveMetrics: { voiceSeam: { v: 1, brand: 'roboapply', provider: 'livekit_selfhosted' } } }, 'goapply')).toBe('roboapply');
  });

  it("else the account's brand (no column, no seam, or an unreadable value)", () => {
    expect(sessionArtifactBrand({ brand: null, liveMetrics: null }, 'goapply')).toBe('goapply');
    expect(sessionArtifactBrand({ brand: null, liveMetrics: { latencyMs: 120 } }, 'goapply')).toBe('goapply');
    expect(sessionArtifactBrand({ brand: 'not-a-brand', liveMetrics: [] }, 'roboapply')).toBe('roboapply');
    expect(sessionArtifactBrand({}, 'roboapply')).toBe('roboapply');
  });
});

describe('account purge: interview artifacts are deleted in the session brand', () => {
  it("a GoApply session's objects go through CN_S3_* — the intl store is never used for them", async () => {
    configureIntl();
    configureCn();
    await closedAccount('cn1', 'goapply');
    await session({ id: 'ga_sess', userId: 'cn1', brand: 'goapply', recordingKey: 'interviews/ga_sess/recording.ogg' });

    expect(await purgeAccountNow('cn1')).toEqual({ blocked: false });

    expect(h.deletes.length).toBeGreaterThanOrEqual(4);
    for (const d of h.deletes) {
      expect(d).toMatchObject({ bucket: CN.bucket, endpoint: CN.endpoint, accessKeyId: CN.key });
    }
    expect(h.deletes.map((d) => d.key).sort()).toEqual([
      'interviews/ga_sess/recording.mp4',
      'interviews/ga_sess/recording.ogg',
      'interviews/ga_sess/report.json',
      'interviews/ga_sess/transcript.json',
      'interviews/ga_sess/transcript.txt',
    ]);
    expect(h.deletes.some((d) => d.bucket === INTL.bucket || d.endpoint === INTL.endpoint || d.accessKeyId === INTL.key)).toBe(false);
    expect(db().$rows('user')).toHaveLength(0);
  });

  it('the purge runs in the account brand, yet each session is cleaned in its own (column, then seam, then account)', async () => {
    configureIntl();
    configureCn();
    // A RoboApply account that holds one GoApply session (seam only: the column is null on older rows).
    await closedAccount('mixed', 'roboapply');
    await session({ id: 'seam_cn', userId: 'mixed', brand: null, liveMetrics: { voiceSeam: { v: 1, brand: 'goapply', provider: 'livekit_cloud' } } });
    await session({ id: 'plain_intl', userId: 'mixed', brand: null, liveMetrics: { latencyMs: 80 } });
    await session({ id: 'col_cn', userId: 'mixed', brand: 'goapply' });

    const summary = await runAccountPurgeSweep({ now: NOW });
    expect(summary).toMatchObject({ purged: 1, blocked: 0, interviewSessionsCleaned: 3 });

    for (const id of ['seam_cn', 'col_cn']) {
      expect(deletesFor(id).length, id).toBe(4);
      for (const d of deletesFor(id)) expect(d, id).toMatchObject({ bucket: CN.bucket, endpoint: CN.endpoint, accessKeyId: CN.key });
    }
    expect(deletesFor('plain_intl')).toHaveLength(4);
    for (const d of deletesFor('plain_intl')) expect(d).toMatchObject({ bucket: INTL.bucket, endpoint: INTL.endpoint, accessKeyId: INTL.key });
    // No GoApply object was ever requested from the intl store.
    expect(h.deletes.filter((d) => d.bucket === INTL.bucket).every((d) => d.key.includes('/plain_intl/'))).toBe(true);
  });

  it("a GoApply account's session with neither column nor seam falls back to the account brand", async () => {
    configureIntl();
    configureCn();
    await closedAccount('cn2', 'goapply');
    await session({ id: 'bare', userId: 'cn2' });
    expect(await purgeAccountNow('cn2')).toEqual({ blocked: false });
    expect(h.deletes).toHaveLength(4);
    for (const d of h.deletes) expect(d).toMatchObject({ bucket: CN.bucket, accessKeyId: CN.key });
  });

  it('without the CN store the account is held (never cleaned from, or orphaned in, the intl store)', async () => {
    configureIntl(); // RoboApply storage works; GoApply has none
    await closedAccount('mixed2', 'roboapply');
    await session({ id: 'cn_only', userId: 'mixed2', brand: 'goapply' });
    await session({ id: 'intl_one', userId: 'mixed2' });

    expect(await purgeAccountNow('mixed2')).toEqual({ blocked: true, reason: 'r2_not_configured (goapply)' });
    expect(h.deletes).toEqual([]);
    expect(db().$rows('user')).toHaveLength(1);
    expect(db().$rows('interviewSession')).toHaveLength(2);

    // The same account goes through once GoApply storage exists.
    configureCn();
    expect(await purgeAccountNow('mixed2')).toEqual({ blocked: false });
    expect(deletesFor('cn_only').every((d) => d.bucket === CN.bucket)).toBe(true);
    expect(deletesFor('intl_one').every((d) => d.bucket === INTL.bucket)).toBe(true);
    expect(db().$rows('user')).toHaveLength(0);
  });

  it('a failed delete in the CN store keeps the account for the next run', async () => {
    configureIntl();
    configureCn();
    h.failBuckets.add(CN.bucket);
    await closedAccount('cn3', 'goapply');
    await session({ id: 'stuck', userId: 'cn3', brand: 'goapply' });
    const out = await purgeAccountNow('cn3');
    expect(out.blocked).toBe(true);
    expect(out.reason).toMatch(/storage_cleanup_incomplete \(artifacts=4/);
    expect(db().$rows('user')).toHaveLength(1);
    expect(h.deletes).toEqual([]);
  });

  it('a RoboApply account with RoboApply sessions is unchanged: the intl store only', async () => {
    configureIntl();
    configureCn();
    await closedAccount('us1', 'roboapply');
    await session({ id: 's1', userId: 'us1', brand: 'roboapply' });
    await session({ id: 's2', userId: 'us1' });
    expect(await purgeAccountNow('us1')).toEqual({ blocked: false });
    expect(h.deletes).toHaveLength(8);
    for (const d of h.deletes) expect(d).toMatchObject({ bucket: INTL.bucket, endpoint: INTL.endpoint, accessKeyId: INTL.key });
  });
});
