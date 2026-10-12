// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  ResidencyStartupError,
  TOPOLOGY_FAILURE_CODES,
  allowedDbHostSuffixes,
  assertResidencyAtStartup,
  checkResidency,
  dbHostOf,
  isAllowedCnDbHost,
  resolveCnSelectorProvider,
} from './startupAssertions.js';

/** A mainland environment that passes every check. */
const GOOD = {
  NODE_ENV: 'production',
  DEPLOY_REGION: 'cn-mainland',
  CN_ICP_NUMBER: '沪ICP备00000000号-1',
  DATABASE_URL: 'postgresql://u:p@pgm-uf6abc.pg.rds.aliyuncs.com:5432/goapply?sslmode=require',
  ALLOWED_BRANDS: 'goapply',
  CN_LLM_PROVIDER: 'deepseek',
  CN_LLM_MODEL: 'deepseek-v4-flash',
  CN_LLM_FALLBACK_MODEL: 'qwen/qwen-plus',
  CN_S3_ENDPOINT: 'https://oss-cn-shanghai.aliyuncs.com',
  CN_S3_BUCKET: 'goapply-resumes',
  CN_S3_ACCESS_KEY_ID: 'id',
  CN_S3_SECRET_ACCESS_KEY: 'secret',
  CN_CONTENT_SAFETY_PROVIDER: 'aliyun_green',
  ALIYUN_GREEN_ACCESS_KEY_ID: 'green-id',
  ALIYUN_GREEN_ACCESS_KEY_SECRET: 'green-secret',
  CN_EMAIL_TRANSPORT: 'aliyun_dm',
};

type Env = Record<string, string | undefined>;

/** Failure codes: what refuses the boot. */
function codes(env: Env) {
  return [...new Set(checkResidency(env).failures.map((f) => f.code))];
}
/** Advisory codes: reported at boot, the deployment runs on the shared stack for that part. */
function advisories(env: Env) {
  return [...new Set(checkResidency(env).advisories.map((f) => f.code))];
}
/** The same environment under the strict mainland posture (an explicit operator choice). */
const strict = (env: Env): Env => ({ ...env, CN_RESIDENCY_STRICT: 'true' });

describe('offshore (DEPLOY_REGION unset)', () => {
  it('asserts nothing: the shared stack, which serves GoApply too', () => {
    expect(checkResidency({ NODE_ENV: 'production' })).toEqual({ region: 'offshore', strict: false, failures: [], advisories: [], warnings: [] });
    expect(checkResidency({ NODE_ENV: 'production', CN_RESIDENCY_STRICT: 'true' })).toMatchObject({ strict: true, failures: [], advisories: [] });
    expect(checkResidency({ ALLOWED_BRANDS: 'roboapply,goapply', CN_LLM_PROVIDER: 'openrouter' }).failures).toEqual([]);
    expect(() => assertResidencyAtStartup({})).not.toThrow();
  });

  it('refuses an unknown DEPLOY_REGION in any region', () => {
    expect(codes({ DEPLOY_REGION: 'cn_mainland' })).toEqual(['deploy_region_unknown']);
    expect(() => assertResidencyAtStartup({ DEPLOY_REGION: 'china' })).toThrow(ResidencyStartupError);
  });
});

