# GoApply interview worker (mainland China)

The same LiveKit voice worker as RoboApply's, registered as
**`GoApply-Interview`**, with a domestic model stack selected by the backend
switch (`src/backends/`, WP-63b):

| Piece | RoboApply worker | GoApply worker |
|---|---|---|
| Agent name | `RoboApply-Interview` | `GoApply-Interview` (`CN_INTERVIEW_ENGINE_AGENT_NAME` on the control plane) |
| LLM | LiveKit Inference gateway (`LLM_BACKEND=gateway`) | OpenAI-compatible domestic endpoint (`LLM_BACKEND=openai_compatible`): DeepSeek, Qwen (DashScope), Kimi, GLM, Doubao (Ark), MiniMax |
| STT | Inference `deepgram/nova-3` | DashScope Paraformer realtime (`STT_BACKEND=dashscope_paraformer`) |
| TTS | Inference voice + optional OpenAI floor | DashScope CosyVoice (`TTS_BACKEND=dashscope_cosyvoice`), no OpenAI floor |
| Callback secret | `LIVEKIT_AGENT_CALLBACK_SECRET` = control plane `LIVEKIT_AGENT_CALLBACK_SECRET` | `LIVEKIT_AGENT_CALLBACK_SECRET` = control plane `CN_LIVEKIT_AGENT_CALLBACK_SECRET` |
| LiveKit | RoboApply project | GoApply project: CN-0 a separate LiveKit Cloud project in Asia, CN-1 self-hosted in Shanghai |

The `deploy/cn/Dockerfile` image pins the agent name and all three backends.
The guard does not depend on those pins: a worker registered as
`GoApply-Interview` (or with `WORKER_BRAND=goapply`) refuses every gateway
backend in code — an unset `LLM_BACKEND` means `openai_compatible` there, and
a session whose speech models are not `dashscope/…` fails with `worker_config`.
So a GoApply worker started by the dev supervisor, compose or a bare host still
cannot reach the international gateway.

## What the control plane sends

The GoApply control plane (WP-63a, `server/src/interview-engine/config.ts`)
refuses to dispatch unless the session is domestic end to end:

- `metadata.llm.model` is a raw domestic model id such as
  `deepseek/deepseek-chat` (`CN_LLM_INTERVIEW_LIVE_MODEL`, else the GoApply
  interview model). The worker strips the vendor prefix, calls that vendor's
  mainland endpoint with its key, and never sends `reasoning_effort`.
- `metadata.stt.model` / `metadata.voice.model` are `dashscope/…` ids
  (`CN_INTERVIEW_ENGINE_STT_MODEL`, `CN_INTERVIEW_ENGINE_TTS_MODEL`, e.g.
  `dashscope/paraformer-realtime-v2`, `dashscope/cosyvoice-v2`).
- `metadata.voice.voiceId` is the CosyVoice voice (`CN_INTERVIEW_ENGINE_TTS_VOICE`
  / `_MALE`) or empty; empty means the worker default for the voice's gender
  (read from the voice label): `COSYVOICE_VOICE_ZH_FEMALE` / `_MALE`, else
  `longxiaochun_v2` / `longcheng_v2` (cosyvoice-v2) or `longxiaochun` /
  `longcheng` (cosyvoice-v1). Other CosyVoice generations need a configured voice.

The worker fails closed: a missing `DASHSCOPE_API_KEY`, a vendor key, or an
endpoint outside the mainland allowlist ends the session with lifecycle error
`worker_config` (reported to the control plane) instead of reaching another
provider. `dashscope-intl.aliyuncs.com` (Singapore) is not on the allowlist.

## Audio only

The worker never publishes or subscribes to video (the room input keeps the
SDK default `videoEnabled: false`, and the GoApply join token already has
`cameraPublish: false`). Recording is the control plane's job: audio only, to
`CN_S3_*`, and only with `interview_recording` consent.

## Build and run

From `interview-agent/`:

