// Worker launcher. Separate from agent.ts so job subprocesses can import the
// agent's default export WITHOUT re-running cli.runApp. Run with:
//   node dist/main.js dev     (connect to LiveKit Cloud, hot for development)
//   node dist/main.js start   (production worker)
//   node dist/main.js download-files   (fetch the Silero VAD model)

import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { cli, ServerOptions } from '@livekit/agents';

loadEnv({ path: '.env.local' });

// DELIBERATELY its own var (NOT LIVEKIT_AGENT_NAME, which is "Agent Alex") so the
// interview worker never collides with Agent Alex. MUST match the control
// plane's INTERVIEW_ENGINE_AGENT_NAME. The default MUST stay 'RoboApply-Interview'
// — the deployed contract on the shared LiveKit project. A 'RoboHire-Interview'
// fallback here once routed dispatches to nobody (silent-room outage, 2026-07-03).
const AGENT_NAME = process.env.INTERVIEW_ENGINE_AGENT_NAME?.trim() || 'RoboApply-Interview';

cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(new URL('./agent.js', import.meta.url)),
    agentName: AGENT_NAME,
  }),
);