describe('DEPLOY_REGION=cn-mainland: boots without China-specific providers (D5)', () => {
  /** A mainland deployment with a valid database and nothing China-specific: the shared stack. */
  const SHARED_ONLY: Env = {
    NODE_ENV: 'production',
    DEPLOY_REGION: 'cn-mainland',
    DATABASE_URL: 'postgresql://u:p@10.0.0.12:5432/goapply',
    ALLOWED_BRANDS: 'goapply',
    LLM_PROVIDER: 'openrouter',
    LLM_MODEL: 'openai/gpt-5',
    OPENROUTER_API_KEY: 'k',
    S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
    S3_BUCKET: 'shared',
    S3_ACCESS_KEY_ID: 'i',
    S3_SECRET_ACCESS_KEY: 's',
    RESEND_API_KEY: 're_test',
  };

  it('no CN_S3_*, CN_LLM_*, CN_ICP_NUMBER or Aliyun keys: no failure, every gap reported as an advisory', () => {
    const report = assertResidencyAtStartup(SHARED_ONLY);
    expect(report.region).toBe('cn-mainland');
    expect(report.strict).toBe(false);
    expect(report.failures).toEqual([]);
    expect(report.advisories.map((a) => a.code)).toEqual(['icp_missing', 'cn_storage_missing', 'content_safety_not_aliyun_green', 'cn_email_offshore']);
    expect(report.advisories.find((a) => a.code === 'cn_storage_missing')?.message).toContain('shared store');
    // The shared model stack is named too, so the log says where AI requests go.
    expect(report.warnings).toEqual([expect.stringContaining('shared model stack')]);
  });

  it('the same environment under CN_RESIDENCY_STRICT=true refuses to boot, with the same codes as failures', () => {
    expect(codes(strict(SHARED_ONLY))).toEqual(['icp_missing', 'cn_storage_missing', 'content_safety_not_aliyun_green', 'cn_email_offshore']);
    expect(checkResidency(strict(SHARED_ONLY)).advisories).toEqual([]);
    expect(() => assertResidencyAtStartup(strict(SHARED_ONLY))).toThrow(ResidencyStartupError);
  });

  it('a complete mainland configuration has neither failures nor advisories, strict or not', () => {
    for (const env of [GOOD, strict(GOOD)]) {
      const report = assertResidencyAtStartup(env);
      expect(report.region).toBe('cn-mainland');
      expect(report.failures).toEqual([]);
      expect(report.advisories).toEqual([]);
    }
  });

  it('each provider gap is an advisory by default and a failure under the strict switch', () => {
    const cases: Array<[Env, string]> = [
      [{ ...GOOD, CN_ICP_NUMBER: '' }, 'icp_missing'],
      [{ ...GOOD, CN_LLM_PROVIDER: 'openrouter', CN_LLM_MODEL: undefined, CN_LLM_FALLBACK_MODEL: undefined }, 'cn_llm_off_allowlist'],
      [{ ...GOOD, CN_S3_BUCKET: undefined }, 'cn_storage_missing'],
      [{ ...GOOD, CN_S3_ENDPOINT: 'https://s3.us-east-1.amazonaws.com' }, 'cn_storage_offshore'],
      [{ ...GOOD, CN_CONTENT_SAFETY_PROVIDER: 'keyword_only' }, 'content_safety_not_aliyun_green'],
      [{ ...GOOD, ALIYUN_GREEN_ACCESS_KEY_ID: undefined, ALIYUN_GREEN_ACCESS_KEY_SECRET: undefined }, 'content_safety_not_ready'],
      [{ ...GOOD, CN_EMAIL_TRANSPORT: 'resend' }, 'cn_email_offshore'],
    ];
    for (const [env, code] of cases) {
      expect(codes(env)).toEqual([]);
      expect(advisories(env)).toEqual([code]);
      expect(codes(strict(env))).toEqual([code]);
      expect(advisories(strict(env))).toEqual([]);
    }
  });

  it('email: unset means Resend now, flagged only when a key makes it real; none and aliyun_dm are never flagged', () => {
    const noTransport = { ...GOOD, CN_EMAIL_TRANSPORT: undefined };
    expect(advisories(noTransport)).toEqual([]);
    expect(advisories({ ...noTransport, RESEND_API_KEY: 're_test' })).toEqual(['cn_email_offshore']);
    expect(codes(strict({ ...noTransport, RESEND_API_KEY: 're_test' }))).toEqual(['cn_email_offshore']);
    expect(advisories({ ...GOOD, CN_EMAIL_TRANSPORT: 'none', RESEND_API_KEY: 're_test' })).toEqual([]);
    expect(advisories({ ...GOOD, RESEND_API_KEY: 're_test' })).toEqual([]);
  });

  it('email: a value that names no transport is read as Resend (the email service does), so a typo cannot hide the offshore route', () => {
    for (const typo of ['aliyun', 'smtp', ' Aliyun-DM ']) {
      const env = { ...GOOD, CN_EMAIL_TRANSPORT: typo, RESEND_API_KEY: 're_test' };
      expect(advisories(env)).toEqual(['cn_email_offshore']);
      expect(codes(env)).toEqual([]);
      // Under the strict switch the deployment does not boot with it.
      expect(codes(strict(env))).toEqual(['cn_email_offshore']);
      expect(checkResidency(env).advisories[0]?.message).toContain('names no transport');
      // Without a Resend key nothing can be sent through it: not flagged.
      expect(advisories({ ...GOOD, CN_EMAIL_TRANSPORT: typo })).toEqual([]);
    }
    // The two real mainland-safe values in any letter case are never flagged.
    expect(advisories({ ...GOOD, CN_EMAIL_TRANSPORT: 'Aliyun_DM', RESEND_API_KEY: 're_test' })).toEqual([]);
    expect(advisories({ ...GOOD, CN_EMAIL_TRANSPORT: 'NONE', RESEND_API_KEY: 're_test' })).toEqual([]);
  });

  it('TOPOLOGY_FAILURE_CODES are the checks the strict switch never touches', () => {
    expect([...TOPOLOGY_FAILURE_CODES].sort()).toEqual(['db_host_not_allowed', 'db_url_missing', 'deploy_region_unknown', 'intl_brand_on_mainland']);
  });
});

