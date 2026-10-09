// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../services/LoggerService.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { runWithBrand } from '../../lib/requestContext.js';
import {
  ResumeOriginalFileStorageService,
  StorageUnavailableError,
  brandOfKey,
  type S3ClientLike,
} from '../../services/ResumeOriginalFileStorageService.js';

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

describe('GoApply offshore (CN-0): no original file is kept', () => {
  it('writes nothing — not to the intl bucket, not to the CN bucket — even when both are configured', async () => {
    const { svc, sent, created } = harness({ ...INTL_S3, ...CN_S3 });
    expect(svc.isConfigured('goapply')).toBe(false);
    expect(svc.getProviderMode('goapply')).toBe('discard');
    const stored = await runWithBrand('goapply', () => svc.saveFile(FILE));
    expect(stored).toBeNull();
    expect(sent).toHaveLength(0);
    // Only the eager intl client exists; nothing was built for GoApply.
    expect(created).toEqual([{ endpoint: INTL_S3.S3_ENDPOINT, accessKeyId: 'intl-id' }]);
    expect(() => svc.assertAvailable('goapply')).not.toThrow();
  });

  it('follows the brand context when no brand is passed', async () => {
    const { svc } = harness(INTL_S3);
    expect(runWithBrand('goapply', () => svc.isConfigured())).toBe(false);
    expect(runWithBrand('roboapply', () => svc.isConfigured())).toBe(true);
  });
});

describe('no brand context: a residency-critical write never falls back to RoboApply', () => {
  const BOTH = { ...INTL_S3, ...CN_S3, ALLOWED_BRANDS: 'roboapply,goapply' };

  it('refuses the write on a multi-brand deployment and sends nothing to either bucket', async () => {
    const { svc, sent } = harness(BOTH);
    expect(svc.isConfigured()).toBe(false);
    expect(svc.getProviderMode()).toBe('none');
    await expect(svc.saveFile(FILE)).rejects.toMatchObject({ code: 'brand_context_missing' });
    expect(() => svc.assertAvailable()).toThrow(/no brand for this write/);
    expect(sent).toHaveLength(0);
  });

  it('uses the brand the deployment implies: a RoboApply-only deployment, or GoApply on the mainland', async () => {
    const intlOnly = harness({ ...INTL_S3, ALLOWED_BRANDS: 'roboapply' });
    expect((await intlOnly.svc.saveFile(FILE))?.key.startsWith('resume-originals/')).toBe(true);
    expect(intlOnly.sent).toHaveLength(1);

    const mainland = harness({ ...INTL_S3, ...CN_S3, DEPLOY_REGION: 'cn-mainland', ALLOWED_BRANDS: 'goapply' });
    const stored = await mainland.svc.saveFile(FILE);
    expect(stored?.key.startsWith('cn/')).toBe(true);
    expect(mainland.sent.map((s) => s.input.Bucket)).toEqual(['cn-bucket']);

    // GoApply-only offshore (CN-0): implied GoApply → discard, nothing written.
    const cn0 = harness({ ...INTL_S3, ALLOWED_BRANDS: 'goapply' });
    expect(await cn0.svc.saveFile(FILE)).toBeNull();
    expect(cn0.sent).toHaveLength(0);
  });
});

describe('GoApply on the mainland stack', () => {
  const MAINLAND = { DEPLOY_REGION: 'cn-mainland' };

  it('without CN_S3_* fails closed with 503 storage_unavailable and never writes to the intl bucket', async () => {
    const { svc, sent } = harness({ ...INTL_S3, ...MAINLAND });
    expect(svc.isConfigured('goapply')).toBe(false);
    expect(svc.getProviderMode('goapply')).toBe('unavailable');
    expect(() => svc.assertAvailable('goapply')).toThrow(StorageUnavailableError);
    await expect(svc.saveFile({ ...FILE, brand: 'goapply' })).rejects.toMatchObject({ code: 'storage_unavailable', status: 503 });
    expect(sent).toHaveLength(0);
    // A GoApply key can never be read from the intl bucket either.
    await expect(svc.readFile({ provider: 's3', key: 'cn/roboapply-resumes/u/2026-10-10/x.pdf' })).rejects.toBeInstanceOf(
      StorageUnavailableError,
    );
    expect(await svc.deleteFile({ provider: 's3', key: 'cn/roboapply-resumes/u/2026-10-10/x.pdf' })).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('with CN_S3_* writes to the CN bucket with CN credentials only, under a cn/ key', async () => {
    const { svc, sent } = harness({ ...INTL_S3, ...CN_S3, ...MAINLAND, AWS_ACCESS_KEY_ID: 'aws-id' });
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
    expect(sent.slice(1).map((s) => [s.command, s.input.Bucket, s.accessKeyId])).toEqual([
      ['GetObjectCommand', 'cn-bucket', 'cn-id'],
      ['DeleteObjectCommand', 'cn-bucket', 'cn-id'],
    ]);
    expect(svc.describeStorageProvider('goapply')).toMatchObject({ mode: 's3', bucket: 'cn-bucket' });
  });

  // REQ-WP15-02 (FND/INT: storage_unavailable → 503 in platform/http.ts ERROR_STATUS) and
  // REQ-WP15-04 (WP-36b/WP-22: the upload route calls assertAvailable() before accepting the file).
  it.todo('REQ-WP15-02/04: POST a resume on cn-mainland without CN_S3_* → 503 {code:"storage_unavailable"} and zero PutObject calls');

  it('refuses a CN_S3_ENDPOINT that is not mainland object storage (e.g. AWS us-east-1)', async () => {
    const aws = 'https://s3.us-east-1.amazonaws.com';
    const { svc, sent, created } = harness({ ...INTL_S3, ...CN_S3, CN_S3_ENDPOINT: aws, ...MAINLAND });
    expect(svc.getProviderMode('goapply')).toBe('unavailable');
    expect(svc.isConfigured('goapply')).toBe(false);
    await expect(svc.saveFile({ ...FILE, brand: 'goapply' })).rejects.toBeInstanceOf(StorageUnavailableError);
    expect(sent).toHaveLength(0);
    expect(created.some((c) => c.endpoint === aws)).toBe(false);
  });

  it('refuses a CN_S3_ENDPOINT that is the intl bucket host', async () => {
    const { svc, sent } = harness({ ...INTL_S3, ...CN_S3, CN_S3_ENDPOINT: INTL_S3.S3_ENDPOINT, ...MAINLAND });
    expect(svc.getProviderMode('goapply')).toBe('unavailable');
    await expect(svc.saveFile({ ...FILE, brand: 'goapply' })).rejects.toBeInstanceOf(StorageUnavailableError);
    expect(sent).toHaveLength(0);
  });
});

describe('brandOfKey', () => {
  it('routes cn/ keys to GoApply and everything else to RoboApply', () => {
    expect(brandOfKey('cn/roboapply-resumes/u/x.pdf')).toBe('goapply');
    expect(brandOfKey('roboapply-resumes/u/x.pdf')).toBe('roboapply');
    expect(brandOfKey('resume-originals/cn/x.pdf')).toBe('roboapply');
  });
});
