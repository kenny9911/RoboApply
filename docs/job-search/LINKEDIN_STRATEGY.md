# LinkedIn discovery strategy for the Job Search Agent

Research date: **2026-09-14**. This is a primary-source documentation review and repository assessment. No paid searches, subscriptions, vendor messages, or configuration changes were made for this review. Recommendations below are engineering decisions; coverage and freshness claims remain unmeasured unless explicitly identified as existing local evidence.

## Recommendation

Build the user experience around an explicit **Search Job** action: the user describes the role and constraints, the agent converts that request into a small search plan, queries enabled providers, deduplicates real postings, and returns a shortlist with source links and clear coverage. For LinkedIn-focused discovery, the most practical candidate is the already implemented **Fantastic.jobs LinkedIn adapter**, supplemented by employer ATS results and JSearch. Enable the LinkedIn source after confirming the subscribed endpoint and applicable use rights, then measure incremental relevant jobs before increasing spend.

This is a recommendation to trial a concrete existing integration, not a claim that Fantastic.jobs is universally the best provider or includes every LinkedIn opening. A second wrapper over the same underlying inventory is useful only if it improves coverage, reliability, or measured cost.

For the standalone integration API, use separately licensed data or employer-authorized feeds. Website eligibility and a marketplace subscription do not establish rights to operate a competing job-data service.

## What official LinkedIn access provides

