# Runbook: GoApply mainland deployment (CN-1) and the CN-0 → CN-1 migration

**Owner:** ops, with the product owner's sign-off on every step marked **[owner]**.
**Kit:** `deploy/cn/` (WP-76). **Plan of record:** `docs/jobright-clone/CN_TW_LAUNCH_PLAN.md` §3 (stages), §5.2–5.3 (accounts and env), §6.1 (C-1…C-17), §6.2 (hosting).
**Status:** the kit is ready; nothing is deployed. CN-1 is blocked on the Part C filings, not on code.

This is not legal advice. The legal gates below come from the launch plan and need PRC counsel's sign-off.

---

## 1. What runs where

One repository, one commit, two deployments. Vercel serves RoboApply (and the GoApply CN-0 beta). The mainland stack serves GoApply only. Behaviour differs only by environment (`DEPLOY_REGION`, `ALLOWED_BRANDS`, `CN_*`).

| Piece | Image (built from) | In the cluster | Notes |
|---|---|---|---|
| Gateway | `goapply-gateway` (`deploy/cn/Dockerfile.gateway`, config `deploy/cn/nginx.conf`) | Deployment `gateway` ×2 + Service `gateway` (type LoadBalancer → Aliyun SLB) | The only public entry. `/api/v1/*` → API, everything else → web (mirrors `vercel.json`). `/api/v1/cron/*` answers 404 from outside, in any letter case. Resolves the visitor's address from the SLB hop only and overwrites `X-Forwarded-For` / `X-Real-IP` (per-IP rate limits depend on it). |
| Web | `goapply-web` (`deploy/cn/Dockerfile.web`, Next.js standalone) | Deployment `web` ×2, Service `web:3000` | Server-side SEO reads go to `http://api:4607` (runtime `NEXT_PUBLIC_API_URL`). |
| API | `goapply-api` (`deploy/cn/Dockerfile.api`, `node server/dist/app.js`) | Deployment `api` ×2, Service `api:4607`, initContainer `preflight` | `ROBOAPPLY_CRON_DISABLED=true`: no node-cron; the CronJobs below run the sweeps. |
| Crons | `goapply-api` (runs `deploy/cn/cron-call.mjs`) | 16 CronJobs `cron-*` (`deploy/cn/k8s/cronjobs.yaml`) | Generated from `vercel.json` by `scripts/gen-cn-cronjobs.mjs`; UTC schedules; `Authorization: Bearer $CRON_SECRET` to the API Service. |
| Voice worker | `goapply-worker` (`interview-agent/deploy/cn/Dockerfile`) | Deployment `worker`, **0 replicas** until voice is ready | Agent name `GoApply-Interview`. Needs the self-hosted CN LiveKit and WP-63b's domestic backend. Text practice needs no worker. |
| Database | Aliyun RDS PostgreSQL (cn-shanghai), same VPC | — | Reached over the VPC private address (passes the residency check without a suffix list). |
| Object storage | Aliyun OSS (`CN_S3_*`) | — | No fallback to the international bucket. |

