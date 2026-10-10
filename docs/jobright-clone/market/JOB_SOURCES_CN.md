# GoApply (mainland China): job board, job sources and job-search APIs

**Date:** 2026-10-11. **Scope:** where GoApply (goapply.top) can get REAL mainland job postings, how to search, retrieve and match them, and what needs a partner or a licence. Researcher output for owner directive D5 ("the differences are the job board, job sources and job-search APIs").

**Confidence labels:** *confirmed* = read in our code, measured by a live probe, or read on the primary source; *likely* = one credible secondary source; *inferred* = my reasoning, or general knowledge I could not re-verify today. Every external claim carries a URL. Facts older than 2025 are marked stale where it matters.

**Probe budget used:** 8 of 8 RapidAPI calls (read-only, key never printed), plus unauthenticated reads of `robots.txt` files, one Postgres `SSLRequest` handshake to the GoHire DB endpoint (no login), and one `GET /api/v1/health` on `api.gohire.top`.

---

## 1. Verdict

1. **No mainland job board offers a public read API for postings.** BOSS直聘, 智联招聘, 前程无忧, 猎聘, 拉勾, 实习僧, 牛客, 应届生, 脉脉: none found, and the two biggest actively block automated readers (智联 puts even `robots.txt` behind a captcha). They stay **deep-link only**. *(confirmed for the robots/captcha facts; likely for "no API")*
2. **The only inventory that is ours, licensable and structured is the GoHire bank, and it is switched off today.** The cause is not a code bug: the GoHire Postgres endpoint does not speak TLS at all (it answered `N` to an SSL request), and our guard correctly refuses plaintext. RoboApply code alone cannot fix it. Two real fixes exist (§2.3); the better one is a small HTTPS syndication endpoint in the GoHire backend.
3. **RapidAPI does not solve mainland.** JSearch with `country=cn` returns real postings, but they come from Bing, are 100% "LinkedIn"-published, most are LinkedIn copies of 猎聘 postings, and **0 of 60 rows (and 0 of 1 detail call) carried an apply link or a salary**. A job card the user cannot open is not a job. Active Jobs DB is on the free BASIC plan (25 requests a month, exhausted); the LinkedIn Job Search API is not subscribed. *(confirmed by probe)*
4. **The largest legal, real, link-out inventory available without a platform partnership is employer career sites**: public ATS boards (北森 `*.zhiye.com`, Moka `app.mokahr.com`, plus the Greenhouse / Lever / Ashby / SmartRecruiters boards we already read, filtered to China) and big-company career portals. An open-source project already indexes about 17.6k live postings from 143 employers this way. This route needs counsel sign-off under the 2025 Anti-Unfair-Competition Law, strict politeness, source labels and a takedown path. Moka needs extra care (AES-wrapped responses). 飞书招聘 must not be read (signed requests plus captcha).
5. **Operating a job feed in the mainland is a regulated activity.** Publishing or aggregating postings sits between 备案 (collect-and-publish supply/demand information) and 许可 (网络招聘服务 needs a 人力资源服务许可证). The January 2026 five-ministry notice adds: verified posting accounts, mandatory fields (incl. base pay and validity), and **reposted postings must state their source**. D5 says the feed ships on; the lawful way to do that is to run it under GoHire's licence line and label every non-GoHire posting with its source and a link out.

**Recommended GoApply stack, in order of feasibility** (details in §6):

| # | Source | Real jobs now? | Blocker |
|---|---|---|---|
| 1 | User import (paste link / JD text) + deep links to boards | Yes, shipped | None |
| 2 | GoHire bank (`bank_gohire`) | Yes once reachable; inventory is thin | TLS on the endpoint, or the HTTPS syndication endpoint (2 repos) |
| 3 | `ats_public` China: Greenhouse / Lever / Ashby / SmartRecruiters boards tagged CN (already built), then 北森 | Yes | Curated employer list; counsel sign-off for 北森 |
| 4 | Active Jobs DB with `location=China` (multinationals on Workday / SuccessFactors etc.) | Likely; unmeasured | Paid plan; adapter is `intl`-only today |
| 5 | Campus calendar from official announcements (already designed) | Yes | Curation staff |
| 6 | Moka boards; big-company portals (字节, 腾讯, 阿里, 美团, 京东) | Yes | Counsel sign-off or employer / vendor authorisation |
| 7 | 24365 岗位共享, 国聘, 公共招聘网, 猎聘 / 智联 / 51job / BOSS / 牛客 / 实习僧 | Later | Partnership + licence |
| — | JSearch `country=cn`, scrapers, resold scraped datasets | No | No apply link / unlawful or ToS-breaking |

---

## 2. What we already have (code inspection)

### 2.1 GoApply's source stack as built

| Piece | File | State |
|---|---|---|
| Brand job providers | `server/src/platform/brand/registry.ts` line 230 | GoApply = `['bank_gohire', 'user_import']`. RoboApply = `['activejobs', 'bank_robohire', 'linkedin', 'jsearch', 'user_import']`. |
| Ingest provider selection | `server/src/features/jobs/ingest/providers.ts` | For `market === 'cn'`: `bank_gohire`, plus JSearch only if `CN_EXTERNAL_PROVIDERS=jsearch` ("testing only"). Then any registered adapter whose `markets` include `cn`. |
| RapidAPI adapters | `server/src/features/jobs/ingest/adapters/rapidApi.ts` | `jsearch` → markets `['intl','cn']`; `activejobs` and `linkedin` → `['intl']` only. |
| Bank cursor sync | `server/src/features/jobs/ingest/adapters/bank.ts` | Reads recruiter `Job` rows (open AND published) by `updatedAt|id` cursor into `RAJob`. `employerVerified` and `publicDisplay` read false until the bank schema has those fields (SR-16b-3 / SR-16b-4). |
| Bank clients and guard | `server/src/roboapply/v2/lib/raBankClients.ts` | `bankTlsSatisfied('gohire')` requires `sslmode ∈ {require, verify-ca, verify-full}` unless the host is local. Otherwise the bank is treated as not configured; one warning is logged. |
| Live cross-bank search | `server/src/roboapply/v2/lib/raBankProviders.ts`, `raCrossBankMatch.ts`, `services/RACrossBankSearchService.ts` | `findMany` with OR over title / description / tag sets, `status='open'`, fresh; never throws. Depends on the same client, so it is off for GoHire too. |
| Public ATS boards | `server/src/features/jobs/sources/atsPublic/connectors.ts` | Greenhouse, Lever, Ashby, SmartRecruiters. Provider `ats_public`. Workday deliberately unsupported. No Chinese ATS connector yet. |
| GoApply job rules | `server/src/features/cn/jobs/` (`mode.ts`, `card.ts`, `deeplinks.ts`, `fraud/`) | `CN_RECRUITMENT_INFO_MODE = off | partner_deeplink | licensed`, default **off** (pre-D5). Source line "企业直招" only when bank + verified + not agency, else "来源：{sourceName}". Deep links for BOSS, 智联, 猎聘 only. Fraud rules (培训贷, 收费, 传销…). Market tags (落户, 央国企, 事业编, 外企) need an evidence quote. |
| CN pay parsing | `server/src/features/jobs/normalize/salary.ts` | "15-25K·14薪" → monthly 15000–25000 CNY, `salaryMonths` 14. |
| Taxonomy and geo | `server/src/features/jobs/taxonomy/taxonomy.v1.json`, `geo/cities.json` | 307 role nodes with `zh` labels; 51 mainland cities (all four tier-1 and all fifteen 2025 新一线 cities are present). |
| Campus calendar | `server/src/features/cn/campus/` | Extractor over official announcements, curated. |
| Job import | `server/src/features/jobs/import/` | Paste a link or JD text; private to the user. |

