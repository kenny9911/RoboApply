# Job sources for the international market (RoboApply)

**Research date:** 2026-10-11. **Scope:** US, CA, UK, EU, AU, SG and remote roles for the RoboApply brand (`market = intl`). Taiwan and mainland China are covered by their own notes.
**Method:** read the current pipeline, eight read-only probe calls (five with the key already in `.env`, three against public ATS job-board endpoints), and primary-source documentation where it could be fetched. No account was created, no terms were accepted, no plan was changed, no code was edited.

**Confidence tags.** `[confirmed]` = seen in a probe response, in our code, or on the vendor's own page today. `[likely]` = two or more secondary sources, or one vendor page that could not be cross-checked. `[inferred]` = my reasoning from confirmed facts. Third-party comparisons written by competing vendors (JobsPipe, JobDataLake) are marked `[likely]` at best.

---

## 1. What matters most (read this first)

1. **Our primary source is switched off in practice.** Active Jobs DB is priority 10 in the brand registry, but the key is on the free **BASIC** plan: 25 requests and 250 jobs per month. The probe got HTTP 429 with `x-ratelimit-requests-remaining: 0` and about 17 days until reset. Ingest's default budget for it is 300 calls **per day**. `[confirmed]`
2. **The LinkedIn feed is not subscribed** (HTTP 403 "You are not subscribed to this API"). The planner still creates queries for it. `[confirmed]`
3. **JSearch is the only paid source that works today**: 10,000 requests per month, 9,773 left. It is a Google for Jobs wrapper. In three probes (58 rows) only 8 rows linked to an employer site; 15 linked to LinkedIn; none carried a "direct" flag; structured salary was 4 of 58. `[confirmed]`
4. **The employer-direct backbone already exists in code and is the right design**: `sources/atsPublic` reads Greenhouse, Lever, Ashby and SmartRecruiters boards and closes postings the board stops listing. What it lacks is **companies**: sources are added one at a time in an admin panel, and there is no seed list or discovery. `[confirmed]`
5. **Recommendation in one line:** make public ATS boards the backbone (bulk-seeded, 10k+ boards, free), buy one licensed feed for the ATSs that have no public API (Workday, iCIMS, Oracle, SuccessFactors — Fantastic.jobs as a window sync, with TheirStack as the alternative), keep JSearch only for on-demand long-tail queries, add USAJobs, and never touch Indeed, LinkedIn or Glassdoor directly.

---

## 2. What the pipeline does today

Files read: `server/src/features/jobs/{ingest,sources,normalize}/**`, `server/src/roboapply/v2/lib/{raRapidApiJobs,raFantasticJobs,raJobProviders}.ts`, `docs/job-search/{PROVIDER_EVALUATION,LINKEDIN_STRATEGY}.md`, `docs/jobright-clone/ARCHITECTURE.md` §4.

| Part | Behaviour | Where |
|---|---|---|
| Providers for RoboApply | `activejobs` (10) → `bank_robohire` (15) → `linkedin` (20) → `jsearch` (30), plus `ats_public` registered for the market | `platform/brand/registry.ts:163`, `ingest/providers.ts` |
| Planner | Daily. Demand tuples (role × country × city/remote) from active users' default profiles, plus SEO seeds (300 roles × 3 cities per seed country). **One query per tuple per search provider.** Refresh 6 h / 12 h / 24 h, back-off after 4 empty runs | `ingest/planner.ts` |
| Search adapters | JSearch `GET /search-v2` with `query="{role} in {city}"`, `country`, `date_posted=week`, `num_pages=2`. Fantastic `GET /active-ats` and `/active-jb` with `title`, `location`, `time_frame=7d`, `limit=20`, `description_format=text` | `ingest/adapters/rapidApi.ts`, the two clients |
| Public ATS | One standing cursor query; reads 3 due boards per fetch, each board every 6 h, at most 500 postings per board per run; closes postings by listing diff | `sources/atsPublic/*` |
| Budgets | DB daily call budget per provider (defaults 300 / 150 / 200), plus a separate in-process daily budget inside each client (default 300) | `ingest/config.ts`, the two clients |
| Dedupe | Unique on `(externalId, sourceBoard)`; then `dedupeKey = sha1(company | title | place)`; canonical row = lowest `sourcePriority`, then newest | `normalize/identity.ts`, `ingest/upsert.ts` |
| Expiry | Provider expiry if given, else posted + 45 days. Banks and ATS boards never expire by date. "Missed in two later runs of the same query" archives a row, but only once three columns from schema request SR-16b-1 exist | `ingest/maintain.ts`, `ingest/tracking.ts` |
| Schedules | `jobs-ingest` every 10 minutes, `jobs-plan` 02:00 UTC, `jobs-maintain` 03:30 UTC | `vercel.json` |
| Display rule | No LinkedIn name, logo or URL on any source field; applicant counts never taken from LinkedIn-derived providers | `normalize/source.ts` |

---

## 3. Probe results (2026-10-11)

Eight calls. Only counts and field names were recorded; no posting or key was saved. Probe script: scratchpad only, not in the repo.

### 3.1 Keyed providers

| # | Call | Result |
|---|---|---|
| 1 | JSearch `/search-v2` "software engineer", `us`, week, 2 pages | 200 in 15.1 s. 19 jobs. Envelope `data.jobs` + **`data.cursor`**. Publishers: LinkedIn 9, ZipRecruiter 3, Indeed 1, employer career sites 6. `apply_options` length 1 on every row; `is_direct` true on none. Salary min/max on 4 of 19. `job_posted_at_datetime_utc` on 19 of 19 (age 0.6–6.9 days, median 2.9). `job_highlights` empty on all. No expiry field. Quota header: limit 10,000, remaining 9,787, reset in ~17 days |
| 2 | JSearch "registered nurse in London", `gb`, week | 200 in 8.1 s. 20 jobs. **No employer site at all**: Carehome.co.uk 3, Jobrapido 3, SimplyHired 2, Totaljobs 2, LinkedIn 2, Jooble 1 and other boards. Structured salary 0 of 20 |
| 3 | JSearch "data analyst in Singapore", `sg`, week | 200 in 7.5 s. 19 jobs. LinkedIn 4, Trabajo.org 4, Jobstreet 2, MyCareersFuture 2, Adzuna 1, employer sites 2. Structured salary 0 of 19. Remaining quota 9,773 |
| 4 | Active Jobs DB `/active-ats` software engineer, United States, 7d | **429.** "exceeded the MONTHLY quota for Requests on your current plan, BASIC". Headers: requests limit 25, remaining 0; jobs limit 250, remaining 112; reset in ~16.9 days |
| 5 | LinkedIn Job Search API `/active-jb` | **403.** "You are not subscribed to this API" |

