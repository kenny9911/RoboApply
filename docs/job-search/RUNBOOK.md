# Job search operations

## Local configuration

Use Node 24 and the existing lockfile. The service uses the configured RoboApply PostgreSQL database, existing `ApiKey`/`ApiUsageRecord` models, and server-only `RAPID_API_KEY`. Each RapidAPI product requires its own subscription on the same app. Never put the upstream key in frontend environment variables or integration examples.

| Setting | Default | Meaning |
| --- | --- | --- |
| `JOB_SEARCH_PROVIDERS` | `jsearch,activejobs` | Website provider allowlist; also upper bound for API sources |
| `JOB_SEARCH_API_PROVIDERS` | empty | Sources with applicable integration redistribution rights; explicit grant, not subscription detection |
| `JOB_SEARCH_DISABLED` | false | Stop all sources, including cache retrieval |
| `JOB_SEARCH_TIMEOUT_MS` | 20000 | Per-source deadline, maximum 25000 ms |
| `JOB_SEARCH_AGENT_TIMEOUT_MS` | 15000 | Planning deadline, clamped to 50–30000 ms; existing intent-parser/fast/default LLM settings choose the model |
| `JOB_SEARCH_CACHE_TTL_MS` | 300000 | Service cache TTL; 0 disables service cache, existing adapter caches still apply |
| `JOB_SEARCH_USER_PER_MINUTE` | 10 | Shared owner request allowance per rolling minute |
| `JOB_SEARCH_USER_DAILY_LIMIT` | 100 | Shared owner request allowance per UTC day |
| `JOB_SEARCH_GLOBAL_DAILY_LIMIT` | 250 | Deployment-wide search attempts per UTC day |
| `JOB_SEARCH_HIRINGINDEX_DISABLED` | false | Optional Hiring Index hard-off switch |
| `JOB_SEARCH_HIRINGINDEX_DAILY_BUDGET` | 100 | Optional adapter’s process-local call cap; 0 disables it |

The existing `RA_ONBOARDING_*` switches and per-provider budgets remain honored despite their historical name. `RA_ONBOARDING_EXTERNAL_JOBS_DISABLED=true` stops all existing external sources. Hiring Index is optional: add `hiringindex` to the website allowlist only for an entitled account after reviewing the evaluation.

Any owner/deployment quota value of `0` stops searches. Invalid or unset values use the documented default. API calls without explicit provider selection query the website/API allowlist intersection; explicitly requested restricted sources still produce diagnostics.

The website requests one JSearch page per source search and up to 20 Fantastic rows. Provider retries can consume a second call. Fantastic’s default time frame is seven days; asking for `month` or `all` does not guarantee month-wide history from that source. The unified service cache is five minutes by default and legacy adapter caches can retain results for six hours; the returned `fetchedAt` preserves the original retrieval time.

The Job Search Agent adds one bounded planning step and at most two source searches. It uses the existing configured LLM stack; ensure that stack has a working credential/model before enabling the agent workflow. Each executed query consumes a shared search reservation, including the first reservation before planning. A two-query agent run can therefore consume two quota units. Failed planning consumes the first reservation. A later query hitting quota returns the earlier results with partial execution diagnostics. Source caches preserve their normal retrieval timestamps: pressing Search Job does not imply every original page was just crawled.

## Integrator onboarding

1. Record the applicable provider agreement for API distribution. Default partner access intentionally has no upstream sources. The website and code can be tested before any commercial data grant exists.
2. Configure `JOB_SEARCH_API_PROVIDERS` as a subset of subscribed/enabled website providers covered by that agreement. Restart/redeploy to apply the hosting environment change. Do not interpret a provider’s displayed availability as proof of its subscription or license.
3. Sign in and visit `/job-search/developers`. Create a named key; save the once-returned token in the consuming server’s secret store. Keys expire and can be revoked from the same page.
4. Fetch `/api/v1/job-search/providers`, then call `/api/v1/job-search/search`. Import `/api/v1/job-search/openapi.json` into the consuming client tool.

