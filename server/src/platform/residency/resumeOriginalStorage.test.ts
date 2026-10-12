// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../services/LoggerService.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { afterEach } from 'vitest';
import { runWithBrand } from '../../lib/requestContext.js';
import { setUserBrandLookup } from '../brand/userBrand.js';
import {
  ResumeOriginalFileStorageService,
  StorageUnavailableError,
  brandOfKey,
  originalStorageConfigured,
  type S3ClientLike,
} from '../../services/ResumeOriginalFileStorageService.js';

// The owner lookup (`User.brand`) never reaches a database here.
const OWNERS: Record<string, string> = { user_1: 'roboapply', user_cn: 'goapply' };
function knownOwners(): void {
  setUserBrandLookup(async (userId) => OWNERS[userId] ?? null);
}
afterEach(() => setUserBrandLookup(null));

const INTL_S3 = {
  NODE_ENV: 'production',
  S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
  S3_BUCKET: 'intl-bucket',
  S3_ACCESS_KEY_ID: 'intl-id',
  S3_SECRET_ACCESS_KEY: 'intl-secret',
};
const CN_S3 = {
  CN_S3_ENDPOINT: 'https://oss-cn-shanghai.aliyuncs.com',
  CN_S3_BUCKET: 'cn-bucket',
  CN_S3_ACCESS_KEY_ID: 'cn-id',
  CN_S3_SECRET_ACCESS_KEY: 'cn-secret',
};

type Sent = { endpoint?: string; accessKeyId: string; command: string; input: Record<string, unknown> };

function harness(env: Record<string, string | undefined>) {
  const sent: Sent[] = [];
  const created: Array<{ endpoint?: string; accessKeyId: string }> = [];
  const svc = new ResumeOriginalFileStorageService({
    env,
    createS3Client: (config) => {
      created.push({ endpoint: config.endpoint, accessKeyId: config.credentials.accessKeyId });
      const client: S3ClientLike = {
        send: (async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
          sent.push({ endpoint: config.endpoint, accessKeyId: config.credentials.accessKeyId, command: command.constructor.name, input: command.input });
          if (command.constructor.name === 'GetObjectCommand') return { Body: Buffer.from('bytes'), ContentType: 'application/pdf' };
          return {};
        }) as unknown as S3ClientLike['send'],
      };
      return client;
    },
  });
  return { svc, sent, created };
}

const FILE = { buffer: Buffer.from('%PDF-1.4 resume'), fileName: '简历 final.pdf', mimeType: 'application/pdf', size: 15, userId: 'user_1' };

describe('RoboApply (unchanged behaviour)', () => {
  it('stores in the intl bucket under the given keyspace', async () => {
    const { svc, sent } = harness(INTL_S3);
    const stored = await runWithBrand('roboapply', () => svc.saveFile({ ...FILE, keyspace: 'roboapply-resumes' }));
    expect(stored?.provider).toBe('s3');
    expect(stored?.key).toMatch(/^roboapply-resumes\/user_1\/\d{4}-\d{2}-\d{2}\/[0-9a-f-]+-.+\.pdf$/);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ command: 'PutObjectCommand', endpoint: INTL_S3.S3_ENDPOINT, input: { Bucket: 'intl-bucket' } });
    expect(svc.isConfigured('roboapply')).toBe(true);
    expect(svc.describeStorageProvider()).toEqual({ mode: 's3', bucket: 'intl-bucket', endpoint: INTL_S3.S3_ENDPOINT, prefix: 'resume-originals' });
  });

  it('stores nothing in production without a bucket', async () => {
    const { svc, sent } = harness({ NODE_ENV: 'production' });
    expect(svc.getProviderMode('roboapply')).toBe('none');
    expect(await svc.saveFile({ ...FILE, brand: 'roboapply' })).toBeNull();
    expect(sent).toHaveLength(0);
  });
});

const STRICT = { CN_RESIDENCY_STRICT: 'true' };
const MAINLAND = { DEPLOY_REGION: 'cn-mainland' };

