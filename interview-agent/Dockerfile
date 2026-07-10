# RoboApply Interview Engine — voice worker image (Node/TS).
#
# Portable by design: the worker only dials OUT (WSS to LiveKit Cloud + HTTPS
# callbacks to the control plane), so this image runs identically on a laptop,
# a VPS, Fly.io, Railway, Render, or Kubernetes — no inbound ports required.
# The exposed 8081 serves only the SDK's health endpoints (GET / → 200/503,
# GET /worker → JSON status) for container/platform probes.
#
# Build:  docker build -t roboapply-interview-agent .
# Run:    docker run --env-file .env.local roboapply-interview-agent
# Scale:  run N containers with the SAME INTERVIEW_ENGINE_AGENT_NAME —
#         LiveKit Cloud load-balances dispatches across registered workers.
#
# The Silero VAD model ships INSIDE @livekit/agents-plugin-silero (no runtime
# download), so the image is fully self-contained and cold-starts fast.

# ── Stage 1: build (dev deps + tsc) ─────────────────────────────────────────
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

# ── Stage 2: production node_modules only ───────────────────────────────────
FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ── Stage 3: runtime ────────────────────────────────────────────────────────
FROM node:24-slim
WORKDIR /app

# tini: the SDK runs each interview in a child job subprocess; PID 1 must reap
# zombies and forward SIGTERM so the worker's graceful drain (finish running
# interviews, reject new ones) actually happens on platform deploys/stops.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# Deterministic health bind for the HEALTHCHECK below and platform probes.
ENV NODE_ENV=production \
    WORKER_HEALTH_HOST=0.0.0.0 \
    WORKER_HEALTH_PORT=8081
EXPOSE 8081

# Never run a network-facing long-lived process as root.
USER node

# SDK health endpoint: 200 while healthy, 503 otherwise. node ships no curl —
# use the built-in fetch.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8081/').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

ENTRYPOINT ["/usr/bin/tini", "--"]
# `start` = production mode: registers with LiveKit Cloud, waits for explicit
# dispatches, and DRAINS on SIGTERM (finishes live interviews before exit —
# give the platform a generous kill timeout; see deploy/ recipes).
CMD ["node", "dist/main.js", "start"]
