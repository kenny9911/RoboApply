// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

import { isEnabledForBrand, setVoiceAvailabilityProbe, setWechatPayReadinessProbe } from './flags.js';
import { BRANDS } from './brand/registry.js';
import { ResidencyStartupError } from './residency/index.js';
import { AssistantModelStartupError, copilotBrands, runStartupAssertions, type StartupLog } from './startup.js';

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

  it('a real cn-mainland misconfiguration is refused', () => {
    const exit = vi.fn() as unknown as (code: number) => never;
    expect(() =>
      runStartupAssertions({ env: { DEPLOY_REGION: 'cn-mainland' } as NodeJS.ProcessEnv, log: log(), exit, copilotTools: okTools }),
    ).toThrow(ResidencyStartupError);
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
  it('production + capability on + tool-less model → refuses to boot (exit 1 off Vercel)', () => {
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
    expect(error.failures).toEqual([{ brand: 'roboapply', problem: 'provider "anthropic" cannot stream tool calls', selector: 'anthropic/claude-sonnet' }]);
    expect(error.message).toContain('FLAG_<BRAND>_COPILOT=false');
    expect(exit).toHaveBeenCalledWith(1);
    expect(l.error).toHaveBeenCalledWith('STARTUP', expect.stringContaining('roboapply: provider "anthropic" cannot stream tool calls'), { brands: ['roboapply'] });
    // Only served brands with the capability are asked about; the check never throws by itself.
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
    const both = { NODE_ENV: 'production', ALLOWED_BRANDS: 'roboapply,goapply' } as NodeJS.ProcessEnv;
    // GoApply without a domestic model has no copilot capability (R-13); RoboApply has it.
    expect(isEnabledForBrand('copilot', BRANDS.goapply, both)).toBe(false);
    expect(copilotBrands(both)).toEqual(['roboapply']);
    expect(copilotBrands({ ...both, FLAG_ROBOAPPLY_COPILOT: 'false' } as NodeJS.ProcessEnv)).toEqual([]);
    expect(copilotBrands({ ...both, CN_LLM_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'k', CN_LLM_MODEL: 'deepseek-chat' } as NodeJS.ProcessEnv)).toEqual(
      ['roboapply', 'goapply'].filter((id) => isEnabledForBrand('copilot', BRANDS[id as 'roboapply' | 'goapply'], { ...both, CN_LLM_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'k', CN_LLM_MODEL: 'deepseek-chat' })),
    );
    // A brand this deployment does not serve is never checked.
    expect(copilotBrands(PROD)).toEqual(['roboapply']);

    const copilotTools = vi.fn((o: { brands: string[] }) => o.brands.map(toolless));
    // RoboApply switched off: a tool-less model no longer blocks the boot.
    runStartupAssertions({
      env: { ...both, FLAG_ROBOAPPLY_COPILOT: 'false' } as NodeJS.ProcessEnv,
      log: log(),
      exit: neverExit,
      residency: okResidency,
      copilotTools: copilotTools as never,
    });
    expect(copilotTools).not.toHaveBeenCalled();
    // Switched on (the default): the same model refuses to boot, and only RoboApply is named.
    expect(() =>
      runStartupAssertions({ env: { ...both, VERCEL: '1' } as NodeJS.ProcessEnv, log: log(), residency: okResidency, copilotTools: copilotTools as never }),
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
    const env = {
      CN_PAYMENTS_ENABLED: 'true',
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
    expect(isEnabledForBrand('pay.wechatpay', BRANDS.goapply, { ...env, CN_PAYMENTS_ENABLED: '' })).toBe(false);
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
