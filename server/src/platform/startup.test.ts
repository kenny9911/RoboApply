// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

import { isEnabledForBrand, setVoiceAvailabilityProbe, setWechatPayReadinessProbe } from './flags.js';
import { BRANDS } from './brand/registry.js';
import { ResidencyStartupError } from './residency/index.js';
import { AssistantModelStartupError, StrictStorageGroupStartupError, copilotBrands, runStartupAssertions, type StartupLog } from './startup.js';

afterEach(() => {
  setVoiceAvailabilityProbe(null);
  setWechatPayReadinessProbe(null);
  vi.unstubAllEnvs();
});

function log(): StartupLog & { warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const okResidency = () => ({ region: 'offshore', failures: [], warnings: [] }) as never;
const okTools = () => [];

describe('runStartupAssertions', () => {
  it('passes with the default (offshore) environment and logs nothing', () => {
    const l = log();
    runStartupAssertions({ env: {} as NodeJS.ProcessEnv, log: l, copilotTools: okTools });
    expect(l.warn).not.toHaveBeenCalled();
    expect(l.error).not.toHaveBeenCalled();
  });

  it('refuses to boot on a residency failure: exits 1 off Vercel', () => {
    const l = log();
    const exit = vi.fn() as unknown as (code: number) => never;
    const failing = () => {
      throw new ResidencyStartupError([{ code: 'icp_missing', message: 'CN_ICP_NUMBER is not set' }] as never);
    };
    expect(() => runStartupAssertions({ env: {} as NodeJS.ProcessEnv, log: l, exit, residency: failing, copilotTools: okTools })).toThrow(
      ResidencyStartupError,
    );
    expect(exit).toHaveBeenCalledWith(1);
    expect(l.error).toHaveBeenCalledWith('STARTUP', expect.stringContaining('icp_missing'), { failures: ['icp_missing'] });
  });

  it('on Vercel the failure is thrown (module init fails) without process.exit', () => {
    const exit = vi.fn() as unknown as (code: number) => never;
    const failing = () => {
      throw new ResidencyStartupError([{ code: 'db_url_missing', message: 'DATABASE_URL is not set' }] as never);
    };
    expect(() =>
      runStartupAssertions({ env: { VERCEL: '1' } as NodeJS.ProcessEnv, log: log(), exit, residency: failing, copilotTools: okTools }),
    ).toThrow(ResidencyStartupError);
    expect(exit).not.toHaveBeenCalled();
  });

  it('a real cn-mainland topology error is refused (no database URL, RoboApply would be served)', () => {
    const exit = vi.fn() as unknown as (code: number) => never;
    expect(() =>
      runStartupAssertions({ env: { DEPLOY_REGION: 'cn-mainland' } as NodeJS.ProcessEnv, log: log(), exit, copilotTools: okTools }),
    ).toThrow(ResidencyStartupError);
    expect(exit).toHaveBeenCalledWith(1);
  });

  /** A mainland deployment with a valid database URL and nothing China-specific: GoApply on the shared stack. */
  const MAINLAND_SHARED = {
    NODE_ENV: 'production',
    DEPLOY_REGION: 'cn-mainland',
    DATABASE_URL: 'postgresql://u:p@10.0.0.12:5432/goapply',
    ALLOWED_BRANDS: 'goapply',
    LLM_PROVIDER: 'openrouter',
    LLM_MODEL: 'openai/gpt-5',
    S3_BUCKET: 'shared',
    S3_ACCESS_KEY_ID: 'i',
    S3_SECRET_ACCESS_KEY: 's',
  } as NodeJS.ProcessEnv;

  it('a mainland deployment without CN_S3_*, CN_LLM_*, CN_ICP_NUMBER or Aliyun keys boots, with each gap in the log as a warning', () => {
    const l = log();
    const copilotTools = vi.fn((o: { brands: string[] }) => o.brands.map(fine));
    expect(() => runStartupAssertions({ env: MAINLAND_SHARED, log: l, exit: neverExit, copilotTools: copilotTools as never })).not.toThrow();
    expect(l.error).not.toHaveBeenCalled();
    const warned = l.warn.mock.calls.map((c) => String(c[1]));
    for (const code of ['icp_missing', 'cn_storage_missing', 'content_safety_not_aliyun_green']) {
      expect(warned.some((line) => line.startsWith(`Residency: [${code}]`))).toBe(true);
    }
    expect(l.warn).toHaveBeenCalledWith('STARTUP', expect.stringContaining('[cn_storage_missing]'), { region: 'cn-mainland', code: 'cn_storage_missing' });
    // GoApply is served, so its Assistant model is checked.
    expect(copilotTools).toHaveBeenCalledWith({ brands: ['goapply'], throwOnError: false });
  });

  it('the same deployment with CN_RESIDENCY_STRICT=true exits 1, as before the parity wave', () => {
    const l = log();
    const exit = vi.fn() as unknown as (code: number) => never;
    let thrown: unknown;
    try {
      runStartupAssertions({ env: { ...MAINLAND_SHARED, CN_RESIDENCY_STRICT: 'true' } as NodeJS.ProcessEnv, log: l, exit, copilotTools: okTools });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ResidencyStartupError);
    expect((thrown as ResidencyStartupError).failures.map((f) => f.code)).toEqual(['icp_missing', 'cn_storage_missing', 'content_safety_not_aliyun_green']);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('logs residency warnings and copilot-tool problems without blocking boot outside production', () => {
    const l = log();
    runStartupAssertions({
      env: {} as NodeJS.ProcessEnv,
      log: l,
      residency: () => ({ region: 'cn-mainland', failures: [], warnings: ['check the RDS RegionId'] }) as never,
      copilotTools: () =>
        [
          { brand: 'roboapply', ok: false, problem: 'provider "anthropic" cannot stream tool calls', route: { selector: 'anthropic/claude' } },
          { brand: 'goapply', ok: true, skipped: 'no domestic model configured (AI hidden)', route: { selector: null } },
        ] as never,
    });
    expect(l.warn).toHaveBeenCalledWith('STARTUP', 'Residency: check the RDS RegionId', { region: 'cn-mainland' });
    expect(l.warn).toHaveBeenCalledWith('STARTUP', expect.stringContaining('roboapply'), { brand: 'roboapply', selector: 'anthropic/claude' });
    expect(l.warn).toHaveBeenCalledTimes(2);
    expect(l.error).not.toHaveBeenCalled();
  });

  it('a crash inside the copilot check is logged, never thrown', () => {
    const l = log();
    const boom = () => {
      throw new Error('boom');
    };
    runStartupAssertions({ env: {} as NodeJS.ProcessEnv, log: l, residency: okResidency, copilotTools: boom });
    expect(l.warn).toHaveBeenCalledWith('STARTUP', 'Assistant model check could not run', { error: 'boom' });
    // In production it is an error line, but a fault in the check is not evidence about the model.
    const p = log();
    expect(() => runStartupAssertions({ env: PROD, log: p, residency: okResidency, copilotTools: boom, exit: neverExit })).not.toThrow();
    expect(p.error).toHaveBeenCalledWith('STARTUP', 'Assistant model check could not run', { error: 'boom' });
  });
});

const PROD = { NODE_ENV: 'production' } as NodeJS.ProcessEnv;
const neverExit = (() => {
  throw new Error('exit must not be called');
}) as (code: number) => never;

const toolless = (brand: string) =>
  ({ brand, ok: false, problem: 'provider "anthropic" cannot stream tool calls', route: { selector: 'anthropic/claude-sonnet' } }) as never;
const fine = (brand: string) => ({ brand, ok: true, route: { selector: 'openai/gpt' } }) as never;

describe('Assistant model check (WP-93: blocking in production for brands with the copilot capability)', () => {
  it('production with no deployment scope checks BOTH brands: a tool-less model refuses to boot (exit 1 off Vercel)', () => {
    const l = log();
    const exit = vi.fn() as unknown as (code: number) => never;
    const copilotTools = vi.fn((options?: { brands?: string[] }) => (options?.brands ?? []).map(toolless));
    let thrown: unknown;
    try {
      runStartupAssertions({ env: PROD, log: l, exit, residency: okResidency, copilotTools: copilotTools as never, copilotEnabled: () => true });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AssistantModelStartupError);
    const error = thrown as AssistantModelStartupError;
    expect(error.code).toBe('assistant_model_unusable');
    // Every deployment serves both brands unless ALLOWED_BRANDS / BRAND_LOCK narrows it (D5).
    expect(error.failures).toEqual([
      { brand: 'roboapply', problem: 'provider "anthropic" cannot stream tool calls', selector: 'anthropic/claude-sonnet' },
      { brand: 'goapply', problem: 'provider "anthropic" cannot stream tool calls', selector: 'anthropic/claude-sonnet' },
    ]);
    expect(error.message).toContain('FLAG_<BRAND>_COPILOT=false');
    expect(exit).toHaveBeenCalledWith(1);
    expect(l.error).toHaveBeenCalledWith('STARTUP', expect.stringContaining('roboapply: provider "anthropic" cannot stream tool calls'), { brands: ['roboapply', 'goapply'] });
    // Only served brands with the capability are asked about; the check never throws by itself.
    expect(copilotTools).toHaveBeenCalledWith({ brands: ['roboapply', 'goapply'], throwOnError: false });
  });

  it('a deployment narrowed to RoboApply checks RoboApply only', () => {
    const exit = vi.fn() as unknown as (code: number) => never;
    const copilotTools = vi.fn((options?: { brands?: string[] }) => (options?.brands ?? []).map(toolless));
    let thrown: unknown;
    try {
      runStartupAssertions({
        env: { ...PROD, ALLOWED_BRANDS: 'roboapply' } as NodeJS.ProcessEnv,
        log: log(),
        exit,
        residency: okResidency,
        copilotTools: copilotTools as never,
        copilotEnabled: () => true,
      });
    } catch (err) {
      thrown = err;
    }
    expect((thrown as AssistantModelStartupError).failures).toEqual([
      { brand: 'roboapply', problem: 'provider "anthropic" cannot stream tool calls', selector: 'anthropic/claude-sonnet' },
    ]);
    expect(copilotTools).toHaveBeenCalledWith({ brands: ['roboapply'], throwOnError: false });
  });

  it('on Vercel the failure is thrown (module init fails) without process.exit', () => {
    const exit = vi.fn() as unknown as (code: number) => never;
    expect(() =>
      runStartupAssertions({
        env: { ...PROD, VERCEL: '1' } as NodeJS.ProcessEnv,
        log: log(),
        exit,
        residency: okResidency,
        copilotTools: ((o: { brands: string[] }) => o.brands.map(toolless)) as never,
        copilotEnabled: () => true,
      }),
    ).toThrow(AssistantModelStartupError);
    expect(exit).not.toHaveBeenCalled();
  });

  it('production + capability off → boots, and the model is not even checked', () => {
    const l = log();
    const copilotTools = vi.fn(() => [toolless('roboapply')]);
    runStartupAssertions({ env: PROD, log: l, exit: neverExit, residency: okResidency, copilotTools: copilotTools as never, copilotEnabled: () => false });
    expect(copilotTools).not.toHaveBeenCalled();
    expect(l.warn).not.toHaveBeenCalled();
    expect(l.error).not.toHaveBeenCalled();
  });

  it('the capability comes from the flag resolver: FLAG_<BRAND>_COPILOT=false skips that brand', () => {
    // GoApply's Assistant is on without a domestic model: it runs on the shared one (D5).
    expect(isEnabledForBrand('copilot', BRANDS.goapply, PROD)).toBe(true);
    expect(copilotBrands(PROD)).toEqual(['roboapply', 'goapply']);
    expect(copilotBrands({ ...PROD, ALLOWED_BRANDS: 'roboapply,goapply' } as NodeJS.ProcessEnv)).toEqual(['roboapply', 'goapply']);
    // Each brand has its own off switch.
    expect(copilotBrands({ ...PROD, FLAG_GOAPPLY_COPILOT: 'false' } as NodeJS.ProcessEnv)).toEqual(['roboapply']);
    expect(copilotBrands({ ...PROD, FLAG_ROBOAPPLY_COPILOT: 'false' } as NodeJS.ProcessEnv)).toEqual(['goapply']);
    expect(copilotBrands({ ...PROD, FLAG_ROBOAPPLY_COPILOT: 'false', FLAG_GOAPPLY_COPILOT: 'false' } as NodeJS.ProcessEnv)).toEqual([]);
    // A brand this deployment does not serve is never checked.
    expect(copilotBrands({ ...PROD, ALLOWED_BRANDS: 'roboapply' } as NodeJS.ProcessEnv)).toEqual(['roboapply']);
    expect(copilotBrands({ ...PROD, BRAND_LOCK: 'goapply' } as NodeJS.ProcessEnv)).toEqual(['goapply']);

    const copilotTools = vi.fn((o: { brands: string[] }) => o.brands.map(toolless));
    // Both switched off: a tool-less model no longer blocks the boot, and nothing is checked.
    runStartupAssertions({
      env: { ...PROD, FLAG_ROBOAPPLY_COPILOT: 'false', FLAG_GOAPPLY_COPILOT: 'false' } as NodeJS.ProcessEnv,
      log: log(),
      exit: neverExit,
      residency: okResidency,
      copilotTools: copilotTools as never,
    });
    expect(copilotTools).not.toHaveBeenCalled();
    // GoApply switched off: the same model refuses to boot, and only RoboApply is named.
    expect(() =>
      runStartupAssertions({
        env: { ...PROD, VERCEL: '1', FLAG_GOAPPLY_COPILOT: 'false' } as NodeJS.ProcessEnv,
        log: log(),
        residency: okResidency,
        copilotTools: copilotTools as never,
      }),
    ).toThrow(/roboapply: provider "anthropic"/);
    expect(copilotTools).toHaveBeenCalledWith({ brands: ['roboapply'], throwOnError: false });
  });

  it('production + capability on + a tool-capable model → boots quietly', () => {
    const l = log();
    runStartupAssertions({
      env: PROD,
      log: l,
      exit: neverExit,
      residency: okResidency,
      copilotTools: ((o: { brands: string[] }) => o.brands.map(fine)) as never,
      copilotEnabled: () => true,
    });
    expect(l.warn).not.toHaveBeenCalled();
    expect(l.error).not.toHaveBeenCalled();
  });

  it.each(['development', 'test', undefined])('NODE_ENV=%s + tool-less model → a warning only', (nodeEnv) => {
    const l = log();
    runStartupAssertions({
      env: (nodeEnv ? { NODE_ENV: nodeEnv } : {}) as NodeJS.ProcessEnv,
      log: l,
      exit: neverExit,
      residency: okResidency,
      copilotTools: ((o: { brands: string[] }) => o.brands.map(toolless)) as never,
      copilotEnabled: () => true,
    });
    expect(l.warn).toHaveBeenCalledWith('STARTUP', expect.stringContaining('cannot be used'), expect.objectContaining({ selector: 'anthropic/claude-sonnet' }));
    expect(l.error).not.toHaveBeenCalled();
  });

  it('the real check boots without any copilot model outside production (npm run dev, tests importing app.ts)', () => {
    const l = log();
    for (const name of ['LLM_COPILOT_MODEL', 'CN_LLM_COPILOT_MODEL', 'LLM_MODEL', 'LLM_PROVIDER', 'NODE_ENV']) vi.stubEnv(name, name === 'NODE_ENV' ? 'test' : '');
    expect(() => runStartupAssertions({ env: process.env, log: l, exit: neverExit, residency: okResidency })).not.toThrow();
    expect(l.error).not.toHaveBeenCalled();
  });
});

describe('WeChat Pay readiness probe', () => {
  it('startup registers wechatPayReadiness behind pay.wechatpay', () => {
    // CN_PAYMENTS_ENABLED is a kill switch now: unset means on, a false value stops both CN rails.
    const env = {
      WECHATPAY_MCH_ID: '1900000001',
      WECHATPAY_APP_ID: 'wx1234567890abcdef',
      WECHATPAY_API_V3_KEY: 'k'.repeat(32),
      WECHATPAY_MCH_CERT_SERIAL: 'SERIAL01',
      WECHATPAY_MCH_PRIVATE_KEY: 'merchant-private-key-pem',
      WECHATPAY_PUBLIC_KEY: 'wechatpay-public-key-pem',
      WECHATPAY_PUBLIC_KEY_ID: 'PUB_KEY_ID_01',
      CN_PAYMENT_COLLECTING_ENTITY: '示例（上海）科技有限公司',
      WECHATPAY_MERCHANT_ENTITY: '示例(上海)科技有限公司',
    };
    runStartupAssertions({ env: {} as NodeJS.ProcessEnv, log: log(), residency: okResidency, copilotTools: okTools });
    expect(isEnabledForBrand('pay.wechatpay', BRANDS.goapply, env)).toBe(true);
    expect(isEnabledForBrand('pay.wechatpay', BRANDS.goapply, { ...env, WECHATPAY_MERCHANT_ENTITY: '另一家有限公司' })).toBe(false);
    expect(isEnabledForBrand('pay.wechatpay', BRANDS.goapply, { ...env, CN_PAYMENTS_ENABLED: 'true' })).toBe(true);
    expect(isEnabledForBrand('pay.wechatpay', BRANDS.goapply, { ...env, CN_PAYMENTS_ENABLED: 'false' })).toBe(false);
    expect(isEnabledForBrand('pay.wechatpay', BRANDS.roboapply, env)).toBe(false);
  });
});

describe('voice capability probe', () => {
  it('startup registers voiceAvailable behind ai.interviewVoice', () => {
    for (const name of ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET']) vi.stubEnv(name, 'x');
    vi.stubEnv('VOICE_PROVIDER', 'volcano');
    vi.stubEnv('FLAG_ROBOAPPLY_INTERVIEW_VOICE', '');
    vi.stubEnv('FLAG_ROBOAPPLY_AI_INTERVIEW_VOICE', '');
    runStartupAssertions({ env: {} as NodeJS.ProcessEnv, log: log(), residency: okResidency, copilotTools: okTools });
    // The engine's answer (reserved provider → no voice) is what the flag reports.
    expect(isEnabledForBrand('ai.interviewVoice', BRANDS.roboapply, process.env)).toBe(false);
    vi.stubEnv('VOICE_PROVIDER', 'livekit_cloud');
    expect(isEnabledForBrand('ai.interviewVoice', BRANDS.roboapply, process.env)).toBe(true);
  });
});

describe('configuration problems are reported at boot, never silent (PAR-1 requests P5-6)', () => {
  const run = (env: Record<string, string>) => {
    const l = log();
    runStartupAssertions({ env: env as NodeJS.ProcessEnv, log: l, exit: neverExit, residency: okResidency, copilotTools: okTools });
    return l;
  };
  const lines = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls.map((c) => String(c[1]));

  it('a clean environment logs nothing', () => {
    const l = run({ S3_BUCKET: 'shared', LIVEKIT_URL: 'wss://x.livekit.cloud', CN_RECRUITMENT_INFO_MODE: 'off', CN_STORAGE_MODE: 'redact', ALLOWED_BRANDS: 'roboapply,goapply' });
    expect(l.warn).not.toHaveBeenCalled();
    expect(l.error).not.toHaveBeenCalled();
  });

  it('ALLOWED_BRANDS / BRAND_LOCK naming no brand: an error line with the tokens and what is served', () => {
    const l = run({ ALLOWED_BRANDS: 'roboaply' });
    expect(l.error).toHaveBeenCalledWith(
      'STARTUP',
      'ALLOWED_BRANDS / BRAND_LOCK names no brand: ALLOWED_BRANDS="roboaply". This deployment serves roboapply only.',
      { invalid: [{ variable: 'ALLOWED_BRANDS', token: 'roboaply' }], serves: ['roboapply'], failedClosed: true },
    );
    // A partly wrong list is narrowed, and the bad token is still named.
    const partly = run({ ALLOWED_BRANDS: 'goapply,gopply' });
    expect(lines(partly.error)).toEqual(['ALLOWED_BRANDS / BRAND_LOCK has a value that is not a brand: ALLOWED_BRANDS="gopply". It is ignored; this deployment serves goapply.']);
  });

  it('a half-set GoApply group: one warning per group, naming the variables and the missing anchor', () => {
    const l = run({
      CN_S3_ENDPOINT: 'https://oss-cn-shanghai.aliyuncs.com',
      CN_S3_ACCESS_KEY_ID: 'cn-id-value',
      CN_LIVEKIT_API_KEY: 'lk-key-value',
      CN_VAPID_PRIVATE_KEY: 'vapid-private-value',
    });
    expect(lines(l.warn)).toEqual([
      'GoApply voice settings CN_LIVEKIT_API_KEY are ignored because CN_LIVEKIT_URL is not set; GoApply uses the shared voice stack.',
      'GoApply storage settings CN_S3_ENDPOINT, CN_S3_ACCESS_KEY_ID are ignored because CN_S3_BUCKET is not set; GoApply uses the shared storage stack.',
      'GoApply push settings CN_VAPID_PRIVATE_KEY are ignored because CN_VAPID_PUBLIC_KEY is not set; GoApply uses the shared push stack.',
    ]);
    expect(l.warn).toHaveBeenCalledWith('STARTUP', expect.stringContaining('GoApply storage settings'), {
      group: 'storage',
      set: ['CN_S3_ENDPOINT', 'CN_S3_ACCESS_KEY_ID'],
      missingAnchors: ['CN_S3_BUCKET'],
    });
    // Names only: no value of any variable reaches the log.
    const everything = JSON.stringify([l.warn.mock.calls, l.error.mock.calls]);
    for (const secret of ['cn-id-value', 'lk-key-value', 'vapid-private-value']) expect(everything).not.toContain(secret);
    expect(l.error).not.toHaveBeenCalled();
  });

  it('under CN_RESIDENCY_STRICT a half-set storage group refuses the boot: GoApply would silently use the shared bucket', () => {
    const l = log();
    const exit = vi.fn() as unknown as (code: number) => never;
    const env = { CN_RESIDENCY_STRICT: 'true', CN_S3_ENDPOINT: 'https://oss-cn-shanghai.aliyuncs.com', CN_LIVEKIT_API_KEY: 'k' } as NodeJS.ProcessEnv;
    let thrown: unknown;
    try {
      runStartupAssertions({ env, log: l, exit, residency: okResidency, copilotTools: okTools });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(StrictStorageGroupStartupError);
    expect((thrown as StrictStorageGroupStartupError).code).toBe('cn_storage_group_incomplete');
    expect((thrown as StrictStorageGroupStartupError).problem).toEqual({ group: 'storage', set: ['CN_S3_ENDPOINT'], missingAnchors: ['CN_S3_BUCKET'] });
    expect(exit).toHaveBeenCalledWith(1);
    expect(l.error).toHaveBeenCalledWith('STARTUP', expect.stringContaining('CN_RESIDENCY_STRICT is on'), expect.objectContaining({ group: 'storage' }));
    // A half-set voice group alone stays a warning under the strict switch.
    const voiceOnly = log();
    runStartupAssertions({ env: { CN_RESIDENCY_STRICT: 'true', CN_LIVEKIT_API_KEY: 'k' } as NodeJS.ProcessEnv, log: voiceOnly, exit: neverExit, residency: okResidency, copilotTools: okTools });
    expect(lines(voiceOnly.warn)).toEqual([expect.stringContaining('GoApply voice settings')]);
    // On Vercel the failure is thrown without process.exit.
    const onVercel = vi.fn() as unknown as (code: number) => never;
    expect(() =>
      runStartupAssertions({ env: { ...env, VERCEL: '1' } as NodeJS.ProcessEnv, log: log(), exit: onVercel, residency: okResidency, copilotTools: okTools }),
    ).toThrow(StrictStorageGroupStartupError);
    expect(onVercel).not.toHaveBeenCalled();
  });

  it('an unknown CN_RECRUITMENT_INFO_MODE value: an error line saying the job feed is ON', () => {
    const l = run({ CN_RECRUITMENT_INFO_MODE: 'false' });
    expect(l.error).toHaveBeenCalledWith('STARTUP', 'unknown CN_RECRUITMENT_INFO_MODE value "false"; the job feed is ON. Use off to close it.', { value: 'false' });
  });

  it('an unknown CN_STORAGE_MODE value: an error line saying it is read as discard', () => {
    const l = run({ CN_STORAGE_MODE: 'redcat' });
    expect(lines(l.error)).toEqual([expect.stringMatching(/^unknown CN_STORAGE_MODE value "redcat"; it is read as discard/)]);
  });

  it('an unknown CN_SIGNUP_MODE value: an error line saying sign-up is OPEN (the sign-up policy decides what is unknown)', async () => {
    const l = log();
    const signupModeProblem = vi.fn((env: NodeJS.ProcessEnv) => (env.CN_SIGNUP_MODE === 'invte' ? 'invte' : null));
    const go = (env: Record<string, string>) =>
      runStartupAssertions({ env: env as NodeJS.ProcessEnv, log: l, exit: neverExit, residency: okResidency, copilotTools: okTools, signupModeProblem });
    go({ CN_SIGNUP_MODE: 'invte' });
    await vi.waitFor(() => expect(l.error).toHaveBeenCalledTimes(1));
    expect(l.error).toHaveBeenCalledWith('STARTUP', 'unknown CN_SIGNUP_MODE value "invte"; GoApply sign-up is OPEN. Use invite or closed.', { value: 'invte' });
    // A known mode reports nothing; an unset variable is not even asked about.
    go({ CN_SIGNUP_MODE: 'invite' });
    go({});
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(signupModeProblem).toHaveBeenCalledTimes(2);
    expect(l.error).toHaveBeenCalledTimes(1);
    // A fault in the check is never fatal and logs nothing.
    const quiet = log();
    runStartupAssertions({
      env: { CN_SIGNUP_MODE: 'x' } as NodeJS.ProcessEnv,
      log: quiet,
      exit: neverExit,
      residency: okResidency,
      copilotTools: okTools,
      signupModeProblem: () => {
        throw new Error('boom');
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(quiet.error).not.toHaveBeenCalled();
  });

  it('the GoApply checks are skipped on a deployment that does not serve GoApply', () => {
    const l = run({ ALLOWED_BRANDS: 'roboapply', CN_S3_ENDPOINT: 'x', CN_RECRUITMENT_INFO_MODE: 'false', CN_STORAGE_MODE: 'redcat', CN_SIGNUP_MODE: 'invte', CN_RESIDENCY_STRICT: 'true' });
    expect(l.warn).not.toHaveBeenCalled();
    expect(l.error).not.toHaveBeenCalled();
  });
});

// Acceptance of PAR-1 request O-1 (the deployment order rule): a production
// process with no deployment scope and only the shared model settings boots,
// with GoApply's Assistant checked on the shared model. It needs the effective
// LLM profile of the LLM bundle (lib/llm/llmBrand `effectiveLlmProfile`):
// before that seam exists GoApply's route is still judged by the domestic
// profile and the real check refuses it, which is why the deployment rule says
// not to deploy in between. The test runs as soon as the seam is there.
const llmBrandSeam = (await import('../lib/llm/llmBrand.js')) as Record<string, unknown>;
const hasEffectiveProfile = typeof llmBrandSeam.effectiveLlmProfile === 'function';

describe('production, both brands served, shared model stack only (PAR-1 request O-1)', () => {
  it.runIf(hasEffectiveProfile)('boots with a tool-capable shared copilot model and checks both brands', () => {
    for (const name of ['ALLOWED_BRANDS', 'BRAND_LOCK', 'CN_LLM_PROVIDER', 'CN_LLM_MODEL', 'CN_LLM_COPILOT_MODEL', 'CN_LLM_DOMESTIC_ONLY', 'CN_RESIDENCY_STRICT', 'DEPLOY_REGION', 'LLM_COPILOT_MODEL']) {
      vi.stubEnv(name, '');
    }
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('LLM_SETTINGS_DB_DISABLED', 'true');
    vi.stubEnv('LLM_PROVIDER', 'openrouter');
    vi.stubEnv('LLM_MODEL', 'openai/gpt-5');
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
    const l = log();
    expect(copilotBrands(process.env)).toEqual(['roboapply', 'goapply']);
    expect(() => runStartupAssertions({ env: process.env, log: l, exit: neverExit, residency: okResidency })).not.toThrow();
    expect(l.error).not.toHaveBeenCalled();
  });

  it('until then the gap is the documented one: the check names GoApply, never RoboApply', () => {
    for (const name of ['ALLOWED_BRANDS', 'BRAND_LOCK', 'CN_LLM_PROVIDER', 'CN_LLM_MODEL', 'CN_LLM_COPILOT_MODEL', 'CN_LLM_DOMESTIC_ONLY', 'CN_RESIDENCY_STRICT', 'DEPLOY_REGION', 'LLM_COPILOT_MODEL']) {
      vi.stubEnv(name, '');
    }
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('VERCEL', '1');
    vi.stubEnv('LLM_SETTINGS_DB_DISABLED', 'true');
    vi.stubEnv('LLM_PROVIDER', 'openrouter');
    vi.stubEnv('LLM_MODEL', 'openai/gpt-5');
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
    let thrown: unknown;
    try {
      runStartupAssertions({ env: process.env, log: log(), residency: okResidency });
    } catch (err) {
      thrown = err;
    }
    // RoboApply's route is fine either way: whatever is refused, it is not RoboApply.
    const failed = thrown instanceof AssistantModelStartupError ? thrown.failures.map((f) => f.brand) : [];
    expect(failed).not.toContain('roboapply');
    if (hasEffectiveProfile) expect(thrown).toBeUndefined();
    // Narrowed to RoboApply the same process always boots (the interim deployment rule).
    vi.stubEnv('ALLOWED_BRANDS', 'roboapply');
    expect(() => runStartupAssertions({ env: process.env, log: log(), residency: okResidency })).not.toThrow();
  });
});
