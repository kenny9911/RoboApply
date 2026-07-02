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
  `INTERVIEW_ENGINE_AGENT_NAME`, default `RoboHire-Interview` — deliberately not
  `LIVEKIT_AGENT_NAME`, which is "Agent Alex"; never auto-joins).
- Reads **everything per-interview from room/job metadata** (the
  `InterviewRoomMetadata` contract in
  `backend/src/interview-engine/types.ts`): system prompt, opening line,
  language, voice, STT/LLM/TTS models.
- Smoothest full-duplex: **Silero VAD + the multilingual semantic turn detector
  + preemptive generation (+ preemptive TTS)**. The turn detector waits for a
  *meaning*-complete turn so it won't cut the candidate off; barge-in interrupts
  the interviewer after ~0.5 s.
- Speaks in the candidate's language. STT/LLM use **LiveKit Inference**
  (`elevenlabs/scribe_v2_realtime`, `openai/gpt-4o` — no extra keys). TTS uses
  **OpenAI `tts-1`** (multilingual; needs only `OPENAI_API_KEY`).
- Forwards every finalized turn to the control plane
  (`POST /api/v1/interview-engine/callbacks/sessions/:id/transcript`,
  secret-gated) and posts `lifecycle:ended` on shutdown so the control plane
  finalizes (transcript → R2, scoring).

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
npm run download-files            # Silero VAD + turn-detector models
npm run dev                       # build + connect to LiveKit Cloud (dev)
```

In day-to-day dev you don't run this by hand: the root `npm run dev` (and
`npm run services:start`) supervise the worker via
`scripts/dev-interview-agent.sh` — build, run, **restart on exit** (it once
silently died and mock interviews ran as silent rooms), log at
`/tmp/robohire-interview-agent.log`. If `.env.local` is missing the supervisor
warns loudly and idles instead of failing the dev stack; `npm run services:stop`
also stops the worker. The one-time `npm install` + `.env.local` +
`download-files` setup above is still required.

## Configuration

| Var | Must match |
|---|---|
| `LIVEKIT_URL/API_KEY/API_SECRET` | the **same LiveKit project** as the control plane |
| `INTERVIEW_ENGINE_AGENT_NAME` | the control plane's `INTERVIEW_ENGINE_AGENT_NAME` (default `RoboHire-Interview`) |
| `LIVEKIT_AGENT_CALLBACK_SECRET` | the control plane's `LIVEKIT_AGENT_CALLBACK_SECRET` |
| `OPENAI_API_KEY` | for OpenAI `tts-1` TTS |

STT/LLM default to LiveKit Inference (only `LIVEKIT_*` needed). For native
per-locale voices later, a Google TTS branch can be added behind Google creds.

## Deploy

```bash
lk agent create        # LiveKit Cloud (recommended)
# or any container host:
docker build -t robohire-interview-agent . && docker run --env-file .env.local robohire-interview-agent
```

A name/project mismatch means dispatch succeeds but no one joins — the control
plane surfaces "agent never joined" in the live UI after 15 s.
