# Job API provider evaluation

Research date: **2026-09-12**. Scope: additional RapidAPI providers for the RoboApply website and a reusable job-search service. This is a primary-source documentation review, not a live coverage, latency, billing, or reliability benchmark. No subscriptions were purchased and no authenticated provider calls were made for this review. Public examples are illustrative vendor payloads, not observed production results.

## Recommendation

Use the existing **JSearch + Fantastic.jobs ATS** adapters as the website's initial combination; retain Fantastic.jobs LinkedIn as an optional supplement. Trial **Hiring Index** as an independently operated ATS index and **Techmap Daily International Job Postings** for broader country/source coverage. Add each only if a controlled benchmark demonstrates incremental useful results. Keep Google Jobs wrappers as potential availability/cost alternatives rather than assuming they add independent inventory.

Build one normalized search service with two policy contexts: the RoboApply end-user website and authenticated external integrations. The integration API must use an independently configured provider allowlist. Default external redistribution to no upstream providers until applicable rights are recorded. This is a product requirement arising from reviewed terms, not a blocker to implementing and testing the API.

Fantastic.jobs explicitly permits end-user job boards and matching products while prohibiting competing commercial job-data services and standalone raw-data redistribution. Hiring Index also prohibits reselling its raw index as a competing feed. Normalizing fields is not evidence that those restrictions disappear. [Fantastic.jobs terms, §9](https://developer.fantastic.jobs/terms), [Hiring Index terms](https://hiringindex.org/legal/terms).

## Compared APIs

Ratings below are proposed engineering decisions, not measured quality scores. Prices are USD snapshots from the linked source; the active marketplace plan and taxes may differ. “Unverified” means no reliable current evidence was obtained.

| API and identity | Coverage, freshness, and usable fields | Billing evidence | Decision |
| --- | --- | --- | --- |
| **JSearch — OpenWeb Ninja**, [RapidAPI](https://rapidapi.com/letscrape-6bRBa3QguO5/api/jsearch), [vendor](https://www.openwebninja.com/api/jsearch) | Google for Jobs aggregation, including company sites and boards. Sample includes descriptions, posting timestamps, publisher, and multiple apply destinations; fields may be missing. “Real time” is a vendor claim. | Current RapidAPI price and page/enrichment multipliers unverified. Existing adapter observes request quota headers; these are not a validated cost model. | **Use as baseline.** Existing integration and broad query support. Preserve direct-link preference and missing salary/remote data. |
| **Active Jobs DB — Fantastic.jobs**, [RapidAPI](https://rapidapi.com/fantastic-jobs-fantastic-jobs-default/api/active-jobs-db), [source docs](https://developer.fantastic.jobs/documentation/endpoints/new-jobs) | Employer ATS collection, documented hourly polling; current docs list 55 ATSs while marketing lists 54. Descriptions are opt-in. | Vendor advertises RapidAPI pricing from **$1/1,000 jobs**; current listing-specific tiers unverified. [Vendor pricing statement](https://fantastic.jobs/about). | **Use for website.** Distinct collection route from Google Jobs; measure overlap. Standalone redistribution restricted. |
| **LinkedIn Job Search API — Fantastic.jobs**, [RapidAPI](https://rapidapi.com/fantastic-jobs-fantastic-jobs-default/api/linkedin-job-search-api), [job-board docs](https://developer.fantastic.jobs/api/new-jobs) | Third-party feed, not an official LinkedIn partner API. Current direct API covers LinkedIn, Wellfound, and YC; LinkedIn expiry checks and ATS-duplicate flags are documented. Do not assume direct-API features exist on the legacy listing. | Result and request allowances depend on channel/plan. Direct plans start at **$95/month for 20,000 jobs and 10,000 calls**; this is not a RapidAPI quote. [Direct pricing](https://fantastic.jobs/api). | **Optional website supplement.** Shares vendor/failure domain with Active Jobs DB. Standalone redistribution restricted. |
| **Daily International Job Postings — Techmap**, [RapidAPI](https://rapidapi.com/techmap-io-techmap-io-default/api/daily-international-job-postings), [reference](https://jobdatafeeds.com/job-api-overview) | Global multisource index; three-month API lookback. Full Markdown description under `job.jsonLD.description`, source fields and deduplication filter. “Active” may mean a derived expiry date, not a verified live posting. | **100 free calls/month**, up to 10 jobs/call. Vendor headline **$1/1,000 jobs**; confirm marketplace tier and overages. [Pricing](https://jobdatafeeds.com/pricing). | **Trial next for coverage.** Evaluate Taiwan/Japan and nontechnical roles; do not rank archived records as fresh openings. |
| **Hiring Index — starnikovoleg**, [RapidAPI](https://rapidapi.com/starnikovoleg/api/hiringindex), [docs](https://hiringindex.org/docs) | Daily ATS index with posting, first-seen, and fetched timestamps, employer links, HTML descriptions and disclosed salary. Eleven ATSs in field reference, ten in footer: count is inconsistent. | **$29/month for 25,000 returned postings + 250 insights calls**, hard cap; free 200 postings + 5 insights. Calls also tracked; empty/rejected results consume no posting quota per pricing page. [Pricing](https://hiringindex.org/pricing). | **Best documented new adapter candidate.** Trial website coverage. Raw-index resale restricted. |
| **Jobs Search API — FlyByAPIs**, [vendor docs](https://flybyapis.com/apis/jobs-search/) | Another Google Jobs wrapper. Multiple apply links and qualifications shown. Page claims full descriptions but sample does not establish completeness; code and JSON envelope disagree. | Published Pro **$9.99/month for 10,000 requests**. Free tier contradicts itself: 100 versus 200 requests. | **Fallback trial only.** Potential Google Jobs overlap; resolve schema/pricing contradictions before enabling. |
| **ATS Jobs API — Productra**, [RapidAPI](https://rapidapi.com/productra/api/ats-jobs-api), [vendor](https://productra.com/ats-jobs-api/) | Curated Greenhouse, Lever, Ashby jobs; vendor reports 67+ employers, 10,000+ jobs and two-hour refresh. Sample provides application URL; full description coverage unverified. | **100 free requests/month**; Starter **$12/month for 15,000 requests**, $0.001/request overage. | **Niche trial/defer.** Small curated universe may duplicate Fantastic ATS. Public endpoints and legal marketing do not establish resale rights. |
| **Indeed Scraper API — PullAPI**, [RapidAPI](https://rapidapi.com/pullapi-pullapi-default/api/indeed-scraper-api2), [vendor docs](https://pullapi.com/scrapers/indeed/) | Indeed-specific scraping claim. Search returns up to 15 snippets; full description needs a separate details call. No application URL in shown job payload. Country coverage and direct apply links unverified. | Per-request/credit model; examples show one credit per call. Current paid tiers unverified. | **Defer.** Detail fan-out increases cost/latency; add only for proven unique inventory with usable application destinations. |
| **Job Posting Feed API — Fantastic.jobs**, [RapidAPI pricing](https://rapidapi.com/fantastic-jobs-fantastic-jobs-default/api/job-posting-feed-api/pricing) | Feed delivery from the same vendor, not an independent source. Marketplace says expired jobs are removed and up to 500 jobs returned per request. | Basic 5 calls/month; Pro **$95/month for 150 calls**, hard cap. Bandwidth allowance/overages listed separately. | **Evaluate for scheduled ingestion**, not another fan-out provider. Compare result-metered endpoints. Same vendor rights review applies. |

## Endpoint evidence and integration notes

### Existing RapidAPI adapters

Repository source as inspected at the start of this task:

| Adapter | Host and request path in code | Evidence boundary |
| --- | --- | --- |
| JSearch | `jsearch.p.rapidapi.com`, `GET /search-v2` | `raRapidApiJobs.ts` documents a July 13, 2026 live migration from `/search`; expects `data.jobs` and tolerates legacy `data[]`. Repository evidence, not a live check today. |
| Active Jobs DB | `active-jobs-db.p.rapidapi.com`, `GET /active-ats-7d` or `/active-ats-24h` | Existing `raFantasticJobs.ts`; a window may be unavailable on a particular plan. |
| LinkedIn Job Search | `linkedin-job-search-api.p.rapidapi.com`, `GET /active-jb-7d` or `/active-jb-24h` | Existing shared Fantastic adapter. |

Current Fantastic direct docs instead use `https://data.fantastic.jobs/v1/active-ats` and `/v1/active-jb`, a `time_frame` parameter, and bearer authentication. Do not replace RapidAPI paths merely because direct documentation changed. Direct docs support explicit description selection, expiry, and modification workflows; compare entitlements before migration. [Direct first request](https://developer.fantastic.jobs/documentation/your-first-api-call), [endpoint guide](https://developer.fantastic.jobs/documentation/endpoints/new-jobs).

**Implementation verification, later on 2026-09-12:** the historical RapidAPI `/active-ats-7d` route returned 404. The implementation team independently inspected current marketplace route definitions and verified `GET /active-ats` live. Both marketplace routes are now `/active-ats` and `/active-jb`, with `time_frame`, `title`, `location`, and `description_format`; the adapters were migrated accordingly. The table above records the pre-change checkout, not the final implemented routes. LinkedIn’s current route was verified from marketplace metadata but not live-called in this task.

The bounded Taiwan/Taipei software-engineer smoke returned 14 valid Active Jobs DB postings in approximately 3.3 seconds. The aggregate response was capped at 10; all 10 had descriptions, stated publication dates, and direct application links, and none had normalized salary values. JSearch separately returned six jobs in approximately 7.1 seconds but exceeded a 20-second deadline during the combined smoke, which correctly reported partial coverage. Hiring Index returned 403 under the existing subscription and remains opt-in. Aggregate local evidence is in `logs/job-search-live-smoke.json`; no returned postings or credentials were saved. These observations verify connectivity and a few fields, not comparative market-wide quality. No further paid probes were run after the final smoke.

### Hiring Index: concrete trial contract

- `POST https://hiringindex.p.rapidapi.com/jobs/search`, standard RapidAPI headers and JSON.
- Filters include `job_titles`, `keywords`, `cities`, `country_codes`, `remote_flag` (string array), `days_ago`, `page`, `limit` (up to 100). Terms under three characters are rejected; broad keywords may return 422. Omit unused fields.
- Envelope: `jobs`, `total_count`, `company_count`, `page`, `limit`, `total_pages`, `meta`.
- Fields: `_id`, `source_platform`, `title`, `company_name`, location fields, `remote_flag`, `employment_type`, `salary`, `posted_at`, `first_seen_at`, `fetched_at`, `posting_url`, `apply_url`, `description`. Missing source values are absent. Preserve currency and pay period together.
- Detail: `GET /jobs/{id}`. [Contract](https://hiringindex.org/docs).

### Other contracts to validate

Techmap documents `GET https://daily-international-job-postings.p.rapidapi.com/api/v2/jobs/search` and `/count`. Set `dateCreated` explicitly: default is two days ago. `isActive=true` uses `dateActive`, which may default to creation plus 30 days; it is not independent expiry verification. [Reference](https://jobdatafeeds.com/job-api-overview).

FlyBy documents `GET https://jobs-search-api.p.rapidapi.com/jobs/search`; code reads `jobs` but JSON nests `data.jobs`. Productra shows a direct Workers `/jobs` URL, not a verified RapidAPI host. PullAPI lists `indeed-scraper-api2.p.rapidapi.com` in headers while examples target `api.pullapi.com/indeed/search`; resolve channel mismatch before coding. [FlyBy](https://flybyapis.com/apis/jobs-search/), [Productra](https://productra.com/ats-jobs-api/), [PullAPI](https://pullapi.com/scrapers/indeed/).

## Website and partner API usage rights

| Provider | Evidence reviewed | Operational decision |
| --- | --- | --- |
| Fantastic.jobs family | §9.1 permits end-user job-board/matching use but excludes competing commercial aggregation/resale/syndication; §9.2 excludes standalone raw-data redistribution. §1.3 leaves original-source terms with the consumer. [Terms](https://developer.fantastic.jobs/terms). | Website eligible within applicable subscription/source terms. External API disabled pending applicable custom agreement. |
| Hiring Index | Organization license; storage/processing within own product allowed; competing raw-index resale disallowed. [Terms](https://hiringindex.org/legal/terms). | Website trial; external API disabled pending written scope covering that use. |
| OpenWeb Ninja/JSearch | Generic §2 reserves commercial reproduction/distribution unless otherwise permitted; no JSearch-specific standalone redistribution grant established here. Applicability and RapidAPI exceptions unresolved. [Terms](https://www.openwebninja.com/terms). | Preserve existing end-user integration authorization; record applicable contract before new standalone distribution. |
| Techmap | Website terms defer purchased API data to applicable RapidAPI terms and direct purchases to a signed agreement. Website terms cannot establish data resale rights. [Terms](https://jobdatafeeds.com/terms). | Record applicable data terms; external API disabled meanwhile. |
| FlyByAPIs, Productra, PullAPI | Reviewed product pages do not establish a standalone redistribution grant. | Unverified, not asserted prohibited. External API disabled until rights are recorded. |

No reviewed provider is established here as licensed for RoboApply's standalone job-data API. Practical activation paths are an upstream contract covering integration customers or employer-authorized direct feeds. Continue implementation with synthetic contract fixtures. No vendor contact was sent.

Enforce the allowlist when searching, reading caches, retrieving details, and deduplicating. A permitted record must not inherit a restricted provider's description/enrichment during a merge. Retain source provenance and apply the actual agreement's retention period.

## Controlled benchmark plan

1. **Freeze queries.** Use 24 role/market combinations across Taiwan (traditional Chinese and English), Japan, Singapore, US, UK, and Germany. Include engineering, sales, operations, healthcare, junior roles, onsite, hybrid, and remote with location restrictions. Translate meaning rather than assuming literal terms yield equivalent results.
2. **Bound usage.** Baseline JSearch, then Fantastic ATS/LinkedIn, Hiring Index, and Techmap only where entitled/authorized. Cap requests and returned rows separately; estimate maximum billable units from subscribed plans first. Do not automatically subscribe, enrich every row, retry indefinitely, or exceed the bound.
3. **Record evidence.** Parameters, timestamp, endpoint version, elapsed time, status, retries, raw/normalized counts, drop reasons, cache status, quota deltas. Use synthetic test fixtures and retain only permitted minimal benchmark data.
4. **Deduplicate and assess.** Canonical application URLs/source IDs first; cautiously compare employer + title + location to avoid merging distinct requisitions. Measure additional relevant jobs against baseline. Blind-review a representative sample for role/market fit and report disagreement.
5. **Check applications/freshness.** Inspect original pages for a specific open role and usable application destination. A 200 response or login page alone is not success. Separate publication date, first seen, fetched time, and closure. Include unknown timestamp and missing-description rates.
6. **Repeat once after seven days.** Measure closed jobs and new supply without extra purchases. Schedule only when requested; this document creates no automation.

Report p50/p95 latency, failure/timeout rate, duplication, direct-apply share, complete-description share, wrong-market share, unknown fields, sampled-open share, additional relevant jobs, and **billable cost / unique relevant open jobs**. Include sample sizes. Distinguish measured values from claims and empty results from failures.

Initial trial gates are targets, not results: 15% additional relevant jobs in an underserved market or demonstrated availability/cost advantage; 95% of sampled destinations reach the intended posting; 90% complete descriptions among accepted jobs; no unresolved attribution/activation-rights gap. Revise with market evidence.

## Implementation priorities

1. Restore adapters through a reusable server service with validation, bounded parallelism, deadlines, unknown values, provenance, deduplication, and partial-failure reporting.
2. Expose the service to website and versioned integrations with distinct provider policies, authentication, rate limits, stable errors, OpenAPI, and examples. Never expose the upstream key.
3. Test synthetic malformed envelopes, conflicting salary/location, unsafe URLs/HTML, timeout, quota exhaustion, unavailable subscriptions, cache separation, authorization, and restricted-source merges.
4. Benchmark before changing production defaults. Investigate shared quota storage for multiple replicas; process-local budgets do not enforce account spend.
5. Add scheduled ingestion and expiry/modification handling when contracts and measured economics support maintaining an index. A researched API is not necessarily integrated or enabled.
