# deploy/cn — GoApply mainland deployment kit (CN-1)

Containers, routing, Kubernetes manifests and scripts that run the same commit as the Vercel deployment on Aliyun ACK in cn-shanghai, for GoApply only. Nothing here deploys by itself.

**Runbook:** [`docs/runbooks/cn-deploy.md`](../../docs/runbooks/cn-deploy.md) (setup, secrets, schema, deploy, CN-0 → CN-1 migration).

## What the stack needs

Owner ruling D5 ([`docs/jobright-clone/GOAPPLY_PARITY_PLAN.md`](../../docs/jobright-clone/GOAPPLY_PARITY_PLAN.md)): GoApply has the same functions as RoboApply, and a China-specific provider is an optional override, never a prerequisite. So the kit asks for topology and nothing else:

1. **A database inside the mainland** (`DATABASE_URL` on a private address or an allowed host suffix), with `DEPLOY_REGION=cn-mainland` and `ALLOWED_BRANDS=goapply`, both fixed by the manifests.
2. **The platform secrets** (`JWT_SECRET`, `CRON_SECRET`, `INTERNAL_API_SECRET`).
3. **The shared credentials** GoApply runs on: a model provider key, `RESEND_API_KEY` with `ROBOAPPLY_EMAIL_FROM` (the verified sender of that Resend account; GoApply mail goes out from it under the name GoApply until `CN_EMAIL_FROM` names a verified `goapply.top` sender), `LIVEKIT_*`, `S3_*`, `VAPID_*` (the "Shared stack" section of `cn.env.example`).

With those, the preflight passes with warnings and GoApply works: AI, email, voice practice, uploads, the job feed from public employer boards, open sign-up with email and password, and its plans and prices. Payments open once `ALIPAY_CALLBACK_SECRET` (the Alipay rail's own credential) is set.

Every `CN_<NAME>` value in `cn.env.example` is an optional override of `<NAME>`: a domestic model, Aliyun OSS, Aliyun DirectMail, Aliyun Green, SMS and WeChat sign-in, GoApply's own LiveKit. Set one and it is used; leave it unset and that part runs on the shared stack. Settings that belong together are read as one set, decided by the group's anchor (`CN_S3_BUCKET`, `CN_LIVEKIT_URL`, both speech models, `CN_VAPID_PUBLIC_KEY`): without the anchor the other `CN_` values of that group are ignored, and startup names them in a warning.

## What the preflight refuses

`preflight.mjs` (the API initContainer) exits 1 only on topology:

| Refused | Why |
|---|---|
| `DEPLOY_REGION` is not `cn-mainland` | the mainland checks would assert nothing |
| no `DATABASE_URL`, or a database host outside the mainland allowlist | the data must be in-region |
| RoboApply is served (`ALLOWED_BRANDS` names it, or names no valid brand) | the international brand never runs on the mainland stack |
| no `CRON_SECRET`, node-cron on (`ROBOAPPLY_CRON_DISABLED` not `true`), `VERCEL` set | the CronJobs and listen mode would not work |

Everything else is printed as a warning and the API starts: no `CN_ICP_NUMBER`, a model route outside the mainland, no mainland bucket, content safety that is not Aliyun Green, an offshore email transport. On the shared stack GoApply data is processed by the same offshore processors as RoboApply, and the sign-up consent and processor list are generated from the stack in use.

**Strict mainland posture (opt-in).** An operator who has the domestic providers can set `CN_RESIDENCY_STRICT=true` (and with it `CN_LLM_DOMESTIC_ONLY` and `CN_STORAGE_MODE`): the warnings above become refusals again, GoApply personal data may go only to mainland endpoints, and uploads are refused without `CN_S3_*`. It is never implied by a missing value. Whether the production mainland deployment should run strict is a decision for counsel and the owner (parity plan §8, item 3). The filings themselves (ICP, 公安备案, licences) are the owner's legal track in the runbook; the code does not wait for them.

## Files

| File | What it is |
|---|---|
| `Dockerfile.web` (+ `.dockerignore`) | Next.js standalone server |
| `Dockerfile.api` (+ `.dockerignore`) | Express API in listen mode, node-cron off |
| `Dockerfile.gateway` (+ `.dockerignore`), `nginx.conf` | nginx routing that mirrors `vercel.json`; visitor address from the SLB hop only |
| `gateway-listen-ipv6.sh` | Gateway start-up step: adds the IPv6 listener only when the kernel has IPv6 |
| `k8s/` | Kustomize base: namespace, api, web, worker, gateway, network policies, CronJobs |
| `k8s/worker.yaml` | The one manifest of the interview voice worker for GoApply's **own** media plane. Image from `interview-agent/deploy/cn/Dockerfile`, Secret `goapply-worker-env` (names in `interview-agent/deploy/cn/worker.env.example`), `replicas: 0` until `CN_LIVEKIT_*` is configured. On the shared LiveKit project the shared worker serves GoApply and this Deployment stays at 0 |
| `k8s/cronjobs.yaml` | **Generated** from `vercel.json` by `scripts/gen-cn-cronjobs.mjs`; do not edit |
| `render-overlay.mjs` | Writes the release overlay (ACR image names, tag, SLB certificate, worker replicas) |
| `preflight.mjs` | Mainland readiness check (API initContainer): refuses a wrong topology, warns about the rest; refuses both under `CN_RESIDENCY_STRICT=true` |
| `cron-call.mjs` | What each CronJob runs: the authenticated cron call Vercel Cron would make |
| `compose.yaml`, `cn.env.example` | Local smoke run of the whole stack; API env names only (required topology, the shared stack, then the optional overrides and the strict block) |
| `cn.web.env.example` | Env names for the web pods' Secret (`goapply-web-env`), legal-page values included |
| `migration/plan.mjs` | Renders the SQL for the CN-0 → CN-1 data migration and the offshore purge (connects to nothing) |

Checks that build nothing: `docker build --check -f deploy/cn/Dockerfile.<x> .`, `kubectl kustomize deploy/cn/k8s`, `node scripts/gen-cn-cronjobs.mjs --check`, `npx vitest run __tests__/deploy`.