describe('GoApply on the shared store (D5: no CN bucket is the default, not an error)', () => {
  it('with only S3_* set, stores the original under goapply/ in the shared bucket; it can be read back and deleted', async () => {
    for (const region of [{}, MAINLAND]) {
      const { svc, sent, created } = harness({ ...INTL_S3, ...region });
      expect(svc.isConfigured('goapply')).toBe(true);
      expect(svc.getProviderMode('goapply')).toBe('s3');
      expect(() => svc.assertAvailable('goapply')).not.toThrow();
      const stored = await runWithBrand('goapply', () => svc.saveFile({ ...FILE, keyspace: 'roboapply-resumes' }));
      expect(stored?.provider).toBe('s3');
      expect(stored?.key).toMatch(/^goapply\/roboapply-resumes\/user_1\/\d{4}-\d{2}-\d{2}\/[0-9a-f-]+-.+\.pdf$/);
      expect(brandOfKey(stored!.key)).toBe('goapply');
      // One client, the shared one: GoApply and RoboApply use the same bucket and credentials.
      expect(created).toEqual([{ endpoint: INTL_S3.S3_ENDPOINT, accessKeyId: 'intl-id' }]);
      const back = await svc.readFile({ provider: 's3', key: stored!.key });
      expect(back.buffer.toString()).toBe('bytes');
      expect(await svc.deleteFile({ provider: 's3', key: stored!.key })).toBe(true);
      expect(sent.map((x) => [x.command, x.input.Bucket, x.input.Key])).toEqual([
        ['PutObjectCommand', 'intl-bucket', stored!.key],
        ['GetObjectCommand', 'intl-bucket', stored!.key],
        ['DeleteObjectCommand', 'intl-bucket', stored!.key],
      ]);
      expect(svc.describeStorageProvider('goapply')).toMatchObject({ mode: 's3', bucket: 'intl-bucket' });
    }
  });

  it('RoboApply keys are unchanged beside it: no prefix, and never read as GoApply', async () => {
    const { svc } = harness(INTL_S3);
    const robo = await svc.saveFile({ ...FILE, brand: 'roboapply', keyspace: 'roboapply-resumes' });
    const go = await svc.saveFile({ ...FILE, brand: 'goapply', keyspace: 'roboapply-resumes' });
    expect(robo?.key.startsWith('roboapply-resumes/user_1/')).toBe(true);
    expect(go?.key.startsWith('goapply/roboapply-resumes/user_1/')).toBe(true);
    expect(brandOfKey(robo!.key)).toBe('roboapply');
  });

  it('follows the brand context when no brand is passed', async () => {
    const { svc } = harness(INTL_S3);
    expect(runWithBrand('goapply', () => svc.isConfigured())).toBe(true);
    expect(runWithBrand('roboapply', () => svc.isConfigured())).toBe(true);
    expect((await runWithBrand('goapply', () => svc.saveFile(FILE)))?.key.startsWith('goapply/')).toBe(true);
  });

  it('outside production it uses local disk like RoboApply, and nothing at all in production without a bucket', () => {
    expect(harness({}).svc.getProviderMode('goapply')).toBe('local');
    expect(originalStorageConfigured('goapply', {})).toBe(true);
    expect(harness({ NODE_ENV: 'production' }).svc.getProviderMode('goapply')).toBe('none');
    expect(originalStorageConfigured('goapply', { NODE_ENV: 'production' })).toBe(false);
    expect(originalStorageConfigured('goapply', INTL_S3)).toBe(true);
    expect(originalStorageConfigured('roboapply', INTL_S3)).toBe(true);
  });
});

describe('originalStorageConfigured reads the configuration once per environment', () => {
  it('a half-set CN bucket is logged once, not on every question (the profile page asks on each request)', async () => {
    const { logger } = await import('../../services/LoggerService.js');
    const error = vi.mocked(logger.error);
    error.mockClear();
    const halfSet = { ...INTL_S3, CN_S3_BUCKET: 'cn-bucket' };
    for (let i = 0; i < 5; i += 1) expect(originalStorageConfigured('goapply', halfSet)).toBe(false);
    expect(originalStorageConfigured('roboapply', halfSet)).toBe(true);
    const lines = error.mock.calls.filter(([, message]) => String(message).includes('CN_S3_* set is incomplete'));
    expect(lines).toHaveLength(1);
    // The line names which parts are present, never a value.
    expect(JSON.stringify(lines[0])).not.toContain('intl-secret');
  });

  it('the live process is answered by the module service, the one that does the write', async () => {
    const { resumeOriginalFileStorageService } = await import('../../services/ResumeOriginalFileStorageService.js');
    const spy = vi.spyOn(resumeOriginalFileStorageService, 'isConfigured');
    const answer = originalStorageConfigured('goapply');
    expect(spy).toHaveBeenCalledWith('goapply');
    expect(answer).toBe(spy.mock.results[0]!.value);
    spy.mockRestore();
  });
});