What follows from these `[confirmed unless marked]`:

- **JSearch no longer exposes several apply options.** The client's "prefer the direct publisher link" logic (`pickApplyUrl`) cannot work on today's payload: there is one option per job and the direct flag is never set. "Employer-direct" must be derived from the link's host (`atsTypeFromUrl`), not from `is_direct`.
- **Roughly a quarter of JSearch rows point at LinkedIn** (15 of 58), and in the US tech sample it was nearly half. Under our own rule (no LinkedIn URL on source fields) those rows have no clean source link.
- **JSearch is weak outside US tech.** For a UK nursing query it returned only boards and aggregators of boards. That is thin, third-hand inventory with no closure signal.
- **`job_highlights` is empty**, so any enrichment that expected qualifications or responsibilities from it gets nothing.
- **The Taiwan-only problem of missing timestamps does not apply here**: US, GB and SG rows all carried a UTC posting time.
- **Whether `num_pages=2` costs one request or two could not be settled.** The quota fell by 14 across three probes, but the dev stack shares the key. The client comment says extra pages are free; measure it from the header delta before trusting it. `[inferred]`

### 3.2 Public ATS endpoints (no key)

| # | Call | Result |
|---|---|---|
| 6 | Greenhouse `boards-api.greenhouse.io/v1/boards/stripe/jobs?content=true` | 200 in 1.3 s. **728 jobs in one response, 5.6 MB.** `first_published`, `updated_at`, `requisition_id`, full `content` on 100%. An `application_deadline` field is present. Age since first publication: median 40 days, max 1,074 days |
| 7 | Ashby `api.ashbyhq.com/posting-api/job-board/ramp?includeCompensation=true` | 200 in 0.9 s. 165 jobs, 3.0 MB. **Compensation summary on 96%**, `workplaceType` on 100% (Hybrid 135, OnSite 16, Remote 14), `publishedAt` on 100%, structured postal country |
| 8 | Workable `apply.workable.com/api/v1/widget/accounts/huggingface?details=true` | 200 in 0.5 s. 6 jobs with `description`, `published_on`, `telecommuting`, `country`, `city`, `shortcode`, `application_url` |

What follows:

- One free call returns a whole employer's openings with full text, the employer's own apply URL and exact dates. No aggregator matches that on quality or cost. `[confirmed]`
- **A board can exceed our 500-posting cap** (728 here). `prioritise` handles it over two runs, but full coverage of a large board then takes 12 hours. `[confirmed]`
- **Employer postings are old by design.** A median of 40 days means "posted date" must not drive expiry for board jobs (already true) and that "new" in the feed should mean *first seen by us* as well as *posted*. `[inferred]`
- The Workable widget endpoint works without a key. It is the endpoint Workable-hosted career pages call; I found no Workable page documenting it for third parties. `[confirmed that it works; terms unverified]`

---

## 4. Source evaluation

Prices are USD list prices seen on the date above. "Display" means showing a job to our signed-in users; "public" means an indexable page without login.

### 4.1 Aggregator and data APIs

