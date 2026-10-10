// @vitest-environment node
//
// WP-76: deploy/cn/preflight.mjs (the API initContainer) and
// deploy/cn/cron-call.mjs (the command every mainland CronJob runs).
// The preflight is tested with the server's real residency and content-safety
// checks (TypeScript sources); the image runs the same code from server/dist.

import { describe, expect, it, vi } from 'vitest';

// @ts-expect-error — plain .mjs script, no type declarations
import * as preflight from '../../deploy/cn/preflight.mjs';
// @ts-expect-error — plain .mjs script, no type declarations
import * as cronCall from '../../deploy/cn/cron-call.mjs';
import { checkResidency } from '../../server/src/platform/residency/startupAssertions';
import { contentSafetyReadiness } from '../../server/src/platform/llm/contentSafety/config';

type Env = Record<string, string | undefined>;

/** A complete CN-1 API environment (test values only). */
const GOOD: Env = {
  NODE_ENV: 'production',
  DEPLOY_REGION: 'cn-mainland',
  ALLOWED_BRANDS: 'goapply',
  ROBOAPPLY_CRON_DISABLED: 'true',
  CRON_SECRET: 'cron-secret-value-for-tests',
  INTERNAL_API_SECRET: 'internal-secret-value-for-tests',
  CN_CANONICAL_ORIGIN: 'https://www.goapply.top',
  CN_ICP_NUMBER: '沪ICP备00000000号-1',
  DATABASE_URL: 'postgresql://u:p@172.16.3.4:5432/goapply',
  CN_LLM_PROVIDER: 'deepseek',
  CN_LLM_MODEL: 'deepseek-v4-flash',
  CN_S3_ENDPOINT: 'https://oss-cn-shanghai.aliyuncs.com',
  CN_S3_BUCKET: 'goapply-resumes',
  CN_S3_ACCESS_KEY_ID: 'oss-id-for-tests',
  CN_S3_SECRET_ACCESS_KEY: 'oss-secret-for-tests',
  CN_CONTENT_SAFETY_PROVIDER: 'aliyun_green',
  ALIYUN_GREEN_ACCESS_KEY_ID: 'green-id-for-tests',
  ALIYUN_GREEN_ACCESS_KEY_SECRET: 'green-secret-for-tests',
  CN_EMAIL_TRANSPORT: 'aliyun_dm',
};

function run(env: Env) {
  return preflight.runPreflight({ env, checkResidency, contentSafetyReadiness }) as {
    ok: boolean;
    strict: boolean;
    failures: Array<{ code: string; message: string }>;
    warnings: string[];
  };
}
const codes = (env: Env) => run(env).failures.map((f) => f.code);
/** The codes of the provider gaps the preflight only warns about (`[code] message`). */
const warned = (env: Env) => run(env).warnings.map((w) => /^\[([a-z_0-9]+)\]/.exec(w)?.[1]).filter(Boolean);
/** The strict mainland posture: an explicit operator choice. */
const strict = (env: Env): Env => ({ ...env, CN_RESIDENCY_STRICT: 'true' });

/** A mainland API environment with nothing China-specific: GoApply on the shared stack (D5). */
const SHARED: Env = {
  NODE_ENV: 'production',
  DEPLOY_REGION: 'cn-mainland',
  ALLOWED_BRANDS: 'goapply',
  ROBOAPPLY_CRON_DISABLED: 'true',
  CRON_SECRET: 'cron-secret-value-for-tests',
  INTERNAL_API_SECRET: 'internal-secret-value-for-tests',
  CN_CANONICAL_ORIGIN: 'https://www.goapply.top',
  DATABASE_URL: 'postgresql://u:p@172.16.3.4:5432/goapply',
  LLM_PROVIDER: 'openrouter',
  LLM_MODEL: 'openai/gpt-5',
  S3_BUCKET: 'shared-bucket',
  S3_ACCESS_KEY_ID: 'shared-id-for-tests',
  S3_SECRET_ACCESS_KEY: 'shared-secret-for-tests',
  RESEND_API_KEY: 're_key_for_tests',
};

