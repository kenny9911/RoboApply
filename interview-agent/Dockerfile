# RoboHire Interview Engine — voice worker image (Node/TS).
# Deploy to LiveKit Cloud (`lk agent create`) or any host that can run a
# long-lived process and reach LiveKit Cloud + the control plane.

FROM node:22-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install deps (incl. tsc for the build) with layer caching.
COPY package.json package-lock.json* tsconfig.json ./
RUN npm install

COPY src ./src
RUN npm run build

# Pre-download Silero VAD + turn-detector models so cold-start is fast.
RUN node dist/main.js download-files || true

# `start` connects to LiveKit Cloud and waits for explicit dispatches.
CMD ["node", "dist/main.js", "start"]