*(all confirmed by reading the files)*

**D5 conflict to resolve.** `CN_RECRUITMENT_INFO_MODE` defaults to `off`, which hides every third-party posting on GoApply. D5 says a capability that is on for RoboApply is on for GoApply. The default should become `partner_deeplink` (GoHire bank shown under GoHire's licence line, apply opens the GoHire page) once the bank is reachable, with non-bank sources shown as "来源：{sourceName}" plus a link out. See §5 for why the licence line matters.

### 2.2 Does GoHire's HTTP API expose jobs?

No. GoHire is the RoboHire backend running with `APP_NAME=gohire` (`/Users/kenny/code/RoboHire/backend`; `server/src/lib/databaseUrl.ts` documents the white-label). Every job route is `requireAuth` and scoped to the caller's own jobs or delegations:

- `GET /api/v1/jobs` → `buildJobAccessFilter(accountUser)` (`backend/src/routes/jobs.ts` line 836): owner or delegate only; admins see all.
- `/api/v1/job-bank/*` → recruiter matching UI, all `requireAuth`.
- `/api/v1/public/*` → only match-report shares, job-market-insight shares and assessments. **No public or partner job listing, no feed, no sitemap.**
- API keys (`ApiKey` model, `validateApiKey` in `backend/src/middleware/auth.ts`) authenticate as one user, so `GOHIRE_API_KEY` (used by RoboApply only for `POST /api/v1/parse-resume`) would list only that user's jobs.

`https://api.gohire.top/api/v1/health` answered **200 over valid TLS** today, so an HTTPS route there is a ready transport. *(confirmed)*

### 2.3 Why the GoHire bank is off locally (OPS-A6), and whether code can fix it

**Root cause chain** *(confirmed)*:

1. `.env` → `DATABASE_URL_GOHIRE` points at `101.89.86.83:55543`, database `neondb`, with `sslmode=disable` and `pgbouncer=true` (so the listener is most likely PgBouncer).
2. WP-16b added `bankTlsSatisfied()` (CN-E-05). A GoHire URL without a TLS `sslmode` makes `isBankEnabled('gohire')` false and `getBankClient('gohire')` null. Bank sync stops; cross-bank GoHire search returns nothing; one `RA_BANK_CLIENTS` warning.
3. **Probe:** I sent the 8-byte Postgres `SSLRequest` to `101.89.86.83:55543`. The server replied `N` = "SSL not supported". So simply editing the URL to `sslmode=require` would make every connection fail. The endpoint itself has no TLS.
4. A second trap: `cleanConnectionString()` in `server/src/lib/prisma.ts` (lines 187–189) rewrites `require` / `prefer` / `verify-ca` to **`verify-full`**. After TLS is enabled, the certificate must be publicly trusted **and match the host name**. A bare IP with a self-signed certificate will still fail.

**Can RoboApply code fix it?** Not by itself. Removing the guard would send recruiter data and DB credentials in plaintext across the public internet and across the border, which CN-E-05 forbids. The three legitimate fixes:

| Option | Where | Work | Notes |
|---|---|---|---|
| **A. TLS on the DB endpoint** | GoHire host (ops) | Give the endpoint a DNS name (e.g. `db.gohire.top`), put a publicly trusted certificate on PgBouncer (`client_tls_sslmode = require`, `client_tls_cert_file`, `client_tls_key_file`), restrict the port by IP allow-list, then set the URL host to the DNS name with `sslmode=require`. | No RoboApply code change. Still a direct cross-border DB link carrying full DB credentials. |
| **B. HTTPS syndication endpoint (recommended)** | GoHire backend + RoboApply | In `RoboHire/backend`: `GET /api/v1/syndication/jobs?cursor=<updatedAt|id>&limit=200`, service-key auth with a new scope, returning exactly the `BANK_SYNC_SELECT` columns for open + published jobs, tombstones for closed ones, plus `employerVerified` and `syndicationConsentAt` (which also closes SR-16b-3 / SR-16b-4 and OPS-A4). In RoboApply: an HTTP variant of the bank adapter chosen when `GOHIRE_SYNDICATION_URL` is set. Point live cross-bank search at the synced `RAJob` mirror instead of the remote DB. | Field allow-list and employer consent enforced at the source; no DB credentials leave the mainland; `api.gohire.top` already serves valid TLS. About 2–3 days across both repos. |
| **C. Dev-only tunnel** | Developer machine | `ssh -L 55543:127.0.0.1:55543 <user>@101.89.86.83`, then use `localhost` in `DATABASE_URL_GOHIRE`. Local hosts are exempt from the TLS rule, and SSH encrypts the hop. | Zero code change; unblocks local development today if the owner has SSH access. Not a production answer. |

**Inventory size is unknown.** I did not open a plaintext connection to count rows. Project memory records a July 2026 run that retrieved 14 jobs across both banks for one query and found recruiter test postings (for example 「测试简历匹配」) in the GoHire bank. Expect a thin bank until GoHire recruiters publish more. *(likely; internal note `crossbank-jobsearch-agent-team.md`)*

---

## 3. Live probe results (2026-10-11)

| # | Call | Result |
|---|---|---|
| 1 | JSearch `/search-v2` `query=软件工程师 上海`, `country=cn`, `language=zh-cn` | 200. 20 jobs, all `job_country=CN`, all Chinese titles, 17 distinct employers. Publisher: **LinkedIn ×20**. `job_apply_link` null ×20, `apply_options` empty ×20, salary null ×20. 17 of 20 descriptions begin 「该职位来源于猎聘」. Median age 9 days, oldest 907 days. |
| 2 | JSearch `query=产品经理 北京`, `country=cn` | 200. 20 jobs, LinkedIn ×20, 0 apply links, 0 salaries, 17 of 20 marked from 猎聘. Median age 10 days. |
| 3 | JSearch `query=frontend engineer in Shanghai`, `country=cn` | 200. 20 jobs, LinkedIn ×20, mostly multinationals (Tesla, Anton Paar, Whatnot, Speechify). 0 apply links, 0 salaries. Median age 43 days; 13 of 20 older than 30 days. |
| 4 | JSearch `/job-details` for one job from probe 1 | 200. Still no apply link, no options, no salary. |
| 5–6 | Active Jobs DB `/active-ats` `location=China` (English and Chinese title) | **429**: "exceeded the MONTHLY quota … on your current plan, BASIC". Header limit: 25 requests a month. |
| 7 | LinkedIn Job Search API `/active-jb` `location=China` | **403**: "You are not subscribed to this API". |
| 8 | Same host, second query | 429 "Too many requests". |

What the JSearch rows tell us *(confirmed from the response bodies)*:

- For China, JSearch is served from **Bing**, not Google for Jobs: job ids decode to `bing:…`, and rows carry `job_posted_at_bing_label` and `job_bing_company_id`. Google's job experience does not list mainland China among its regions *(likely: [Teamtailor's copy of Google's region list](https://support.teamtailor.com/en/articles/2547163-available-regions-for-google-job-postings))*.
- The `date_posted=month` filter was not echoed in `parameters` and was not applied (a 907-day-old row came back).
- The publisher label says "LinkedIn" while the text says the posting came from 猎聘. Showing "来源：LinkedIn" would misstate the original source, which the 2026 notice requires us to state (§5).
- The repo's normalizer would store these rows with the note `no_apply_url` (`normalizeProviderJob.ts` line 188). They must not reach a GoApply feed.

**Conclusion:** keep `CN_EXTERNAL_PROVIDERS` empty. JSearch is not a GoApply source.

---

## 4. Source-by-source findings

### 4.1 Commercial job boards

| Board | Open platform / API for reading postings | Technical and robots reality | Use for GoApply |
|---|---|---|---|
| **BOSS直聘** (zhipin.com) | None public. A third-party directory lists only an authorised enterprise mini-program platform ("BossHi"), not a job-data API. *(likely: [API Evangelist](https://providers.apievangelist.com/providers/boss/))* | `robots.txt` disallows every search-parameter URL (`?query=`, `?city=`, `?salary=`, `?degree=`…), `/job_detail/l*.html` and named bots. *(confirmed: [robots.txt](https://www.zhipin.com/robots.txt))* Third-party "MCP servers" drive a logged-in browser and carry account-ban risk. *(likely: [GitHub mucsbr/mcp-bosszp](https://github.com/mucsbr/mcp-bosszp))* | Deep link only. Never automate 打招呼. |
| **智联招聘** (zhaopin.com) | None public. *(likely: no result in a targeted search; [community post describing internal XHR endpoints](https://www.cnblogs.com/dbirder/p/10437024.html), stale 2019)* | Requests from a plain client get a Tencent EdgeOne **captcha page**, even for `robots.txt`. *(confirmed: fetched 2026-10-11)* | Deep link only. Partnership for anything more. |
| **前程无忧 51job** | Contract-gated **posting** API for employers' ATS (push), not a read feed. *(likely: [SAP KBA 2651162](https://userapps.support.sap.com/sap/support/knowledge/en/2651162), [Manatal](https://www.manatal.com/integrations/my-contract-51job))* | Dynamic SPA behind an anti-bot challenge. *(likely: [Apify actor notes](https://apify.com/automation-lab/51job-scraper))* | Deep link (add it). Later: distribution channel for GoHire employers. |
| **猎聘** (liepin.com) | No open platform found. A third-party skill references a Liepin "MCP" login page (`liepin.com/mcp/server`), which returned 404 to me. *(inferred: unverified; [skill listing](https://playbooks.com/skills/xllinbupt/mcp2skill/liepin-jobs))* | `robots.txt` disallows `/*?*` (every query URL, i.e. all search pages) but not individual job pages. *(confirmed: [robots.txt](https://www.liepin.com/robots.txt))* An open-source CLI reads Liepin's public search without login and itself says: low frequency, **no commercial use, no bulk collection**. *(confirmed: [ai-job-search-cn README](https://github.com/rockbenben/ai-job-search-cn/blob/main/README.md))* | Deep link only. Best partnership target among boards: LinkedIn already re-publishes Liepin postings (probe §3), so Liepin does syndicate. |
| **拉勾** | None found. `robots.txt` did not load. | — | Deep link (add it). |
| **实习僧** | None found. Empty `robots.txt` (200). *(confirmed)* Co-organiser of the 2026届 national online campus fair. *(confirmed: [24365 fair page](https://24365.ncss.cn/student/jobfair/fairdetails.html?fairId=7fUt9qv2RwqKhHb6rrcQgL))* | — | Deep link; internship partnership target. |
| **牛客** | None found. `robots.txt` disallows `/search`; publishes sitemaps. *(confirmed: [robots.txt](https://www.nowcoder.com/robots.txt))* | — | Deep link; partnership target for 内推 and 笔试 content. Our copy gate bans the name in marketing copy (OPS-A8). |
| **应届生求职网** | None found. `robots.txt` is permissive (only admin paths disallowed). *(confirmed: [robots.txt](https://www.yingjiesheng.com/robots.txt))* | Content is largely reposted campus announcements. | Deep link. Do not copy: it is itself a reposter, so the original source would be lost. |
| **脉脉** | None found. `robots.txt` allows named AI search bots on article and company pages only. *(confirmed: [robots.txt](https://maimai.cn/robots.txt))* | — | Not a posting source. |

### 4.2 Public and state platforms

| Platform | Finding | Use |
|---|---|---|
| **国家大学生就业服务平台 24365** (ncss.cn, Ministry of Education) | MoE's 2022 notice describes two-way job sharing with provincial and university platforms "through data interfaces and embedding" and interconnection with social recruiting sites. *(confirmed: [MoE notice 2022](http://www.moe.gov.cn/srcsite/A15/s3265/202204/t20220406_614117.html))* The 2026届 fair lists co-organisers 国聘, 中智, 前程无忧, 智联, BOSS, 猎聘, 实习僧, 支付宝 and others. *(confirmed: [fair page](https://24365.ncss.cn/student/jobfair/fairdetails.html?fairId=7fUt9qv2RwqKhHb6rrcQgL))* No public API or published onboarding rules for new social agencies. | **Partner channel.** Needs a licensed entity and a direct approach to 教育部学生服务与素质发展中心. Most defensible campus inventory. |
| **国聘** (iguopin.com, 国投人力) | State-owned-enterprise postings. `robots.txt` allows everything. *(confirmed: [robots.txt](https://www.iguopin.com/robots.txt))* No API found; legal statement page did not render for me. | Deep link now (add it). Partnership for a feed. |
| **中国公共招聘网** (job.mohrss.gov.cn) and **就业在线** (jobonline.cn) | MoHRSS-run aggregation of public employment-service postings; named as a channel in the 2026 "国聘行动" notice. *(likely: [bbtnews 2026-06](https://www.bbtnews.com.cn/2026/0602/595052.shtml))* No published data interface. | Deep link. Ask the local 人社局 when GoHire files its service scope. |
| **Provincial open-data portals** | 辽宁's portal lists HRSS datasets such as graduate job-fair information, with API access. *(likely: [data.ln.gov.cn](https://data.ln.gov.cn/oportal/index))* 北京, 上海 and 深圳 portals have labour categories; I could not confirm posting-level datasets. *(inferred)* | Low volume, patchy, but openly licensed. Worth one day of cataloguing for 招聘会 (job-fair) data that feeds the campus calendar. |
| **公职 / 国企招录** | A commercial API (GuGuData) sells structured 公务员 / 事业单位 / 军队文职 / 三支一扶 / 国有单位 postings "from public materials"; pricing and licence terms are not stated. *(likely: [V2EX thread](https://www.v2ex.com/t/1241407), [product page](https://www.gugudata.com/api/details/recruitmentpositions))* | Candidate for a "体制内" vertical later. Ask for the licence in writing first. |

### 4.3 Aggregators and data APIs that cover China

| Provider | What it returns | Verdict |
|---|---|---|
| **JSearch** (RapidAPI) `country=cn` | Probed, §3: Bing-backed, LinkedIn-only, no apply links, no pay. | **Do not use.** |
| **Active Jobs DB** (Fantastic Jobs, RapidAPI) | Direct postings from employer career sites on 58 ATS platforms (Workday, SAP SuccessFactors, Oracle, iCIMS, Greenhouse, Lever, Ashby, SmartRecruiters…). No Chinese ATS (no Moka, 北森, 飞书, 大易). *(confirmed: [Fantastic Jobs ATS list](https://fantastic.jobs/article/ats-with-api))* | **Useful for multinationals hiring in China** (apply links go to the employer's ATS). Coverage is unmeasured because our plan is BASIC (25 calls a month). Needs a paid plan and `markets: ['intl','cn']` on the adapter. |
| **LinkedIn Job Search API** (Fantastic Jobs) | LinkedIn postings. Not subscribed (403). LinkedIn closed its mainland app InCareer on 2023-08-09 and ended local job posting for mainland employers. *(likely: [Technode](https://technode.com/2023/05/10/linkedin-shuts-china-app-cuts-over-700-jobs), [LinkedIn help](https://www.linkedin.com/help/learning/answer/a543397))* | Skip for GoApply: mainland users cannot rely on LinkedIn to apply. |
| **Careerjet partner API v4** | `search.api.careerjet.net/v4/query`; locale `zh_CN` (careerjet.cn) and `en_CN` exist in the official client. Returns title, company, locations, salary min/max/type, date, excerpt, and a tracking redirect URL. Requires the end user's IP and user agent on every call; paging capped near 1,000 results. *(confirmed: [API docs](https://www.careerjet.com/partners/api), [official Python client](https://github.com/careerjet/careerjet-api-client-python); design read-out: [JobsPipe](https://jobspipe.dev/blog/careerjet-api))* | **Possible display-only source** after the owner opens a publisher account. Built for showing results to a user, not for building an index; sending mainland users' IPs to a foreign API is a cross-border transfer that needs consent. Coverage in China unmeasured (careerjet.cn served me an anti-bot page). Low priority. |
| **Jooble API** | One key per country domain; free tier is 500 requests per key in total. A China domain key is not documented. *(confirmed: [Jooble API docs](https://help.jooble.org/en/support/solutions/articles/60001448238-rest-api-documentation))* | Skip. |
| **企查查 "企业招聘信息" API** | Lookup **by company** (name or credit code), not by keyword or city. Fields: title, monthly pay, experience, education, city, publish date. No source site or original URL. ¥0.50 a call; enterprise real-name account and use-case review. *(confirmed: [企查查开放平台](https://openapi.qcc.com/dataApi/718))* | Enrichment only (for example "this company lists N open roles", with the provider named). Not a feed: without the original link we cannot state the source or let the user apply. |
| **阿里云 / 腾讯云 marketplace "招聘信息查询" APIs** | Same shape as 企查查: company-keyed, "aggregated from multiple public channels", provenance unstated. *(likely: [Aliyun developer article](https://developer.aliyun.com/article/1764502), [Tencent Cloud article](https://developer.cloud.tencent.com/article/2746628))* | Same verdict. Resold scraped data inherits the scraping risk. |
| **聚合数据 / 极速数据** | No job-search product surfaced in search. *(inferred)* | None. |
| **百度百聘** | Shut down; folded into 爱企查, which links out to third-party boards. *(likely: [Tencent News 2024-09](https://news.qq.com/rain/a/20240908A044RH00), may be stale)* SerpApi has no Baidu jobs engine that I could find. *(inferred)* | None. |
| **Revelio / Techmap / Coresignal / TheirStack / Apify actors** | Datasets or scrapers built by crawling 51job, 智联, 猎聘. Revelio states it scrapes those three in-house. *(likely: [CEIC / Revelio note](https://www.ceicdata.com/en/china/number-of-job-postings-new-by-industry), [Apify 智联 actor](https://apify.com/getascraper/zhaopin-jobs-scraper))* | **Do not use for display.** Analytics datasets with no right to republish, and the collection method is exactly what §5 warns about. |

### 4.4 Employer career sites and the ATS behind them

This is where real, first-party mainland postings are publicly readable.

| ATS / site | Public surface | Official, authorised API | Verdict |
|---|---|---|---|
| **北森 Beisen** (`<tenant>.zhiye.com`) | Unauthenticated `POST https://<tenant>.zhiye.com/api/Jobad/GetJobAdPageList` with a JSON body (paging, `Category` 1 = 社招, `DisplayFields` for date / location / salary). No cookie, token or signature. *(likely: [OpenHire connector source](https://github.com/gzchenhao/openhire), read 2026-10-11; not called by me)* | Tenant-authorised OpenAPI at `openapi.italent.cn`, e.g. `POST /RecruitV6/api/v1/JobAd/GetJobAdList`. *(confirmed: [北森 API docs](https://apifox.com/apidoc/docs-site/436023/api-6342760))* Beisen says it connects 170+ external recruiting channels. *(likely: [beisen.com](https://www.beisen.com/product/recruitment/))* | **Best first Chinese ATS connector.** Plain JSON, no technical measure to get around. Still needs counsel sign-off and a curated tenant list. |
| **Moka** (`app.mokahr.com/apply/<org>/<siteId>`, `/social-recruitment/…`, `/campus-recruitment/…`) | `POST /api/outer/ats-apply/website/jobs` and `/website/job`. Responses are **AES-128-CBC wrapped**: the key travels in the response, the IV in the page HTML. `robots.txt` disallows only two named employer boards. *(confirmed for robots: [robots.txt](https://app.mokahr.com/robots.txt); likely for the endpoint: [OpenHire `moka.py`](https://github.com/gzchenhao/openhire))* | Official API set documented on Apifox, including a "招聘官网 API" (list jobs, apply) for customers building their own career site. *(likely: [Moka API docs](https://mokahr.apifox.cn/doc-349793), [2023 manual](https://mokahr.moyincloud.com/d/1590619539539857409.html))* | **Hold.** Decoding a wrapped response is arguably "避开技术管理措施" under the 2025 law (§5). Use the official 招聘官网 API with employer authorisation, or get written counsel sign-off first. Always honour the per-employer robots opt-outs. |
| **飞书招聘** (`<tenant>.jobs.feishu.cn`) | List requests are signed (`_signature`) and gated by a captcha SDK. *(likely: [OpenHire README](https://github.com/gzchenhao/openhire))* | Feishu Open Platform hire APIs under `/open-apis/hire/v1/` with a tenant token (website job-post list). *(likely: [Feishu hire API](https://apifox.com/apidoc/docs-site/532425/api-11256993); the official doc page did not render for me)* | **Never read the public surface.** Employer-authorised API only. |
| **大易 Dayee, 用友, 金蝶** | Not researched to endpoint level. *(inferred: public career pages exist; no public API found)* | Vendor / customer APIs only. | Later, via employer authorisation. |
| **Workday / SuccessFactors China** | No public postings API (our own connector file says so). Covered indirectly by Active Jobs DB. | — | Through Active Jobs DB only. |
| **Greenhouse / Lever / Ashby / SmartRecruiters** | Documented public board APIs, already implemented in `atsPublic/connectors.ts`. Used by foreign firms and some Chinese tech firms hiring in China. | — | **Ready now**: add China-hiring boards to the curated source list with `countryCode: 'CN'`. |
| **字节跳动** (jobs.bytedance.com) | `robots.txt` explicitly **allows** `/experienced`, `/society`, `/campus`; disallows `/referral`. *(confirmed: [robots.txt](https://jobs.bytedance.com/robots.txt))* The site's own JSON search uses request signing. *(inferred, general knowledge)* | — | Calendar entries and link-outs now. A connector only with sign-off, and never by forging signatures. |
| **腾讯, 阿里, 美团, 京东** career portals | Each renders from its own JSON endpoints. `careers.tencent.com/robots.txt` redirects (302); `talent.alibaba.com` has no robots file (404); 美团 returns an app shell. *(confirmed for the robots responses)* Endpoint details are from general knowledge and were not probed. *(inferred)* | — | Same as 字节: campus calendar and link-outs first; per-site connector only after counsel review of each site's terms. |

**Scale check:** OpenHire's public numbers file reports 144 companies indexed, 143 with live postings, **17,626 live postings**, median 68 days open (generated 2026-10-08), from Greenhouse, Lever, Ashby, 北森 and Moka plus two bespoke connectors. It also offers employers removal on request. *(confirmed: [docs/numbers.json](https://github.com/gzchenhao/openhire/blob/HEAD/docs/numbers.json), [project announcement](https://github.com/ruanyf/weekly/issues/12137))* A few hundred curated employers would plausibly give GoApply tens of thousands of first-party postings. *(inferred)*

---

## 5. Legal position, in practical terms

Not legal advice; these are the points counsel must confirm (OPS-C).

**5.1 Reading public postings: unfair-competition law, not PIPL.**
- Job postings are employer information, so PIPL is generally not triggered. A named recruiter's phone number or WeChat inside a posting **is** personal information: strip it or keep it out of the index. *(inferred)*
- The revised 反不正当竞争法 took effect **2025-10-15**. Article 13(3) bars obtaining or using data that another operator lawfully holds "by fraud, coercion, **avoiding or breaking technical management measures** or other improper means" where that harms the operator and disrupts competition. "Avoiding" is new and reaches simulated logins and captcha bypass. *(confirmed: [SPC IP Court note](https://ipc.court.gov.cn/zh-cn/news/view-4588.html); likely for the analysis: [King & Wood Mallesons](https://www.kingandwood.com/cn/zh/insights/latest-thinking/key-takeaways-of-the-2025-revision-of-china-s-anti-unfair-competition-law.html), [DeHeng](https://www.dehenglaw.com/CN/newscontent/0008/034390/2.aspx?MID=0902))* Some scholars read a robots exclusion as a "management measure". *(likely: [Global Law Office](https://www.glo.com.cn/Content/2025/10-24/1107527632.html))*
- **SPC Guiding Case 262** (published 2025-08-28): scraping a platform's content and re-serving it so users no longer need the original is unfair competition; "substantial substitution" is the test that hurts. *(confirmed: [SPC IP Court](https://ipc.court.gov.cn/zh-cn/news/view-4588.html))*
- **SPC Guiding Case 263** (same batch; a recruitment-site case): moving data out of a job site **at the user's own choice and for the user's own use** is not unfair competition, even though the tool handled the site's login captcha. *(confirmed: [SPC case page](https://www.court.gov.cn/shenpan/xiangqing/474461.html))* This is the legal footing for our user-initiated import and the 一键填表 extension.
- Criminal exposure exists for resume scraping (the 巧达 case in our earlier research), not for postings.

**What follows for GoApply:**

| Practice | Risk | Rule |
|---|---|---|
| User pastes a link or JD; extension reads the page the user is on | Low (Case 263) | Keep it user-initiated, private to that user, no bulk. |
| Reading an employer's own career board and linking out to it | Low to medium | We send traffic to the employer, we do not substitute it. Respect robots, rate-limit per tenant, never log in, never solve a captcha, never compute a signature, label the source, remove on request. Get counsel sign-off per ATS. |
| Decoding Moka's AES envelope | Medium | Arguably "avoiding a technical measure". Sign-off or official API first. |
| Reading BOSS / 智联 / 猎聘 / 51job search results | **High** | Captcha, query URLs disallowed, direct competitors, substitution. Never. |
| Buying scraped posting data to display | High | Inherits the above and breaks the "state the source" duty. Never. |

**5.2 Operating the job board: licence and filing.**
- 《人力资源市场暂行条例》 Art. 18: 职业中介活动 needs a **人力资源服务许可证**; merely collecting and publishing supply/demand information needs a **备案** within 15 days. Art. 42: unlicensed intermediary activity → closure, confiscation, fine ¥10k–50k; failure to file → ¥5k–10k after refusing to correct. *(confirmed: [State Council Order 700](https://www.gov.cn/zhengce/content/2018-07/17/content_5306967.htm))*
- 《网络招聘服务管理规定》 (in force 2021-03-01): commercial agencies doing 网络招聘服务 must hold the licence, plus a telecom licence where a telecom business is involved (Art. 9); show the business licence and HR licence on the home page (Art. 13); vet employers' materials (Art. 17); keep postings current (Art. 18); platforms verify entrants and keep records at least 3 years (Arts. 25–26). The text does not address pure linking or indexing. *(confirmed: [gov.cn text](https://www.gov.cn/zhengce/zhengceku/2020-12/25/content_5573141.htm))*
- **Five-ministry notice 《关于规范网络平台招聘类信息发布的通知》** (dated 2025-12-25, published January 2026): platforms offering posting services need the licence; real-name accounts; posting accounts verified by type and **re-verified at least every six months**; a "招聘服务类" label with licence details; each posting must carry employer basics, headcount, requirements, duties, location and **base pay**, and a **validity period or be kept current**; **reposted postings must clearly state the source**; no "高薪" / "保录" bait, no 招转培 / 培训贷 funnels. *(confirmed for publication: [中国就业网](https://chinajob.mohrss.gov.cn/c/2026-01-14/480200.shtml); likely for the clause read-out: [安全内参 full text](https://www.secrss.com/articles/87005))*

**What follows for GoApply:**
1. Run the mainland feed under **GoHire's licence line** (`CN_HR_LICENCE_HOLDER`, `CN_HR_LICENCE_NUMBER`, already wired in `cn/jobs/mode.ts`). The owner must confirm GoHire's entity actually holds the licence with "开展网络招聘服务" in scope, and the ICP / EDI position.
2. Every non-GoHire posting shows **"来源：{original publisher}"**, the original link, "最后核验 {date}", and expires on a clock (the repo archives after 45 days without an expiry: keep that for CN).
3. GoApply never accepts postings from employers directly; that is GoHire's job. This keeps GoApply on the "collect and publish information / link out" side, with GoHire as the licensed 网络招聘 operator.
4. Keep the fraud rules and the admin review queue: they map one-to-one to the notice's prohibited list.

---

## 6. Recommended GoApply source stack

Ranked by "returns real mainland jobs soonest for the least risk".

### Tier 0: already works, zero dependency
1. **User import** (`features/jobs/import`): paste a link or JD text from any board. Private rows; full matching, tailoring and tracking work on them.
2. **Deep links**, extended from 3 to 9 boards. Add 前程无忧, 拉勾, 实习僧, 牛客, 国聘 and 24365 to `CN_EXTERNAL_BOARD_SPECS`, each built only from the user's own query. Pick per audience: 校招 users see 实习僧 / 牛客 / 24365 / 国聘 first. URL patterns must be checked in a browser before shipping; I did not verify them.

### Tier 1: this month, code and ops only
3. **GoHire bank** via fix B (HTTPS syndication endpoint) or fix A (TLS on the endpoint). Flip `CN_RECRUITMENT_INFO_MODE` default to `partner_deeplink` when reachable. Filter out test postings (empty company, titles containing 测试). First-party, licensed, verified: this is the only source that may ever carry "企业直招".
4. **`ats_public` for China, phase 1**: add China-hiring boards on Greenhouse / Lever / Ashby / SmartRecruiters to the curated source list (connectors already exist). Change needed: let `ats_public` rows with a CN location enter `market: 'cn'`.
5. **Active Jobs DB for `cn`**: upgrade the RapidAPI plan, set the adapter's markets to `['intl','cn']`, query `location=China` with both English and Chinese titles, then measure. Multinationals' China roles with direct ATS apply links. Send only role text to the API, never user data.

### Tier 2: after counsel sign-off (2–4 weeks)
6. **北森 connector** in `atsPublic/connectors.ts`: `ats: 'beisen'`, `boardToken = tenant`, social and campus categories read separately, 2 tenants in flight at most, 30-minute floor per tenant, hard cap per run, identify ourselves in the User-Agent with a contact address. Seed 100–300 employers by hand (tenant validated against the live board).
7. **Campus calendar** stays the campus spine: 届别, 网申 open / close, 笔试 / 面试 waves, official link. Fed by employer portals (字节 allows `/campus` in robots) and university career centres.
8. **Moka connector** only via the official 招聘官网 API with employer authorisation, or with written sign-off on the AES point.

### Tier 3: partnerships (owner track)
9. **24365 岗位共享** and **国聘**: campus and SOE inventory. Requires the licensed entity.
10. **Employer-authorised ATS channel**: register GoHire as a recruiting channel with 北森 / Moka / 飞书招聘 so customers can push postings to GoHire with one click. GoApply then receives them through the bank.
11. **猎聘** (it already syndicates to LinkedIn), then 智联 / 51job / 实习僧 / 牛客: commercial feed or affiliate deals.

### Never
- Scrape or automate BOSS, 智联, 猎聘, 51job, 拉勾 or 飞书招聘. Use reverse-engineered "MCP servers". Buy scraped posting datasets for display. Show JSearch `country=cn` rows.

**Honesty rule for counts (D3):** the GoApply feed header states where its postings come from, for example "来自 GoHire 与 N 家企业招聘官网". It never implies full-market coverage. When a search has few results, show the deep links.

---

## 7. How to search, retrieve and match (query plan)

**7.1 Architecture: ingest first, search locally.** No mainland source offers lawful keyword search over the whole market. Per-employer boards and the GoHire bank are feeds, so GoApply must ingest on a schedule into `RAJob (market='cn')` and search its own index. Live fan-out per user query, which RoboApply does with RapidAPI, does not exist for the mainland (Active Jobs DB is the one exception).

**7.2 Chinese text retrieval.** I found no CJK word segmentation in the jobs search path (`grep` for jieba / bigram / segmenter / tsvector under `server/src/features/jobs` and `search` found only resume and enrichment keyword code). Trigram indexes do not help two-character Chinese terms such as 产品 or 运营. Recommendation *(inferred; check against ARCHITECTURE §4 before building)*:
- At ingest, segment title, company and JD with `Intl.Segmenter('zh', { granularity: 'word' })` (built into Node 24) into a `searchTokens` column; index `to_tsvector('simple', searchTokens)` with GIN. Segment the user's query the same way.
- Expand the query with taxonomy synonyms (below) and with Simplified / Traditional variants (`normalize/zhVariants.ts` exists).
- Rank: taxonomy role match > title token match > JD token match, then freshness, then the existing LLM match scorer on the top N. Add multilingual embeddings later for recall.

**7.3 中文职位分类 (role taxonomy).** Keep `taxonomy.v1.json` (307 nodes, `zh` labels) as the canonical tree and add a CN alias layer:

| Family (L1) | Canonical zh (examples) | Aliases to map in |
|---|---|---|
| 技术 | 前端开发, 后端开发, 移动开发, 测试, 运维, 算法, 数据开发, 嵌入式, 硬件 | Web前端 / 前端工程师 / FE; 服务端 / Java开发 / Go开发 / 后台开发; iOS / Android / 鸿蒙开发; QA / 测试开发; SRE / DevOps; 机器学习 / 大模型 / NLP / CV / AIGC; 数仓 / 大数据; 单片机 / 驱动; FPGA / 芯片验证 |
| 产品 | 产品经理, 产品运营, 数据产品 | PM / 产品策划 / B端产品 / AI产品经理 |
| 设计 | UI设计, 交互设计, 视觉设计, 工业设计 | UX / UE / 平面设计 |
| 运营 | 用户运营, 内容运营, 电商运营, 新媒体运营, 活动运营 | 直播运营 / 社群运营 / 短视频运营 |
| 市场 / 销售 | 市场营销, 品牌, 销售, 大客户销售, 商务拓展 | BD / KA / 销售代表 / 客户经理 |
| 职能 | 人力资源, 财务, 法务, 行政, 采购 | HRBP / 招聘专员 / 会计 / 出纳 |
| 金融 | 投行, 行研, 风控, 量化, 柜员, 理财经理 | 投资经理 / 分析师 |
| 制造 / 供应链 | 工艺工程师, 质量工程师, 生产管理, 供应链, 物流 | PE / QE / ME / PMC |
| 教育 / 医疗 / 其他 | 教师, 教研, 医生, 护士, 医药代表, 客服 | — |
| 校招专属 | 管培生, 储备干部, 校招通用岗 | 管理培训生 |

For formal mapping and public-sector roles, key the tree to 《国家职业分类大典（2022年版）》 *(inferred: standard reference, not re-verified today)*.

**7.4 Cities.**
- 一线: 北京, 上海, 广州, 深圳.
- 新一线 (2025 list): 成都, 杭州, 重庆, 武汉, 苏州, 西安, 南京, 长沙, 郑州, 天津, 合肥, 青岛, 东莞, 宁波, 佛山. *(confirmed: [湖南日报 2025-05](https://www.hunantoday.cn/news/xhn/202505/29577937.html))* The 2026 report was published 2026-05-28; I could not read its list, so refresh the tier table from it. *(likely: [第一财经](https://www.yicai.com/news/103204902.html))*
- All 19 are already in `geo/cities.json`. Store the 6-digit administrative division code as the city key, parse "上海市·浦东新区" and "上海-浦东新区-张江" into city + district, and treat 全国 / 多地 / 远程 as flags rather than cities.
- Seed ingest demand with tier-1 plus 新一线 × the top 40 roles; let user profiles drive the rest (the planner already works that way).

**7.5 校招 vs 社招.** One enum on every posting: `社招 | 校招 | 实习 | 兼职`.
- Sources state it: 北森 `Category`, Moka path (`social-recruitment` vs `campus-recruitment`), 字节 path (`/experienced` vs `/campus`), GoHire `employmentType` / `experienceLevel`.
- 校招 needs 届别 (already modelled as `class_year:<yyyy>` tags with an evidence quote) and batch (提前批 / 秋招 / 春招 / 补录). Never infer 届别 from the posting date.
- 实习 needs 天/周, 月数 and 是否可转正 when stated.
- Onboarding should ask 身份 (在校生 / 应届 / 往届 / 职场人) first and default the filter from it.

**7.6 Pay (薪资).** Mainland convention is monthly × N months.

| Posting text | Parse to |
|---|---|
| `15-25K·14薪` | monthly 15,000–25,000 CNY, `salaryMonths` 14 (done) |
| `1.5-2.5万` / `1.5万-2.5万/月` | monthly 15,000–25,000 |
| `20-40万/年` | yearly 200,000–400,000 |
| `200-300元/天` (实习) | daily 200–300 |
| `8-10千` | monthly 8,000–10,000 |
| `面议` / `薪资面议` | not disclosed; keep the text verbatim |
| 北森 / Moka bare numbers (`35-57` vs `35000-60000`) | ambiguous unit: keep verbatim, mark estimated, do not filter on it |

Rules: filter and sort on **monthly** pay for the mainland; show the source's own text first; annualise only with a stated N (otherwise ×12, labelled 估算); currency CNY unless stated; never invent a range. Since the 2026 notice requires base pay on postings, a posting with no pay gets a "未标注薪资" flag rather than being dropped.

**7.7 Education (学历)** enum: 不限 / 初中及以下 / 中专·中技 / 高中 / 大专 / 本科 / 硕士 / 博士. Tags only when the posting says so: 统招, 全日制, 985 / 211 / 双一流, 海外留学. Match rule: the posting's requirement is a floor; "本科及以上" matches 硕士 and 博士.

**7.8 Experience (经验)** enum: 在校生 / 应届生 / 1年以内 / 1-3年 / 3-5年 / 5-10年 / 10年以上 / 经验不限. Parse "3年以上" to a minimum of 3 with no maximum. An age cap in a posting ("35岁以下") is a discrimination signal: flag it, never use it to filter users out.

**7.9 Other mainland filters** (only from stated facts, each with an evidence quote): 企业性质 (央企 / 国企 / 民企 / 外企 / 事业单位), 融资阶段, 规模, 五险一金, 双休 / 大小周 / 单休, 落户, 编制, 是否外包 / 驻场, 是否接受应届.

---

## 8. Normalization rules for mainland sources

1. **Identity and dedupe.** Key = normalised company + normalised title + city. Company normalisation: strip 有限公司 / 有限责任公司 / 股份有限公司 / 集团 / bracketed region such as （上海） / 分公司; map brand to legal name through a curated alias table (字节跳动 = 北京抖音信息服务有限公司, and so on); use the 统一社会信用代码 when a source provides it. Add a JD text fingerprint for cross-source twins. Preference when twins collide: GoHire bank > employer board > aggregator.
2. **Source and attribution** (five-ministry notice). Always store `sourceName` (the original publisher), `sourceUrl`, `fetchedAt`, `lastSeenAt`. An aggregator's label is never the source: for a LinkedIn row that says 「该职位来源于猎聘」 the original publisher is 猎聘.
3. **Apply link.** A mainland posting with no usable apply URL is not shown in the feed. Bank jobs open the GoHire page (`https://www.gohire.top/jobs/{id}`); board jobs open the employer's own page.
4. **Dates.** Sources publish naive Beijing time: store UTC, treat as UTC+8. 北森 serialises "no date" as year 0001: store null. Without a posted date, show "最后核验 {date}", never "发布于".
5. **Expiry.** Use the source's validity when stated; otherwise close when the posting disappears from a complete board listing, and archive after 45 days unseen.
6. **Text.** Convert HTML to text, collapse whitespace, strip slogans (急聘 / 高薪 / 直招; the regex is already in `normalize/text.ts`), remove recruiter phone numbers, WeChat ids and QR-code fields (北森 returns `WorkWeChatQrCode`: do not store it).
7. **Location.** One row per posting with a `locations[]` list for multi-city postings; the city filter matches any of them.
8. **Language.** Store Simplified Chinese as received. Keep bilingual titles such as "软件工程师 Software Engineer" whole, and index both halves.
9. **Fraud and quality.** Run the existing CN fraud rules on every ingested row. Blacklisted employers and flagged rows never enter the public feed.
10. **Agencies.** Postings from 人力资源公司 / 外包 / 猎头 are labelled 代招 with the agency named; never "企业直招".

---

## 9. What needs a partnership, a licence or an owner action

| Item | Type | Owner action |
|---|---|---|
| GoHire bank reachable | Ops or code | Choose fix A (TLS + DNS name + trusted certificate) or fix B (syndication endpoint; needs a work package in the RoboHire repo). Fix C for local dev needs SSH access. |
| GoHire 人力资源服务许可证 with 网络招聘 in scope; ICP / EDI | Licence | Confirm holder and number; set `CN_HR_LICENCE_HOLDER` / `CN_HR_LICENCE_NUMBER`. |
| GoApply entity: 备案 for 人力资源供求信息的收集和发布, or rely on GoHire | Filing | Counsel decision. |
| Employer verification on GoHire: real-name, six-month re-verification, base pay and validity on every post | Product (GoHire) | Add `employerVerified`, `syndicationConsentAt`, validity to the bank schema (SR-16b-3 / SR-16b-4). |
| Counsel memo on reading 北森 / Moka / big-company boards under AUCL Art. 13(3) | Legal | One memo covering: robots as a management measure, Moka's AES envelope, link-out vs substitution, takedown process. |
| Active Jobs DB paid plan | Subscription | Upgrade on RapidAPI, then measure China coverage before committing. |
| Curated CN employer list (tenant ids for 北森 / Moka / global ATS) | Content ops | 100–300 employers to start; reuse campus-calendar staff. |
| 24365, 国聘, 公共招聘网 | Partnership | Approach through the licensed entity. |
| 北森 / Moka / 飞书招聘 channel registration for GoHire | Partnership | Vendor business-development contact; customers authorise per tenant. |
| 猎聘 / 智联 / 51job / BOSS / 实习僧 / 牛客 feeds | Commercial | Later; 猎聘 first. |
| Careerjet publisher account (optional) | Account | Owner signs up and accepts terms; weigh the cross-border IP transfer. |

---

## 10. Open questions

1. How many open, published, non-test jobs does the GoHire bank hold today, by city and role? (Not measured: the only route is plaintext.)
2. Does GoHire's entity hold the 人力资源服务许可证, and does its scope include 网络招聘服务?
3. Fix A or fix B for the bank? B needs a work package in the RoboHire/GoHire backend repo.
4. Does D5 change the default of `CN_RECRUITMENT_INFO_MODE` to `partner_deeplink`, and may employer-board postings be shown before the counsel memo?
5. Active Jobs DB: what is the real China volume and how many rows have Chinese titles? Needs a paid plan and about 10 calls.
6. May `ats_public` postings be shown publicly (SEO pages) on GoApply, or to signed-in users only? `PUBLIC_DISPLAY_PROVIDERS` is empty by default.
7. Does 猎聘 run an official agent / MCP channel (`liepin.com/mcp/server` returned 404 from outside the mainland)? Check from a mainland network.
8. The 2026 新一线 city list (published 2026-05-28) was not readable; refresh the tier table from it.
9. Exact deep-link URL patterns for 51job, 拉勾, 实习僧, 牛客, 国聘 and 24365 need a browser check.

---

## 11. Sources

**Internal (confirmed):** `server/src/roboapply/v2/lib/raBankClients.ts`, `raBankProviders.ts`, `raCrossBankMatch.ts`, `raRapidApiJobs.ts`, `raFantasticJobs.ts`; `server/src/features/jobs/ingest/{providers.ts,config.ts,adapters/bank.ts,adapters/rapidApi.ts}`; `server/src/features/jobs/sources/atsPublic/connectors.ts`; `server/src/features/jobs/normalize/{salary.ts,normalizeProviderJob.ts}`; `server/src/features/cn/jobs/{mode.ts,deeplinks.ts,contract.ts}`; `server/src/platform/brand/registry.ts`; `server/src/lib/{databaseUrl.ts,prisma.ts}`; `/Users/kenny/code/RoboHire/backend/src/{index.ts,routes/jobs.ts,middleware/auth.ts}`; `docs/jobright-clone/requests/wave2-carryover.md` (OPS-A6); `docs/jobright-clone/research/china-market.md`.

**Regulation and case law:**
- [人力资源市场暂行条例 (State Council Order 700)](https://www.gov.cn/zhengce/content/2018-07/17/content_5306967.htm)
- [网络招聘服务管理规定](https://www.gov.cn/zhengce/zhengceku/2020-12/25/content_5573141.htm)
- [五部门《关于规范网络平台招聘类信息发布的通知》: 中国就业网](https://chinajob.mohrss.gov.cn/c/2026-01-14/480200.shtml), [full text copy](https://www.secrss.com/articles/87005)
- [SPC guiding cases 262–267 on data rights](https://ipc.court.gov.cn/zh-cn/news/view-4588.html), [Guiding Case 263](https://www.court.gov.cn/shenpan/xiangqing/474461.html)
- [KWM on the 2025 AUCL revision](https://www.kingandwood.com/cn/zh/insights/latest-thinking/key-takeaways-of-the-2025-revision-of-china-s-anti-unfair-competition-law.html), [DeHeng](https://www.dehenglaw.com/CN/newscontent/0008/034390/2.aspx?MID=0902), [Global Law Office](https://www.glo.com.cn/Content/2025/10-24/1107527632.html)

**Boards and platforms:** robots files of [zhipin.com](https://www.zhipin.com/robots.txt), [liepin.com](https://www.liepin.com/robots.txt), [nowcoder.com](https://www.nowcoder.com/robots.txt), [yingjiesheng.com](https://www.yingjiesheng.com/robots.txt), [iguopin.com](https://www.iguopin.com/robots.txt), [maimai.cn](https://maimai.cn/robots.txt), [app.mokahr.com](https://app.mokahr.com/robots.txt), [jobs.bytedance.com](https://jobs.bytedance.com/robots.txt); [MoE 24365 notice](http://www.moe.gov.cn/srcsite/A15/s3265/202204/t20220406_614117.html); [2026届 national online fair](https://24365.ncss.cn/student/jobfair/fairdetails.html?fairId=7fUt9qv2RwqKhHb6rrcQgL); [API Evangelist on BOSS](https://providers.apievangelist.com/providers/boss/); [SAP KBA on 51job posting](https://userapps.support.sap.com/sap/support/knowledge/en/2651162); [LinkedIn InCareer closure](https://technode.com/2023/05/10/linkedin-shuts-china-app-cuts-over-700-jobs).

**ATS and aggregators:** [北森 OpenAPI](https://apifox.com/apidoc/docs-site/436023/api-6342760); [Moka API docs](https://mokahr.apifox.cn/doc-349793); [Feishu hire API](https://apifox.com/apidoc/docs-site/532425/api-11256993); [OpenHire repo](https://github.com/gzchenhao/openhire) and [announcement](https://github.com/ruanyf/weekly/issues/12137); [ai-job-search-cn README](https://github.com/rockbenben/ai-job-search-cn/blob/main/README.md); [Fantastic Jobs ATS list](https://fantastic.jobs/article/ats-with-api); [Careerjet API](https://www.careerjet.com/partners/api) and [client](https://github.com/careerjet/careerjet-api-client-python); [Jooble API](https://help.jooble.org/en/support/solutions/articles/60001448238-rest-api-documentation); [企查查 招聘 API](https://openapi.qcc.com/dataApi/718); [GuGuData 公职岗位 API thread](https://www.v2ex.com/t/1241407); [百度百聘 closure](https://news.qq.com/rain/a/20240908A044RH00); [Google Jobs regions (Teamtailor copy)](https://support.teamtailor.com/en/articles/2547163-available-regions-for-google-job-postings); [Revelio China sources via CEIC](https://www.ceicdata.com/en/china/number-of-job-postings-new-by-industry).

**Cities:** [2025 新一线 list](https://www.hunantoday.cn/news/xhn/202505/29577937.html); [第一财经 2026 report notice](https://www.yicai.com/news/103204902.html).