Example (the variable is supplied by the consuming application, never committed):

```sh
curl --request POST https://roboapply.io/api/v1/job-search/search \
  --header "Authorization: Bearer $ROBOAPPLY_JOB_SEARCH_KEY" \
  --header 'Content-Type: application/json' \
  --data '{"query":"software engineer","country":"tw","location":"Taipei","limit":10}'
```

This documents the route after deployment; it is not evidence that the current production host has this release. Applications must handle 200 with partial coverage, genuine empty results, 429 with `Retry-After`, and 503 without retry storms. Keep keys server-side. Current CORS is inherited from RoboApply; server-to-server integration does not require browser origins to be opened.

The same scoped key can invoke the natural-language agent:

```sh
curl --request POST https://roboapply.io/api/v1/job-search/agent/search \
  --header "Authorization: Bearer $ROBOAPPLY_JOB_SEARCH_KEY" \
  --header 'Content-Type: application/json' \
  --data '{"request":"Find remote backend engineering jobs in Taiwan posted this week. Visa sponsorship is important.","locale":"en","linkedinOnly":true,"limit":20}'
```

Omit country/location/date/remote/employment overrides to let the planner extract the request. Read `agent.criteria`, `agent.queries`, `agent.unverifiedPreferences`, and per-query `searches` together with normal job/source metadata. The source grants for API distribution apply equally to this endpoint. LinkedIn-only filters actual source evidence; it cannot turn an unentitled LinkedIn source on. See [LINKEDIN_STRATEGY.md](LINKEDIN_STRATEGY.md) before activating that provider.

## Validation

Run `node scripts/job-search-harness.mjs` for the bounded local regression gate. `--full` runs the whole repository suite and policy checks as well. The harness writes command outcomes to `logs/job-search-harness.json`; inspect failure logs and fix relevant failures before claiming success.

Run `npm run typecheck:server` and `npm run check`. Build with `npm run build` in an isolated checkout/copy if `next dev` is active, so development `.next` files remain intact. No database push is needed.

`node --import tsx scripts/job-search-smoke.ts` is a bounded live provider smoke using the existing configured website allowlist. It makes one search (at most two providers), prints aggregate counts/status/latency only, and does not persist postings or keys. Review the current subscription first; it does not sign up for any service. It is an operational probe, not a statistically meaningful coverage benchmark. Do not run it repeatedly against exhausted subscriptions.

For coverage experiments, use the protocol in [PROVIDER_EVALUATION.md](PROVIDER_EVALUATION.md). Separate declared publication dates from inferred dates and normalize pay periods before comparing salaries.

## Diagnosis and rollback

- **401 integration:** malformed, expired, revoked, wrong-scope key, or disabled owner. Session cookies and recruiter keys are not integration credentials.
- **503 / not_licensed:** no integration grant configured. Website results cannot be repackaged by bypassing the API audience.
- **503 / missing_credentials:** configure the upstream secret server-side.
- **503 / agent_unavailable:** planning failed, timed out, or returned an invalid plan. Verify the configured LLM stack and retry after recovery. No provider search is performed with an invalid plan.
- **error after enabled:** subscription, upstream quota, schema mismatch, or provider failure. Check sanitized logs and vendor dashboard. An enabled pre-check cannot validate the subscription.
- **429:** inspect owner/deployment reservations, size limits for the actual vendor billing unit, and wait for the documented window. Do not bypass limits by making more keys.
- **partial:** use returned results and provider diagnostics. Failed sources are not represented as successful empty inventories.

Emergency rollback: set `JOB_SEARCH_DISABLED=true`; API key revocation can additionally stop an individual integration. Disable only a source through the allowlist or its provider switch to preserve other coverage. No jobs are automatically applied to, no postings are persisted by search, and no schema rollback is required.
