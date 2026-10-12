// server/src/platform/llm/contentSafety/engine.ts
//
// The check engine (WP-24): provider selection, timeout, fail-closed
// handling and event recording. index.ts is the public surface.

import { resolveContentSafetyConfig, createContentSafetyProvider } from './config.js';
import { buildContentSafetyEvent, recordContentSafetyEvent } from './events.js';
import {
  ContentBlockedError,
  ContentSafetyProviderError,
  ContentSafetyUnavailableError,
  isVerdict,
  type ContentSafetyContext,
  type ContentSafetyFailureCause,
  type ContentSafetyProvider,
  type ContentSafetyResult,
  type ContentSafetyStage,
} from './types.js';
import type { BrandId } from '../../brand/registry.js';

const PASS = (provider: string): ContentSafetyResult => ({ verdict: 'pass', labels: [], provider });

/** The FND-5 placeholder: passes everything. Only for tests and tooling now; never the default. */
export const noopContentSafetyProvider: ContentSafetyProvider = {
  id: 'noop',
  async checkInput() {
    return PASS('noop');
  },
  async checkOutput() {
    return PASS('noop');
  },
};

interface Installed {
  provider: ContentSafetyProvider;
  timeoutMs: number;
}

let installed: Installed | null = null;
let fromEnv: Installed | null = null;

/**
 * Install a provider (tests, tooling). Pass null to go back to the provider
 * the environment configures (CN_CONTENT_SAFETY_PROVIDER; keyword_only by
 * default and for a configuration that cannot run as written). `timeoutMs`
 * defaults to the configured timeout.
 */
export function setContentSafetyProvider(next: ContentSafetyProvider | null, opts: { timeoutMs?: number } = {}): void {
  installed = next ? { provider: next, timeoutMs: opts.timeoutMs ?? envInstalled().timeoutMs } : null;
}

function envInstalled(): Installed {
  if (!fromEnv) {
    const config = resolveContentSafetyConfig(process.env);
    // Once per process (the result is cached): a bad setting is never silent.
    if (config.degraded) {
      // eslint-disable-next-line no-console
      console.warn(`[contentSafety] configuration problems; the filter runs as ${config.provider} on its safe defaults:`, config.problems.join('; '));
    } else if (config.problems.length) {
      // eslint-disable-next-line no-console
      console.error('[contentSafety] misconfigured under CN_RESIDENCY_STRICT; GoApply AI will answer ai_unavailable:', config.problems.join('; '));
    }
    fromEnv = { provider: createContentSafetyProvider(config), timeoutMs: config.timeoutMs };
  }
  return fromEnv;
}

/** Drop the cached environment provider (after env changes; tests). */
export function reloadContentSafetyFromEnv(): void {
  fromEnv = null;
}

export function getContentSafetyProvider(): ContentSafetyProvider {
  return (installed ?? envInstalled()).provider;
}

function activeTimeoutMs(): number {
  return (installed ?? envInstalled()).timeoutMs;
}

/**
 * Brands whose LLM calls are checked: GoApply only, on EVERY route it takes
 * (its own domestic provider or the shared international one). The check
 * follows the brand of the call, never the provider or the LLM profile.
 */
export function contentSafetyApplies(brand: BrandId): boolean {
  return brand === 'goapply';
}

class CheckTimeoutError extends Error {
  constructor() {
    super('content-safety check timed out');
    this.name = 'CheckTimeoutError';
  }
}

async function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new CheckTimeoutError());
    }, ms);
  });
  try {
    return await Promise.race([run(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function failureCause(err: unknown): ContentSafetyFailureCause {
  if (err instanceof CheckTimeoutError || (err as Error)?.name === 'AbortError') return 'timeout';
  if (err instanceof ContentSafetyProviderError) return err.cause_;
  return 'provider_error';
}

export interface RunCheckOptions {
  /** Write an event row (default true). The stream guard records one summary row itself. */
  record?: boolean;
  /** Run this provider instead of the active one (the stream guard's final keyword scan). */
  provider?: ContentSafetyProvider;
}

/**
 * Run the active provider once, with the timeout. Fails closed: any provider
 * error, timeout or malformed result throws ContentSafetyUnavailableError
 * (503 ai_unavailable). Does not throw on `block`; callers decide.
 */
export async function runCheck(
  stage: ContentSafetyStage,
  text: string,
  ctx: ContentSafetyContext,
  opts: RunCheckOptions = {},
): Promise<ContentSafetyResult> {
  const record = opts.record !== false;
  const provider = opts.provider ?? getContentSafetyProvider();
  let result: ContentSafetyResult;
  try {
    result = await withTimeout(
      (signal) => (stage === 'input' ? provider.checkInput(text, ctx, { signal }) : provider.checkOutput(text, ctx, { signal })),
      activeTimeoutMs(),
    );
    if (!result || !isVerdict(result.verdict) || !Array.isArray(result.labels)) {
      throw new ContentSafetyProviderError('provider returned a malformed result', 'invalid_result');
    }
  } catch (err) {
    const cause = failureCause(err);
    // eslint-disable-next-line no-console
    console.warn(`[contentSafety] ${stage} check failed closed (brand=${ctx.brand} task=${ctx.task} cause=${cause}):`, (err as Error)?.message);
    if (record) {
      await recordContentSafetyEvent(
        buildContentSafetyEvent({ stage, text, ctx, verdict: 'error', cause, provider: provider.id }),
      );
    }
    throw new ContentSafetyUnavailableError(stage, cause);
  }
  if (record) await recordContentSafetyEvent(buildContentSafetyEvent({ stage, text, ctx, verdict: result.verdict, result }));
  return result;
}

/** Public result: internal fields (hitOffset, hitSlice) stay inside the module. */
function publicResult(r: ContentSafetyResult): ContentSafetyResult {
  const { hitOffset: _offset, hitSlice: _slice, ...rest } = r;
  return rest;
}

export async function check(stage: ContentSafetyStage, text: string, ctx: ContentSafetyContext): Promise<ContentSafetyResult> {
  if (!contentSafetyApplies(ctx.brand)) return PASS('not_applicable');
  const result = await runCheck(stage, text, ctx);
  if (result.verdict === 'block') throw new ContentBlockedError(stage, result.labels);
  return publicResult(result);
}
