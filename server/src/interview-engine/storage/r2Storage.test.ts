// @vitest-environment node
//
// INT-09 (wave4 WP-93 #8, R8): the interview storage client cache is keyed by
// endpoint + bucket + access key id, not by bucket name alone, so two brands
// with a bucket of the same name on different stores never share a client.
// D5 (GOAPPLY_PARITY_PLAN §3.5, G55): GoApply with no bucket of its own uses
// the shared bucket (one client), and once it has its own, deletes still reach
// the shared bucket for its earlier sessions.
// Under CN_RESIDENCY_STRICT (mainland storage required) GoApply without a
// bucket of its own writes nothing new; reads and deletes of what earlier
// sessions stored in the shared bucket keep working.
// No network: the S3 client is only constructed; `send` is a spy where used.
// Run: npx vitest run server/src/interview-engine/storage/r2Storage.test.ts

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runWithBrand } from '../../lib/requestContext.js';
import { getR2Creds } from '../config.js';
import { InterviewR2Storage, r2ClientCacheKey } from './r2Storage.js';

const PREFIXES = ['S3_', 'AWS_', 'CN_S3_', 'CN_AWS_', 'CN_RESIDENCY_STRICT'];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  saved = { ...process.env };
  for (const k of Object.keys(process.env)) {
    if (PREFIXES.some((p) => k.startsWith(p))) delete process.env[k];
  }
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

const SAME_NAME = {
  S3_BUCKET: 'interviews', S3_ENDPOINT: 'https://r2.example', S3_ACCESS_KEY_ID: 'intl-ak', S3_SECRET_ACCESS_KEY: 'intl-sk',
  CN_S3_BUCKET: 'interviews', CN_S3_ENDPOINT: 'https://oss-cn-shanghai.example', CN_S3_ACCESS_KEY_ID: 'cn-ak', CN_S3_SECRET_ACCESS_KEY: 'cn-sk',
  CN_S3_REGION: 'cn-shanghai',
};

async function endpointOf(storage: InterviewR2Storage): Promise<string> {
  const endpoint = await storage.clientForCurrentBrand().config.endpoint!();
  return endpoint.hostname;
}

describe('r2ClientCacheKey', () => {
  const base = { bucket: 'b', region: 'auto', endpoint: 'https://a.example', accessKeyId: 'ak', secretAccessKey: 'sk', forcePathStyle: false };

  it('differs by endpoint, bucket and access key id', () => {
    const key = r2ClientCacheKey(base);
    expect(r2ClientCacheKey({ ...base })).toBe(key);
    expect(r2ClientCacheKey({ ...base, endpoint: 'https://b.example' })).not.toBe(key);
    expect(r2ClientCacheKey({ ...base, bucket: 'c' })).not.toBe(key);
    expect(r2ClientCacheKey({ ...base, accessKeyId: 'other' })).not.toBe(key);
    expect(r2ClientCacheKey({ ...base, endpoint: undefined })).not.toBe(key);
  });

  it('never contains the secret', () => {
    expect(r2ClientCacheKey({ ...base, secretAccessKey: 'very-secret-value' })).not.toContain('very-secret-value');
  });
});

