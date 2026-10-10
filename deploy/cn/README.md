# deploy/cn — GoApply mainland deployment kit (CN-1)

Containers, routing, Kubernetes manifests and scripts that run the same commit as the Vercel deployment on Aliyun ACK in cn-shanghai, for GoApply only. Nothing here deploys by itself.

**Runbook:** [`docs/runbooks/cn-deploy.md`](../../docs/runbooks/cn-deploy.md) (setup, secrets, schema, deploy, CN-0 → CN-1 migration).

| File | What it is |
|---|---|
| `Dockerfile.web` (+ `.dockerignore`) | Next.js standalone server |
| `Dockerfile.api` (+ `.dockerignore`) | Express API in listen mode, node-cron off |
| `Dockerfile.gateway` (+ `.dockerignore`), `nginx.conf` | nginx routing that mirrors `vercel.json`; visitor address from the SLB hop only |
| `gateway-listen-ipv6.sh` | Gateway start-up step: adds the IPv6 listener only when the kernel has IPv6 |
| `k8s/` | Kustomize base: namespace, api, web, worker, gateway, network policies, CronJobs |
| `k8s/cronjobs.yaml` | **Generated** from `vercel.json` by `scripts/gen-cn-cronjobs.mjs`; do not edit |
| `render-overlay.mjs` | Writes the release overlay (ACR image names, tag, SLB certificate, worker replicas) |
| `preflight.mjs` | CN-1 readiness check (API initContainer) |
| `cron-call.mjs` | What each CronJob runs: the authenticated cron call Vercel Cron would make |
| `compose.yaml`, `cn.env.example` | Local smoke run of the whole stack; API env names only |
| `cn.web.env.example` | Env names for the web pods' Secret (`goapply-web-env`), legal-page values included |
| `migration/plan.mjs` | Renders the SQL for the CN-0 → CN-1 data migration and the offshore purge (connects to nothing) |

Checks that build nothing: `docker build --check -f deploy/cn/Dockerfile.<x> .`, `kubectl kustomize deploy/cn/k8s`, `node scripts/gen-cn-cronjobs.mjs --check`, `npx vitest run __tests__/deploy`.
