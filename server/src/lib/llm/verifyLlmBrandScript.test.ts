// @vitest-environment node
//
// scripts/verify-llm-brand.ts (`npm run verify:llm`) is how an operator sees
// where each task of each brand resolves. This runs the real script with
// --json against an explicit environment: no .env, no provider call, and the
// admin override rows come from a mocked AppConfig table.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ rows: {} as Record<string, string>, reads: [] as string[] }));
vi.mock('../prisma.js', () => ({
  prisma: {
    appConfig: {
      findUnique: vi.fn(async ({ where }: { where: { key: string } }) => {
        db.reads.push(where.key);
        return db.rows[where.key] ? { key: where.key, value: db.rows[where.key], updatedAt: new Date(), updatedBy: 'admin' } : null;
      }),
    },
  },
}));
vi.mock('../../services/LoggerService.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
  generateRequestId: () => 'req_test',
}));
// The script loads the repository's .env; a test never reads it.
vi.mock('dotenv', () => ({ default: { config: () => ({ parsed: {} }) } }));

interface Row {
  brand: string;
  task: string;
  envName: string;
  ownEnvName: string;
  source: string;
  settingSource: string;
  selector: string | null;
  inheritsDefault: boolean;
  provider: string | null;
  allowed: boolean;
  policy: string;
  sharedNotUsed?: { envName: string; selector: string };
}
interface Report {
  rows: Row[];
  summaries: Array<{ brand: string; profile: string; providerMode: string; providerSource: string; providerOrigin: string; domesticOnly: boolean }>;
  violations: number;
  wallWithoutModel: string[];
  overrideRows?: Record<string, string>;
}

const llmEnvNames = () => Object.keys(process.env).filter((n) => /^(CN_)?(LLM_|RESIDENCY_)/.test(n) || /_API_KEY$|_BASE_URL$/.test(n));
let savedEnv: Record<string, string | undefined> = {};
let savedArgv: string[] = [];

beforeEach(() => {
  const names = [...new Set([...llmEnvNames(), 'NODE_ENV', 'LOG_LEVEL', 'BRAND_LOCK', 'ALLOWED_BRANDS', 'LLM_SETTINGS_DB_DISABLED'])];
  savedEnv = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  for (const n of names) delete process.env[n];
  process.env.NODE_ENV = 'test';
  process.env.LLM_PROVIDER = 'openrouter';
  process.env.LLM_MODEL = 'openrouter/openai/gpt-6-luna';
  process.env.OPENROUTER_API_KEY = 'test-key';
  savedArgv = process.argv;
  db.rows = {};
  db.reads = [];
  vi.resetModules();
});
afterEach(() => {
  for (const n of new Set([...Object.keys(savedEnv), ...llmEnvNames(), 'LLM_SETTINGS_DB_DISABLED', 'LOG_LEVEL'])) {
    if (savedEnv[n] === undefined) delete process.env[n];
    else process.env[n] = savedEnv[n];
  }
  process.argv = savedArgv;
  vi.restoreAllMocks();
});

/** Run the script with these flags; returns its --json report and exit code. */
async function runScript(flags: string[]): Promise<{ report: Report; exitCode: number | undefined }> {
  process.argv = ['node', 'verify-llm-brand.ts', '--json', ...flags];
  let printed = '';
  let exitCode: number | undefined;
  vi.spyOn(console, 'log').mockImplementation((text: unknown) => {
    printed += String(text);
  });
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code;
    return undefined as never;
  }) as typeof process.exit);
  await import('../../../../scripts/verify-llm-brand.js');
  return { report: JSON.parse(printed) as Report, exitCode };
}

const rowOf = (report: Report, brand: string, task: string): Row => {
  const row = report.rows.find((r) => r.brand === brand && r.task === task);
  if (!row) throw new Error(`no row for ${brand} ${task}`);
  return row;
};

