// Model backend switch for the interview worker (WP-63b): which LLM, STT and
// TTS a session runs on. See llm.ts and speech.ts for the rules.

import { GOAPPLY_AGENT_NAME, WorkerConfigError, envValue, hostOf, isDomesticHost, isGoApplyWorker, type Env } from './config.js';
import { resolveLlmBackend } from './llm.js';
import { STT_BACKENDS, TTS_BACKENDS } from './speech.js';

export * from './config.js';
export * from './llm.js';
export * from './speech.js';
export * from './session.js';

/**
 * Deployment-level checks, run once per worker process (agent prewarm) so a
 * misconfigured GoApply worker says so at boot rather than at the first
 * candidate's session. Returns human-readable problems; empty = fine.
 * Per-session checks (model ids from metadata) still happen at session start.
 */
export function backendConfigProblems(env: Env = process.env): string[] {
  const problems: string[] = [];
  let llm: string | null = null;
  try {
    llm = resolveLlmBackend(env);
  } catch (err) {
    problems.push(err instanceof Error ? err.message : String(err));
  }
  const stt = envValue(env, 'STT_BACKEND').toLowerCase();
  const tts = envValue(env, 'TTS_BACKEND').toLowerCase();
  if (stt && !(STT_BACKENDS as readonly string[]).includes(stt)) {
    problems.push(`STT_BACKEND="${stt}" is not supported. Use ${STT_BACKENDS.join(' or ')}.`);
  }
  if (tts && !(TTS_BACKENDS as readonly string[]).includes(tts)) {
    problems.push(`TTS_BACKEND="${tts}" is not supported. Use ${TTS_BACKENDS.join(' or ')}.`);
  }
  if ((stt.startsWith('dashscope') || tts.startsWith('dashscope')) && !envValue(env, 'DASHSCOPE_API_KEY')) {
    problems.push('STT_BACKEND/TTS_BACKEND select DashScope but DASHSCOPE_API_KEY is not set');
  }
  const wsUrl = envValue(env, 'DASHSCOPE_WS_URL');
  if (wsUrl && !isDomesticHost(hostOf(wsUrl), env)) {
    problems.push(`DASHSCOPE_WS_URL host ${hostOf(wsUrl) ?? wsUrl} is not a mainland endpoint`);
  }
  if (llm === 'openai_compatible') {
    const base = envValue(env, 'LLM_BASE_URL');
    if (base && !isDomesticHost(hostOf(base), env)) {
      problems.push(`LLM_BASE_URL host ${hostOf(base) ?? base} is not a mainland endpoint (add it to DOMESTIC_HOSTS if it is)`);
    }
    if (base && !envValue(env, 'LLM_API_KEY')) {
      problems.push('LLM_BASE_URL is set but LLM_API_KEY is not (vendor keys are only sent to the vendor\'s own endpoint)');
    }
  }

  // Brand ↔ backend consistency. The per-session resolvers already refuse a
  // gateway backend on the GoApply worker; these lines make the mismatch
  // visible at boot instead of at the first candidate's session.
  if (isGoApplyWorker(env)) {
    if (stt !== 'dashscope_paraformer') {
      problems.push(
        `GoApply worker: STT_BACKEND is ${stt ? `"${stt}"` : 'unset'}; pin STT_BACKEND=dashscope_paraformer ` +
        '(sessions without a dashscope/ STT model are refused)',
      );
    }
    if (tts !== 'dashscope_cosyvoice') {
      problems.push(
        `GoApply worker: TTS_BACKEND is ${tts ? `"${tts}"` : 'unset'}; pin TTS_BACKEND=dashscope_cosyvoice ` +
        '(sessions without a dashscope/ voice model are refused)',
      );
    }
    if (!envValue(env, 'DASHSCOPE_API_KEY') && !stt.startsWith('dashscope') && !tts.startsWith('dashscope')) {
      problems.push('GoApply worker: DASHSCOPE_API_KEY is not set (DashScope speech is required)');
    }
  } else if (llm === 'openai_compatible' || stt.startsWith('dashscope') || tts.startsWith('dashscope')) {
    problems.push(
      `domestic backends are configured but this worker is not registered as ${GOAPPLY_AGENT_NAME}; ` +
      `set INTERVIEW_ENGINE_AGENT_NAME=${GOAPPLY_AGENT_NAME} (or WORKER_BRAND=goapply) so the GoApply guard applies`,
    );
  }
  return [...new Set(problems)];
}

/** True for errors no retry can fix (reported as lifecycle reason `worker_config`). */
export function isWorkerConfigError(err: unknown): err is WorkerConfigError {
  return err instanceof WorkerConfigError;
}