The current LinkedIn Talent documentation describes job posting, recruiting, and applicant integrations. The Job Posting API creates/manages customer postings and requires LinkedIn-approved developers plus an API agreement. Its overview directs new access requests to Apply Connect. These documents do **not** establish a generally available API for searching all LinkedIn jobs; that conclusion is a scope inference from the documented products, not proof that no private commercial arrangement could exist. An OAuth login or posting partnership should not be represented as granting broad job-discovery access. [Talent API catalog](https://learn.microsoft.com/en-us/linkedin/talent/), [Job Posting API overview](https://learn.microsoft.com/en-us/linkedin/talent/job-postings/api/overview).

Do not design the product around collecting a candidate's LinkedIn cookies or driving their logged-in account. LinkedIn's published rules restrict scraping and unauthorized automation, and explicitly address copied information obtained through third-party aggregators. A third-party provider's availability is therefore not evidence of LinkedIn authorization. [LinkedIn prohibited software guidance](https://www.linkedin.com/help/linkedin/answer/a1341387/prohibited-software-and-extensions?lang=en).

## Concrete provider choice and evidence boundary

| Channel | Contract/evidence | Decision |
| --- | --- | --- |
| Existing RapidAPI LinkedIn adapter | `GET https://linkedin-job-search-api.p.rapidapi.com/active-jb`, RapidAPI authentication. Repository sends `source=linkedin`, `time_frame`, `title`, `location`, `description_format=text`, bounded results, and excludes recruiter/contact fields. | Smallest implementation gap. Route was verified against marketplace metadata on September 12; LinkedIn entitlement and successful live responses remain unverified. [Marketplace listing](https://rapidapi.com/fantastic-jobs-fantastic-jobs-default/api/linkedin-job-search-api). |
| Fantastic direct API | `GET https://data.fantastic.jobs/v1/active-jb`, bearer authentication. Direct docs support LinkedIn source filtering, title/description/location search, pagination, explicit descriptions, LinkedIn IDs, seniority, Easy Apply, and ATS-duplicate signals. | Candidate for later ingestion/indexing. Confirm exact RapidAPI feature parity before adding these parameters to the existing adapter. [Direct reference](https://developer.fantastic.jobs/api/new-jobs#job-board-jobs). |
| JSearch | Vendor describes Google for Jobs/open-web aggregation, including LinkedIn among publishers. | Keep as a complementary discovery route. Presence of LinkedIn in its publisher list does not establish completeness. [JSearch product reference](https://www.openwebninja.com/api/jsearch). |
| Employer ATS data | Existing Active Jobs DB integration returns employer/ATS application destinations. | Keep employer postings when the same role is found on LinkedIn; preserve both sources, prefer an available employer application destination, and avoid merging separate requisitions. |

Direct-reference details that matter: `direct_apply` means an application **within the job board**, such as LinkedIn Easy Apply; it does not mean an employer-direct URL. `linkedin_id` differs from the vendor's internal `id`. The documented `exclude_ats_duplicate` match is approximate; RoboApply must retain its own conservative deduplication. Description search is unavailable for the job-board `6m` window. [Direct reference](https://developer.fantastic.jobs/api/new-jobs#job-board-jobs).

The vendor documents hourly indexing for English-speaking LinkedIn markets and technology roles, with several hours' delay elsewhere. It describes ordinary keyword search rather than built-in semantic expansion, and warns that complex live queries can be slow or expensive across many users. These are vendor statements, not RoboApply measurements. [How the API works](https://developer.fantastic.jobs/documentation/how-fantastic-jobs-api-works).

LinkedIn expiry is documented as a daily source recheck, with postings auto-expired at six months; the expiry feed returns vendor IDs. That does not prove a listing is open at the moment a candidate sees it. Preserve publication, indexing, retrieval, and verification times as distinct facts. [Expiry documentation](https://developer.fantastic.jobs/documentation/endpoints/expired-jobs).

Direct pricing currently starts at **$95/month for 20,000 jobs and 10,000 API requests**. This is not a quote for the RapidAPI listing. Confirm result credits, request credits, feature entitlement, and any overages on the actual chosen plan. [Direct pricing](https://fantastic.jobs/api).

## Website versus external API activation

Fantastic's terms permit job-board/matching features for a product's own users, but prohibit competing commercial job-data services and standalone raw-data redistribution. They also leave original-source terms with the consumer and disclaim guaranteed upstream completeness. The reviewed page labels its top update date May 19, 2026 and its footer modification date September 11, 2026; record the retrieval date rather than treating either label as proof of contractual history. [Terms, §§1.3 and 9](https://developer.fantastic.jobs/terms).

Before activation, record the provider, subscribed channel/plan, intended audience, permitted fields and retention, attribution requirements, and contractual scope. Confirm original-source use is addressed; do not describe a third-party feed as an official LinkedIn integration. Require an applicable additional agreement for external job-data API distribution. The current independent `JOB_SEARCH_PROVIDERS` and `JOB_SEARCH_API_PROVIDERS` controls should remain separate, including caches and merged results. Do not broaden API permissions merely because an agent calls the service.

## Product behavior to implement

1. **Understand the request.** Extract titles, skills, market, work arrangement, employment type, freshness, and explicit exclusions. Keep constraints the backend cannot enforce visible as unverified preferences. Do not assume that remote means eligible worldwide or that missing salary meets a minimum.
2. **Show the search intent.** Distinguish exact requirements from expanded title variants. A request for “backend engineering in Taipei using Python” may produce a focused title search plus one close synonym; it should not send the entire paragraph as a title filter.
3. **Search with bounds.** Use a small fixed maximum of planned queries, enabled-source allowlists, deadlines, cancellation, and durable usage reservations. Reserve for the planned execution before provider work; do not let one agent request create unmetered fan-out. Preserve user-selected filters through every query.
4. **Keep LinkedIn preference honest.** If the LinkedIn provider is enabled and selected, include it in the bounded plan. If it is unavailable, report that coverage and label any ATS/JSearch fallback. If the user explicitly requires LinkedIn only, do not present unrelated fallback inventory as satisfying that requirement.
5. **Rank evidence, then explain.** Only return jobs obtained from providers. Use supplied title, description, location, and employment facts to explain relevance. Keep unknowns visible. Avoid invented openings, unsupported fit percentages, or promises that the whole internet was searched.
6. **Return actionable results.** Show original source, available application destination, stated posting date, and provider failures separately from zero matches. Allow the user to refine and run the agent again. Job discovery does not submit applications or message recruiters.

At larger scale, evaluate a licensed local index with scheduled ingestion, expiry reconciliation, and semantic retrieval. On-demand provider searches can fill gaps. That is a later infrastructure decision requiring measured cost/latency and retention rights, not a prerequisite for this interaction.

## Validation and rollout

Existing September 12 local evidence confirms Active Jobs DB connectivity and a small Taipei software-engineer result sample; JSearch also returned jobs separately but timed out in one combined run. **There is no live LinkedIn coverage, latency, entitlement, or incremental-quality result yet.** See [provider evaluation](./PROVIDER_EVALUATION.md) for exact historical scope.

After entitlement and cost bounds are established, compare the same bilingual Taiwan queries and representative target markets across LinkedIn, ATS, and JSearch. Keep the first batch small and fixed. Record unique relevant jobs added by LinkedIn, duplicate rate, wrong-market rate, description completeness, sampled application availability, stated-date age, p50/p95 latency, provider failures, and billable cost per useful unique job. Do not count generated query variants as newly discovered jobs.

Proposed trial gates: measurable incremental coverage in a target segment; at least 95% of sampled application destinations reaching the intended posting; no material hidden market/remote restriction; and economics inside an explicitly set per-search bound. These are acceptance targets, not achieved results. Test unavailable LinkedIn, partial results, strict LinkedIn-only intent, planner failure, ambiguous constraints, cancellation, and quota exhaustion with fixtures before a bounded live trial.