describe('CN_STORAGE_MODE=discard (opt-in): no original file is kept', () => {
  it('writes nothing, to neither bucket, even when both are configured', async () => {
    const { svc, sent, created } = harness({ ...INTL_S3, ...CN_S3, CN_STORAGE_MODE: 'discard' });
    expect(svc.isConfigured('goapply')).toBe(false);
    expect(svc.getProviderMode('goapply')).toBe('discard');
    const stored = await runWithBrand('goapply', () => svc.saveFile(FILE));
    expect(stored).toBeNull();
    expect(sent).toHaveLength(0);
    // Only the eager shared client exists; nothing was built for GoApply.
    expect(created).toEqual([{ endpoint: INTL_S3.S3_ENDPOINT, accessKeyId: 'intl-id' }]);
    expect(() => svc.assertAvailable('goapply')).not.toThrow();
    expect(originalStorageConfigured('goapply', { ...INTL_S3, CN_STORAGE_MODE: 'discard' })).toBe(false);
    // RoboApply is untouched by the switch.
    expect(svc.isConfigured('roboapply')).toBe(true);
  });
});

describe('no brand context: a residency-critical write never guesses RoboApply (production serves both brands by default)', () => {
  const BOTH = { ...INTL_S3 };

  it('uses the stored brand of the owning user: RoboApply keys for a RoboApply user, goapply/ for a GoApply user', async () => {
    knownOwners();
    const { svc, sent } = harness(BOTH);
    const robo = await svc.saveFile({ ...FILE, userId: 'user_1' });
    const go = await svc.saveFile({ ...FILE, userId: 'user_cn' });
    expect(robo?.key.startsWith('resume-originals/user_1/')).toBe(true);
    expect(go?.key.startsWith('goapply/resume-originals/user_cn/')).toBe(true);
    expect(sent.map((x) => x.input.Bucket)).toEqual(['intl-bucket', 'intl-bucket']);
  });

  it('with its own bucket the GoApply user\'s file goes there, the RoboApply user\'s stays in the shared one', async () => {
    knownOwners();
    const { svc, sent } = harness({ ...BOTH, ...CN_S3 });
    await svc.saveFile({ ...FILE, userId: 'user_1' });
    const go = await svc.saveFile({ ...FILE, userId: 'user_cn' });
    expect(go?.key.startsWith('cn/')).toBe(true);
    expect(sent.map((x) => [x.input.Bucket, x.accessKeyId])).toEqual([
      ['intl-bucket', 'intl-id'],
      ['cn-bucket', 'cn-id'],
    ]);
  });

  it('with neither a context nor a known owner it writes nothing and reports brand_context_missing', async () => {
    setUserBrandLookup(async () => null);
    const { svc, sent } = harness(BOTH);
    expect(svc.isConfigured()).toBe(false);
    expect(svc.getProviderMode()).toBe('none');
    await expect(svc.saveFile({ ...FILE, userId: 'nobody' })).rejects.toMatchObject({ code: 'brand_context_missing' });
    expect(() => svc.assertAvailable()).toThrow(/no brand for this write/);
    expect(sent).toHaveLength(0);
    // A failing lookup is not evidence about the brand either.
    setUserBrandLookup(async () => {
      throw new Error('db down');
    });
    await expect(svc.saveFile(FILE)).rejects.toMatchObject({ code: 'brand_context_missing' });
    expect(sent).toHaveLength(0);
  });

  it('an owner whose brand this deployment does not serve gets nothing written', async () => {
    knownOwners();
    const { svc, sent } = harness({ ...BOTH, ALLOWED_BRANDS: 'roboapply' });
    await expect(svc.saveFile({ ...FILE, userId: 'user_cn' })).rejects.toMatchObject({ code: 'brand_context_missing' });
    expect(sent).toHaveLength(0);
  });

  it('uses the brand the deployment implies when the owner is unknown: a one-brand deployment, or GoApply on the mainland', async () => {
    setUserBrandLookup(async () => null);
    const intlOnly = harness({ ...INTL_S3, ALLOWED_BRANDS: 'roboapply' });
    expect((await intlOnly.svc.saveFile(FILE))?.key.startsWith('resume-originals/')).toBe(true);
    expect(intlOnly.sent).toHaveLength(1);

    const mainland = harness({ ...INTL_S3, ...CN_S3, ...MAINLAND, ALLOWED_BRANDS: 'goapply' });
    const stored = await mainland.svc.saveFile(FILE);
    expect(stored?.key.startsWith('cn/')).toBe(true);
    expect(mainland.sent.map((x) => x.input.Bucket)).toEqual(['cn-bucket']);

    // GoApply-only offshore on the shared stack: implied GoApply, stored under goapply/.
    const shared = harness({ ...INTL_S3, ALLOWED_BRANDS: 'goapply' });
    expect((await shared.svc.saveFile(FILE))?.key.startsWith('goapply/resume-originals/')).toBe(true);
  });
});

