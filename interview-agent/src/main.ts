// Worker launcher. Separate from agent.ts so job subprocesses can import the
// agent's default export WITHOUT re-running cli.runApp. Run with:
//   node dist/main.js dev     (connect to LiveKit Cloud, hot for development)
//   node dist/main.js start   (production worker: drains gracefully on SIGTERM)
//
// PORTABLE BY DESIGN: the worker only dials OUT — a WSS connection to LiveKit
// Cloud (job dispatch + media) and HTTPS callbacks to the control plane. No
// inbound ports are required, so it runs identically on a laptop, a VPS, Fly,
// Railway, Render, or Kubernetes, from behind any NAT. The only inbound
// listener is the SDK's local health server (GET / → 200/503, GET /worker →
// JSON status), for container HEALTHCHECKs and platform probes.
//
// Scaling = run more replicas with the SAME agent name: LiveKit Cloud
// load-balances dispatches across registered workers and skips any worker
// whose load exceeds its threshold or that is draining. See README "Run it
// anywhere".

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { cli, ServerOptions } from '@livekit/agents';

// Container/host convention first (.env), local dev convention second
// (.env.local wins if both define a var — dotenv never overrides an existing
// value, so load the more specific file first). Real environment variables
// always take precedence over both.
loadEnv({ path: '.env.local' });
loadEnv({ path: '.env' });

// DELIBERATELY its own var (NOT LIVEKIT_AGENT_NAME, which is "Agent Alex") so the
// interview worker never collides with Agent Alex. MUST match the control
// plane's INTERVIEW_ENGINE_AGENT_NAME. The default MUST stay 'RoboApply-Interview'
// — the deployed contract on the shared LiveKit project. A 'RoboHire-Interview'
// fallback here once routed dispatches to nobody (silent-room outage, 2026-07-03).
const AGENT_NAME = process.env.INTERVIEW_ENGINE_AGENT_NAME?.trim() || 'RoboApply-Interview';

// ── Fail-fast env validation ────────────────────────────────────────────────
// A worker with missing creds either refuses to register (LIVEKIT_*) or
// silently degrades mid-interview (callback secret → transcripts rejected →
// empty reports; OpenAI key → no last-resort TTS floor). Surface all of that
// at boot, loudly, instead of at minute 12 of someone's interview.

const REQUIRED = ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'] as const;
const missing = REQUIRED.filter((k) => !process.env[k]?.trim());
if (missing.length > 0) {
  console.error(
    `[interview-agent] FATAL: missing required env: ${missing.join(', ')}\n` +
    '  Copy .env.example to .env.local (dev) or set real environment variables (containers).',
  );
  process.exit(1);
}
if (!process.env.LIVEKIT_AGENT_CALLBACK_SECRET?.trim()) {
  console.warn(
    '[interview-agent] WARN: LIVEKIT_AGENT_CALLBACK_SECRET is not set — the control plane will ' +
    'REJECT transcript/lifecycle callbacks and every session will produce an empty report.',
  );
}
if (!process.env.OPENAI_API_KEY?.trim()) {
  console.warn(
    '[interview-agent] WARN: OPENAI_API_KEY is not set — the local last-resort TTS floor is ' +
    'unavailable; a gateway TTS construction failure would leave a session mute.',
  );
}

// ── Startup banner ──────────────────────────────────────────────────────────
// One greppable line with everything ops needs to identify this worker in a
// fleet: name, version, target project, health port, tuning. Never secrets.

const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf-8'),
) as { name: string; version: string };

// Health server bind. Only overridden when explicitly configured — the SDK's
// own defaults are mode-aware (production: 8081, dev: 0 = random free port,
// so parallel dev workers never fight over a port). Containers set both via
// env (see Dockerfile) so the HEALTHCHECK has a deterministic target.
const healthPort = Number.parseInt(process.env.WORKER_HEALTH_PORT ?? '', 10) || undefined;
const healthHost = process.env.WORKER_HEALTH_HOST?.trim() || undefined;
// Prewarmed job subprocesses. The SDK's production default (3) is tuned for
// beefy hosts; small VMs (512MB–1GB) should set WORKER_NUM_IDLE_PROCESSES=1.
const numIdleProcesses = Number.parseInt(process.env.WORKER_NUM_IDLE_PROCESSES ?? '', 10) || undefined;
// 0..1 — above this reported load the worker is marked unavailable and LiveKit
// routes new interviews to other replicas. SDK default applies when unset.
const loadThreshold = Number.parseFloat(process.env.WORKER_LOAD_THRESHOLD ?? '') || undefined;
// Per-interview job memory guardrails (MB). Warn logs at the soft line; the
// hard limit kills a runaway job subprocess instead of the whole worker.
const jobMemoryWarnMB = Number.parseInt(process.env.WORKER_JOB_MEMORY_WARN_MB ?? '', 10) || 1024;
const jobMemoryLimitMB = Number.parseInt(process.env.WORKER_JOB_MEMORY_LIMIT_MB ?? '', 10) || 0;
// Registration-WS reconnect attempts (backoff caps at 10s per attempt). The
// SDK default (10 ≈ 100s of LiveKit unavailability) then EXITS the worker —
// killing live interview job subprocesses with it. 60 (~10 min) rides out a
// LiveKit Cloud blip while sessions keep running on their own room sockets.
const maxRetry = Number.parseInt(process.env.WORKER_MAX_RETRY ?? '', 10) || 60;
// Graceful drain window on SIGTERM (production `start`). As of agents 1.5.0 the
// SDK default is ONE HOUR — deliberately long so a live interview is never cut
// mid-sentence by a redeploy — which can stall fast rollouts. Left at the SDK
// default unless WORKER_DRAIN_TIMEOUT_MS is set, so ops can shorten it when a
// fast deploy matters more than the tail of an in-flight interview. (ms)
const drainTimeoutMs = Number.parseInt(process.env.WORKER_DRAIN_TIMEOUT_MS ?? '', 10) || undefined;

const lkHost = (() => {
  try { return new URL(process.env.LIVEKIT_URL!).host; } catch { return process.env.LIVEKIT_URL; }
})();
console.info(
  `[interview-agent] ${pkg.name}@${pkg.version} agent_name=${AGENT_NAME} livekit=${lkHost} ` +
  `health=${healthHost ?? 'sdk-default'}:${healthPort ?? 'sdk-default(prod 8081)'} node=${process.version} ` +
  `idle_procs=${numIdleProcesses ?? 'sdk-default'} load_threshold=${loadThreshold ?? 'sdk-default'} ` +
  `job_mem_warn_mb=${jobMemoryWarnMB}${jobMemoryLimitMB ? ` job_mem_limit_mb=${jobMemoryLimitMB}` : ''} ` +
  `max_retry=${maxRetry} drain_timeout_ms=${drainTimeoutMs ?? 'sdk-default(1h)'}`,
);

cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(new URL('./agent.js', import.meta.url)),
    agentName: AGENT_NAME,
    ...(healthHost ? { host: healthHost } : {}),
    ...(healthPort ? { port: healthPort } : {}),
    ...(numIdleProcesses ? { numIdleProcesses } : {}),
    ...(loadThreshold ? { loadThreshold } : {}),
    jobMemoryWarnMB,
    ...(jobMemoryLimitMB ? { jobMemoryLimitMB } : {}),
    maxRetry,
    ...(drainTimeoutMs ? { drainTimeout: drainTimeoutMs } : {}),
  }),
);