describe('InterviewR2Storage client cache', () => {
  it('two brands with the same bucket name and different endpoints get different clients', async () => {
    Object.assign(process.env, SAME_NAME);
    const storage = new InterviewR2Storage();

    const intl = runWithBrand('roboapply', () => storage.clientForCurrentBrand());
    const cn = runWithBrand('goapply', () => storage.clientForCurrentBrand());
    expect(cn).not.toBe(intl);
    expect(await runWithBrand('roboapply', () => endpointOf(storage))).toBe('r2.example');
    expect(await runWithBrand('goapply', () => endpointOf(storage))).toBe('oss-cn-shanghai.example');

    // Each brand signs with its own key, against its own store.
    const intlCreds = await intl.config.credentials();
    const cnCreds = await cn.config.credentials();
    expect(intlCreds.accessKeyId).toBe('intl-ak');
    expect(cnCreds.accessKeyId).toBe('cn-ak');
  });

  it('alternating brands reuses each brand’s client instead of rebuilding it', () => {
    Object.assign(process.env, SAME_NAME);
    const storage = new InterviewR2Storage();
    const intl = runWithBrand('roboapply', () => storage.clientForCurrentBrand());
    const cn = runWithBrand('goapply', () => storage.clientForCurrentBrand());
    expect(runWithBrand('roboapply', () => storage.clientForCurrentBrand())).toBe(intl);
    expect(runWithBrand('goapply', () => storage.clientForCurrentBrand())).toBe(cn);
  });

  it('a presigned link goes to the session brand’s own store', async () => {
    Object.assign(process.env, SAME_NAME);
    const storage = new InterviewR2Storage();
    const key = storage.transcriptTextKey('s1');
    const intlUrl = await runWithBrand('roboapply', () => storage.presignGet({ key }));
    const cnUrl = await runWithBrand('goapply', () => storage.presignGet({ key }));
    expect(new URL(intlUrl!).hostname).toContain('r2.example');
    expect(new URL(cnUrl!).hostname).toContain('oss-cn-shanghai.example');
    expect(cnUrl).toContain('cn-ak');
    expect(intlUrl).not.toContain('cn-ak');
  });

  it('a new access key id on the same store builds a new client; a rotated secret replaces it', () => {
    Object.assign(process.env, SAME_NAME);
    const storage = new InterviewR2Storage();
    const first = runWithBrand('roboapply', () => storage.clientForCurrentBrand());
    process.env.S3_ACCESS_KEY_ID = 'intl-ak-2';
    const second = runWithBrand('roboapply', () => storage.clientForCurrentBrand());
    expect(second).not.toBe(first);
    process.env.S3_SECRET_ACCESS_KEY = 'intl-sk-rotated';
    const third = runWithBrand('roboapply', () => storage.clientForCurrentBrand());
    expect(third).not.toBe(second);
    expect(runWithBrand('roboapply', () => storage.clientForCurrentBrand())).toBe(third);
  });

  it('GoApply with only S3_* set is configured on the shared bucket and shares RoboApply’s client (G55)', () => {
    Object.assign(process.env, { S3_BUCKET: 'interviews', S3_ENDPOINT: 'https://r2.example', S3_ACCESS_KEY_ID: 'intl-ak', S3_SECRET_ACCESS_KEY: 'intl-sk' });
    expect(getR2Creds('goapply')).toMatchObject({ bucket: 'interviews', endpoint: 'https://r2.example', accessKeyId: 'intl-ak' });
    const storage = new InterviewR2Storage();
    expect(runWithBrand('goapply', () => storage.isConfigured())).toBe(true);
    expect(runWithBrand('goapply', () => storage.clientForCurrentBrand())).toBe(runWithBrand('roboapply', () => storage.clientForCurrentBrand()));
    // Artifacts are keyed by session id, so one bucket never mixes two sessions.
    expect(storage.recordingKey('s1')).toBe('interviews/s1/recording.mp4');
    expect(storage.transcriptJsonKey('s2')).toBe('interviews/s2/transcript.json');
  });

  it('naming the shared bucket in CN_S3_BUCKET is accepted too (sharing is the fallback, not an error)', () => {
    Object.assign(process.env, { ...SAME_NAME, CN_S3_ENDPOINT: 'https://r2.example' });
    expect(getR2Creds('goapply')).toMatchObject({ bucket: 'interviews', endpoint: 'https://r2.example', accessKeyId: 'cn-ak' });
    const storage = new InterviewR2Storage();
    expect(runWithBrand('goapply', () => storage.isConfigured())).toBe(true);
  });

  it('an own bucket with a missing key is not configured, never the shared keys', () => {
    Object.assign(process.env, SAME_NAME);
    delete process.env.CN_S3_SECRET_ACCESS_KEY;
    expect(getR2Creds('goapply')).toBeNull();
    const storage = new InterviewR2Storage();
    expect(runWithBrand('goapply', () => storage.isConfigured())).toBe(false);
    expect(() => runWithBrand('goapply', () => storage.clientForCurrentBrand())).toThrow(/not configured/);
    expect(runWithBrand('roboapply', () => storage.isConfigured())).toBe(true);
  });
});

describe('deleting artifacts after GoApply gets its own bucket', () => {
  function spySend(storage: InterviewR2Storage, brand: 'roboapply' | 'goapply') {
    const client = runWithBrand(brand, () => storage.clientForCurrentBrand());
    const send = vi.fn(async () => ({}));
    (client as unknown as { send: typeof send }).send = send;
    return send;
  }
  const keysOf = (send: ReturnType<typeof vi.fn>) =>
    send.mock.calls.map((c) => (c[0] as { input: { Bucket: string; Key: string } }).input);

  it('a GoApply delete reaches its own bucket and the shared one its earlier sessions wrote to', async () => {
    Object.assign(process.env, { ...SAME_NAME, CN_S3_BUCKET: 'interviews-cn' });
    const storage = new InterviewR2Storage();
    const shared = spySend(storage, 'roboapply');
    const own = spySend(storage, 'goapply');
    const key = storage.recordingKey('cn-session');
    expect(await runWithBrand('goapply', () => storage.deleteObject(key))).toBe(true);
    expect(keysOf(own)).toEqual([{ Bucket: 'interviews-cn', Key: key }]);
    expect(keysOf(shared)).toEqual([{ Bucket: 'interviews', Key: key }]);
  });

  it('a failed delete in either store is reported, so the row keeps its keys for the next run', async () => {
    Object.assign(process.env, { ...SAME_NAME, CN_S3_BUCKET: 'interviews-cn' });
    const storage = new InterviewR2Storage();
    const shared = spySend(storage, 'roboapply');
    spySend(storage, 'goapply');
    shared.mockRejectedValueOnce(new Error('store down'));
    const result = await runWithBrand('goapply', () => storage.deleteSessionArtifacts('cn-session'));
    expect(result).toEqual({ attempted: 4, failed: 1 });
  });

  it('RoboApply deletes only in the shared bucket; GoApply on the shared bucket deletes there once', async () => {
    Object.assign(process.env, { ...SAME_NAME, CN_S3_BUCKET: 'interviews-cn' });
    const storage = new InterviewR2Storage();
    const shared = spySend(storage, 'roboapply');
    const own = spySend(storage, 'goapply');
    await runWithBrand('roboapply', () => storage.deleteObject('interviews/intl-session/recording.mp4'));
    expect(keysOf(shared)).toHaveLength(1);
    expect(own).not.toHaveBeenCalled();
    // No bucket of its own: one store, one delete.
    for (const k of Object.keys(process.env)) if (k.startsWith('CN_S3_')) delete process.env[k];
    shared.mockClear();
    await runWithBrand('goapply', () => storage.deleteObject('interviews/cn-session/recording.mp4'));
    expect(keysOf(shared)).toEqual([{ Bucket: 'interviews', Key: 'interviews/cn-session/recording.mp4' }]);
  });

  it('with no storage at all a delete is never claimed', async () => {
    const storage = new InterviewR2Storage();
    expect(await runWithBrand('goapply', () => storage.deleteObject('interviews/x/recording.mp4'))).toBe(false);
    expect(await runWithBrand('goapply', () => storage.deleteSessionArtifacts('x'))).toEqual({ attempted: 0, failed: 0 });
  });
});

