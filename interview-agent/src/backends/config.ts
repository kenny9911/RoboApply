// Shared helpers for the worker's model backends (WP-63b, CN-E-06).
//
// The worker serves one brand per deployment: the RoboApply worker
// (`RoboApply-Interview`) runs every model through the LiveKit Inference
// gateway, exactly as before; the GoApply worker (`GoApply-Interview`) runs a
// domestic OpenAI-compatible LLM and DashScope speech, and must never reach an
// international endpoint with a candidate's words. The rules here mirror the
// control plane's GoApply policy (server/src/platform/llm/brandPolicy.ts,
// TASK_PLAN R-13): only mainland endpoints, matched by host, plus an explicit
// allowlist for a self-hosted mainland gateway.
//
// Pure module (no I/O); unit-tested.

export type Env = Record<string, string | undefined>;

/**
 * A worker misconfiguration that no retry can fix (missing key, foreign
 * endpoint, unknown backend name). The session fails with reason
 * `worker_config` instead of silently degrading.
 */
export class WorkerConfigError extends Error {
  readonly code = 'worker_config' as const;
  constructor(message: string) {
    super(message);
    this.name = 'WorkerConfigError';
  }
}

/** Trimmed env value, '' when unset. */
export function envValue(env: Env, name: string): string {
  return (env[name] ?? '').trim();
}

/**
 * Mainland-China model endpoints (exact host or any subdomain). Kept equal to
 * MAINLAND_LLM_HOST_SUFFIXES in server/src/platform/llm/brandPolicy.ts.
 * `dashscope-intl.aliyuncs.com` (Singapore) is deliberately NOT on the list.
 */
export const MAINLAND_HOST_SUFFIXES = [
  'api.deepseek.com',
  'deepseek.com',
  'dashscope.aliyuncs.com',
  'api.moonshot.cn',
  'moonshot.cn',
  'open.bigmodel.cn',
  'bigmodel.cn',
  'volces.com',
  'volcengineapi.com',
  'api.minimaxi.com',
  'minimaxi.com',
  'api.minimax.chat',
  'minimax.chat',
] as const;

/** Lowercase host of a URL or bare host; null when unparseable. */
export function hostOf(urlOrHost: string | null | undefined): string | null {
  const raw = (urlOrHost ?? '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    return host || null;
  } catch {
    return null;
  }
}

function matchesSuffix(host: string, suffix: string): boolean {
  const s = suffix.toLowerCase().replace(/^\./, '');
  return host === s || host.endsWith(`.${s}`);
}

/** Extra mainland hosts (`DOMESTIC_HOSTS`, comma list), e.g. a self-hosted gateway in Shanghai. */
export function extraDomesticHosts(env: Env): string[] {
  return envValue(env, 'DOMESTIC_HOSTS')
    .split(',')
    .map((h) => hostOf(h))
    .filter((h): h is string => Boolean(h));
}

export function isDomesticHost(host: string | null | undefined, env: Env): boolean {
  if (!host) return false;
  const h = host.toLowerCase();
  return (
    MAINLAND_HOST_SUFFIXES.some((s) => matchesSuffix(h, s)) ||
    extraDomesticHosts(env).some((s) => matchesSuffix(h, s))
  );
}

/** The agent name the GoApply worker registers under (control plane CN_INTERVIEW_ENGINE_AGENT_NAME default). */
export const GOAPPLY_AGENT_NAME = 'GoApply-Interview';

/**
 * True when this process serves GoApply: it registers as `GoApply-Interview`
 * (INTERVIEW_ENGINE_AGENT_NAME) or sets WORKER_BRAND=goapply. A GoApply worker
 * may never use a gateway backend, whatever LLM_BACKEND / STT_BACKEND /
 * TTS_BACKEND say or leave unset (R-13): the brand, not only the deploy
 * image's env pins, decides.
 */
export function isGoApplyWorker(env: Env): boolean {
  return (
    envValue(env, 'INTERVIEW_ENGINE_AGENT_NAME').toLowerCase() === GOAPPLY_AGENT_NAME.toLowerCase() ||
    envValue(env, 'WORKER_BRAND').toLowerCase() === 'goapply'
  );
}
