# Railway recipe — RoboApply interview voice worker

Railway deploys straight from the repo with the worker's Dockerfile. Three
settings matter; everything else is defaults.

1. **Create the service**: New Project → Deploy from GitHub repo → set
   **Root Directory** to `interview-agent` (Railway then finds the Dockerfile).
2. **Variables** (Service → Variables):

   ```
   LIVEKIT_URL=wss://<project>.livekit.cloud
   LIVEKIT_API_KEY=...
   LIVEKIT_API_SECRET=...
   LIVEKIT_AGENT_CALLBACK_SECRET=...
   OPENAI_API_KEY=...
   INTERVIEW_ENGINE_AGENT_NAME=RoboApply-Interview
   WORKER_NUM_IDLE_PROCESSES=1

   # CRITICAL — Railway's default drain is 0 SECONDS: old deploys get SIGTERM
   # then an immediate SIGKILL, cutting live interviews mid-sentence. 300s is
   # the practical ceiling; deploy off-peak for long sessions.
   RAILWAY_DEPLOYMENT_DRAINING_SECONDS=300
   # Keep the old worker registered while the new one comes up (bluegreen-ish).
   RAILWAY_DEPLOYMENT_OVERLAP_SECONDS=60
   ```

3. **Never enable App Sleeping / Serverless** on this service — sleeping
   severs the worker's LiveKit registration socket and interviews dispatch to
   nobody. No public domain/networking is needed (the worker only dials out).

Scale: Service → Settings → Replicas. All replicas register under the same
agent name; LiveKit Cloud load-balances new interviews across them.
