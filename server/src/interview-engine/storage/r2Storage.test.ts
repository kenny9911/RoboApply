// @vitest-environment node
//
// INT-09 (wave4 WP-93 #8, R8): the interview storage client cache is keyed by
// endpoint + bucket + access key id, not by bucket name alone, so two brands
// with a bucket of the same name on different stores never share a client.
// No network: the S3 client is only constructed, never sent a command.
// Run: npx vitest run server/src/interview-engine/storage/r2Storage.test.ts

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runWithBrand } from '../../lib/requestContext.js';
import { getR2Creds } from '../config.js';
import { InterviewR2Storage, r2ClientCacheKey } from './r2Storage.js';

const PREFIXES = ['S3_', 'AWS_', 'CN_S3_', 'CN_AWS_'];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = { ...process.env };
  for (const k of Object.keys(process.env)) {
    if (PREFIXES.some((p) => k.startsWith(p))) delete process.env[k];
  }
});
afterEach(() => {
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

  it('the same bucket on the same endpoint is still refused for GoApply (CN L-11)', () => {
    Object.assign(process.env, { ...SAME_NAME, CN_S3_ENDPOINT: 'https://r2.example' });
    expect(getR2Creds('goapply')).toBeNull();
    const storage = new InterviewR2Storage();
    expect(runWithBrand('goapply', () => storage.isConfigured())).toBe(false);
    expect(() => runWithBrand('goapply', () => storage.clientForCurrentBrand())).toThrow(/not configured/);
  });
});
