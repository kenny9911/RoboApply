// @vitest-environment node
//
// WP-93 (WP-63a R9): the account purge deletes each interview session's
// stored artifacts inside the SESSION's brand. With its own store (CN_S3_*) a
// GoApply session's recording and transcript are deleted there and RoboApply's
// bucket is never asked for them. The real interview storage service runs here
// against a fake S3 client that records which endpoint, credentials and bucket
// every delete used. No network, no database.
//
// D5 (GOAPPLY_PARITY_PLAN.md §3.6): GoApply resume originals and application
// files are kept on the shared store under goapply/ when it has no bucket of
// its own. The purge deletes them where their key says they are (the real
// resume storage service runs in those cases, against the same fake client).

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
  /** The resume storage the purge talks to: a stub that confirms every delete, or the real service (see `realResumeStorage`). */
  resumeStorage: null as null | { deleteFile: (ref: unknown) => Promise<boolean>; providerOfKey: (key: string) => string },
}));

vi.mock('../../lib/prisma.js', async () => {
  const { createFakePrisma } = await import('../../test/fakePrisma.js');
  const db = createFakePrisma();
  h.db = db;
  return { default: db, prisma: db };
});
vi.mock('../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../services/ResumeOriginalFileStorageService.js', () => ({
  resumeOriginalFileStorageService: {
    deleteFile: (ref: unknown) => (h.resumeStorage ? h.resumeStorage.deleteFile(ref) : Promise.resolve(true)),
    providerOfKey: (key: string) => (h.resumeStorage ? h.resumeStorage.providerOfKey(key) : 's3'),
  },
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
/** The deletes that went through GoApply's own store, and through the shared one. */
const inCn = (list = h.deletes) => list.filter((d) => d.bucket === CN.bucket);
const inShared = (list = h.deletes) => list.filter((d) => d.bucket === INTL.bucket);
// With its own store a GoApply session's objects are deleted THERE, with that store's endpoint and
// key. The interview engine may also clear the shared store of the same keys (objects written while
// GoApply was still on the shared store, D5): such deletes are allowed here, never required, and
// may only ever name that session's own keys.

/**
 * The real resume storage service over the env stubbed so far (its S3 client
 * is the recording fake above). Build it after `configureIntl` / `configureCn`.
 */
async function realResumeStorage(): Promise<void> {
  const actual = await vi.importActual<typeof import('../../services/ResumeOriginalFileStorageService.js')>('../../services/ResumeOriginalFileStorageService.js');
  const svc = new actual.ResumeOriginalFileStorageService({ env: { ...process.env, NODE_ENV: 'production' } });
  h.resumeStorage = { deleteFile: (ref) => svc.deleteFile(ref as never), providerOfKey: (key) => svc.providerOfKey(key) };
}

beforeEach(async () => {
  h.deletes.length = 0;
  h.failBuckets.clear();
  h.resumeStorage = null;
  for (const model of ['user', 'seekerProfile', 'interviewSession', 'rAResumeVariant', 'rAApplicationArtifact', 'rAOnboardingSession', 'rAWorkItem', 'rABillingRefund']) {
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
  it("a GoApply session's objects are deleted in its own store (CN_S3_*), with that store's endpoint and credentials", async () => {
    configureIntl();
    configureCn();
    await closedAccount('cn1', 'goapply');
    await session({ id: 'ga_sess', userId: 'cn1', brand: 'goapply', recordingKey: 'interviews/ga_sess/recording.ogg' });

    expect(await purgeAccountNow('cn1')).toEqual({ blocked: false });

    const KEYS = [
      'interviews/ga_sess/recording.mp4',
      'interviews/ga_sess/recording.ogg',
      'interviews/ga_sess/report.json',
      'interviews/ga_sess/transcript.json',
      'interviews/ga_sess/transcript.txt',
    ];
    for (const d of inCn()) expect(d).toMatchObject({ bucket: CN.bucket, endpoint: CN.endpoint, accessKeyId: CN.key });
    expect(inCn().map((d) => d.key).sort()).toEqual(KEYS);
    // Nothing else is ever touched: any other delete is one of this session's own keys in the shared store.
    expect(h.deletes.every((d) => d.bucket === CN.bucket || d.bucket === INTL.bucket)).toBe(true);
    for (const d of inShared()) {
      expect(KEYS).toContain(d.key);
      expect(d).toMatchObject({ endpoint: INTL.endpoint, accessKeyId: INTL.key });
    }
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
      expect(inCn(deletesFor(id)).length, id).toBe(4);
      for (const d of inCn(deletesFor(id))) expect(d, id).toMatchObject({ bucket: CN.bucket, endpoint: CN.endpoint, accessKeyId: CN.key });
    }
    // The RoboApply session: the shared store only, never GoApply's.
    expect(inShared(deletesFor('plain_intl'))).toHaveLength(4);
    expect(inCn(deletesFor('plain_intl'))).toHaveLength(0);
    for (const d of deletesFor('plain_intl')) expect(d).toMatchObject({ bucket: INTL.bucket, endpoint: INTL.endpoint, accessKeyId: INTL.key });
    // Every delete belongs to one of the three sessions.
    expect(h.deletes.every((d) => ['seam_cn', 'plain_intl', 'col_cn'].some((id) => d.key.includes(`/${id}/`)))).toBe(true);
  });

  it("a GoApply account's session with neither column nor seam falls back to the account brand", async () => {
    configureIntl();
    configureCn();
    await closedAccount('cn2', 'goapply');
    await session({ id: 'bare', userId: 'cn2' });
    expect(await purgeAccountNow('cn2')).toEqual({ blocked: false });
    expect(inCn()).toHaveLength(4);
    for (const d of inCn()) expect(d).toMatchObject({ bucket: CN.bucket, accessKeyId: CN.key });
    expect(h.deletes.every((d) => d.key.includes('/bare/'))).toBe(true);
  });

  it('without a CN store a GoApply session is never orphaned: its objects are deleted from the store it uses, or the account is held', async () => {
    configureIntl(); // the shared store works; GoApply has no bucket of its own
    await closedAccount('mixed2', 'roboapply');
    await session({ id: 'cn_only', userId: 'mixed2', brand: 'goapply' });
    await session({ id: 'intl_one', userId: 'mixed2' });

    const out = await purgeAccountNow('mixed2');
    if (out.blocked) {
      // The interview engine does not use the shared store for GoApply media: nothing is
      // deleted and both the account and its pointers stay for the next run.
      expect(out).toEqual({ blocked: true, reason: 'r2_not_configured (goapply)' });
      expect(h.deletes).toEqual([]);
      expect(db().$rows('user')).toHaveLength(1);
      expect(db().$rows('interviewSession')).toHaveLength(2);
    } else {
      // The interview engine keeps GoApply media on the shared store (D5): deleted there.
      expect(deletesFor('cn_only').length).toBeGreaterThan(0);
      expect(deletesFor('cn_only').every((d) => d.bucket === INTL.bucket)).toBe(true);
      expect(deletesFor('intl_one').every((d) => d.bucket === INTL.bucket)).toBe(true);
      expect(db().$rows('user')).toHaveLength(0);
    }

    // With GoApply's own store the account goes through, each session in its brand's store.
    h.deletes.length = 0;
    await db().user.deleteMany({});
    await db().seekerProfile.deleteMany({});
    await db().interviewSession.deleteMany({});
    configureCn();
    await closedAccount('mixed3', 'roboapply');
    await session({ id: 'cn_only3', userId: 'mixed3', brand: 'goapply' });
    await session({ id: 'intl_one3', userId: 'mixed3' });
    expect(await purgeAccountNow('mixed3')).toEqual({ blocked: false });
    expect(inCn(deletesFor('cn_only3'))).toHaveLength(4);
    expect(inShared(deletesFor('intl_one3'))).toHaveLength(4);
    expect(inCn(deletesFor('intl_one3'))).toHaveLength(0);
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
    // Nothing was confirmed deleted in the CN store, so the pointers stay.
    expect(inCn()).toEqual([]);
    expect(db().$rows('interviewSession')).toHaveLength(1);
  });

  it('a RoboApply account with RoboApply sessions is unchanged: the intl store only', async () => {
    configureIntl();
    configureCn();
    await closedAccount('us1', 'roboapply');
    await session({ id: 's1', userId: 'us1', brand: 'roboapply' });
    await session({ id: 's2', userId: 'us1' });
    expect(await purgeAccountNow('us1')).toEqual({ blocked: false });
    expect(h.deletes).toHaveLength(8);
    expect(inCn()).toEqual([]);
    for (const d of h.deletes) expect(d).toMatchObject({ bucket: INTL.bucket, endpoint: INTL.endpoint, accessKeyId: INTL.key });
  });
});

describe('account purge: GoApply resume originals and application files on the shared store (D5)', () => {
  async function original(userId: string, id: string, key: string): Promise<void> {
    await db().rAResumeVariant.create({
      data: { id, userId, originalFileProvider: 's3', originalFileKey: key, originalFileName: 'cv.pdf', originalFileMimeType: 'application/pdf' },
    });
  }
  const resumeDeletes = () => h.deletes.filter((d) => d.key.includes('roboapply-resumes/') || d.key.includes('roboapply-artifacts/'));

  it('with only S3_* set, the goapply/ originals and artifacts are deleted in the shared bucket and the account is purged', async () => {
    configureIntl();
    await realResumeStorage();
    await closedAccount('cn_shared', 'goapply');
    await original('cn_shared', 'rv1', 'goapply/roboapply-resumes/cn_shared/2026-10-01/a-cv.pdf');
    await original('cn_shared', 'rv2', 'goapply/roboapply-resumes/cn_shared/2026-10-02/b-cv.pdf');
    await db().rAApplicationArtifact.create({ data: { id: 'art1', userId: 'cn_shared', storageKey: 'goapply/roboapply-artifacts/cn_shared/2026-10-03/c-cv.pdf' } });

    expect(await purgeAccountNow('cn_shared')).toEqual({ blocked: false });

    expect(resumeDeletes().map((d) => d.key).sort()).toEqual([
      'goapply/roboapply-artifacts/cn_shared/2026-10-03/c-cv.pdf',
      'goapply/roboapply-resumes/cn_shared/2026-10-01/a-cv.pdf',
      'goapply/roboapply-resumes/cn_shared/2026-10-02/b-cv.pdf',
    ]);
    for (const d of resumeDeletes()) expect(d).toMatchObject({ bucket: INTL.bucket, endpoint: INTL.endpoint, accessKeyId: INTL.key });
    expect(db().$rows('user')).toHaveLength(0);
  });

  it('after GoApply gets its own bucket, old goapply/ objects are still deleted in the shared store and cn/ ones in the CN store', async () => {
    configureIntl();
    configureCn();
    await realResumeStorage();
    await closedAccount('cn_moved', 'goapply');
    await original('cn_moved', 'rv1', 'goapply/roboapply-resumes/cn_moved/2026-10-01/a-cv.pdf');
    await original('cn_moved', 'rv2', 'cn/roboapply-resumes/cn_moved/2026-10-05/b-cv.pdf');

    expect(await purgeAccountNow('cn_moved')).toEqual({ blocked: false });

    const byKey = Object.fromEntries(resumeDeletes().map((d) => [d.key, d.bucket]));
    expect(byKey).toEqual({
      'goapply/roboapply-resumes/cn_moved/2026-10-01/a-cv.pdf': INTL.bucket,
      'cn/roboapply-resumes/cn_moved/2026-10-05/b-cv.pdf': CN.bucket,
    });
  });

  it('a RoboApply account keeps its unprefixed keys in the shared bucket', async () => {
    configureIntl();
    await realResumeStorage();
    await closedAccount('us_keys', 'roboapply');
    await original('us_keys', 'rv1', 'roboapply-resumes/us_keys/2026-10-01/a-cv.pdf');
    expect(await purgeAccountNow('us_keys')).toEqual({ blocked: false });
    expect(resumeDeletes()).toEqual([{ bucket: INTL.bucket, endpoint: INTL.endpoint, accessKeyId: INTL.key, key: 'roboapply-resumes/us_keys/2026-10-01/a-cv.pdf' }]);
  });

  it('a delete that fails keeps the account and the pointer for the next run', async () => {
    configureIntl();
    await realResumeStorage();
    h.failBuckets.add(INTL.bucket);
    await closedAccount('cn_stuck', 'goapply');
    await original('cn_stuck', 'rv1', 'goapply/roboapply-resumes/cn_stuck/2026-10-01/a-cv.pdf');
    const out = await purgeAccountNow('cn_stuck');
    expect(out.blocked).toBe(true);
    expect(db().$rows('user')).toHaveLength(1);
    expect(db().$rows('rAResumeVariant')).toHaveLength(1);
  });
});
