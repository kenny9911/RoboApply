# RoboHire Interview Engine — Voice Worker (Node/TS)

The AI interviewer voice brain, built on **`@livekit/agents` (Node, 1.4.x)**.
A **separate deployable** from the RoboHire backend — the Node "control plane"
(`backend/src/interview-engine/`) creates the room, dispatches this worker,
records via Egress, and persists transcripts/scores. This worker only runs the
real-time conversation.

> This replaces the earlier Python worker (`backend/interview-agent`). The whole
> stack is now one language (Node/TS).

## What it does

- Joins the LiveKit room on **explicit dispatch** (registered with
  `INTERVIEW_ENGINE_AGENT_NAME`, default `RoboApply-Interview` — deliberately not
  `LIVEKIT_AGENT_NAME`, which is "Agent Alex"; never auto-joins).
- Reads **everything per-interview from room/job metadata** (the
  `InterviewRoomMetadata` contract in
  `backend/src/interview-engine/types.ts`): system prompt, opening line,
  language, voice, STT/LLM/TTS models.
- Smoothest full-duplex: **Silero VAD end-of-turn detection
  (`turnDetection: 'vad'`) + preemptive generation (+ preemptive TTS)**, with
  per-language endpointing (wider for zh/ja/ko); barge-in interrupts the
  interviewer after ~0.6 s. The multilingual *semantic* turn detector is
  deliberately NOT used — its inference is unreliable in this Node build
  (fails every turn → "stuck waiting" turn-taking).
- Speaks in the candidate's language. STT/LLM/TTS all run through **LiveKit
  Inference** (no extra provider keys): STT `deepgram/nova-3` (idle-tolerant;
  the control plane also sends a server-side `deepgram/nova-2` fallback), LLM
  per metadata (control-plane default `openai/gpt-5.4`; the worker's own
  metadata-less fallback is `openai/gpt-4o`), TTS the control-plane-resolved
  native voice (e.g. `cartesia/sonic-3` or ElevenLabs per locale) with a gateway
  ElevenLabs fallback. **OpenAI `tts-1`** is only the local last-resort floor
  (needs `OPENAI_API_KEY`) so a session is never mute.
- Forwards every finalized turn to the control plane
  (`POST /api/v1/interview-engine/callbacks/sessions/:id/transcript`,
  secret-gated), posts `lifecycle:started`/`lifecycle:ended` (plus
  `lifecycle:error` on an unexpected AgentSession close), and shuts itself down
  ~90 s after the candidate disconnects without returning, so an abandoned room
  never holds a worker slot until the overtime hard-stop.

Recording is **not** done here — the control plane starts a LiveKit Egress
RoomComposite → Cloudflare R2.

## Structure

- `src/agent.ts` — the agent (`defineAgent`, default export). Job subprocesses
  import this.
- `src/main.ts` — the launcher (`cli.runApp` + `ServerOptions`). Points
  `agent` at the built `dist/agent.js`.

The build-then-run split (run `node dist/main.js`, not `tsx`) is deliberate:
job subprocesses run plain `node` on the built JS, avoiding loader issues.

## Quickstart

```bash
cd interview-agent
npm install
cp .env.example .env.local        # fill LIVEKIT_* + LIVEKIT_AGENT_CALLBACK_SECRET + OPENAI_API_KEY
npm run dev                       # build + connect to LiveKit Cloud (dev)
```

(No model download step: the Silero VAD model ships inside
`@livekit/agents-plugin-silero`.)

In day-to-day dev you don't run this by hand: the root `npm run dev` (and
`npm run services:start`) supervise the worker via
`scripts/dev-interview-agent.sh` — build, run, **restart on exit** (it once
silently died and mock interviews ran as silent rooms), log at
`/tmp/roboapply-interview-agent.log`. If `.env.local` is missing the supervisor
warns loudly and idles instead of failing the dev stack; `npm run services:stop`
also stops the worker. The one-time `npm install` + `.env.local` setup above is
still required.

> **A dev laptop is not a production host.** Dev-mode workers register under
> the same agent name as production, so production interviews at
> www.roboapply.io will happily dispatch to a laptop — and die when it sleeps.
> Run at least one `start`-mode worker on an always-on host (next section).