describe('GoApply with its own bucket (CN_S3_*)', () => {
  it('writes to the CN bucket with CN credentials only, under a cn/ key, in either region', async () => {
    for (const region of [{}, MAINLAND]) {
      const { svc, sent } = harness({ ...INTL_S3, ...CN_S3, ...region, AWS_ACCESS_KEY_ID: 'aws-id' });
      const stored = await svc.saveFile({ ...FILE, brand: 'goapply', keyspace: 'roboapply-resumes' });
      expect(stored?.key.startsWith('cn/roboapply-resumes/user_1/')).toBe(true);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        command: 'PutObjectCommand',
        endpoint: CN_S3.CN_S3_ENDPOINT,
        accessKeyId: 'cn-id',
        input: { Bucket: 'cn-bucket' },
      });
      // Reads and deletes route by key, without a brand context.
      await svc.readFile({ provider: 's3', key: stored!.key });
      await svc.deleteFile({ provider: 's3', key: stored!.key });
      expect(sent.slice(1).map((x) => [x.command, x.input.Bucket, x.accessKeyId])).toEqual([
        ['GetObjectCommand', 'cn-bucket', 'cn-id'],
        ['DeleteObjectCommand', 'cn-bucket', 'cn-id'],
      ]);
      expect(svc.describeStorageProvider('goapply')).toMatchObject({ mode: 's3', bucket: 'cn-bucket' });
    }
  });

  it('an object written to the shared store stays reachable after GoApply gets its own bucket', async () => {
    const { svc, sent } = harness({ ...INTL_S3, ...CN_S3 });
    const key = 'goapply/roboapply-resumes/u/2026-10-10/x.pdf';
    await svc.readFile({ provider: 's3', key });
    expect(await svc.deleteFile({ provider: 's3', key })).toBe(true);
    expect(sent.map((x) => [x.command, x.input.Bucket, x.accessKeyId])).toEqual([
      ['GetObjectCommand', 'intl-bucket', 'intl-id'],
      ['DeleteObjectCommand', 'intl-bucket', 'intl-id'],
    ]);
    expect(svc.providerOfKey(key)).toBe('s3');
    expect(svc.providerOfKey('cn/x.pdf')).toBe('s3');
  });

  it('a started but incomplete CN bucket stores nothing: the shared keys never complete it (P2)', async () => {
    const { svc, sent } = harness({ ...INTL_S3, CN_S3_BUCKET: 'cn-bucket', CN_S3_ENDPOINT: CN_S3.CN_S3_ENDPOINT });
    expect(svc.getProviderMode('goapply')).toBe('none');
    expect(svc.isConfigured('goapply')).toBe(false);
    expect(await svc.saveFile({ ...FILE, brand: 'goapply' })).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it('a cn/ key is never looked for in the shared bucket when the CN bucket is gone', async () => {
    const { svc, sent } = harness({ ...INTL_S3 });
    await expect(svc.readFile({ provider: 's3', key: 'cn/roboapply-resumes/u/2026-10-10/x.pdf' })).rejects.toBeInstanceOf(StorageUnavailableError);
    expect(await svc.deleteFile({ provider: 's3', key: 'cn/roboapply-resumes/u/2026-10-10/x.pdf' })).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('without the strict switch an endpoint outside the mainland is used as configured', async () => {
    const aws = 'https://s3.us-east-1.amazonaws.com';
    const { svc, sent } = harness({ ...INTL_S3, ...CN_S3, CN_S3_ENDPOINT: aws, ...MAINLAND });
    expect(svc.getProviderMode('goapply')).toBe('s3');
    await svc.saveFile({ ...FILE, brand: 'goapply' });
    expect(sent[0]).toMatchObject({ endpoint: aws, input: { Bucket: 'cn-bucket' } });
  });
});

describe('CN_RESIDENCY_STRICT=true: mainland storage or nothing', () => {
  it('without CN_S3_* fails closed with 503 storage_unavailable and never writes to the shared bucket', async () => {
    for (const region of [{}, MAINLAND]) {
      const { svc, sent } = harness({ ...INTL_S3, ...STRICT, ...region });
      expect(svc.isConfigured('goapply')).toBe(false);
      expect(svc.getProviderMode('goapply')).toBe('unavailable');
      expect(() => svc.assertAvailable('goapply')).toThrow(StorageUnavailableError);
      await expect(svc.saveFile({ ...FILE, brand: 'goapply' })).rejects.toMatchObject({ code: 'storage_unavailable', status: 503 });
      expect(sent).toHaveLength(0);
      // RoboApply on the same deployment is unaffected.
      expect(svc.isConfigured('roboapply')).toBe(true);
    }
  });

  it('with a mainland CN bucket it stores there', async () => {
    const { svc, sent } = harness({ ...INTL_S3, ...CN_S3, ...STRICT, ...MAINLAND });
    expect(svc.getProviderMode('goapply')).toBe('s3');
    expect((await svc.saveFile({ ...FILE, brand: 'goapply' }))?.key.startsWith('cn/')).toBe(true);
    expect(sent.map((x) => x.input.Bucket)).toEqual(['cn-bucket']);
  });

  // The route case (strict, no CN_S3_* → 503 storage_unavailable, zero PutObject
  // calls) is covered in server/src/roboapply/v2/routes/resumes.hub.test.ts.

  it('refuses a CN_S3_ENDPOINT that is not mainland object storage (e.g. AWS us-east-1)', async () => {
    const aws = 'https://s3.us-east-1.amazonaws.com';
    const { svc, sent, created } = harness({ ...INTL_S3, ...CN_S3, CN_S3_ENDPOINT: aws, ...STRICT, ...MAINLAND });
    expect(svc.getProviderMode('goapply')).toBe('unavailable');
    expect(svc.isConfigured('goapply')).toBe(false);
    await expect(svc.saveFile({ ...FILE, brand: 'goapply' })).rejects.toBeInstanceOf(StorageUnavailableError);
    expect(sent).toHaveLength(0);
    expect(created.some((c) => c.endpoint === aws)).toBe(false);
  });

  it('refuses a CN_S3_ENDPOINT that is the shared bucket host', async () => {
    const { svc, sent } = harness({ ...INTL_S3, ...CN_S3, CN_S3_ENDPOINT: INTL_S3.S3_ENDPOINT, ...STRICT, ...MAINLAND });
    expect(svc.getProviderMode('goapply')).toBe('unavailable');
    await expect(svc.saveFile({ ...FILE, brand: 'goapply' })).rejects.toBeInstanceOf(StorageUnavailableError);
    expect(sent).toHaveLength(0);
  });
});

describe('brandOfKey', () => {
  it('routes cn/ and goapply/ keys to GoApply and everything else to RoboApply', () => {
    expect(brandOfKey('cn/roboapply-resumes/u/x.pdf')).toBe('goapply');
    expect(brandOfKey('goapply/roboapply-resumes/u/x.pdf')).toBe('goapply');
    expect(brandOfKey('roboapply-resumes/u/x.pdf')).toBe('roboapply');
    expect(brandOfKey('resume-originals/cn/x.pdf')).toBe('roboapply');
    expect(brandOfKey('resume-originals/goapply/x.pdf')).toBe('roboapply');
  });
});
