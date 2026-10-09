// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { ResidencyStartupError } from './residency/index.js';
import { runStartupAssertions, type StartupLog } from './startup.js';

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

  it('logs residency warnings and copilot-tool problems without blocking boot', () => {
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
  });

  it('a crash inside the copilot check is logged, never thrown', () => {
    const l = log();
    runStartupAssertions({
      env: {} as NodeJS.ProcessEnv,
      log: l,
      residency: okResidency,
      copilotTools: () => {
        throw new Error('boom');
      },
    });
    expect(l.warn).toHaveBeenCalledWith('STARTUP', 'Assistant model check could not run', { error: 'boom' });
  });
});