## Configuration

| Var | Must match |
|---|---|
| `LIVEKIT_URL/API_KEY/API_SECRET` | the **same LiveKit project** as the control plane |
| `INTERVIEW_ENGINE_AGENT_NAME` | the control plane's `INTERVIEW_ENGINE_AGENT_NAME` (default `RoboApply-Interview`) |
| `LIVEKIT_AGENT_CALLBACK_SECRET` | the control plane's `LIVEKIT_AGENT_CALLBACK_SECRET` |
| `OPENAI_API_KEY` | for the OpenAI `tts-1` last-resort TTS floor |

STT/LLM/TTS run through LiveKit Inference (only `LIVEKIT_*` needed); model ids
arrive per-interview via room metadata, so there is nothing model-related to
configure here.

## Run it anywhere

The worker only dials **out** — a WSS registration socket to LiveKit Cloud
(443, with TURN/TLS 443 as the media worst-case) and HTTPS callbacks to the
control plane. No inbound ports, no public IP, no domain: it runs identically
on a laptop, a VPS, Fly.io, Railway, Render, or Kubernetes, from behind any
NAT. The only listener is the SDK's local health server (production mode:
`GET :8081/` → 200/503, `GET :8081/worker` → JSON with `active_jobs`).

**Scaling is just replicas.** Every worker that registers under the same
`INTERVIEW_ENGINE_AGENT_NAME` joins one pool; LiveKit Cloud round-robins new
interviews across them and skips any worker above its load threshold
(default 0.7 CPU) or draining. Sizing: roughly **0.13 core + ~100 MB per live
session** — a 2-core/2 GB box comfortably runs ~10 concurrent interviews.

### Docker (any machine)

```bash
cd interview-agent
docker build -t roboapply-interview-agent .
docker run -d --env-file .env.local --restart unless-stopped roboapply-interview-agent
# or: docker compose up -d --scale worker=3
```

### Managed hosts

Ready-made recipes in [`deploy/`](deploy): [`fly.toml`](deploy/fly.toml)
(bluegreen, no public service), [`render.yaml`](deploy/render.yaml) (private
service + autoscaling), [`railway.md`](deploy/railway.md) (**must** set
`RAILWAY_DEPLOYMENT_DRAINING_SECONDS` — Railway's default drain is 0 s),
[`k8s.yaml`](deploy/k8s.yaml) (long grace periods + HPA), and
[`systemd/`](deploy/systemd) for a plain VPS.

### Deploys vs live interviews

SIGTERM starts a graceful drain: the worker stops accepting new interviews and
finishes the ones in flight — but only up to the host's kill window. Fly and
Render cap that at **300 s**; Railway defaults to **0 s** (configure it!).
Only Kubernetes/systemd/VPS hosts can wait out a full 60-minute interview
(`terminationGracePeriodSeconds` / `TimeoutStopSec`). Practical policy: run
≥2 replicas, deploy off-peak, and prefer bluegreen/overlap strategies so a new
worker is registered before the old one drains.

### Worker tuning (env)

| Var | Default | Meaning |
|---|---|---|
| `WORKER_HEALTH_PORT` / `WORKER_HEALTH_HOST` | SDK: 8081/0.0.0.0 (prod), random (dev) | health server bind |
| `WORKER_NUM_IDLE_PROCESSES` | SDK: min(cores, 4) | prewarmed job processes — set 1 on small VMs |
| `WORKER_LOAD_THRESHOLD` | SDK: 0.7 | CPU load above which no new interviews are accepted |
| `WORKER_JOB_MEMORY_WARN_MB` | 1024 | per-interview memory warn line |
| `WORKER_JOB_MEMORY_LIMIT_MB` | off | hard per-interview memory kill |
| `WORKER_MAX_RETRY` | 60 | LiveKit reconnect attempts before the worker exits |

A name/project mismatch means dispatch succeeds but no one joins — the control
plane surfaces "agent never joined" in the live UI after 15 s. Check any
worker's identity with `curl -s localhost:8081/worker`.
