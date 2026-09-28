// verify-llm.mjs — gateway LLM model acceptance probe.
//
// WHY: the control plane starts an interview only when LLM_INTERVIEW_MODEL maps
// to a LiveKit Inference id in ALIGNED_INTERVIEW_MODELS
// (server/src/interview-engine/config.ts); an unmapped model 503s at session
// create. An id on that list that the gateway does NOT serve is worse: it passes
// the check, then kills the interview silently inside the room. Neither
// docs.livekit.io nor the SDK's `LLMModels` union tracks the gateway (it served
// GPT-6 Luna/Sol before the docs listed any GPT-6 model), so ask the gateway
// itself: this probe builds each id exactly as src/agent.ts buildLlm() does and
// streams a one-line reply through it.
//
// Run: node verify-llm.mjs [--effort minimal|low|medium|high] [model ...]
//   node verify-llm.mjs                                    # every ALIGNED_INTERVIEW_MODELS id
//   node verify-llm.mjs openai/gpt-6-luna --effort high
//   npm run verify:llm -- openai/gpt-6-luna --effort high  # npm needs the `--`
//
// Ids are the LiveKit Inference ids the worker receives (openai/gpt-6-luna), not
// backend selectors (openrouter/openai/gpt-6-luna). Needs only LIVEKIT_URL /
// LIVEKIT_API_KEY / LIVEKIT_API_SECRET in .env.local (the same gateway creds the
// worker uses — no provider key). Exit 0 = every probed model streamed a reply;
// exit 1 = at least one was not served, errored, timed out, or replied empty.

import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { config as loadEnv } from 'dotenv';
import { inference, llm, initializeLogger } from '@livekit/agents';

loadEnv({ path: '.env.local' });
loadEnv({ path: '.env' });

// The SDK's inference client logs through a global logger the worker runtime
// (cli.runApp) normally initializes; a standalone probe must do it itself.
initializeLogger({ pretty: false, level: 'warn' });

if (!process.env.LIVEKIT_API_KEY?.trim() || !process.env.LIVEKIT_API_SECRET?.trim() || !process.env.LIVEKIT_URL?.trim()) {
  console.error('Missing LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET in .env.local');
  process.exit(2);
}

// MIRROR of server/src/interview-engine/config.ts ALIGNED_INTERVIEW_MODELS.
// Keep in sync when that list changes (this file can't import the server's TS).
const ALIGNED_INTERVIEW_MODELS = [
  'openai/gpt-6-luna',
  'openai/gpt-6-sol',
  'openai/gpt-5.5',
  'openai/gpt-5.6-luna',
  'openai/gpt-5.6-sol',
  'openai/gpt-5.6-terra',
  'openai/gpt-5.4',
  'openai/gpt-5.4-mini',
  'openai/gpt-5.4-nano',
  'openai/gpt-5.3-chat-latest',
  'openai/gpt-5.2',
  'openai/gpt-5.2-chat-latest',
  'openai/gpt-5.1',
  'openai/gpt-5.1-chat-latest',
  'openai/gpt-5',
  'openai/gpt-5-mini',
  'openai/gpt-5-nano',
  'openai/gpt-4.1',
  'openai/gpt-4.1-mini',
  'openai/gpt-4.1-nano',
  'openai/gpt-4o',
  'openai/gpt-4o-mini',
  'openai/chat-latest',
  'openai/gpt-oss-120b',
  'google/gemini-3.1-pro-preview',
  'google/gemini-3-flash-preview',
  'google/gemini-3.1-flash-lite',
  'google/gemini-3.5-flash',
  'google/gemini-3.5-flash-lite',
  'google/gemini-3.6-flash',
  'google/gemini-2.5-pro',
  'google/gemini-2.5-flash',
  'google/gemini-2.5-flash-lite',
];

// The reasoning efforts the worker accepts in room metadata (llm.reasoningEffort).
const EFFORTS = ['minimal', 'low', 'medium', 'high'];
const PROMPT = 'Greet a job candidate in one short sentence.';
const REQUEST_TIMEOUT_MS = 30_000; // connOptions.timeoutMs for the gateway request
const PROBE_TIMEOUT_MS = 45_000; // the whole streamed reply, enforced in the child
const CHILD_TIMEOUT_MS = 60_000; // backstop: kill a child that never reports
const RESULT_TAG = 'VERIFY_LLM_RESULT ';
const USAGE = 'Usage: node verify-llm.mjs [--effort minimal|low|medium|high] [model ...]\n' +
  '   or: npm run verify:llm -- [--effort minimal|low|medium|high] [model ...]';

let args;
try {
  args = parseArgs({
    allowPositionals: true,
    options: {
      effort: { type: 'string' },
      // Internal: probe exactly one model and print a tagged JSON result line.
      child: { type: 'boolean' },
    },
  });
} catch (err) {
  console.error(`${err.message}\n${USAGE}`);
  process.exit(2);
}

const effort = args.values.effort?.trim().toLowerCase();
if (effort !== undefined && !EFFORTS.includes(effort)) {
  console.error(`--effort must be one of ${EFFORTS.join(', ')} (the values the worker accepts)`);
  process.exit(2);
}

// LiveKit ids are always provider/model. Anything else is usually a flag that
// npm swallowed (missing `--`) or an unsplit shell variable ("model high").
const models = [...new Set(args.positionals.map((m) => m.trim()))];
const badModel = models.find((m) => !/^[^\s/]+\/\S+$/.test(m));
if (badModel !== undefined) {
  console.error(`"${badModel}" is not a provider/model id\n${USAGE}`);
  process.exit(2);
}

