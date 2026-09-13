# Job search service and website

Version 1.1 · 2026-09-14

## Problem and outcome

RoboApply retained three external job adapters after the onboarding flow that called them was removed. Candidates need a working search across external sources, and integrators need the same search capability without coupling to RoboApply’s resume, onboarding, or match-scoring flows.

This release provides a search workspace at `/job-search`, developer key management at `/job-search/developers`, a public integration guide at `/developers/job-search`, and a versioned HTTP API. Existing personalized matches remain available at `/jobs`, with a link to external search. This scope completes the job-search product within the existing website; it does not replace resume editing, applications, or interview practice.

## Product decisions

- The primary **Search Job** action opens a Job Search Agent. Candidates describe the roles, places, and conditions they want in their own language. A bounded language-model plan produces up to two focused role queries; configured internet job sources supply the actual postings. It does not require uploading a resume.
- Advanced location, country, date, remote-only, and employment filters are optional explicit overrides. Leaving them at “From my request” lets the planner extract stated constraints. The resolved plan is visible with the results; the structured keyword API remains available.
- Initial website sources are JSearch and Active Jobs DB. LinkedIn via Fantastic.jobs and Hiring Index are optional. Additional APIs are researched in [PROVIDER_EVALUATION.md](PROVIDER_EVALUATION.md); researched does not mean integrated or subscribed.
- A result represents a posting, not a match score or a verified hiring probability. Show original application destination, contributing providers, publication date when known, retrieval time, and salary together with its currency and period.
- Unknown facts stay unknown. Retrieval time must not masquerade as publication time. Remote-only and known-fact filters must not invent a match from missing data.
- Duplicate postings collapse while preserving source attribution, with direct employer destinations preferred. A bounded search response must not claim to represent all available jobs.
- No automatic applications. The candidate chooses an original posting and follows its application link.
- LinkedIn-only means returned postings have LinkedIn provenance. It is not a promise of exhaustive LinkedIn coverage, official LinkedIn API access, or a fresh crawl of the original posting. Disabled providers are never enabled by a request. See [LINKEDIN_STRATEGY.md](LINKEDIN_STRATEGY.md).
- Initial market evaluation includes Taiwan/Asia and US/Europe; country input is global. No promised country coverage until measured. No subscriptions are purchased by the implementation.

## Website acceptance criteria

1. Signed-in candidates reach external search from `/jobs`; unauthenticated users return through login with their destination preserved.
2. Search filters are native accessible controls. Enter submits; loading prevents accidental duplicate submission; stale requests do not replace newer results.
3. Cards display role, employer, location or unknown state, salary with period or undisclosed state, remote evidence, sources, dates, and an original application link. Detailed descriptions remain inert text.
4. The interface distinguishes not-yet-searched, loading, successful empty, partial source coverage, all sources unavailable, validation error, and quota exhaustion.
5. Source availability means configured/readiness checks, not verified subscription health. Actual search outcomes show per-source success or failure.
6. Key management supports named keys, expiry, one-time token display/copy, list, and revoke. It never displays another owner’s key or stores raw tokens in browser persistence.
7. All new copy ships in the nine existing locales; controls work at mobile and desktop widths and in both themes.

## Service architecture

`website / integrator → Express route → identity + durable quota → HTTP-independent search service → authorized provider adapters → normalization/filtering → deduplication → bounded results`

`server/src/job-search/types.ts` is the canonical transport contract; the frontend imports through `lib/api/job-search-types.ts`. Browser requests remain under `lib/api/` and use same-origin API paths. Provider credentials remain server-side.

The service owns input validation, bounded parallel provider requests, deadlines, abort propagation, in-flight coalescing, and a bounded process cache. Existing adapters retain their local cache, breaker, and daily-call controls. Process-local optimizations do not represent a cross-instance spending guarantee; durable route quotas provide the shared request cap.

## Job Search Agent

The agent executes `natural-language brief → validated query plan → bounded provider searches → provenance filtering → cross-query deduplication → original postings`. The planner uses RoboApply’s configured LLM stack and never generates job listings or application URLs. Results come only from the existing normalized source service. This release plans and searches on demand; it does not run a background crawl or send applications.

The request is 10–2,000 characters. Supported hard filters are country, city/location, remote-only, publication window, and employment types. Explicit controls override extracted values. The response exposes the exact queries and resolved criteria. Nuanced or unsupported preferences, including salary and sponsorship conditions, appear as unverified preferences to check in the original postings; the UI does not imply those conditions were proven or enforced.

There are at most two role queries per agent request. Every executed query consumes a durable shared search reservation. The first reservation precedes planning, bounding requests to the configured LLM as well as provider searches. A second-query failure must retain successful first-query jobs and mark partial coverage, with per-query source diagnostics. Planner failure returns `503 agent_unavailable`; it must not turn a long natural-language request into a literal job title or fabricate a fallback plan. Invalid input shape and unavailable source readiness are rejected before planning. If planning finds no role or occupational keyword, the response is `400 invalid_request` and asks for a clearer role; that attempted planning reservation still counts.

Agent routes use exactly the same session/scoped-key authentication and website/API source rights as structured search. A natural-language request cannot enable a provider, change the audience, bypass quotas, or access a website-only cached result through the integration API.