describe('CN_RESIDENCY_STRICT: new artifacts need a bucket of GoApply’s own', () => {
  const SHARED = { S3_BUCKET: 'interviews', S3_ENDPOINT: 'https://r2.example', S3_ACCESS_KEY_ID: 'intl-ak', S3_SECRET_ACCESS_KEY: 'intl-sk' };

  function spySend(storage: InterviewR2Storage, brand: 'roboapply' | 'goapply') {
    const client = runWithBrand(brand, () => storage.clientForCurrentBrand());
    const send = vi.fn(async () => ({}));
    (client as unknown as { send: typeof send }).send = send;
    return send;
  }
  const commandsOf = (send: ReturnType<typeof vi.fn>) => send.mock.calls.map((c) => (c[0] as { constructor: { name: string } }).constructor.name);

  it('without it GoApply stores nothing new in the shared bucket; RoboApply is untouched', async () => {
    Object.assign(process.env, SHARED, { CN_RESIDENCY_STRICT: 'true' });
    const storage = new InterviewR2Storage();
    const send = spySend(storage, 'roboapply'); // one shared client for both brands
    expect(runWithBrand('goapply', () => storage.canStore())).toBe(false);
    await expect(runWithBrand('goapply', () => storage.putObject({ key: 'interviews/s/transcript.txt', body: 'x', contentType: 'text/plain' })))
      .rejects.toThrow(/not available for new objects/);
    expect(send).not.toHaveBeenCalled();
    expect(runWithBrand('roboapply', () => storage.canStore())).toBe(true);
    await runWithBrand('roboapply', () => storage.putObject({ key: 'interviews/r/transcript.txt', body: 'x', contentType: 'text/plain' }));
    expect(commandsOf(send)).toEqual(['PutObjectCommand']);
  });

  it('what earlier sessions stored there is still read and still deleted on time', async () => {
    Object.assign(process.env, SHARED, { CN_RESIDENCY_STRICT: 'true' });
    const storage = new InterviewR2Storage();
    const send = spySend(storage, 'roboapply');
    expect(runWithBrand('goapply', () => storage.isConfigured())).toBe(true);
    expect(await runWithBrand('goapply', () => storage.deleteSessionArtifacts('cn-session'))).toEqual({ attempted: 4, failed: 0 });
    expect(commandsOf(send)).toEqual(['DeleteObjectCommand', 'DeleteObjectCommand', 'DeleteObjectCommand', 'DeleteObjectCommand']);
    const url = await runWithBrand('goapply', () => storage.presignGet({ key: storage.recordingKey('cn-session') }));
    expect(new URL(url!).hostname).toContain('r2.example');
  });

  it('with a bucket of its own GoApply stores there; without the strict switch the shared bucket is the fallback', async () => {
    Object.assign(process.env, SHARED, {
      CN_RESIDENCY_STRICT: 'true',
      CN_S3_BUCKET: 'interviews-cn', CN_S3_ENDPOINT: 'https://oss-cn-shanghai.example', CN_S3_ACCESS_KEY_ID: 'cn-ak', CN_S3_SECRET_ACCESS_KEY: 'cn-sk',
    });
    const storage = new InterviewR2Storage();
    const own = spySend(storage, 'goapply');
    expect(runWithBrand('goapply', () => storage.canStore())).toBe(true);
    await runWithBrand('goapply', () => storage.putObject({ key: 'interviews/s/report.json', body: '{}', contentType: 'application/json' }));
    expect((own.mock.calls[0]![0] as { input: { Bucket: string } }).input.Bucket).toBe('interviews-cn');
    for (const k of Object.keys(process.env)) if (k.startsWith('CN_')) delete process.env[k];
    expect(runWithBrand('goapply', () => storage.canStore())).toBe(true);
  });
});