/** Streams one reply from `model`; never throws, always returns a result. */
async function probe(model) {
  let failure;
  // A failed request reaches us twice: as an 'error' event on the LLM, and as
  // a rejection of the SDK's fire-and-forget request task. Unhandled, either
  // one kills node (ERR_UNHANDLED_ERROR / unhandled rejection) before we report.
  process.on('unhandledRejection', (reason) => { failure ??= reason; });

  // Built exactly as src/agent.ts buildLlm() builds the worker's LLM.
  const engine = new inference.LLM({
    model,
    ...(effort ? { modelOptions: { reasoning_effort: effort } } : {}),
  });
  engine.on('error', (ev) => { failure ??= ev.error; });

  const chatCtx = llm.ChatContext.empty();
  chatCtx.addMessage({ role: 'user', content: PROMPT });

  const startedAt = performance.now();
  let firstTokenMs = null;
  let reply = '';
  const stream = engine.chat({
    chatCtx,
    connOptions: { maxRetry: 0, retryIntervalMs: 0, timeoutMs: REQUEST_TIMEOUT_MS },
  });
  const drain = (async () => {
    for await (const chunk of stream) {
      const text = chunk.delta?.content;
      if (!text) continue;
      firstTokenMs ??= performance.now() - startedAt;
      reply += text;
    }
  })();

  let timer;
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(`no complete reply after ${PROBE_TIMEOUT_MS}ms`)), PROBE_TIMEOUT_MS);
  });
  try {
    await Promise.race([drain, timeout]);
  } catch (err) {
    failure ??= err;
  } finally {
    clearTimeout(timer);
    stream.close();
  }
  // A failed stream can end, empty, before its error is reported; give the
  // error a moment to land so the reason is right. Empty output fails anyway.
  await new Promise((resolve) => setTimeout(resolve, 200));
  try { await engine.aclose(); } catch { /* best effort */ }

  reply = reply.trim();
  if (!failure && !reply) failure = new Error('stream ended without any text');
  if (!failure) return { status: 'served', firstTokenMs, reply };
  const error = String(failure?.message || failure).replace(/\s+/g, ' ');
  // The gateway's answer for an id it has no model for.
  return { status: /error getting model definition/i.test(error) ? 'not-served' : 'failed', error };
}

// Each model runs in its own node process: an SDK failure path we did not
// anticipate then costs only that model, never the rest of the run. Every model
// also starts cold (new process, new gateway connection), so the first-token
// latencies compare fairly.
function probeInChild(model) {
  const run = spawnSync(
    process.execPath,
    [import.meta.filename, '--child', ...(effort ? ['--effort', effort] : []), model],
    { encoding: 'utf8', timeout: CHILD_TIMEOUT_MS, killSignal: 'SIGKILL' },
  );
  const line = (run.stdout ?? '').split('\n').findLast((l) => l.startsWith(RESULT_TAG));
  if (line) {
    try { return JSON.parse(line.slice(RESULT_TAG.length)); } catch { /* truncated: report the exit below */ }
  }
  if (run.error?.code === 'ETIMEDOUT') {
    return { status: 'failed', error: `probe process killed after ${CHILD_TIMEOUT_MS}ms` };
  }
  // A crash report ends with "Node.js vX"; the error line is the useful one.
  const lines = (run.stderr ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  const reason = lines.find((l) => /^\w*Error\b/.test(l)) ?? lines.at(-1) ?? run.error?.message ?? 'no output';
  return { status: 'failed', error: `probe process exited (${run.signal ?? run.status}): ${reason}` };
}

function quote(text, max = 60) {
  const flat = text.replace(/\s+/g, ' ');
  return JSON.stringify(flat.length > max ? `${flat.slice(0, max - 1)}…` : flat);
}

async function main() {
  if (args.values.child) {
    const result = await probe(models[0]);
    // Exit only once the line is flushed: stdout is a pipe here, and pipe
    // writes are asynchronous on macOS.
    process.stdout.write(`${RESULT_TAG}${JSON.stringify(result)}\n`, () => process.exit(0));
    return;
  }

  const targets = models.length ? models : ALIGNED_INTERVIEW_MODELS;
  const width = Math.max(...targets.map((m) => m.length));
  console.log(
    `\nProbing ${targets.length} model(s) against the LiveKit Inference gateway ` +
    `(reasoning_effort: ${effort ?? 'model default'}) …\n`,
  );
  const failed = [];
  for (const model of targets) {
    const r = probeInChild(model);
    if (r.status === 'served') {
      console.log(`✅ ${model.padEnd(width)}  first token ${(r.firstTokenMs / 1000).toFixed(2)}s  ${quote(r.reply)}`);
    } else {
      failed.push(model);
      console.log(`❌ ${model.padEnd(width)}  ${r.status === 'not-served' ? 'NOT SERVED' : 'FAILED'}: ${r.error}`);
    }
  }

  console.log('\n──────── VERIFY LLM RESULT ────────');
  console.log(failed.length
    ? `❌ FAIL — ${failed.length} of ${targets.length} model(s) did not stream a reply: ${failed.join(', ')}`
    : '✅ PASS — every probed model streamed a reply');
  console.log('   ALIGNED_INTERVIEW_MODELS (server/src/interview-engine/config.ts)');
  console.log('   must list only ids that pass here.');
  console.log('───────────────────────────────────\n');
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('PROBE HARNESS ERROR:', err?.stack || err?.message || err);
  process.exit(2);
});