describe('CN-1 preflight', () => {
  it('passes a complete mainland configuration', () => {
    const report = run(GOOD);
    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.warnings).toEqual([]);
  });

  it('refuses when DEPLOY_REGION is not cn-mainland (the residency checks would assert nothing)', () => {
    expect(codes({ ...GOOD, DEPLOY_REGION: undefined })).toEqual(['deploy_region_not_mainland']);
    expect(codes({ ...GOOD, DEPLOY_REGION: 'cn_mainland' })).toEqual(['deploy_region_not_mainland', 'deploy_region_unknown']);
  });

  it('without China-specific providers the preflight passes with warnings: the API boots on the shared stack (D5)', () => {
    const report = run(SHARED);
    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.strict).toBe(false);
    expect(warned(SHARED)).toEqual(['icp_missing', 'cn_storage_missing', 'content_safety_not_aliyun_green', 'cn_email_offshore']);
    const text = preflight.formatReport(report) as string;
    expect(text).toMatch(/^CN-1 preflight: OK, with warnings/);
    expect(text).toContain('! [cn_storage_missing]');
    for (const name of ['CRON_SECRET', 'INTERNAL_API_SECRET', 'S3_SECRET_ACCESS_KEY', 'RESEND_API_KEY']) expect(text).not.toContain(SHARED[name]!);
  });

  it('with CN_RESIDENCY_STRICT=true the same environment is refused (exit 1), as before', () => {
    const report = run(strict(SHARED));
    expect(report.ok).toBe(false);
    expect(report.strict).toBe(true);
    expect(codes(strict(SHARED))).toEqual([
      'icp_missing',
      'cn_storage_missing',
      'content_safety_not_aliyun_green',
      'cn_email_offshore',
      'content_safety_not_cn1_ready',
    ]);
    expect(preflight.formatReport(report)).toMatch(/^CN-1 preflight: REFUSED/);
  });

  it('strict: requires Aliyun Green to be READY, not just named (carry-over from WP-24 / WP-15)', () => {
    // Since the Wave 5 gate (WP-76 request) the boot-time residency check
    // asserts readiness too, and the preflight reports it once.
    const keyless = strict({ ...GOOD, ALIYUN_GREEN_ACCESS_KEY_ID: undefined, ALIYUN_GREEN_ACCESS_KEY_SECRET: undefined });
    expect(checkResidency(keyless).failures.map((f) => f.code)).toEqual(['content_safety_not_ready']);
    expect(codes(keyless)).toEqual(['content_safety_not_ready']);
    expect(run(keyless).failures[0]!.message).toMatch(/ALIYUN_GREEN_ACCESS_KEY_ID/);
    expect(codes(strict({ ...GOOD, ALIYUN_GREEN_REGION: 'ap-southeast-1' }))).toEqual(['content_safety_not_ready']);
    // Without the strict switch the same gap is a warning and the preflight passes.
    const lenient = { ...GOOD, ALIYUN_GREEN_ACCESS_KEY_ID: undefined, ALIYUN_GREEN_ACCESS_KEY_SECRET: undefined };
    expect(codes(lenient)).toEqual([]);
    expect(warned(lenient)).toEqual(['content_safety_not_ready']);
  });

  it('keyword-only content safety on the mainland: a warning by default, refused under the strict switch', () => {
    const keywordOnly = { ...GOOD, CN_CONTENT_SAFETY_PROVIDER: 'keyword_only' };
    expect(codes(keywordOnly)).toEqual([]);
    expect(warned(keywordOnly)).toEqual(['content_safety_not_aliyun_green']);
    expect(codes(strict(keywordOnly))).toEqual(['content_safety_not_aliyun_green', 'content_safety_not_cn1_ready']);
  });

  it('topology failures always refuse; provider gaps refuse only under the strict switch', () => {
    const env = { ...GOOD, CN_ICP_NUMBER: '', ALLOWED_BRANDS: 'roboapply,goapply', CN_EMAIL_TRANSPORT: 'resend' };
    expect(codes(env)).toEqual(['intl_brand_on_mainland']);
    expect(warned(env)).toEqual(['icp_missing', 'cn_email_offshore']);
    expect(codes(strict(env))).toEqual(expect.arrayContaining(['icp_missing', 'intl_brand_on_mainland', 'cn_email_offshore']));
    for (const mode of [(e: Env) => e, strict]) {
      expect(codes(mode({ ...GOOD, DATABASE_URL: 'postgresql://u:p@ep-x.us-east-2.aws.neon.tech/db' }))).toEqual(['db_host_not_allowed']);
    }
  });

  it('a mistyped CN_EMAIL_TRANSPORT is read as Resend, as the email service reads it: warned, and refused under the strict switch', () => {
    for (const typo of ['aliyun', 'smtp']) {
      const env = { ...GOOD, CN_EMAIL_TRANSPORT: typo, RESEND_API_KEY: 're_test' };
      expect(codes(env)).toEqual([]);
      expect(warned(env)).toEqual(['cn_email_offshore']);
      expect(codes(strict(env))).toEqual(['cn_email_offshore']);
      expect(run(strict(env)).ok).toBe(false);
    }
  });

  it('requires the CronJob setup: CRON_SECRET set and node-cron off', () => {
    expect(codes({ ...GOOD, CRON_SECRET: ' ' })).toEqual(['cron_secret_missing']);
    expect(codes({ ...GOOD, ROBOAPPLY_CRON_DISABLED: undefined })).toEqual(['node_cron_enabled']);
    expect(codes({ ...GOOD, ROBOAPPLY_CRON_DISABLED: 'false' })).toEqual(['node_cron_enabled']);
    expect(codes({ ...GOOD, VERCEL: '1' })).toEqual(['vercel_env_set']);
  });

  it('warns (without refusing) about optional settings and residency facts it cannot prove', () => {
    const report = run({
      ...GOOD,
      INTERNAL_API_SECRET: undefined,
      CN_CANONICAL_ORIGIN: undefined,
      DATABASE_URL: 'postgresql://u:p@pgm-uf6abc.pg.rds.aliyuncs.com:5432/goapply',
    });
    expect(report.ok).toBe(true);
    expect(report.warnings).toEqual([
      expect.stringContaining('RegionId'),
      expect.stringContaining('INTERNAL_API_SECRET'),
      expect.stringContaining('CN_CANONICAL_ORIGIN'),
    ]);
  });

  it('never prints a secret value', () => {
    const env = strict({ ...GOOD, CN_ICP_NUMBER: '', CN_CONTENT_SAFETY_PROVIDER: 'keyword_only', ROBOAPPLY_CRON_DISABLED: 'no' });
    const text = preflight.formatReport(run(env)) as string;
    expect(text).toMatch(/^CN-1 preflight: REFUSED/);
    for (const name of ['CRON_SECRET', 'INTERNAL_API_SECRET', 'CN_S3_SECRET_ACCESS_KEY', 'ALIYUN_GREEN_ACCESS_KEY_SECRET']) {
      expect(text).not.toContain(GOOD[name]!);
    }
    expect(text).not.toContain('u:p@');
    expect(preflight.formatReport(run(GOOD))).toBe('CN-1 preflight: OK');
  });
});