describe('verify:llm report', () => {
  it('without --db it reads no database and names the variable each value comes from', async () => {
    process.env.CN_LLM_PROVIDER = 'deepseek';
    process.env.CN_LLM_MODEL = 'deepseek-v4-flash';
    process.env.LLM_COPILOT_MODEL = 'openrouter/openai/gpt-6-luna';
    const { report, exitCode } = await runScript([]);
    expect(db.reads).toEqual([]);
    expect(report.overrideRows).toBeUndefined();
    expect(rowOf(report, 'goapply', 'default')).toMatchObject({ envName: 'CN_LLM_MODEL', source: 'own', settingSource: 'env', selector: 'deepseek-v4-flash' });
    expect(rowOf(report, 'goapply', 'copilot')).toMatchObject({ envName: 'LLM_COPILOT_MODEL', source: 'shared', settingSource: 'shared', provider: 'openrouter', allowed: true });
    expect(rowOf(report, 'roboapply', 'copilot')).toMatchObject({ envName: 'LLM_COPILOT_MODEL', source: 'own', settingSource: 'env' });
    expect(report.summaries.find((x) => x.brand === 'goapply')).toMatchObject({ providerSource: 'own', providerOrigin: 'CN_LLM_PROVIDER', domesticOnly: false });
    expect(report.summaries.find((x) => x.brand === 'roboapply')).toMatchObject({ providerSource: 'own', providerOrigin: 'LLM_PROVIDER' });
    expect(report.violations).toBe(0);
    expect(exitCode).toBe(0);
  });

  it('--db: a selector from an admin override is labelled as the override row, never as an environment variable', async () => {
    const blob = (over: Record<string, unknown>) =>
      JSON.stringify({ provider: null, defaultModel: null, fallbackModel: null, purposes: {}, tuning: {}, ...over });
    // GoApply's own row sets its copilot model; RoboApply's row sets the shared rewrite model.
    db.rows['llm_stack.goapply.development'] = blob({ purposes: { copilot: 'openrouter/openai/gpt-6-sol' } });
    db.rows['llm_stack.development'] = blob({ purposes: { rewrite: 'openrouter/anthropic/claude-sonnet-4-6' } });
    const { report, exitCode } = await runScript(['--db']);

    expect(db.reads.sort()).toEqual(['llm_stack.development', 'llm_stack.goapply.development']);
    expect(report.overrideRows).toEqual({ roboapply: 'db', goapply: 'db' });
    // GoApply's own override: no CN_LLM_COPILOT_MODEL variable exists, and the row does not claim one.
    expect(process.env.CN_LLM_COPILOT_MODEL).toBeUndefined();
    expect(rowOf(report, 'goapply', 'copilot')).toMatchObject({
      envName: 'admin override (llm_stack.goapply.development)',
      ownEnvName: 'CN_LLM_COPILOT_MODEL',
      source: 'own',
      settingSource: 'override',
      selector: 'openrouter/openai/gpt-6-sol',
    });
    // A value GoApply inherits from RoboApply's override row is shared, and labelled as that row.
    expect(rowOf(report, 'goapply', 'rewrite')).toMatchObject({
      envName: 'admin override (llm_stack.development)',
      source: 'shared',
      settingSource: 'shared',
      selector: 'openrouter/anthropic/claude-sonnet-4-6',
    });
    expect(rowOf(report, 'roboapply', 'rewrite')).toMatchObject({ envName: 'admin override (llm_stack.development)', source: 'own', settingSource: 'override' });
    // Values that do come from the environment still name their variable.
    expect(rowOf(report, 'goapply', 'default')).toMatchObject({ envName: 'LLM_MODEL', source: 'shared', settingSource: 'shared' });
    expect(rowOf(report, 'roboapply', 'default')).toMatchObject({ envName: 'LLM_MODEL', source: 'own', settingSource: 'env' });
    expect(exitCode).toBe(0);
  });

  it('behind the wall it shows the shared value that is not used and what runs instead; no violation when a mainland model exists', async () => {
    process.env.CN_LLM_DOMESTIC_ONLY = 'true';
    process.env.CN_LLM_PROVIDER = 'deepseek';
    process.env.CN_LLM_MODEL = 'deepseek-v4-flash';
    process.env.DEEPSEEK_API_KEY = 'test-key';
    process.env.LLM_COPILOT_MODEL = 'openrouter/openai/gpt-6-luna';
    const { report, exitCode } = await runScript([]);
    expect(rowOf(report, 'goapply', 'copilot')).toMatchObject({
      envName: 'CN_LLM_MODEL',
      source: 'own',
      settingSource: 'env',
      selector: 'deepseek-v4-flash',
      inheritsDefault: true,
      provider: 'deepseek',
      allowed: true,
      sharedNotUsed: { envName: 'LLM_COPILOT_MODEL', selector: 'openrouter/openai/gpt-6-luna' },
    });
    expect(rowOf(report, 'roboapply', 'copilot')).toMatchObject({ selector: 'openrouter/openai/gpt-6-luna', allowed: true });
    expect(rowOf(report, 'roboapply', 'copilot').sharedNotUsed).toBeUndefined();
    expect(report.summaries.find((x) => x.brand === 'goapply')).toMatchObject({ domesticOnly: true, profile: 'domestic_cn', providerMode: 'deepseek' });
    expect(report.wallWithoutModel).toEqual([]);
    expect(report.violations).toBe(0);
    expect(exitCode).toBe(0);
  });

  it('behind the wall with no mainland model it fails loudly (the boot check only skips GoApply)', async () => {
    process.env.CN_LLM_DOMESTIC_ONLY = 'true';
    process.env.LLM_COPILOT_MODEL = 'openrouter/openai/gpt-6-luna';
    const { report, exitCode } = await runScript([]);
    expect(rowOf(report, 'goapply', 'default')).toMatchObject({
      selector: null,
      source: 'unset',
      policy: 'not configured',
      sharedNotUsed: { envName: 'LLM_MODEL', selector: 'openrouter/openai/gpt-6-luna' },
    });
    expect(rowOf(report, 'goapply', 'copilot')).toMatchObject({ selector: null, sharedNotUsed: { envName: 'LLM_COPILOT_MODEL', selector: 'openrouter/openai/gpt-6-luna' } });
    expect(rowOf(report, 'roboapply', 'default')).toMatchObject({ selector: 'openrouter/openai/gpt-6-luna', allowed: true });
    expect(report.wallWithoutModel).toEqual(['goapply']);
    expect(report.violations).toBe(1);
    expect(exitCode).toBe(1);
  });
});