Five vercel.json crons are deliberately **not** mirrored (listed with reasons at the top of `cronjobs.yaml`): the V1 auto-apply sweeps `daily-matcher`, `submitter`, `catchup` (D1: nothing submits on the user's behalf), the V1 `digest`, and the retired `billing-friday-nudge`.

## 2. Gates before the first production deploy

Do not point `goapply.top` at the mainland stack until each of these is done (launch plan §3, §6.1):

- [ ] **[owner]** C-1 entity decision; C-2 domain under the entity; **C-3 ICP 备案** (the SLB needs an ICP-filed domain to serve HTTP/HTTPS in the mainland).
- [ ] **[owner]** C-5 PIPL package; `CN_LEGAL_DOCS_VERSION` set to the counsel-approved documents.
- [ ] **[owner]** C-6 生成式AI 登记 (counsel decides whether the soft launch can wait for it), with `CN_GENAI_DISCLOSURES` filled.
- [ ] Content safety live: `CN_CONTENT_SAFETY_PROVIDER=aliyun_green` with keys; the large-model moderation services turned on in the Aliyun console.
- [ ] C-7 SMS signature and OTP template (phone login); C-8 WeChat (optional for the soft launch).
- [ ] C-4 公安备案 is filed **within 30 days of go-live**; set `CN_PSB_*` when it is granted.
- [ ] Payments stay off (`CN_PAYMENTS_ENABLED=false`) until C-12 (EDI licence) and C-13.

The API refuses to boot if the residency assertions fail, and the preflight (§7) refuses a few more cases. Neither replaces the list above.

## 3. One-time cloud setup (Aliyun, cn-shanghai)

1. **VPC** with IPv4 and IPv6 CIDRs (dual stack), vSwitches in two zones.
2. **ACK** managed cluster in that VPC, Kubernetes ≥ 1.27 (CronJob `timeZone`), Terway CNI with NetworkPolicy enabled, dual-stack if offered. Node pool sized for ~6 vCPU / 12 GB to start. Nodes booted with IPv6 disabled in the kernel (`ipv6.disable=1`) are fine: the gateway adds its IPv6 listener only when `/proc/net/if_inet6` exists (`deploy/cn/gateway-listen-ipv6.sh`) and logs which one it chose.
3. **ACR** (Enterprise edition recommended) in cn-shanghai, namespace `goapply` (or set `ALIYUN_ACR_NAMESPACE`). Mirror the base images there if you will build inside the mainland (`node:24-slim`, `nginxinc/nginx-unprivileged:1.28-alpine`).
4. **RDS PostgreSQL 16** in the same VPC. Create the database and a role for the app; enable `pg_trgm` once (`server/prisma/sql/000_extensions.sql`). Use the **VPC private address** in `DATABASE_URL`.
5. **OSS** bucket (private, server-side encryption on) in cn-shanghai; an AccessKey for a RAM user limited to that bucket → `CN_S3_*`.
6. **SLB certificate** for the ICP-filed domain uploaded to the SLB certificate service; note its id (`ACK_SLB_CERT_ID`).
7. **Visitor address:** the gateway's listeners are layer 7 (`http:80`, `https:443`), so the SLB connects to the pods from its own backend range and puts the visitor's address at the end of `X-Forwarded-For` (CLB layer-7 listeners always add it). `deploy/cn/nginx.conf` trusts only `100.64.0.0/10`, the Aliyun SLB backend range. If you choose an SLB type that connects from another range, add that range to `set_real_ip_from` (never `0.0.0.0/0`); otherwise every visitor shares the SLB's address and the per-IP limits throttle normal traffic. §7 has the check.
8. **IPv6:** the gateway Service asks for `PreferDualStack`. Whether the SLB itself answers on IPv6 depends on the SLB type (CLB IPv6 instances are IPv6-only; ALB/NLB can be dual stack). Decide with the network test (C-16) and adjust the annotations in `deploy/cn/k8s/gateway.yaml`. The annotation names there are the ACK cloud-controller-manager's; check them against your cluster's CCM version before the first apply.
9. **Deploy identity for CI:** a ServiceAccount in `goapply` with a Role allowing `get/list/watch/create/update/patch` on deployments, services, cronjobs, poddisruptionbudgets, networkpolicies and `get` on namespaces; export a kubeconfig for it, base64 it → GitHub secret `ACK_KUBECONFIG_B64`. The ACK API endpoint must be reachable from GitHub-hosted runners (public endpoint with an allowlist) — or run the deploy job on a self-hosted runner inside the VPC.

## 4. Configuration and secrets

Nothing secret lives in git. Three Secrets in namespace `goapply`, created from local files that never leave the operator's machine:

```bash
kubectl apply -f deploy/cn/k8s/namespace.yaml
cp deploy/cn/cn.env.example     deploy/cn/.env.cn      # .env* is git-ignored; fill it
cp deploy/cn/cn.web.env.example deploy/cn/.env.cn.web  # fill it
kubectl -n goapply create secret generic goapply-api-env    --from-env-file=deploy/cn/.env.cn
kubectl -n goapply create secret generic goapply-web-env    --from-env-file=deploy/cn/.env.cn.web
kubectl -n goapply create secret generic goapply-worker-env --from-env-file=deploy/cn/.env.cn.worker   # only with voice
kubectl -n goapply create secret docker-registry acr-pull \
  --docker-server=<acr host> --docker-username=<user> --docker-password=<password>
```

- **`goapply-api-env`**: everything in `deploy/cn/cn.env.example` (names only; the repository-root `.env.example` has the full catalogue with comments). Generate **fresh** `JWT_SECRET`, `CRON_SECRET`, `INTERNAL_API_SECRET` for the mainland. `SENSITIVE_DATA_KEY`: see §8.6.
- **`goapply-web-env`**: only what the web server reads, names in `deploy/cn/cn.web.env.example`:
  - `INTERNAL_API_SECRET` (same value as the API), `CN_CANONICAL_ORIGIN`, `BAIDU_SITE_VERIFICATION` (no `CN_` prefix), and `BRAND_HOST_MAP` if you serve extra hostnames;
  - the values the legal pages (`/legal/[doc]`) fill in, same values as the API: `CN_LEGAL_ENTITY_NAME`, `CN_LEGAL_POSTAL_ADDRESS`, `CN_SUPPORT_EMAIL`, `CN_COMPLAINT_EMAIL`, `CN_COMPLAINT_PHONE`, `CN_LEGAL_DOCS_VERSION`, and optionally `CN_TAKEDOWN_CONTACT` (falls back to the support address). Without them the GoApply privacy policy and terms show 未披露 for the operator and complaint contacts and 草稿 for the version, which fails the C-5 disclosure.

  Do not give the web pods database or vendor credentials.
- **`goapply-worker-env`**: the CN LiveKit (`LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`), `LIVEKIT_AGENT_CALLBACK_SECRET` (= the API's `CN_LIVEKIT_AGENT_CALLBACK_SECRET`) and WP-63b's backend variables (`LLM_BACKEND`, `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`, `STT_BACKEND`, `TTS_BACKEND`, `DASHSCOPE_API_KEY`, …).
- **Fixed by the manifests** (and not overridable from a Secret): `NODE_ENV=production`, `DEPLOY_REGION=cn-mainland`, `ALLOWED_BRANDS=goapply`, `ROBOAPPLY_CRON_DISABLED=true`, `FILE_LOGGING=false`, ports, `HOSTNAME=0.0.0.0` (web).

To change a value: edit the local file, `kubectl -n goapply create secret generic goapply-api-env --from-env-file=… --dry-run=client -o yaml | kubectl apply -f -`, then `kubectl -n goapply rollout restart deployment/api` (or `goapply-web-env` and `deployment/web`). A legal value lives in both files; change both.

## 5. Build and check the images locally

From the repository root. Each command below either lints/validates without building, or builds without deploying.

```bash
# Lint the Dockerfiles (builds nothing)
docker build --check -f deploy/cn/Dockerfile.api .
docker build --check -f deploy/cn/Dockerfile.web .
docker build --check -f deploy/cn/Dockerfile.gateway .

# Validate compose and render the Kubernetes manifests offline
cp deploy/cn/cn.env.example deploy/cn/.env.cn && docker compose -f deploy/cn/compose.yaml config --quiet
kubectl kustomize deploy/cn/k8s > /dev/null
node scripts/gen-cn-cronjobs.mjs --check
npx vitest run __tests__/deploy

# Build the images (no push)
docker build -f deploy/cn/Dockerfile.api     -t goapply-api:local .
docker build -f deploy/cn/Dockerfile.web     -t goapply-web:local .
docker build -f deploy/cn/Dockerfile.gateway -t goapply-gateway:local .
docker build -f interview-agent/deploy/cn/Dockerfile -t goapply-worker:local interview-agent

# Building inside the mainland: npm mirror + base images from ACR
docker build -f deploy/cn/Dockerfile.api \
  --build-arg NPM_REGISTRY=https://registry.npmmirror.com/ \
  --build-arg NODE_IMAGE=<acr host>/<ns>/node:24-slim -t goapply-api:local .
```

A whole-stack smoke run on one machine: `docker compose -f deploy/cn/compose.yaml --profile localdb up --build`, then open `http://goapply.localhost:8080`. The preflight checks the configuration's shape (keys present, hosts allowed), not whether vendor credentials work, so test values pass it locally. Never use production credentials in a local smoke run.

`npm run build` / `next build` must not run in a checkout where `next dev` is running (they share `.next`); the Docker build is isolated from that.

## 6. Schema on the mainland database **[owner]**

Schema changes are never automated (the workflow cannot touch a database). For the first deploy and after every schema change on `main`:

1. From a bastion inside the VPC (the database is not public), check out the commit being deployed and run `npm ci`.
2. Diff first (read-only; `prisma.config.ts` uses `DIRECT_DATABASE_URL`): `DIRECT_DATABASE_URL=<RDS, direct> npx prisma migrate diff --from-config-datasource --to-schema server/prisma/schema --script > diff.sql` and review it. Additive only, as on Neon (no `DROP`, no `ALTER COLUMN`), unless the owner approved otherwise.
3. **The owner confirms**, then: `DIRECT_DATABASE_URL=<RDS, direct> npx prisma db push`.
4. Re-run the diff; it must be empty.

Deploy the code **after** the schema: the generated client selects every column on default reads, so a missing column is a 500 (P2022) on the affected screens.

## 7. Deploy

### With GitHub Actions (normal path)

Secrets: `ALIYUN_ACR_REGISTRY`, `ALIYUN_ACR_USERNAME`, `ALIYUN_ACR_PASSWORD`, `ACK_KUBECONFIG_B64`, optional `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` (32-byte base64; keeps Server Functions valid across builds).
Variables: `ACK_SLB_CERT_ID` (required to deploy), `ALIYUN_ACR_NAMESPACE` (default `goapply`), `CN_WORKER_REPLICAS` (default `0`), `CN_NPM_REGISTRY`, `NEXT_PUBLIC_CN_EXT_ID`, `NEXT_PUBLIC_CN_EXT_STORE_URL`.
Create a GitHub **environment** `cn-production` with required reviewers; the deploy job waits for approval.

Run **Actions → deploy-cn → Run workflow** on the commit to ship. Without the ACR/ACK secrets it stops at the first job with a notice and builds nothing. Otherwise: kit tests + cron parity → four images pushed to ACR tagged with the commit sha → overlay rendered → server-side dry run → apply → rollout status. Images are built on GitHub's offshore runners and pushed to ACR Shanghai; expect slower pushes, or move the build job to a self-hosted runner in the mainland with `CN_NPM_REGISTRY` set.

### By hand

```bash
node deploy/cn/render-overlay.mjs --registry <acr host> --namespace goapply --tag <sha> \
  --slb-cert-id <cert id> --worker-replicas 0 --out deploy/cn/overlays/prod
kubectl apply -k deploy/cn/overlays/prod --dry-run=server
kubectl apply -k deploy/cn/overlays/prod
kubectl -n goapply rollout status deployment/api deployment/web deployment/gateway
```

`deploy/cn/overlays/` is generated output; do not commit it.

### After every deploy

- `kubectl -n goapply logs deploy/api -c preflight` shows `CN-1 preflight: OK` (a refusal lists codes such as `content_safety_not_cn1_ready`, never values).
- `curl -sS https://www.goapply.top/api/v1/health` and `/api/health` answer `ok: true`.
- The cron sweeps are closed from outside, in any letter case: `for p in cron CRON Cron; do curl -sS -o /dev/null -w '%{http_code}\n' https://www.goapply.top/api/v1/$p/queue-drain; done` prints **404** three times.
- The visitor address cannot be forged: `curl -sS -o /dev/null -H 'X-Forwarded-For: 203.0.113.9' https://www.goapply.top/healthz`, then `kubectl -n goapply logs deploy/gateway --tail=50 | grep healthz` shows **your own** public address on that line, not `203.0.113.9` and not a `100.64.x.x` SLB address. If it shows a `100.64.` address, the SLB is not adding `X-Forwarded-For` or connects from another range (§3 step 7); do not open sign-up until this is right, because login, SMS and signup rate limits are keyed on it.
- The legal pages are complete: `curl -sS https://www.goapply.top/legal/privacy | grep -cE '未披露|草稿'` prints **0** (same for `/legal/terms`).
- `curl -sS https://www.goapply.top/api/v1/public/brand` reports brand `goapply`.
- One cron by hand: `kubectl -n goapply create job --from=cronjob/cron-queue-drain manual-$(date +%s)` and read its log (`answered 200`).
- Sign up with a test phone number, upload a resume, run a text practice session, export a PDF (the AI label appears), then delete the test account.

Rollback: `kubectl -n goapply rollout undo deployment/<name>` (images are immutable by sha), or re-run the workflow on the previous commit. A schema change is not rolled back by a code rollback.

## 8. CN-0 → CN-1 data migration (C-17) **[owner]**

Moves GoApply users' rows from the offshore database (Neon, CN-0 beta) to RDS, then removes them offshore. RoboApply data never leaves Neon: every exported row is scoped to `brand = 'goapply'` (or to a GoApply user, or to market `cn` for ownerless catalogue rows).

**8.1 Fourteen days before (T-14).** Notify every GoApply beta user (email + in-app announcement) with the date, the downtime window, what moves, where it will be stored (mainland China), and how to delete their account instead. Counsel approves the text. Record the send.

**8.2 Prepare (T-14 … T-1).** CN-1 stack deployed (§7) with the schema at the same commit as Vercel (§6) and smoke-tested with test accounts only. Generate and review the plan on the commit being migrated:

```bash
node deploy/cn/migration/plan.mjs --out ~/cn-migration     # renders SQL only, connects to nothing
```

Read `report.json` with the owner:
- `tables`: each table and the rule that scopes it (`brand`, `market`, `user`, `userId`, `parent`, `manual`). The `manual` ones are reviewed entries in `MANUAL_SCOPES` (`plan.mjs`) for tables that hold a user's id without a foreign key: `AIAuditLog` (`actorUserId`), `MemoryEntry` (`scope = 'user'`, `scopeId`) and `RoboApplyCoverLetterCache` (by its `resumeId`).
- `purgeOnly`: regenerable caches with users' text but no owner column (`InterviewTranscriptSegment`, `InterviewGraderResult`). They do not move; the purge deletes every row created before the freeze (§8.3), RoboApply's rows of that age included (they are recomputed on demand).
- `unscoped`: tables that neither move nor are purged (shared catalogues, RoboHire recruiter tables, config, runtime state). Every one of them that has a free-form payload (`Json`, `@db.Text`) or a user-like id column is also listed under `issues` as `unscoped_personal_data`. Go through each with the owner: confirm it holds no GoApply user's data, or add a reviewed `MANUAL_SCOPES` / `PURGE_ONLY` entry and regenerate. Do not start §8.4 with one unexplained.
- `issues`: `unscoped_personal_data` (above), `required_fk_to_unscoped` (the import fails unless the referenced rows exist), `optional_fk_to_unscoped` (null the column or move the rows), `self_reference` and `fk_cycle` (import order within the table; an RDS privileged account can relax FK checks for the session), `multiple_user_relations`, `stale_manual_entry` (a `MANUAL_SCOPES` / `PURGE_ONLY` table that no longer exists).

Lower the DNS TTL of `goapply.top` to 300 s.

**8.3 Freeze (cutover day).** Stop CN-0 writes: on Vercel set `ALLOWED_BRANDS=roboapply` and redeploy, so the offshore stack no longer serves GoApply. From here until §8.5 GoApply is unavailable. **Record the time the redeploy went live, in UTC**: it is the freeze time the purge (§8.8) needs.

**8.4 Export → transfer → import.**
1. On a hardened operator machine with an encrypted disk: `cd ~/cn-migration && psql "$NEON_DIRECT_DATABASE_URL" -v ON_ERROR_STOP=1 -f export.sql` (one read-only snapshot) and `psql … -f verify-source.sql > source-counts.txt`.
2. Copy `data/` and `source-counts.txt` to a bastion in the mainland VPC over SSH (or a private OSS bucket with server-side encryption). The CSVs hold personal data: no email, no chat tools, no laptops without disk encryption. Log who copied what, when.
3. On the bastion: `psql "$RDS_DIRECT_DATABASE_URL" -v ON_ERROR_STOP=1`, then `\i import.sql`, then `\i verify-target.sql`; compare with `source-counts.txt`. **COMMIT** only if every count matches; otherwise `ROLLBACK`, fix, repeat.
4. Files in object storage: CN-0 stores no resume originals or photos for GoApply by default (WP-15 upload policy). If any GoApply object exists in the international bucket (check the migrated rows' storage keys), copy those objects to the `CN_S3_BUCKET` with the same keys before cutover.

**8.5 Cut over.** Point `goapply.top` / `www.goapply.top` at the SLB. Smoke test (§7, "After every deploy") with a migrated test account. GoApply users sign in again (the mainland `JWT_SECRET` is new); passwords and phone logins carry over.

**8.6 Encrypted fields.** Values encrypted with CN-0's `SENSITIVE_DATA_KEY` must stay readable: set the mainland `SENSITIVE_DATA_KEY_PREVIOUS` to CN-0's key and a fresh `SENSITIVE_DATA_KEY` (with `SENSITIVE_DATA_KEY_VERSION`), so old values decrypt and new writes use the new key. Remove the previous key only after every value has been re-encrypted.

**8.7 Verification window (7 days).** Keep a Neon branch/backup of the pre-purge state for these 7 days only. Watch error rates and support requests. Rollback during the window = DNS back to Vercel + `ALLOWED_BRANDS=roboapply,goapply` on Vercel (writes made on CN-1 in between must then be reconciled by hand).

**8.8 Purge offshore [owner, written go-ahead].** After the window, in one interactive session:

```
psql "$NEON_DIRECT_DATABASE_URL" -v ON_ERROR_STOP=1
\set cn_freeze_at '<freeze time from §8.3, UTC>'
\i purge-source.sql     -- snapshots the GoApply user ids, deletes children first, leaves the transaction open
\i verify-purge.sql     -- same session: every count must be 0
COMMIT;                 -- only then; otherwise ROLLBACK;
```

`purge-source.sql` stops before doing anything if `cn_freeze_at` is not set. Run `verify-purge.sql` before `COMMIT`: it reads the user-id snapshot, which is dropped at commit (`verify-source.sql` after the purge proves nothing, because it finds GoApply users through the `User` rows just deleted). Delete the 7-day Neon branch, the CSV files on every machine, and the OSS transfer copy. Record the deletion (date, operator, table counts, approver) in the compliance log. Set Vercel `ALLOWED_BRANDS=roboapply` permanently.

## 9. Operating the stack

- **Logs:** every container logs to stdout/stderr (`FILE_LOGGING=false`); ship them with the ACK log component to SLS in cn-shanghai. Nothing is sent to an offshore log service.
- **Crons:** `kubectl -n goapply get cronjobs,jobs`. A failed call is a failed Job (`failedJobsHistoryLimit: 3`); the API's own log has the sweep's report. `concurrencyPolicy: Forbid` skips a tick rather than overlapping, as Vercel would not run two at once either.
- **When vercel.json crons change** (a sweep is added, removed or rescheduled): run `node scripts/gen-cn-cronjobs.mjs`, commit the regenerated `deploy/cn/k8s/cronjobs.yaml`. The parity test (`__tests__/deploy/cronParity.test.ts`) and the workflow's `--check` fail until you do.
- **Web caching:** each web replica keeps its own Next.js cache; `seo-rebuild` revalidates through the public origin, which reaches one replica. The others catch up within the page TTL (15 min). If that matters, run one web replica or add a shared cache handler.
- **Scaling:** `api` and `web` are stateless; raise `replicas` in the manifest (an apply resets manual scaling). The worker drains for up to 90 minutes on rollout.
- **Shutdown:** on SIGTERM the API stops its cron mirror, stops accepting connections, drains in-flight requests for up to 305 s (`SHUTDOWN_DRAIN_TIMEOUT_MS`), disconnects the database and exits. The `preStop` delay still lets the Service drop the pod first, inside the 330 s grace period.

## 10. Known limits of the kit

- Annotation names for the Aliyun SLB (HTTPS listener, certificate, redirect, health check, IPv6) follow the ACK CCM documentation and were not exercised against a live cluster; verify them on the first deploy (`kubectl describe svc gateway`).
- The self-hosted LiveKit for CN-1 voice (L-11, C-16) is not part of this kit; the worker stays at 0 replicas until it exists.
- `next.config.mjs` adds one `next/image` remote pattern for `CN_PUBLIC_ASSET_BASE_URL` (a plain https origin, never a wildcard), and the deployment id for version-skew protection is the build argument `NEXT_DEPLOYMENT_ID` (the workflow passes the commit SHA). Both are build-time values of the web image (`deploy/cn/Dockerfile.web`); set the repository variable `CN_PUBLIC_ASSET_BASE_URL` before the first build.
- No mainland CDN in front of static assets yet; the gateway serves them from the web pods.