Website access and integration access are separate audiences. `JOB_SEARCH_PROVIDERS` enables sources for the website. An integration source must also appear in `JOB_SEARCH_API_PROVIDERS`, which defaults to empty. Default API searches select that intersection; an explicit request for a restricted provider reports its unavailable status. This separation is enforced before retrieval and incorporated in cache identity, including contributing sources of merged records. A website cache cannot expose restricted provider results through the API.

## API contract

The authoritative machine-readable contract is generated from `server/src/job-search/openapi.ts` and served at **GET `/api/v1/job-search/openapi.json`** without authentication.

| Audience | Method/path | Behavior |
| --- | --- | --- |
| Integrator | GET `/api/v1/job-search/providers` | Source availability for the API audience |
| Integrator | POST `/api/v1/job-search/search` | Normalized bounded search |
| Integrator | POST `/api/v1/job-search/agent/search` | Natural-language planning and bounded search, same scoped key and source grants |
| Website session | GET `/api/v1/roboapply/v2/job-search/providers` | Website source availability |
| Website session | POST `/api/v1/roboapply/v2/job-search/search` | Same search contract, website rights |
| Website session | POST `/api/v1/roboapply/v2/job-search/agent/search` | Job Search Agent, website rights |
| Website session | GET/POST `/api/v1/roboapply/v2/job-search/keys` | List or create owner-scoped keys |
| Website session | DELETE `/api/v1/roboapply/v2/job-search/keys/:id` | Revoke, retaining audit attribution |

Integration authentication: `Authorization: Bearer rajs_…`. Keys carry only `jobs:search`, expire in 90 days by default (1–365 days configurable on creation), and are limited to five unexpired active keys per owner. Only SHA-256 digests are persisted. New integration keys do not grant login, resume access, broad legacy API permissions, or key management. Legacy API keys cannot use the website route to bypass the integration source policy.

Search input: query (2–160 characters), optional location (≤120), country (real ISO alpha-2; default `us`), optional `remote`, `datePosted` (`all`, `today`, `3days`, `week`, `month`), normalized employment types, provider IDs, and integer `limit` (1–50; default 20). Unknown fields and unsupported provider IDs fail validation before paid work.

Response: `{jobs, meta}`. `meta` includes request ID, returned count, duplicates collapsed, per-provider status/count, partial coverage, search time, and cache outcome. `jobs` include stable posting IDs, employer/title, description, application URL, contributing sources, nullable factual fields, and original fetch timestamps.

Agent response: the same `{jobs, meta}` plus `agent` (planned queries, resolved criteria, unverified preferences, LinkedIn-only setting) and `searches` (per-query provider outcomes and any partial execution error). Agent input uses `request` instead of `query`, optional explicit search filters, optional supported UI `locale`, and optional `linkedinOnly`. The OpenAPI document defines the full schema and examples.

HTTP outcomes: 200 if at least one provider succeeds (including genuine empty results); 400 invalid request or malformed JSON; 401 invalid integration authentication; 403 session-only endpoint misuse; 413 oversized request body; 429 shared quota with `Retry-After`; 503 when no source is available or a service dependency fails. Errors use `{error, code, requestId}`; source-unavailable errors also carry diagnostic `data` in the search-result shape. Every response has `X-Request-Id`; credential and search responses use `Cache-Control: no-store`.

## Usage and operations

No new Prisma migration is required. Scoped hashed keys reuse `ApiKey`; durable reservations reuse `ApiUsageRecord`. Soft revocation preserves existing audit relationships. No database schema is pushed by this work.

A PostgreSQL advisory transaction lock with explicit Read Committed isolation serializes quota checking and reservation across replicas. A reservation is created before upstream calls; storage failure fails closed. Defaults: 10 requests/minute per owner, 100/day per owner, 250/day deployment-wide. Setting any quota to zero stops searches. Website and integration requests share the owner allowance. Multiple keys cannot multiply it. The global request cap bounds searches, not a currency-denominated bill: result-metered providers, retries, pages, and existing upstream limits must be included when sizing a subscription.

Cached and failed attempts count. Validation rejection and all-disabled providers do not reserve. Status and duration finalize the reservation; a crash or accounting-finalization failure retains the reservation. Records contain no resume, search query, raw job content, or API token.

Configuration, smoke checks, rollback, and commercial activation requirements are in [RUNBOOK.md](RUNBOOK.md).

## Delivery plan and gates

1. **Provider evaluation:** primary-source comparison, verified endpoint identities, rights matrix, and benchmark protocol. Documentation evidence is kept separate from live observations.
2. **Service and API:** reusable provider contract, restored adapters, optional Hiring Index, audience policies, scoped key lifecycle, durable quotas, OpenAPI, unit and HTTP tests.
3. **Website:** search workspace, original links and details, error recovery, developer guide/key management, translated copy, responsive verification.
4. **Validation harness:** scoped regression tests, full affected suite, server typecheck, design/copy checks, production build in isolation from active development output, browser checks, and bounded live smoke when existing credentials permit.
5. **Activation:** operate the website against subscribed sources; enable partner sources only after applicable redistribution rights are established. Track unique useful jobs per market, direct application rate, stale-link rate, missing fields, p95 latency, and cost per useful result before expanding defaults.

Commercial API resale, vendor contracts, new paid subscriptions, and public deployment are external rollout activities. The implementation does not claim those activities happened. Automated recurring indexing, payment plans, unbounded pagination, full-text historical exports, and recruiter application submission are outside this release.