describe('cron-call (CronJob command)', () => {
  const ok = (status: number, body = '{"ok":true}') =>
    vi.fn(async (_url: string, _init: RequestInit) => ({ status, text: async () => body }) as unknown as Response);

  it('sends the Bearer CRON_SECRET to the API Service and exits 0 on 2xx', async () => {
    const fetchImpl = ok(200);
    const lines: string[] = [];
    const code = await cronCall.callCron({
      path: '/api/v1/cron/jobs-ingest',
      env: { CRON_SECRET: 's3cret-value' },
      fetchImpl,
      log: (l: string) => lines.push(l),
    });
    expect(code).toBe(0);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('http://api:4607/api/v1/cron/jobs-ingest');
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer s3cret-value');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(lines.join('\n')).not.toContain('s3cret-value');
    expect(lines.join('\n')).toContain('answered 200');
  });

  it('honours CRON_API_URL and exits 1 on a non-2xx answer', async () => {
    const fetchImpl = ok(500, '{"ok":false}');
    const code = await cronCall.callCron({
      path: '/api/v1/cron/reminders',
      env: { CRON_SECRET: 'x', CRON_API_URL: 'http://localhost:4607/' },
      fetchImpl,
      log: () => {},
    });
    expect(code).toBe(1);
    expect(fetchImpl.mock.calls[0]![0]).toBe('http://localhost:4607/api/v1/cron/reminders');
    expect(await cronCall.callCron({ path: '/api/v1/cron/reminders', env: { CRON_SECRET: 'x' }, fetchImpl: ok(401), log: () => {} })).toBe(1);
  });

  it('exits 1 on a network error or timeout', async () => {
    const fail = vi.fn(async () => {
      throw Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    });
    const lines: string[] = [];
    const code = await cronCall.callCron({
      path: '/api/v1/cron/reminders',
      env: { CRON_SECRET: 'x', CRON_TIMEOUT_MS: '1000' },
      fetchImpl: fail,
      log: (l: string) => lines.push(l),
    });
    expect(code).toBe(1);
    expect(lines[0]).toContain('timed out after 1000 ms');
  });

  it('exits 2 without calling anything on a bad invocation', async () => {
    const fetchImpl = ok(200);
    expect(await cronCall.callCron({ path: '/api/v1/cron/reminders', env: {}, fetchImpl, log: () => {} })).toBe(2);
    expect(await cronCall.callCron({ path: '/api/v1/roboapply/auth/me', env: { CRON_SECRET: 'x' }, fetchImpl, log: () => {} })).toBe(2);
    expect(await cronCall.callCron({ path: undefined, env: { CRON_SECRET: 'x' }, fetchImpl, log: () => {} })).toBe(2);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('truncates long bodies in the log', async () => {
    const lines: string[] = [];
    await cronCall.callCron({ path: '/api/v1/cron/reminders', env: { CRON_SECRET: 'x' }, fetchImpl: ok(200, 'a'.repeat(5000)), log: (l: string) => lines.push(l) });
    expect(lines[0]!.length).toBeLessThan(2200);
  });
});