describe('DEPLOY_REGION=cn-mainland: topology checks always refuse', () => {
  it('warns (without refusing) that a default RDS suffix does not prove the region; private hosts and an explicit list do not warn', () => {
    // pgm-*.pg.rds.aliyuncs.com has the same shape in Singapore and Shanghai.
    expect(checkResidency(GOOD).warnings).toEqual([expect.stringContaining('RegionId')]);
    expect(checkResidency({ ...GOOD, DATABASE_URL: 'postgresql://u:p@172.16.3.4:5432/db' }).warnings).toEqual([]);
    expect(
      checkResidency({ ...GOOD, CN_ALLOWED_DB_HOST_SUFFIXES: 'pg.rds.aliyuncs.com' }).warnings,
    ).toEqual([]);
  });

  it('refuses a database host off the allowlist (e.g. Neon) and a missing DATABASE_URL, strict or not', () => {
    for (const mode of [(e: Env) => e, strict]) {
      expect(codes(mode({ ...GOOD, DATABASE_URL: 'postgresql://u:p@ep-x.us-east-2.aws.neon.tech/db' }))).toEqual(['db_host_not_allowed']);
      expect(codes(mode({ ...GOOD, DIRECT_DATABASE_URL: 'postgresql://u:p@db.example.com/db' }))).toEqual(['db_host_not_allowed']);
      expect(codes(mode({ ...GOOD, DATABASE_URL: undefined }))).toEqual(['db_url_missing']);
    }
  });

  it('allows private addresses and honours CN_ALLOWED_DB_HOST_SUFFIXES as a replacement list', () => {
    expect(codes({ ...GOOD, DATABASE_URL: 'postgresql://u:p@10.0.0.12:5432/db' })).toEqual([]);
    expect(codes({ ...GOOD, DATABASE_URL: 'postgresql://u:p@127.0.0.1:6432/db' })).toEqual([]);
    const custom = { ...GOOD, CN_ALLOWED_DB_HOST_SUFFIXES: 'db.goapply.internal', DATABASE_URL: 'postgresql://u:p@pg1.db.goapply.internal/db' };
    expect(codes(custom)).toEqual([]);
    expect(codes({ ...custom, DATABASE_URL: GOOD.DATABASE_URL })).toEqual(['db_host_not_allowed']);
  });

  it('refuses to serve roboapply on the mainland stack', () => {
    expect(codes({ ...GOOD, ALLOWED_BRANDS: 'roboapply,goapply' })).toEqual(['intl_brand_on_mainland']);
    expect(codes({ ...GOOD, ALLOWED_BRANDS: 'intl,cn' })).toEqual(['intl_brand_on_mainland']);
    // Unset ALLOWED_BRANDS means both brands, in every environment: RoboApply would be served.
    expect(codes({ ...GOOD, ALLOWED_BRANDS: undefined })).toEqual(['intl_brand_on_mainland']);
    // A scope that names no brand closes to RoboApply only (fail closed), which the mainland refuses: loud, not silent.
    expect(codes({ ...GOOD, ALLOWED_BRANDS: 'gopply' })).toEqual(['intl_brand_on_mainland']);
    expect(codes({ ...GOOD, ALLOWED_BRANDS: undefined, BRAND_LOCK: 'goapply' })).toEqual([]);
  });

  it('a topology failure refuses the boot even when every provider gap is only an advisory', () => {
    const env = { DEPLOY_REGION: 'cn-mainland', NODE_ENV: 'production' };
    try {
      assertResidencyAtStartup(env);
      throw new Error('expected a throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ResidencyStartupError);
      const e = err as ResidencyStartupError;
      expect(e.failures.map((f) => f.code)).toEqual(['db_url_missing', 'intl_brand_on_mainland']);
      expect(e.message).toContain('[db_url_missing]');
    }
    expect(advisories(env)).toEqual(['icp_missing', 'cn_storage_missing', 'content_safety_not_aliyun_green']);
  });
});

describe('DEPLOY_REGION=cn-mainland under CN_RESIDENCY_STRICT=true (the former rules)', () => {
  const GOOD_STRICT = strict(GOOD);

  it('refuses to boot without the ICP number', () => {
    expect(codes({ ...GOOD_STRICT, CN_ICP_NUMBER: '' })).toEqual(['icp_missing']);
  });

  it('refuses a CN model route outside the domestic allowlist', () => {
    expect(codes({ ...GOOD_STRICT, CN_LLM_PROVIDER: 'openrouter' })).toEqual(['cn_llm_off_allowlist']);
    // Every unpinned selector follows the provider: each one is reported.
    expect(
      checkResidency({ ...GOOD_STRICT, CN_LLM_PROVIDER: 'openrouter' }).failures.map((f) => f.message.split(' ')[0]),
      // CN_LLM_FALLBACK_MODEL ('qwen/qwen-plus') carries its own prefix, which
      // WP-14 maps to DashScope (domestic), so it no longer follows CN_LLM_PROVIDER.
    ).toEqual(['CN_LLM_PROVIDER', 'CN_LLM_MODEL']);
    expect(codes({ ...GOOD_STRICT, CN_LLM_COPILOT_MODEL: 'anthropic/claude-x' })).toEqual(['cn_llm_off_allowlist']);
    expect(codes({ ...GOOD_STRICT, CN_RA_MODEL_TAILOR: 'openai/gpt-x' })).toEqual(['cn_llm_off_allowlist']);
    // A domestic provider pointed at an offshore base URL is refused too.
    expect(codes({ ...GOOD_STRICT, CN_LLM_PROVIDER: 'newapi', NEWAPI_BASE_URL: 'https://gateway.example.com/v1' })).toEqual([
      'cn_llm_off_allowlist',
    ]);
    expect(codes({ ...GOOD_STRICT, CN_LLM_PROVIDER: 'newapi', NEWAPI_BASE_URL: 'https://dashscope.aliyuncs.com/compatible-mode/v1' })).toEqual([]);
    // Routing modes are not providers: in direct mode an unprefixed model
    // (with no prefixed default) and a prefix LLMService does not know
    // (qwen/… today) both go to OpenRouter, so they fail.
    expect(codes({ ...GOOD_STRICT, CN_LLM_PROVIDER: 'direct' })).toEqual(['cn_llm_off_allowlist']);
    // Default-suffixed selectors with a domestic provider stay allowed.
    expect(codes({ ...GOOD_STRICT, CN_LLM_PROVIDER: 'direct', CN_LLM_MODEL: 'deepseek/deepseek-v4-flash', CN_LLM_FALLBACK_MODEL: 'kimi/kimi-k2' })).toEqual([]);
    // No CN model at all is fine: behind the wall GoApply AI is simply off.
    expect(codes({ ...GOOD_STRICT, CN_LLM_PROVIDER: undefined, CN_LLM_MODEL: undefined, CN_LLM_FALLBACK_MODEL: undefined })).toEqual([]);
  });

  it('resolves selectors the way LLMService does and fails closed on anything off the domestic list', () => {
    const DIRECT = { ...GOOD_STRICT, CN_LLM_FALLBACK_MODEL: undefined };
    // Review probes: each of these booted before the fix.
    // Direct mode + an unknown prefix → OpenRouter.
    expect(codes({ ...DIRECT, CN_LLM_PROVIDER: 'direct', CN_LLM_MODEL: 'mistralai/mistral-large' })).toEqual(['cn_llm_off_allowlist']);
    // No provider and no prefix → LLMService's default provider, OpenRouter.
    expect(codes({ ...DIRECT, CN_LLM_PROVIDER: undefined, CN_LLM_MODEL: 'gpt-4o' })).toEqual(['cn_llm_off_allowlist']);
    // Multi-word task settings are checked too.
    expect(codes({ ...DIRECT, CN_LLM_INTERVIEW_LIVE_MODEL: 'openrouter/openai/gpt-5' })).toEqual(['cn_llm_off_allowlist']);
    expect(codes({ ...DIRECT, CN_LLM_INTERVIEW_BLUEPRINT_MODEL: 'openai/gpt-5' })).toEqual(['cn_llm_off_allowlist']);
    // Local Ollama is not a domestic vendor.
    expect(codes({ ...DIRECT, CN_LLM_MODEL: 'ollama/llama3' })).toEqual(['cn_llm_off_allowlist']);
    // gemini/ is an alias for google.
    expect(codes({ ...DIRECT, CN_RA_MODEL_MATCH: 'gemini/gemini-3-flash' })).toEqual(['cn_llm_off_allowlist']);
    // With a domestic CN_LLM_PROVIDER, an unpinned selector is sent to that provider.
    expect(codes({ ...DIRECT, CN_LLM_PROVIDER: 'deepseek', CN_LLM_MODEL: 'gpt-4o' })).toEqual([]);
  });

  it('requires the CN bucket and refuses one that points at the shared bucket', () => {
    expect(codes({ ...GOOD_STRICT, CN_S3_BUCKET: undefined })).toEqual(['cn_storage_missing']);
    expect(codes({ ...GOOD_STRICT, S3_ENDPOINT: GOOD.CN_S3_ENDPOINT })).toEqual(['cn_storage_offshore']);
    // The shared bucket never counts as GoApply's own.
    expect(codes({ ...GOOD_STRICT, CN_S3_BUCKET: undefined, S3_BUCKET: 'shared', S3_ACCESS_KEY_ID: 'i', S3_SECRET_ACCESS_KEY: 's' })).toEqual(['cn_storage_missing']);
  });

  it('refuses a CN bucket endpoint that is not mainland object storage', () => {
    // Review probe: a US AWS endpoint used to boot and resolve storage to s3.
    expect(codes({ ...GOOD_STRICT, CN_S3_ENDPOINT: 'https://s3.us-east-1.amazonaws.com' })).toEqual(['cn_storage_offshore']);
    // Aliyun OSS Singapore is not mainland.
    expect(codes({ ...GOOD_STRICT, CN_S3_ENDPOINT: 'https://oss-ap-southeast-1.aliyuncs.com' })).toEqual(['cn_storage_offshore']);
    expect(codes({ ...GOOD_STRICT, CN_S3_ENDPOINT: 'https://cos.ap-singapore.myqcloud.com' })).toEqual(['cn_storage_offshore']);
    // Mainland regions, in-cluster MinIO and an operator-listed host pass.
    expect(codes({ ...GOOD_STRICT, CN_S3_ENDPOINT: 'https://cos.ap-guangzhou.myqcloud.com' })).toEqual([]);
    expect(codes({ ...GOOD_STRICT, CN_S3_ENDPOINT: 'https://obs.cn-east-3.myhuaweicloud.com' })).toEqual([]);
    expect(codes({ ...GOOD_STRICT, CN_S3_ENDPOINT: 'http://10.1.2.3:9000' })).toEqual([]);
    expect(
      codes({ ...GOOD_STRICT, CN_S3_ENDPOINT: 'https://minio.goapply.internal', CN_ALLOWED_STORAGE_HOST_SUFFIXES: 'goapply.internal' }),
    ).toEqual([]);
  });

  it('requires Aliyun Green content safety and refuses offshore email', () => {
    expect(codes({ ...GOOD_STRICT, CN_CONTENT_SAFETY_PROVIDER: 'keyword_only' })).toEqual(['content_safety_not_aliyun_green']);
    expect(codes({ ...GOOD_STRICT, CN_EMAIL_TRANSPORT: 'resend' })).toEqual(['cn_email_offshore']);
  });

  it('requires Aliyun Green to be usable, not just chosen (WP-76 request, Wave 5 gate)', () => {
    const noKeys = { ...GOOD_STRICT, ALIYUN_GREEN_ACCESS_KEY_ID: undefined, ALIYUN_GREEN_ACCESS_KEY_SECRET: undefined };
    expect(codes(noKeys)).toEqual(['content_safety_not_ready']);
    expect(checkResidency(noKeys).failures.find((f) => f.code === 'content_safety_not_ready')?.message).toContain('ALIYUN_GREEN_ACCESS_KEY_ID');
    expect(codes({ ...GOOD_STRICT, ALIYUN_GREEN_REGION: 'ap-southeast-1' })).toEqual(['content_safety_not_ready']);
  });

  it('lists every failure at once in the thrown error', () => {
    try {
      assertResidencyAtStartup({ DEPLOY_REGION: 'cn-mainland', NODE_ENV: 'production', CN_RESIDENCY_STRICT: 'true' });
      throw new Error('expected a throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ResidencyStartupError);
      const e = err as ResidencyStartupError;
      expect(e.failures.map((f) => f.code)).toEqual([
        'icp_missing',
        'db_url_missing',
        'intl_brand_on_mainland',
        'cn_storage_missing',
        'content_safety_not_aliyun_green',
      ]);
      expect(e.message).toContain('[icp_missing]');
    }
  });
});

describe('helpers', () => {
  it('reads DB hosts and suffix lists', () => {
    expect(dbHostOf('postgresql://u:p@host.rds.aliyuncs.com:5432/db')).toBe('host.rds.aliyuncs.com');
    expect(dbHostOf('not a url')).toBeNull();
    expect(allowedDbHostSuffixes({})).toContain('rds.aliyuncs.com');
    expect(allowedDbHostSuffixes({ CN_ALLOWED_DB_HOST_SUFFIXES: '.a.cn, b.cn' })).toEqual(['a.cn', 'b.cn']);
    expect(isAllowedCnDbHost('x.tencentcdb.com', {})).toBe(true);
    expect(isAllowedCnDbHost('rds.aliyuncs.com.evil.com', {})).toBe(false);
  });

  it('resolves CN selectors to the provider LLMService would call', () => {
    expect(resolveCnSelectorProvider('deepseek/deepseek-v4-pro', {})).toBe('deepseek');
    expect(resolveCnSelectorProvider('openrouter/deepseek/deepseek-v4-pro', { CN_LLM_PROVIDER: 'deepseek' })).toBe('openrouter');
    expect(resolveCnSelectorProvider('mistralai/mistral-large', { CN_LLM_PROVIDER: 'direct' })).toBe('openrouter');
    expect(resolveCnSelectorProvider('mistralai/mistral-large', { CN_LLM_PROVIDER: 'kimi' })).toBe('kimi');
    expect(resolveCnSelectorProvider('deepseek-v4-flash', { CN_LLM_PROVIDER: 'direct', CN_LLM_MODEL: 'deepseek/deepseek-v4-pro' })).toBe('deepseek');
    expect(resolveCnSelectorProvider('gpt-4o', {})).toBe('openrouter');
  });
});