```bash
docker build -f deploy/cn/Dockerfile -t goapply-interview-agent .
cp deploy/cn/worker.env.example deploy/cn/worker.env   # fill it; never commit it
docker run --env-file deploy/cn/worker.env goapply-interview-agent
```

`deploy/cn/worker.env` holds secrets (LiveKit secret, callback secret,
DashScope and vendor keys). `deploy/cn/.gitignore` keeps it out of git; better
still, keep the filled file outside the repo or in the cluster's secret store.

Inside the mainland use reachable registries (build args in the Dockerfile
header: `NODE_IMAGE`, `NPM_REGISTRY=https://registry.npmmirror.com`,
`APT_MIRROR=mirrors.aliyun.com`).

On ACK the worker is part of the mainland stack: its one manifest is
[`deploy/cn/k8s/worker.yaml`](../../../deploy/cn/k8s/worker.yaml) (Deployment
`worker`, Secret `goapply-worker-env`, 90-minute drain window), built and
rolled out by `.github/workflows/deploy-cn.yml` from this Dockerfile. The
base has `replicas: 0`; the release sets the count (`CN_WORKER_REPLICAS`).
Scale by that count with the same agent name. `k8s.yaml` in this folder is
only a pointer to that manifest.

The worker prints one line per process at start, e.g.
`backends llm_backend=openai_compatible stt_backend=dashscope_paraformer tts_backend=dashscope_cosyvoice dashscope_key=set`,
followed by `CONFIG:` lines for anything misconfigured. Each session logs the
backends it used (`backends={llm:openai_compatible@api.deepseek.com, stt:…, tts:… voice=…}`).

## Stages

- **CN-0** (before ICP): GoApply LiveKit Cloud project in an Asia region,
  this worker on a host near Asia, domestic LLM + DashScope speech. WebRTC
  crosses the border; the client network pre-check offers text practice on a
  weak connection.
- **CN-1**: self-hosted LiveKit in Shanghai (`CN_VOICE_PROVIDER=livekit_selfhosted`
  on the control plane), this worker on ACK in cn-shanghai. Nothing in the
  worker changes between stages except `LIVEKIT_*`.

## Checks before turning GoApply voice on

1. Control plane: `CN_LIVEKIT_*`, `CN_LIVEKIT_AGENT_CALLBACK_SECRET`,
   `CN_LLM_INTERVIEW_MODEL`, `CN_INTERVIEW_ENGINE_STT_MODEL`,
   `CN_INTERVIEW_ENGINE_TTS_MODEL`, `CN_S3_*` (see the root `.env.example`).
2. Worker: `worker.env.example` filled, same LiveKit project and secret.
3. Worker log: the startup banner shows `agent_name=GoApply-Interview` and
   the GoApply LiveKit host; the backends line has no `CONFIG:` lines after it.
4. One practice session: greeting audible, transcript turns arrive, report generated.

## Websocket fixtures

The DashScope plugins are tested offline against fixtures in
`src/plugins/dashscope/fixtures/` (replayed by `replay.ts`). The fixtures in
the repo follow the published DashScope protocol; replace them with live
captures once a key is available (needs a mainland network path):

```bash
npm run build
DASHSCOPE_API_KEY=… node dist/plugins/dashscope/record-fixture.js stt sample-16k.pcm out-stt.json
DASHSCOPE_API_KEY=… node dist/plugins/dashscope/record-fixture.js tts "请先做个自我介绍。" out-tts.json
```

The recorder uses the worker's own connection settings (`DASHSCOPE_WS_URL`,
`DASHSCOPE_WORKSPACE`, mainland endpoint enforced). Recordings keep protocol
frames only: the key is never written and the task id becomes `{{task_id}}`.
Use a test recording, never a candidate's audio.

The STT capture prints `usage.duration` next to each final sentence's
`end_time`. The plugin reports each sentence's `usage.duration` as billed
audio; if the capture shows a running total instead, `stt.ts` must report only
the increase. Also confirm in the capture that the `heartbeat` parameter is
accepted and that CosyVoice audio arrives as raw binary PCM frames.
