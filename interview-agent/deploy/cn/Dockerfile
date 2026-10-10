# GoApply interview voice worker image (mainland China, CN-0 / CN-1).
#
# Same worker as ../../Dockerfile, built to run and build inside the
# mainland, with the domestic backend switch pinned so this image can never
# fall back to the LiveKit Inference gateway or OpenAI:
#   LLM_BACKEND=openai_compatible  (DeepSeek / Qwen / Kimi / GLM / Doubao / MiniMax)
#   STT_BACKEND=dashscope_paraformer, TTS_BACKEND=dashscope_cosyvoice
#   INTERVIEW_ENGINE_AGENT_NAME=GoApply-Interview
#
# Build from interview-agent/ (the build context is the package root):
#   docker build -f deploy/cn/Dockerfile -t goapply-interview-agent .
# Inside the mainland, point the base image and the package mirrors at
# reachable registries (Docker Hub and npmjs are not reliable there):
#   docker build -f deploy/cn/Dockerfile \
#     --build-arg NODE_IMAGE=registry.cn-shanghai.aliyuncs.com/<namespace>/node:24-slim \
#     --build-arg NPM_REGISTRY=https://registry.npmmirror.com \
#     --build-arg APT_MIRROR=mirrors.aliyun.com \
#     -t registry.cn-shanghai.aliyuncs.com/<namespace>/goapply-interview-agent:<tag> .
# Run (secrets from a file, never baked in): see README.md and worker.env.example.

ARG NODE_IMAGE=node:24-slim

# ── Stage 1: build (dev deps + tsc) ─────────────────────────────────────────
FROM ${NODE_IMAGE} AS build
ARG NPM_REGISTRY=https://registry.npmjs.org
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --registry="${NPM_REGISTRY}"
COPY src ./src
RUN npm run build

# ── Stage 2: production node_modules only ───────────────────────────────────
FROM ${NODE_IMAGE} AS deps
ARG NPM_REGISTRY=https://registry.npmjs.org
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --registry="${NPM_REGISTRY}"

# ── Stage 3: runtime ────────────────────────────────────────────────────────
FROM ${NODE_IMAGE}
ARG APT_MIRROR=
WORKDIR /app

# tini reaps the per-interview job subprocesses and forwards SIGTERM so the
# graceful drain runs on rollouts. APT_MIRROR swaps deb.debian.org for a
# mainland mirror when set.
RUN if [ -n "${APT_MIRROR}" ]; then \
      sed -i "s#deb.debian.org#${APT_MIRROR}#g" /etc/apt/sources.list.d/debian.sources 2>/dev/null || \
      sed -i "s#deb.debian.org#${APT_MIRROR}#g" /etc/apt/sources.list; \
    fi \
    && apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# Domestic pins (see header). Credentials are runtime env only.
ENV NODE_ENV=production \
    WORKER_HEALTH_HOST=0.0.0.0 \
    WORKER_HEALTH_PORT=8081 \
    INTERVIEW_ENGINE_AGENT_NAME=GoApply-Interview \
    WORKER_BRAND=goapply \
    LLM_BACKEND=openai_compatible \
    STT_BACKEND=dashscope_paraformer \
    TTS_BACKEND=dashscope_cosyvoice
EXPOSE 8081

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8081/').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js", "start"]
