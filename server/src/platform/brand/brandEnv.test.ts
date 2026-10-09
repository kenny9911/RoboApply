// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { brandEnv, brandEnvFlag, brandEnvName, envSet } from './brandEnv.js';

describe('brandEnv (R-03)', () => {
  const env = { S3_BUCKET: 'intl-bucket', CN_S3_BUCKET: 'cn-bucket', EMPTY: '  ', FLAG: 'TRUE' };

  it('reads the unprefixed name for RoboApply and CN_ for GoApply', () => {
    expect(brandEnvName('roboapply', 'S3_BUCKET')).toBe('S3_BUCKET');
    expect(brandEnvName('goapply', 'S3_BUCKET')).toBe('CN_S3_BUCKET');
    expect(brandEnv('roboapply', 'S3_BUCKET', env)).toBe('intl-bucket');
    expect(brandEnv('goapply', 'S3_BUCKET', env)).toBe('cn-bucket');
  });

  it('never falls back from CN_X to X', () => {
    expect(brandEnv('goapply', 'S3_BUCKET', { S3_BUCKET: 'intl-bucket' })).toBeUndefined();
  });

  it('treats blank values as unset', () => {
    expect(brandEnv('roboapply', 'EMPTY', env)).toBeUndefined();
    expect(envSet(env, 'EMPTY')).toBe(false);
    expect(envSet(env, 'S3_BUCKET', 'CN_S3_BUCKET')).toBe(true);
  });

  it('parses boolean flags', () => {
    expect(brandEnvFlag('roboapply', 'FLAG', false, env)).toBe(true);
    expect(brandEnvFlag('goapply', 'FLAG', true, env)).toBe(true);
    expect(brandEnvFlag('goapply', 'FLAG', false, env)).toBe(false);
  });

  it('rejects prefixed or lowercase names', () => {
    expect(() => brandEnvName('goapply', 'CN_S3_BUCKET')).toThrow();
    expect(() => brandEnvName('goapply', 's3_bucket')).toThrow();
  });
});