| Source | Coverage and freshness | Fields that matter | Limits and price | Terms | Verdict |
|---|---|---|---|---|---|
| **JSearch** (OpenWeb Ninja, RapidAPI) | Google for Jobs results, any country. Fresh to the hour, but third-hand. No closed status | Title, employer, description, one apply link, UTC posted time, sparse salary, remote flag only when true | Our plan: 10,000 requests/month `[confirmed]`. Reported tiers: $25 for 10,000, $150 for 200,000, free 200 `[likely]` ([JobsPipe comparison](https://jobspipe.dev/blog/best-jobs-api-2026.md)) | Vendor terms page did not show data-use terms when fetched; rights for redisplay are **unresolved** ([openwebninja.com/terms](https://www.openwebninja.com/terms)). Upstream is Google, which sued SerpApi in December 2025 over scraping search results ([ppc.land](https://ppc.land/google-sues-serpapi-over-search-scraping-in-copyright-lawsuit/)) `[likely]` | **Keep, demote.** On-demand long tail only. Never the base of the feed. No public pages |
| **Active Jobs DB** (Fantastic.jobs) | 58 ATS platforms incl. Workday, iCIMS, Oracle, SuccessFactors, Taleo, ADP, Paylocity, Greenhouse, Lever; "200k+ career sites", "3M+ career-site jobs/month", hourly polling, "95% of new jobs within 3 hours" ([fantastic.jobs/api](https://fantastic.jobs/api), [about](https://fantastic.jobs/about)) `[confirmed as vendor claims]` | Employer URL, ATS name, description on request, LLM fields: experience level, work arrangement, employment type, key skills, taxonomy, **visa sponsorship**, salary; company domain; `date_validthrough` | **One credit per job returned.** `limit` up to 1,000; windows `1h`, `24h`, `7d`, `6m` ([endpoint docs](https://developer.fantastic.jobs/documentation/endpoints/new-jobs)). Direct plans: $95 / 20k jobs, $175 / 50k, $250 / 100k (+$0.0025 per extra job), $500 / 250k, $900 / 500k. RapidAPI "from $1 per 1,000 jobs" `[vendor statement; RapidAPI tier table not retrievable]` | §9.1–9.2 allow powering features for our own users, including showing matched jobs; forbid a competing aggregation or resale product and standalone raw-data redistribution. §1.3: we stay responsible for the original source's terms. No attribution or retention rule stated ([terms](https://developer.fantastic.jobs/terms)) `[confirmed]` | **Use as the licensed feed** for ATSs we cannot read directly, as a window sync (§6.2). Needs a paid plan. Ask in writing about public pages |
| **LinkedIn Job Search API** (Fantastic.jobs) | LinkedIn, Wellfound, YC. Hourly for English-speaking countries. Not an official LinkedIn API | Same schema; `direct_apply` means Easy Apply on LinkedIn, not an employer link; `exclude_ats_duplicate` flag | Same credit model | Same terms; LinkedIn's own rules forbid scraped data, including via third parties (see `LINKEDIN_STRATEGY.md`) | **Do not subscribe.** We may not show LinkedIn branding or links anyway, so the rows add legal exposure and little the ATS feed lacks |
| **TheirStack** | "225M records, ~305k new/day, 195 countries, 352k sources"; career sites, ATSs and boards, deduplicated; closed jobs carry an offline date ([pricing](https://theirstack.com/en/pricing)) `[confirmed as vendor claims]` | 40+ fields incl. salary, seniority, company domain; closed date | 1 credit per job. $49 / 1,500; $169 / 10k; $400 / 50k; $600 / 100k; $1,200 / 500k; $1,500 / 1M. 4 req/s, 500 per page. Credits roll over 12 months | **§4.3 expressly permits reposting, redistributing and publicly displaying job postings, including on search-indexable pages.** Not allowed as the sole or primary value of the product, nor as a standalone feed ([terms](https://theirstack.com/en/docs/legal/terms-and-conditions)) `[confirmed]` | **Best alternative to Fantastic**, and the only reviewed vendor whose terms clearly allow public SEO job pages. Dearer per job below 500k. Trial before choosing |
| **Coresignal** | 482M+ postings, batch-oriented, 24–72 h lag `[likely]` ([JobsPipe](https://jobspipe.dev/blog/best-jobs-api-2026.md), [JobDataLake](https://www.jobdatalake.com/blog/best-job-data-apis-2026)) | Historical depth | $49 (2,500 credits) to $5,000/month `[likely]` | Not reviewed | **No.** Built for analytics, not a live feed |
| **Mantiks** | LinkedIn, Indeed, Glassdoor, Welcome to the Jungle only; no ATS-direct `[likely]` ([JobsPipe review](https://jobspipe.dev/blog/mantiks-review.md)) | Company-level hiring signals | €99–190/month on annual terms `[likely]` | Scrapes the three boards we must avoid | **No** |
| **SerpApi Google Jobs** | Same Google for Jobs data as JSearch | Similar | $25 / 1,000 searches, $75 / 5,000 `[likely]` ([apiserpent](https://apiserpent.com/blog/serpapi-pricing-explained)) | Defendant in Google's DMCA suit (N.D. Cal., filed 2025-12-19; motion to dismiss filed 2026-02, outcome not found) `[likely]` | **No.** Dearer than JSearch, same data, live litigation |
| **Adzuna** | Own index, strong in UK, EU, AU, and a US site | Truncated description, salary incl. predicted flag, redirect link through Adzuna | Free default: 25/min, 250/day, 1,000/week, 2,500/month ([terms](https://developer.adzuna.com/docs/terms_of_service)) `[confirmed]` | Each ad must be labelled "Adzuna" with a link. Uses other than publishing listings get a 14-day trial, then need a licence. Data must be removed on termination `[confirmed]` | **Only with a commercial licence.** Excerpts plus redirect links make poor inventory for match scoring. Possible later for UK/AU breadth |
| **Jooble** | Aggregator of boards, many countries | Snippet, free-text salary, redirect link | Key by application form ([jooble.org/api/about](https://jooble.org/api/about)); limits not published `[confirmed]` | Terms not retrieved | **No.** Snippet-only, links go through Jooble |
| **Careerjet** | Publisher/affiliate search API, ~70 markets `[likely]` | Snippet, redirect link | Requires the end user's IP and user agent on every call; paging stops near 1,100 results `[likely]` ([JobsPipe](https://jobspipe.dev/blog/careerjet-api.md)) | Affiliate display model | **No.** Cannot be ingested by a server job honestly (it wants the real user's IP) |
| **Techmap** (Daily International Job Postings) | Multi-source, three-month lookback | Full description; "active" is a derived date | $1 per 1,000 `[likely]` | See `PROVIDER_EVALUATION.md` | Unchanged: optional trial for non-English markets |
| **Hiring Index** | ~11 ATSs, daily | Employer link, salary | $29 / 25,000 postings | Raw-index resale forbidden | Superseded by reading the same boards ourselves |

### 4.2 Free feeds and niche boards

| Source | What it is | Limits | Terms | Verdict |
|---|---|---|---|---|
| **USAJobs** | US federal vacancies, official API | Free key; 500 per page; `DatePosted` 0–60 days; salary min/max and `ApplicationCloseDate` on every row ([docs](https://developer.usajobs.gov/api-reference/get-api-search)) `[confirmed]` | Key by application; email in the User-Agent header `[likely]` | **Add.** Clean licence, real close dates, structured pay. Tag citizenship requirement honestly |
| **Arbeitnow** | Europe (and a UK feed since 2026), sourced from Greenhouse, SmartRecruiters, Join, Teamtailor, Recruitee, Comeet; `visa_sponsorship` and `remote` flags ([blog](https://www.arbeitnow.com/blog/job-board-api)) `[confirmed]` | No key; limits not stated | No terms stated; paid private endpoint by email | **Trial after asking for terms by email.** Useful for Germany; overlaps boards we can read directly |
| **Jobicy** | Remote jobs. `GET /api/v2/remote-jobs`, cursor paging, salary fields, **batch status endpoint** (`active` / `closed`) ([docs](https://jobicy.com/jobs-rss-feed)) `[confirmed]` | Sync a few times a day, not more than hourly; 7-day window, 3-hour delay | Keep Jobicy as source and link its canonical URL. Employer ATS link only with a paid key at $0.01 per job | **Optional.** Fine as a labelled source; apply link goes via Jobicy unless paid |
| **RemoteOK** | Remote jobs JSON feed, `salary_min`/`max`, `apply_url` ([api](https://remoteok.com/api)) `[confirmed]` | Not stated | Must link back with a followed link and name Remote OK as source; logo use needs permission | **Optional**, same caveat |
| **Remotive** | Remote jobs API | Listings delayed 24 h | Must link back and credit. **Forbids showing listings in order to collect sign-ups or email addresses**, and forbids resubmitting to other sites ([page](https://remotive.com/remote-jobs/api)) `[confirmed]` | **No.** Our feed sits behind sign-up |
| **We Work Remotely** | RSS feeds | — | Terms not retrieved | Not evaluated; treat as no until terms are read |
| **The Muse** | Curated employer profiles and jobs | 500 requests/hour without a key, 3,600 with one `[likely]` | Terms not retrieved | Low priority; small, US-centred |
| **Reed** (UK) | UK board, official jobseeker API | Free key; 100 per page; full text needs one call per job `[likely]` ([JobsPipe](https://jobspipe.dev/blog/reed-api.md)); developer page returned 403 to the fetcher | Terms not retrieved | **Candidate for UK depth** once terms are read; includes agency flag and salary |

### 4.3 Public employment services

| Country | Source | Status |
|---|---|---|
| US | USAJobs | Official API. Add (above) |
| Germany | Bundesagentur für Arbeit Jobsuche | Community-documented REST with a shared static key; the agency offers no official API ([bundesAPI](https://github.com/bundesAPI/jobsuche-api)) `[likely]`. **Defer** until terms are confirmed |
| France | France Travail "Offres d'emploi" | Official API under a licence contract; data.gouv notes exposure was suspended while reuse terms are reviewed after heavy automated use ([data.gouv](https://www.data.gouv.fr/dataservices/api-offres-demploi)) `[likely]`. **Defer** |
| Canada | Job Bank | No open API. XML feed for partner job boards with conditions (Canadian business number, link back) and open-data CSVs ([Job Bank network](https://www.jobbank.gc.ca/network)) `[likely]`. **Owner decision** if Canada matters |
| UK | DWP Find a job | No public developer API found. **No** |
| Singapore | MyCareersFuture | Unofficial JSON endpoint used by scrapers; no terms found. **No** (JSearch already surfaces some of it) |

### 4.4 Employer ATS job-board endpoints

This is how Jobright-class products get fresh, de-duplicated, employer-direct postings: read each employer's own board. Jobright itself says it aggregates from LinkedIn, Indeed and company career pages, and runs an Easy Apply integration on Greenhouse (see `research/matching-jobs.md` §10). We take only the career-page half.

| ATS | Endpoint | Auth | List has full text | Pay | Dates | Status for us |
|---|---|---|---|---|---|---|
| **Greenhouse** | `GET boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true` | None for GET, stated in the docs ([job board API](https://docs.greenhouse.io/job-board.html)) `[confirmed]` | Yes | `pay_input_ranges` with `pay_transparency=true` on the job request `[confirmed in docs]` | `first_published`, `updated_at`, `application_deadline` | **Built.** Add pay ranges and deadline |
| **Lever** | `GET api.lever.co/v0/postings/{site}?mode=json`, EU tenants on `api.eu.lever.co` ([postings API](https://github.com/lever/postings-api)) | None for published postings; the README notes they "may be scraped by third parties" `[confirmed]` | Yes | `salaryRange`, `salaryDescription` | `createdAt` (ms) | **Built.** Add the EU host |
| **Ashby** | `GET api.ashbyhq.com/posting-api/job-board/{org}?includeCompensation=true` ([docs](https://developers.ashbyhq.com/docs/public-job-posting-api)) | None `[confirmed]` | Yes | Compensation tiers and summary | `publishedAt` | **Built** |
| **SmartRecruiters** | `GET api.smartrecruiters.com/v1/companies/{id}/postings`, then `/postings/{id}` for text | None | No (one call per posting) | Rare | `releasedDate` | **Built**, capped at 100 details per run |
| **Workable** | `GET apply.workable.com/api/v1/widget/accounts/{slug}?details=true` | None; works in probe 8. Not found in official third-party docs `[confirmed works]` | Yes | Not seen | `published_on` (date only) | **Add** |
| **Recruitee** | `GET {company}.recruitee.com/api/offers/` | None; Recruitee's docs call it the Careers Site API that "does not require authorization" `[likely]` ([docs](https://docs.recruitee.com/reference/offers)) | Yes (HTML) | Sometimes | `published_at` | **Add** (strong in NL, DE) |
| **Personio** | `GET {company}.jobs.personio.de/xml` (some tenants `.com`), `?language=en` ([support article](https://support.personio.de/hc/en-us/articles/207576365)) | None `[likely]` | Yes (XML, CDATA) | No | `createdAt` | **Add** (DACH). Do not follow the redirect that non-customers return |
| **Teamtailor** | Per-site `jobs.rss` / `jobs.json` feeds; sources disagree on the format `[likely]` | None for the public feed; the real API needs a key | Partly | No | Yes | **Later**, after verifying on a live tenant (Nordics) |
| **BambooHR** | `GET {company}.bamboohr.com/careers/list`, then `/careers/{id}/detail`; undocumented `[likely]` | None | No | Sometimes | Not in list | **Later**; small employers, low yield |
| **Workday** | `POST {tenant}.wd{n}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs` — the page's own internal call. 20 per page, hard stop at 2,000, relative dates, text only via one page fetch per job ([write-up](https://dev.to/dododata/scraping-workday-career-sites-without-a-browser-and-the-2000-job-ceiling-h2e)) `[likely]` | None, but **undocumented** | No | No | Relative text | **Do not read directly.** Our rule L-5 already says so. Get Workday through the licensed feed |
| **iCIMS, Oracle/Taleo, SuccessFactors, ADP, UKG, Paylocity** | No public JSON API for third parties; customer credentials or HTML only | — | — | — | — | **Licensed feed only** |

Terms position `[inferred]`: Greenhouse, Lever and Ashby publish these endpoints so that postings can be embedded and syndicated, and state no key is needed. None publishes a rate limit or a third-party redistribution licence. The postings belong to the employers. Our safe behaviour is: show the employer's name, link straight to the employer's posting, take a posting down when the board drops it, honour an employer's removal request, identify our client in the User-Agent, and keep request rates low (one listing call per board per sync). Counsel should confirm this before any ATS-sourced job goes on a public page.

### 4.5 Where to get the company list

| Route | What it gives | Notes |
|---|---|---|
| **Our own rows** | Every JSearch or feed row whose apply URL is on an ATS host already names a board (`boards.greenhouse.io/{token}`, `jobs.lever.co/{site}`, `jobs.ashbyhq.com/{org}`, `apply.workable.com/{slug}`, `jobs.smartrecruiters.com/{company}`) | Free, demand-shaped, zero legal question. Start here |
| **open-apply** | About 10–12k Greenhouse, Lever and Ashby tenants found through Common Crawl index queries, refreshed monthly; code MIT; daily job dump on Hugging Face ([repo](https://github.com/sec-js/openapply)) `[likely]` | Use the *slug lists* as candidates and validate each against the live board. Do not ingest the job dump: its data licence is "redistributed as a convenience" |
| **Common Crawl index, ourselves** | Query the CDX index for the ATS host patterns | Reproducible, covers Workable, Recruitee, Personio, SmartRecruiters too |
| **Curated lists** | YC company directory, Fortune 500 / FTSE / DAX lists, H-1B sponsor lists (below), our users' target companies and tracker entries | Prioritises boards users actually want |
| **Probing by name** | Try the company's lower-case name as a token | Accept only when the board's own company name matches; an empty list is ambiguous on Lever, Ashby and SmartRecruiters ([ATS reference](https://conorscode.github.io/ats-api-reference/)) `[likely]` |

### 4.6 Sponsorship data (the H-1B features)

Jobright labels jobs "H1B Sponsored" (posting says so), "H1B Sponsor Likely" (company sponsored similar roles in the last three years) and "No H1B" (`research/matching-jobs.md` §4). Honest equivalents:

| Signal | Source | Use |
|---|---|---|
| Posting says it sponsors / does not sponsor | The posting text, quoted verbatim (we already do this for Taiwan permit tags) | Job-level tag with the quote |
| Vendor flag | Fantastic `ai_visa_sponsorship`; Arbeitnow `visa_sponsorship` | Job-level, labelled as the provider's reading, never as fact |
| Company sponsored before | USCIS H-1B Employer Data Hub (CSV by fiscal year, FY2009–FY2025) and DOL OFLC LCA disclosure files (quarterly; job title, wage, SOC code, worksite) ([DOL performance data](https://www.dol.gov/agencies/eta/foreign-labor/performance)) `[likely — official pages not opened]` | Company-level fact with year and count, plus the disclaimer that history does not guarantee sponsorship for this role |
| UK | Home Office "Register of licensed sponsors: workers" CSV on gov.uk (name, town, rating, routes) `[likely]` | Company-level "licensed sponsor" fact, dated |

All three government files are public records and fit D3 because every number has a named, dated source.

### 4.7 Off-limits

| Source | Why | Evidence |
|---|---|---|
| **Indeed** | No public job-search API (Publisher API retired, 2023 or 2024 depending on the source); site and developer terms forbid scraping and building databases of its content; bot protection | [JobsPipe guide](https://jobspipe.dev/blog/indeed-publisher-api.md) `[likely]` |
| **LinkedIn, scraped** | User agreement forbids scraping and use of scraped data; hiQ ended with a $500,000 judgment and an injunction (2022); LinkedIn's 2025 suit closed Proxycurl | [hiQ v. LinkedIn](https://en.wikipedia.org/wiki/HiQ_Labs_v._LinkedIn), [Proxycurl shutdown](https://nubela.co/blog/goodbye-proxycurl/) `[confirmed in secondary sources]` |
| **Glassdoor** | Partner API closed to new users | [OpenWeb Ninja blog](https://www.openwebninja.com/blog/glassdoor-api) `[likely]` |
| **Apify actors, Bright Data, Mantiks, "Indeed scraper" APIs** | They are scrapers of the three boards above; buying the output does not change whose terms were broken | — `[inferred]` |
| **Workday CXS, iCIMS HTML, any career-site HTML** | Undocumented or HTML scraping; forbidden by our own adapter rule | `sources/types.ts` header `[confirmed]` |
| **Candidate's own LinkedIn session or cookies** | Automation of a user account | `LINKEDIN_STRATEGY.md` `[confirmed]` |

One uncomfortable consequence `[inferred]`: JSearch itself is a scraper of Google for Jobs, and Google is in court against a company that does the same. JSearch should therefore be the part of the stack we can lose without the feed going empty.

---

## 5. Recommended source stack

| Tier | Source | Role | Share of the feed we should aim for | Cost |
|---|---|---|---|---|
| **0** | **`ats_public`**: Greenhouse, Lever (+EU), Ashby, SmartRecruiters, then Workable, Recruitee, Personio | Backbone. Employer-direct, exact dates, real closures, best pay data | 50–70% of tech, startup and professional roles | Free (compute only) |
| **0** | **RoboHire bank** | Exclusive recruiter jobs | Unchanged | Free |
| **1** | **Licensed ATS feed**: Fantastic.jobs Active Jobs DB (default) or TheirStack (alternative) | Everything on ATSs with no public API: Workday, iCIMS, Oracle, SuccessFactors, ADP, UKG, Paylocity — that is most large enterprises, healthcare, retail, finance | 30–50% | $250/month for 100k jobs to start (Fantastic direct) `[inferred sizing]` |
| **2** | **JSearch** | On-demand search for a user's query when tiers 0–1 return too few; small employers with no ATS; countries where ATS coverage is thin | Under 10%, labelled as found on the open web | Current $25 plan |
| **3** | **USAJobs** | US federal roles | Niche | Free |
| **3** | Arbeitnow, Jobicy, RemoteOK, Reed | Optional labelled sources once each one's terms are confirmed | Small | Free |
| — | LinkedIn feed, Indeed, Glassdoor, SerpApi, Mantiks, Coresignal, Jooble, Careerjet, Remotive | Not used | — | — |

**Why Fantastic first, TheirStack second** `[inferred]`: Fantastic is cheaper per job at our starting volume ($2.50 per 1,000 against $6 per 1,000 at 100k), exposes an expired-jobs feed and hourly windows, and our adapter and normalizer already speak its schema. TheirStack's terms are the better fit for public SEO job pages. If public job pages are a launch requirement, trial TheirStack for that surface; otherwise start with Fantastic and ask it the public-display question in writing.

---

## 6. How to query each tier

### 6.1 Public ATS boards — no query, sync the board

- **Unit of work:** one board. One listing call returns everything (Greenhouse, Lever, Ashby, Workable, Recruitee, Personio); SmartRecruiters needs one call per posting text.
- **Schedule:** adaptive instead of a flat 6 h. Boards that added or closed a posting in the last 48 h: every 2 h. Quiet boards: every 12–24 h. New boards: immediately.
- **Filter after fetching**, not before: keep postings whose resolved country is in the brand's countries or that are remote; map titles to the taxonomy; drop nothing silently (count what was skipped and why).
- **Incremental sync:** already correct — diff the listing's ids against our open rows; new ids are inserted, missing ids are closed, existing ids are refreshed oldest-first under the cap.
- **Capacity check** `[inferred]`: 10,000 boards at an average 8 h interval is about 21 boards a minute. Today one fetch reads 3 boards serially inside a 240-second budget shared with every other query. That will not reach 10,000 boards. It needs concurrency (4–8 boards at once) and its own cron entry, or a small always-on worker.

### 6.2 Licensed feed — sync windows, do not search

The current adapter runs one `title` × `location` search per planned tuple and takes 20 rows. On a per-job price that buys the same popular jobs repeatedly and misses most of the index. Use the feed the way the vendor documents it ([endpoint docs](https://developer.fantastic.jobs/documentation/endpoints/new-jobs)):

| Step | Call | Notes |
|---|---|---|
| Backfill once | `active-ats?time_frame=7d` with `limit=1000`, `offset` += 1000 until a short page | Then never again unless we were down for days |
| Hourly | `active-ats?time_frame=1h&limit=1000` + offset | Rolling window with a one-hour ingestion delay; run at the same minute each hour |
| Hourly | `expired-ats?time_frame=1h` | Returns vendor ids only; archive matching rows with `closeReason = 'source_removed'` ([expired docs](https://developer.fantastic.jobs/documentation/endpoints/expired-jobs)) |
| Daily, after 01:00 UTC | `expired-ats?time_frame=1d` | Catches anything an hourly run missed |
| Monthly | `expired-ats?time_frame=1m` | Reconciliation |

Filters that keep the bill down, all documented parameters:

- `location`: an OR of full country names for the brand's countries (the API wants names, not codes).
- **`exclude_source`: every ATS we read directly** (`greenhouse`, `lever.co`, `ashby`, `smartrecruiters`, `workable`, `recruitee`, `personio`). We should never pay for a posting we can fetch free.
- `organization_agency=exclude` if the product decision is to hide staffing agencies by default; otherwise keep and tag them.
- `description_format=text`, `include_basic_organization_details=true`.
- Role scoping by `ai_taxonomies_a` rather than title strings where a cap is needed.
- `date_created_gte` as a high-water mark when resuming after an outage.

**Sizing** `[inferred — must be measured with the vendor's count endpoint before buying]`: the vendor indexes "3M+ career-site jobs a month" worldwide. Restricting to seven countries, removing the ATSs we read ourselves and removing agencies plausibly leaves a few hundred thousand a month; a taxonomy filter can bring that under any chosen cap. Start on the 100k plan with a hard daily job budget and let overage ($0.0025 per job) absorb spikes.

**When a search call is still right:** onboarding and the Assistant's "find me X in Y" need an answer in seconds. Then query *our own table* first; call the feed's search only when our table has fewer than a threshold of matches, with a quoted-phrase title (`title="product manager" OR "product owner"`) or `title_advanced`. Today `titleFilterFrom` keeps the last three unquoted tokens, which the API reads as natural-language terms; make the phrase and the OR explicit.

### 6.3 JSearch — demand only

- `query = "{L3 role label} in {city}"`, `country`, `date_posted = 3days` for hot tuples (refreshed 6-hourly) and `week` for cold ones; add `work_from_home=true` for remote tuples.
- **No SEO seeds on JSearch.** The planner multiplies every tuple by every search provider. The default 900 seed tuples (300 roles × 3 cities) against a 200-call daily budget with a 50% seed share means each seed runs about once every nine days — yet each asks for a 7-day window, so the "missed twice" closure rule can never be evaluated in time. Seeds should come from tiers 0 and 1, which cost nothing per query.
- Pagination: `/search-v2` returns `data.cursor`. The client still sends `page`/`num_pages`. Confirm the cursor parameter in the vendor's docs and measure what a second page costs before paging deeper.
- Budget: the plan is a **monthly** quota shared by ingest, onboarding chat and the Assistant. Meter it from the response headers (§8.1), not from two independent daily counters.

### 6.4 USAJobs

`GET data.usajobs.gov/api/Search` with `DatePosted=1` daily (and `=7` on first run), `ResultsPerPage=500`, paging until exhausted. Store `ApplicationCloseDate` as `expiresAt`, pay range as stated, and the hiring path (public / federal employees only) as an eligibility tag.

### 6.5 Role taxonomy × location × date window, in general

| Dimension | Board sync | Feed sync | Search providers |
|---|---|---|---|
| Role | Classify after fetch (taxonomy dictionary, then enrichment) | Vendor taxonomy filter, then ours | L3 English label + up to two synonyms, OR-ed |
| Location | Resolve after fetch; keep brand countries and remote | Country names OR-ed | City in the query text + country code |
| Date window | Whole board every time | `1h` rolling, `24h` as a safety net | `3days` or `week`, matched to the refresh interval so the window always overlaps the last run |
| Paging | One call (or skip/limit) | `offset` by `limit` until a short page | Cursor; stop at a fixed page cap |
| Incremental | Id diff | High-water mark + expired feed | None; rely on upsert idempotency |

---

## 7. Dedupe and closure

### 7.1 Dedupe keys

Keep the two existing keys and add one exact key between them.

| Level | Key | Status | Purpose |
|---|---|---|---|
| K1 | `(sourceBoard, externalId)` | Exists | Same row from the same source |
| **K2** | **`atsPostingKey = {ats}:{tenant}:{postingId}`**, parsed from the apply or source URL | **New** | The same requisition arriving from a feed or JSearch collapses onto the board row *exactly*, with no fuzzy matching |
| K3 | `sha1(company | title | place)` | Exists | Cross-source match when no ATS id is available |

URL patterns for K2 `[inferred from public URL shapes; verify each in tests]`:

- Greenhouse: `boards.greenhouse.io/{token}/jobs/{id}`, `job-boards.greenhouse.io/{token}/jobs/{id}`, and employer pages carrying `?gh_jid={id}` (tenant then comes from the known board for that company).
- Lever: `jobs.lever.co/{site}/{uuid}` (and `jobs.eu.lever.co`).
- Ashby: `jobs.ashbyhq.com/{org}/{uuid}`.
- SmartRecruiters: `jobs.smartrecruiters.com/{company}/{id}`.
- Workable: `apply.workable.com/{slug}/j/{shortcode}`.
- Workday: `{tenant}.wd{n}.myworkdayjobs.com/.../job/.../{slug}_{requisitionId}`.
- iCIMS: `{sub}.icims.com/jobs/{id}/`.

Improvements to K3 and to choosing the canonical row:

- Use the **employer's domain** in place of the normalized name when a source gives one (`employer_website`, `domain_derived`, the board's own company). "Stripe" and "Stripe, Inc." then agree, and two different companies called "Summit" do not.
- **Priority:** `ats_public` and `activejobs` are both 10 today. Make `ats_public` win (5): it is the employer's own listing and it carries the real closure signal.
- Tie-break on "has an employer-host apply URL" before recency.
- Keep duplicates as alternates (already the case) so a closed canonical hands over to the next row.
- Known limit: K3 merges two distinct requisitions with the same title in the same city at the same company. That is acceptable for display (one card) but **the tracker must store the row the user actually opened**, not the canonical one.

### 7.2 Closed and expired detection

| Source | Signal | Change |
|---|---|---|
| ATS boards | Posting absent from a *complete* listing → closed (exists) | Add: map Greenhouse `application_deadline` to `expiresAt`; when a board returns 404 or a redirect on three consecutive syncs, disable the source and archive its rows after a 48 h grace period |
| Licensed feed | Vendor's expired feed, by id | **New.** Today a feed row lives until posted + 45 days. The vendor rechecks each job daily and auto-expires at six months |
| JSearch | None in the payload (expiry field absent on 58 of 58) | Shorten the default life from 45 to 21 days for rows whose only link is a board or aggregator. Apply the "missed twice" rule once SR-16b-1 lands. Where the link is on an ATS host, K2 hands closure to the board sync |
| Any row with an ATS-host link | The ATS's own single-posting endpoint answers 404 when closed (`…/boards/{token}/jobs/{id}`, `…/postings/{site}/{id}`) | **Check on demand**: when a user opens the job or adds it to "Ready to apply", confirm it is still listed; show "closed" instead of a dead link. One documented JSON call, never an HTML fetch |
| USAJobs | `ApplicationCloseDate` | Use as `expiresAt` |
| Jobicy | Batch status endpoint | Use if the source is enabled |

Freshness honesty (D3): keep `postedAt` (employer's date), `firstSeenAt` (ours) and `lastSeenAt` (last confirmed listed) as three separate facts. "New" badges should use `firstSeenAt`; "posted N days ago" uses `postedAt` and says "estimated" when it is.

---

## 8. Concrete pipeline changes

Ordered by value. File paths are under `server/src/`.

### 8.1 Must

| # | Change | Where | Why |
|---|---|---|---|
| M1 | **Quota from headers, per month.** Persist `x-ratelimit-requests-remaining`, `-reset` and, for Fantastic, `x-ratelimit-jobs-remaining` into `RAProviderUsage`; stop a provider when remaining falls under a reserve; surface plan name and days to reset in the admin System panel. Remove the split between the clients' in-process budget and ingest's DB budget | `features/jobs/ingest/config.ts`, `ingest/pipeline.ts`, both clients | The defaults (300/day) are 360 times the subscribed Active Jobs plan; nobody saw the primary source die |
| M2 | **Planner: seeds only on unmetered or per-job sources.** Give adapters a `costModel` (`free`, `per_job`, `per_request`) and let `planQueries` skip `per_request` adapters for `seo_seed` tuples; stop planning for adapters whose `isEnabled()` or subscription check fails | `ingest/planner.ts`, `sources/types.ts` | 900 seed tuples × 3 providers cannot be served; LinkedIn queries are planned for an API we do not have |
| M3 | **Bulk career sources and discovery.** (a) CSV/JSON bulk import on the admin route; (b) on every ingested row, parse the apply URL to `(ats, tenant)` and upsert a *candidate* `RACareerSiteSource` (`enabled=false`, `origin='discovered'`); (c) auto-enable after a successful list-only read whose company name matches | `features/jobs/sources/atsPublic/{service,routes,sync}.ts`, `ingest/pipeline.ts` | The backbone has no companies. Needs two fields on `RACareerSiteSource` (`origin`, `discoveredFrom`) — schema request |
| M4 | **Board sync throughput.** Read 4–8 boards concurrently, adaptive interval, own cron entry or worker; raise the 500-posting cap or make it per-ATS (Greenhouse list calls return everything anyway) | `sources/atsPublic/{adapter,shared,sync}.ts`, `vercel.json` | 3 boards per fetch cannot cover 10k boards; a 728-job board takes two runs |
| M5 | **Feed-sync adapter for the licensed feed** (`kind: 'cursor'`): window + offset paging, `exclude_source` for directly-read ATSs, expired feed → `closedExternalIds` | new `features/jobs/ingest/adapters/fantasticFeed.ts`; reuse `normalize/adapters.ts` | Per-job pricing makes title×city search the wrong shape; closure signal is unused |
| M6 | **`atsPostingKey` and priority.** Parse K2 in the normalizer, add the column and index, use it in `applyDedupe` before the fuzzy key; set `ats_public` priority to 5 | `normalize/{ats,identity,source}.ts`, `ingest/upsert.ts`, Prisma `ra-jobs` | Exact cross-source dedupe; employer listing always wins |
| M7 | **JSearch direct-link logic.** Derive employer-direct from the link host; decide what happens to rows whose only link is LinkedIn or Indeed (recommended: keep for matching only when an employer-host alternative exists via K2, otherwise do not ingest); stop relying on `job_highlights` | `roboapply/v2/lib/raRapidApiJobs.ts`, `normalize/adapters.ts:127` | `is_direct` was true on 0 of 58 rows; ~26% of rows are LinkedIn-linked |

### 8.2 Should

| # | Change | Where |
|---|---|---|
| S1 | Connectors: Workable, Recruitee, Personio; Lever EU host; Greenhouse pay ranges and `application_deadline` | `sources/atsPublic/connectors.ts`, `contract.ts` (`PUBLIC_ATS`), `normalize/ats.ts` (add `recruitee`, `personio`, `teamtailor`, `bamboohr` hosts) |
| S2 | USAJobs adapter (cursor kind, `markets: ['intl']`, country US) | new `sources/usaJobs.ts` |
| S3 | Map the feed's enrichment fields first and skip the LLM for them: experience level, work arrangement, employment type, key skills, taxonomy, visa sponsorship (stored as "provider's reading") | `normalize/adapters.ts` (ARCH §4.2 already asks for this) |
| S4 | Sponsorship facts: loaders for USCIS / DOL / UK sponsor register into `RACompany.facts` with source and date; posting-text quotes for job-level tags | new `features/jobs/companies/sponsorship/*` |
| S5 | On-demand liveness check for ATS-host links (documented JSON endpoints only) on job open and on "Ready to apply" | `features/jobs/detail/service.ts` |
| S6 | Shorter life for board-only JSearch rows (21 days) | `normalize/identity.ts` |
| S7 | Identify our client: a User-Agent with product name and contact address on every ATS request | `sources/atsPublic/http.ts` |
| S8 | Source register in the repo: per provider — plan, quota, permitted surfaces (signed-in / public / partner API), attribution text, retention on termination, date read | new `docs/job-search/SOURCE_REGISTER.md`, feeding `PUBLIC_DISPLAY_PROVIDERS` |

### 8.3 Later

- Teamtailor and BambooHR connectors after live verification.
- TheirStack adapter if public job pages need its licence.
- Reed (UK), Arbeitnow (EU), Jobicy / RemoteOK (remote) once terms are confirmed in writing.
- Canada Job Bank partner feed if Canada becomes a priority market.
- A semantic retrieval index over our own table so onboarding and the Assistant stop calling providers at all.

---

## 9. Costs at launch scale `[inferred]`

| Item | Monthly | Basis |
|---|---|---|
| Public ATS boards | $0 | Compute only |
| Fantastic.jobs direct, 100k jobs | $250 (+$0.0025 per extra job) | [fantastic.jobs/api](https://fantastic.jobs/api) |
| JSearch, current plan | ~$25 | 10,000 requests `[likely]` |
| USAJobs | $0 | Free key |
| **Total** | **~$275** | Versus today: ~$25 buying thin third-hand inventory |

Alternative with public-page rights: TheirStack 100k credits at $600/month.

---

## 10. Decisions and credentials the owner must supply

| Need | Detail |
|---|---|
| **Licensed-feed plan** | Upgrade Active Jobs DB on RapidAPI (app 8974502), or buy the direct plan (new env `FANTASTIC_API_KEY`, host `data.fantastic.jobs`). Until then the priority-10 source returns nothing until ~2026-10-28 |
| **LinkedIn feed** | Confirm: do not subscribe; remove `linkedin` from RoboApply's `jobProviders` |
| **Written answer from Fantastic.jobs** | May jobs from the feed appear on public, indexable pages? Any retention rule after cancellation? |
| **USAJobs API key** | Free; requested with a contact email |
| **Counsel sign-off** | Public display of employer postings read from ATS job-board endpoints; JSearch redisplay rights |
| **Canada, Germany, France** | Whether to pursue partner agreements with Job Bank, Bundesagentur, France Travail |
| **Schema requests** | `RAJob.atsPostingKey`; `RACareerSiteSource.origin` / `discoveredFrom`; SR-16b-1 (still pending) |

---

## 11. Open questions

1. What does a second JSearch page cost on our plan, and what is the cursor parameter called in `/search-v2`?
2. How many jobs a month does the Fantastic feed return for our seven countries after excluding the ATSs we read directly? (Use the vendor's count endpoint on a trial.)
3. What are the actual paid tiers of the RapidAPI Active Jobs DB listing? The pricing tab does not render to a fetcher; the vendor only says "from $1 per 1,000 jobs".
4. Do Greenhouse, Lever and Ashby rate-limit the public endpoints at 10k boards a day from one IP? None documents a limit.
5. Is the Workable widget endpoint acceptable to Workable for third-party reading? No official statement found.
6. Does `pay_transparency=true` work on the Greenhouse *list* call, or only per job?
7. What share of our target users' roles (non-tech: healthcare, retail, trades) is reachable only through the licensed feed or JSearch?
8. Did Google v. SerpApi get past the motion to dismiss, and does OpenWeb Ninja face the same claim?

---

## 12. Sources

- Fantastic.jobs: [API and pricing](https://fantastic.jobs/api), [about and ATS list](https://fantastic.jobs/about), [new-jobs endpoint](https://developer.fantastic.jobs/documentation/endpoints/new-jobs), [expired-jobs endpoint](https://developer.fantastic.jobs/documentation/endpoints/expired-jobs), [terms](https://developer.fantastic.jobs/terms)
- TheirStack: [pricing](https://theirstack.com/en/pricing), [terms](https://theirstack.com/en/docs/legal/terms-and-conditions)
- JSearch / OpenWeb Ninja: [product page](https://www.openwebninja.com/api/jsearch), [terms](https://www.openwebninja.com/terms)
- Adzuna: [API terms](https://developer.adzuna.com/docs/terms_of_service), [overview](https://developer.adzuna.com/overview)
- ATS: [Greenhouse job board API](https://docs.greenhouse.io/job-board.html), [Lever postings API](https://github.com/lever/postings-api), [Ashby posting API](https://developers.ashbyhq.com/docs/public-job-posting-api), [Recruitee offers](https://docs.recruitee.com/reference/offers), [Personio XML](https://support.personio.de/hc/en-us/articles/207576365), [ATS endpoint reference](https://conorscode.github.io/ats-api-reference/), [Workday write-up](https://dev.to/dododata/scraping-workday-career-sites-without-a-browser-and-the-2000-job-ceiling-h2e)
- Company lists: [open-apply](https://github.com/sec-js/openapply)
- Free feeds: [USAJobs search API](https://developer.usajobs.gov/api-reference/get-api-search), [Arbeitnow](https://www.arbeitnow.com/blog/job-board-api), [Jobicy](https://jobicy.com/jobs-rss-feed), [RemoteOK](https://remoteok.com/api), [Remotive](https://remotive.com/remote-jobs/api), [Jooble](https://jooble.org/api/about)
- Public services: [bundesAPI Jobsuche](https://github.com/bundesAPI/jobsuche-api), [France Travail on data.gouv](https://www.data.gouv.fr/dataservices/api-offres-demploi), [Job Bank network](https://www.jobbank.gc.ca/network), [DOL OFLC performance data](https://www.dol.gov/agencies/eta/foreign-labor/performance)
- Legal context: [Google v. SerpApi](https://ppc.land/google-sues-serpapi-over-search-scraping-in-copyright-lawsuit/), [hiQ v. LinkedIn](https://en.wikipedia.org/wiki/HiQ_Labs_v._LinkedIn), [Proxycurl shutdown](https://nubela.co/blog/goodbye-proxycurl/), [Glassdoor API status](https://www.openwebninja.com/blog/glassdoor-api), [Indeed Publisher API](https://jobspipe.dev/blog/indeed-publisher-api.md)
- Vendor comparisons (written by competitors; treat as `[likely]`): [JobsPipe](https://jobspipe.dev/blog/best-jobs-api-2026.md), [JobDataLake](https://www.jobdatalake.com/blog/best-job-data-apis-2026), [Mantiks review](https://jobspipe.dev/blog/mantiks-review.md), [Careerjet](https://jobspipe.dev/blog/careerjet-api.md), [Reed](https://jobspipe.dev/blog/reed-api.md)
- In-repo: `docs/job-search/PROVIDER_EVALUATION.md`, `docs/job-search/LINKEDIN_STRATEGY.md`, `docs/jobright-clone/ARCHITECTURE.md` §4, `docs/jobright-clone/research/matching-jobs.md` §10
