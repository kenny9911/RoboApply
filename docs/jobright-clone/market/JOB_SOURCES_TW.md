# Taiwan job sources and APIs (RoboApply, zh-TW)

**Researched:** 2026-10-11. **Scope:** job inventory for Taiwan, which the international brand (RoboApply, `market='intl'`, locale `zh-TW`) serves. **Not legal advice**; the licence readings below still want a Taiwan-counsel glance before launch (CN_TW_LAUNCH_PLAN T-5).

Confidence labels: **confirmed** (I read the primary page or measured it today), **likely** (credible secondary source), **inferred** (my reasoning, not stated by a source).

---

## 1. Summary

1. **The open-data spike is done, and the answer is yes.** 勞動部勞動力發展署 publishes 台灣就業通's live vacancies as data.gov.tw dataset 44062 under the 政府資料開放授權條款 第1版 (OGDL v1). That licence allows commercial use, adaptation and redistribution with attribution, and declares itself compatible with CC BY 4.0. The API is free, needs no key, answered from a non-Taiwan IP today, and returned at least 17,275 open vacancies across all 22 counties (a lower bound, because 13 counties hit the 1,000-row cap). `twOpenData.ts` can stop being a stub. (confirmed)
2. **104, 1111, 518, yes123, Cake, Yourator and Meet.jobs have no public job-read API.** 104's developer centre and "JOB API" are employer and HR-system integrations (posting jobs into 104, pulling résumés out), not a feed for third parties. Cake's terms explicitly forbid crawlers, bulk extraction, building databases from its listings and AI training without written consent. 104's member terms forbid non-104 automation tools and building derivative products from platform content, and 104 serves a Cloudflare challenge even on `robots.txt`. These are partnership-only. (confirmed for Cake and 104's stance; likely for the rest)
3. **104's inventory is still reachable honestly, through Google for Jobs via JSearch.** Our existing JSearch provider with `country=tw` returns postings whose publisher is 104人力銀行, LinkedIn or 1111, with the apply link pointing at the original board. A Traditional Chinese query returned 10 of 10 rows from 104. This is the main white-collar source for Taiwan today. (confirmed by probe)
4. **Two of our three RapidAPI providers are not working right now.** Active Jobs DB returned "exceeded the MONTHLY quota … BASIC" and the LinkedIn Job Search API returned "You are not subscribed to this API". Only JSearch answered (10,000 requests/month, about 9,775 left). This is OPS-A3 and it is still open. (confirmed by probe)
5. **Our Taiwan ingest searches in English.** The planner sends the taxonomy's English L3 label and never sets JSearch's `language`. The taxonomy has no Traditional Chinese labels at all. English queries get a LinkedIn-heavy mix; Chinese queries get the 104-heavy local market. This is the biggest cheap win. (confirmed in code and by probe)
6. **One honesty bug is waiting in the pay parser.** 台灣就業通's own wording for "pay not stated" is `依學經歷、證照核薪(每月經常性薪資達4萬元以上)`. `parseSalaryText` reads that as a disclosed minimum of NT$40,000 a month. That is exactly the claim TW-03 forbids. It affects 8.4% of open-data rows and 38% of the IT rows. Fix before the adapter ships. (confirmed by running the parser)
7. **The NT$40,000 rule is about to move.** On 2026-10-07/08 the Ministry of Labor said it will pre-announce an amendment that sets the threshold at 1.75 × the minimum wage, which works out to NT$50,000 with the 2027 minimum wage of NT$30,900. Nothing has passed and no effective date exists. The tooltip and the floor-clause regex should not hard-code "4萬". (likely; press reports, no gazette text yet)

---

## 2. What I measured today

All probes were read-only. Keyed probes: 8 RapidAPI calls (the cap). No accounts created, no terms accepted, no job-board HTML fetched except one `robots.txt` request to 104 (which returned a bot challenge and was not pursued).

| Probe | Result |
|---|---|
| 台灣就業通 `Webservice.ashx?CITY=<code>&COUNT=1000`, all 22 county codes | 17,275 rows. Capped at 1,000: 台北市, 新北市, 桃園市, 新竹市, 新竹縣, 苗栗縣, 台中市, 彰化縣, 雲林縣, 嘉義縣, 台南市, 高雄市, 屏東縣. Under the cap: 基隆 376, 南投 977, 嘉義市 544, 宜蘭 933, 花蓮 554, 台東 473, 澎湖 189, 金門 225, 連江 4. |
| Same API, `zipno=300` (新竹市) / `407` (台中西屯) / `806` (高雄前鎮) | 1,000 (capped) / 321 / 254. District-level queries work and are how to get under the cap. |
| Same API, pay field | 1,458 of 17,275 rows (8.4%) carry no figure (`NT_L`/`NT_U` are `-`, `SALARYCD` is the "依學經歷…4萬元以上" sentence). IT category (08): 199 rows, 76 without a figure. |
| Same API, Taipei 1,000-row sample | 月薪 754, 時薪 152, no figure 81. 全職 926, 兼職 74. Median description 131 characters. Update dates: 39% Oct 2026, 29% Sep, 13% Aug, a tail back to Nov 2025. Top categories: 旅遊／餐飲／休閒 206, 醫療／美容／保健 150, 客服／門市 76, 清潔／家事／托育 76, 經營／行政／總務 75; 資訊／軟體／系統 35. |
| MOL mirror `apiservice.mol.gov.tw/OdService/rest/datastore/A17000000J-030144-VAL` | JSON, `updateTime` 2026-10-11 01:00, but only 1,000 rows in total (offset 1000 is empty) and 992 of them are Taipei. It is a snapshot of the default query, not the national list. Do not use it for ingest. |
| 事求人 XML (dataset 7229) | HTTP 200 from outside Taiwan, 6.4 MB, 2,101 vacancies, `ANNOUNCE_DATE` 115-10-11 (today). |
| JSearch `/search-v2`, `country=tw`, query `軟體工程師 台北`, `language=zh-TW` | 10 rows, all publisher 104人力銀行, apply links `104.com.tw/job/…`. |
| JSearch, `software engineer in Taipei` | 10 rows: 104 ×4, LinkedIn ×4, BeBee ×1, 1111 ×1. |
| JSearch, `product manager 新竹` | 10 rows: 104 ×6, LinkedIn ×3, 1111 ×1. |
| JSearch, `會計 台中`, `language=zh-TW`, `date_posted=week` | 0 rows. Non-tech + city + a one-week window can come back empty. |
| JSearch field quality over the 30 rows returned | Salary fields: 0 of 30. `job_posted_at_datetime_utc`: 0 of 30 (relative text such as "3 天前" on 25). `job_city`: mostly null; `job_state` carries 縣市+區 (e.g. 臺北市士林區); lat/lng present. `job_location` carries a "• 透過「104人力銀行」" suffix. `job_apply_is_direct` false. |
| Active Jobs DB `/active-ats`, `location=Taiwan` | HTTP 429, monthly quota exceeded on the BASIC plan. |
| LinkedIn Job Search API `/active-jb`, `location=Taiwan` | HTTP 403, not subscribed. |
| Public ATS boards (documented posting APIs, no key) | See §3.5. About 350 Taiwan postings across 14 boards. |

---

## 3. Sources, one by one

### 3.1 台灣就業通 open data: ship now

- **What it is.** Dataset "台灣就業通網站職缺清單", provider 勞動部勞動力發展署, listed 2017-03-16, metadata updated 2026-10-01. https://data.gov.tw/dataset/44062 (confirmed)
- **Licence.** 政府資料開放授權條款-第1版, free of charge. The licence grants a perpetual, worldwide, royalty-free right to reproduce, adapt, distribute and sublicense for any purpose, commercial included. Attribution is mandatory, and a missing attribution voids the grant from the start. Patents and trademarks are excluded (do not use the 台灣就業通 logo). Third-party privacy is not licensed. The provider may withdraw data without compensation and gives no warranty. https://data.gov.tw/license (confirmed)
- **Required attribution** (Exhibit to the licence): provider name, year, and the dataset's full name, plus a statement that the data is released under the OGDL. The current constant `TW_OPEN_DATA_ATTRIBUTION = '資料來源：台灣就業通（勞動部勞動力發展署）'` is short of that. Suggested wording for counsel to confirm: `資料來源：勞動部勞動力發展署 2026「台灣就業通網站職缺清單」，依政府資料開放授權條款第1版公開釋出` with a link to `https://data.gov.tw/license`. (confirmed that the Exhibit asks for these parts; the exact sentence is my suggestion)
- **Endpoint.** `GET https://free.taiwanjobs.gov.tw/webservice_taipei/Webservice.ashx`. Interface document dated 115-08-03 (2026-08-03): https://free.taiwanjobs.gov.tw/webservice_taipei/A17000000J-030144-Taiwanjobs-OpenData.pdf (confirmed)

  | Parameter | Meaning |
  |---|---|
  | `CITY` | County code: 01 台北市, 31 新北市, 11 基隆市, 33 桃園市, 12 新竹市, 34 新竹縣, 35 苗栗縣, 13 台中市, 38 南投縣, 37 彰化縣, 39 雲林縣, 14 嘉義市, 40 嘉義縣, 15 台南市, 02 高雄市, 43 屏東縣, 32 宜蘭縣, 45 花蓮縣, 46 台東縣, 44 澎湖縣, 23 金門縣, 24 連江縣 |
  | `zipno` | First 3 digits of the postal code, i.e. one 鄉鎮市區 (e.g. 104 = 台北市中山區) |
  | `jobno` | 通俗職業分類 code as a prefix: 2 digits (大類), 4 digits, or 6 digits (小類), e.g. `08`, `0802`, `080202` |
  | `COUNT` | Rows to return, maximum 1,000 |
  | `T=CSV` | CSV instead of the default XML |

  There is no offset or paging. With no `CITY`/`zipno` the service appears to default to Taipei (a `jobno`-only query returned Taipei rows only; inferred from one call).
- **Fields** (the tag names really do contain the Chinese label in full-width brackets, e.g. `OCCU_DESC（職務名稱）`): 職務名稱 `OCCU_DESC`, 職務性質 `WK_TYPE` (全職/兼職), 大類代碼/名稱 `CJOB1_COUNT`/`CJOB_NAME1`, 小類代碼/名稱 `CJOB2_COUNT`/`CJOB_NAME2`, 雇用人數 `JOB_PERSON`, 應徵截止日 `STOP_DATE` (YYYYMMDD), 工作內容 `JOB_DETAIL`, 工作地點 `CITYNAME` (縣市+區, e.g. 台北市中山區, or 台中市不限), 工作經驗 `EXPERIENCE`, 工作時間 `WKTIME` (日班, 部份工時 …), 核薪方式 `SALARYCD` (月薪, 時薪, 日薪, 論件計酬, 部分工時(月薪), or the no-figure sentence), 薪資下限/上限 `NT_L`/`NT_U`, 最低學歷 `EDGRDESC`, 職缺 URL `URL_QUERY`, 公司名稱 `COMPNAME`, 更新日期 `TRANDATE`. (confirmed)
- **What it lacks.** No stable ID field (derive `externalId` from `EMPLOYER_ID` + `HIRE_ID` in `URL_QUERY`), no company website or logo, no skills list, no work-model field, no English.
- **Character of the inventory.** Service, healthcare, manufacturing and operations roles dominate; software is about 1% of rows. Descriptions are short. This source gives breadth and disclosed pay for non-tech seekers. It does not replace 104 for professional roles. (confirmed from samples)
- **Freshness.** Rows carry update dates up to the request day and a real application deadline. A tail of rows has not been touched for many months; keep our 45-day rule on `TRANDATE` and treat `STOP_DATE` as `expiresAt`.
- **How to enumerate everything under the cap.** Query by `CITY`. Where a county returns 1,000, split by `zipno` (368 鄉鎮市區 nationwide). Where a district still returns 1,000 (新竹市 300 did), split that district by `jobno` 大類 (22 values, list in §5.2). Worst case that is a few hundred requests per full sweep at 0.3–2 MB each. One sweep a day is enough; the service notes the 1,000-row cap exists to protect its database, so run sequentially with a pause and an identifying User-Agent. (the plan is inferred; the cap and parameters are confirmed)
- **Apply path.** `URL_QUERY` opens the vacancy on `job.taiwanjobs.gov.tw`; the user applies there. D1 holds.
- **Public display.** OGDL permits redisplay, so this is the one Taiwan source that can go into `PUBLIC_DISPLAY_PROVIDERS` and feed `/browse/[role]/[city]` pages for Taipei, Hsinchu, Taichung and Kaohsiung without a partner contract. (confirmed licence; the decision is OPS-A4)

### 3.2 事求人 (civil-service and government contract vacancies): cheap, optional

- Dataset "行政院人事行政總處事求人機關徵才資料", provider 行政院人事行政總處, OGDL v1, free, refreshed at least daily. https://data.gov.tw/dataset/7229 (confirmed)
- One XML file, no parameters: `https://web3.dgpa.gov.tw/WANT03FRONT/AP/WANTF00003.aspx?GETJOB=Y`. 2,101 rows today. (confirmed)
- Fields: `ORG_ID`, `ORG_NAME`, `PERSON_KIND` (一般人員, 約僱人員, 聘用人員, 其他人員, 教育人員 …), `RANK`, `TITLE`, `SYSNAM` (職系), `NUMBER_OF`, `RESERVE_NUM`, `GENDER_TYPE`, `WORK_PLACE_TYPE` (e.g. `10-臺北市`), `DATE_FROM`/`DATE_TO` (ROC dates, 1151231 = 2026-12-31), `IS_HANDICAP`, `IS_ORIGINAL`, `IS_LOCAL_ORIGINAL`, `IS_TRANING`, `TYPE`, `VITAE_EMAIL`, `WORK_QUALITY` (qualifications; pay points and amounts often appear here), `WORK_ITEM`, `WORK_ADDRESS`, `CONTACT_METHOD`, `VIEW_URL`, `IS_TRANSFER`. (confirmed)
- **Caveats.** Roughly 30% of rows are 一般人員 posts open only to serving civil servants (商調); 約僱/聘用/其他人員 are the ones a member of the public can apply for. `VITAE_EMAIL` and `CONTACT_METHOD` contain officials' names, e-mail addresses and phone numbers. The licence does not cover third-party privacy, so do not copy those two fields into our contact or search fields; link to `VIEW_URL` instead. (confirmed fields; the handling is my recommendation)
- **Value.** A distinct "公部門職缺" filter that no private board API gives us. Low volume. Later than §3.1.

### 3.3 JSearch (Google for Jobs) with `country=tw`: the 104 / 1111 / LinkedIn window

- Already integrated (`server/src/roboapply/v2/lib/raRapidApiJobs.ts`, `/search-v2`). Results are Google's job index, so they include any board that publishes job structured data. In Taiwan that is mostly 104, then LinkedIn, then 1111. (confirmed by probe)
- **Query language decides which market you see.** Chinese role + city returned only 104 postings from local employers. English returned a mix weighted to multinationals on LinkedIn.
- **Field reality for Taiwan.** No salary fields, no absolute posting date, city often null with the district in `job_state`. Our parser already maps `臺北市士林區 • 透過「104人力銀行」` to Taipei/TW (I ran `parseLocation` on live strings), but the district is dropped.
- **Licence position.** The apply link goes to the source board and the row names its publisher, which is how we show it (`sourcePublisher`). Whether JSearch rows may sit on public SEO pages is the open OPS-A4 decision; keep them signed-in-only until it is made. (inferred; I did not re-read the provider's terms in this pass)
- **Do not render a LinkedIn name on these rows** (H9 in `normalize/source.ts` already enforces it).

### 3.4 Active Jobs DB and LinkedIn Job Search API (Fantastic Jobs on RapidAPI): blocked on the owner

- Both are wired (`raFantasticJobs.ts`) and both failed today for account reasons, not code reasons: monthly quota exhausted on BASIC, and no subscription. Until OPS-A3 is done, Taiwan runs on JSearch alone. (confirmed)
- I could not measure their Taiwan coverage. Active Jobs DB is built from ATS career sites, so expect it to mirror §3.5 (multinationals and startups on Greenhouse/Lever/Workday and similar), in English, with good dates and descriptions. (inferred)

### 3.5 Public ATS job-board APIs (`ats_public`): built, needs a seed list

The four connectors exist (Greenhouse, Lever, Ashby, SmartRecruiters). What is missing is the ops-curated `RACareerSiteSource` rows; I found no seed list in the repo. Boards I confirmed live today, with a keyword count of postings located in Taiwan:

| ATS | Board token | Employer | Total | In Taiwan |
|---|---|---|---|---|
| Greenhouse | `coupang` | Coupang | 671 | 154 |
| Greenhouse | `ubiquiti` | Ubiquiti | 181 | 85 |
| Greenhouse | `appier` | Appier | 67 | 41 |
| Lever | `binance` | Binance | 34 | 18 |
| Greenhouse | `canonical` | Canonical | 311 | 16 (mostly remote roles that list Taiwan; check) |
| Greenhouse | `asteralabs` | Astera Labs | 174 | 13 |
| Lever | `piccollage` | PicCollage | 9 | 9 |
| Greenhouse | `stripe` | Stripe | 728 | 4 |
| Lever | `shopback-2` | ShopBack | 88 | 4 |
| SmartRecruiters | `BoschGroup` (`country=tw`) | Bosch | n/a | 4 |
| Lever | `crypto` | Crypto.com | 84 | 3 |
| Greenhouse | `okx` | OKX | 346 | 3 |
| Greenhouse | `dcard` | Dcard | 10 | 1 |
| Ashby | `kraken.com` | Kraken | 82 | 1 |

- **Read this as a ceiling check.** A curated list of 100–200 boards plausibly yields 500–1,500 Taiwan postings: direct-apply, well-described, mostly English, pay rarely stated. Useful for the bilingual and foreign-professional segment, small next to 104. (inferred from the sample)
- **Not on these four systems** under their obvious tokens: Gogoro, KKday, iKala, 17LIVE, Trend Micro, Synology, Perfect Corp, KKCompany, Gogolook, SHOPLINE, TSMC, MediaTek. Most Taiwanese employers recruit through 104's own corporate pages or an in-house site; the large semiconductor and US hardware names use Workday or SuccessFactors. (confirmed 404s; the explanation is inferred)
- **Workday.** Its `/wday/cxs/{tenant}/{site}/jobs` JSON endpoint is undocumented, differs per tenant and sits behind bot management. Our rule L-5 excludes it and that should stay. NVIDIA, Micron, Applied Materials and similar Taiwan employers are only reachable through an aggregator that carries Workday (Active Jobs DB lists it as a source). (likely)
- **Possible extra connectors, later.** Teamtailor career sites expose a public jobs feed, Workable has a per-account job-board endpoint, Recruitee has a public offers endpoint. I found no Taiwan employers of note on them, so they are not worth building for this market. (likely; third-party descriptions only)

### 3.6 Commercial job boards: partnership or nothing

| Board | Position | Public job-read API | Terms on automated access | Route |
|---|---|---|---|---|
| **104人力銀行** | Largest by far; about 1.125 M openings in Jan 2026, record 1.18 M in Apr 2025 (likely; press citing 104) | No. `developers.104.com.tw` and the 104 "JOB API / Resume API" serve employers and HR-system vendors: post and sync vacancies into 104, pull résumés into an ATS. https://ehr.104.com.tw/products/job-resume-api/ (confirmed) | Member terms forbid automation tools not supplied by 104 and forbid using platform content for AI training or to build derivative products and services (likely; quoted by search, the page itself is JS-rendered). `robots.txt` answered with a Cloudflare challenge (confirmed). 104 disclosed a breach of about 120,000 résumés on 2026-10-06, so expect them to tighten, not loosen. https://finance.technews.tw/2026/10/06/104-corporation-hacked/ | Reach their postings through JSearch (§3.3). For a feed, apply to the partner programme on the developer centre (owner action). |
| **1111人力銀行** | Second general board (likely) | None found | Not verified; treat as forbidden | JSearch surfaces some 1111 postings. Partnership only. |
| **518熊班, yes123** | Blue-collar, part-time and SME boards; yes123 listed 39,174 openings on 2026-10-11 (likely, from its own page title) | None found | Not verified | Not seen in JSearch results. Partnership only; low priority because 台灣就業通 covers the same segment legally. |
| **Cake (cake.me)** | Tech, startup and foreign-company board; also a résumé builder and a direct competitor in "AI copilot" positioning | No public feed. API integration is an employer feature on the top hiring plan; Greenhouse can cross-post to Cake (confirmed). https://support.greenhouse.io/hc/en-us/articles/28263074749723-Cake-integration | Terms updated 2026-08-20: §7.4 bans crawlers, bots and bulk requests without written consent; §7.2/§7.7 ban republishing listings or building databases from them; §7.5 bans model training on platform data. https://www.cake.me/terms-of-service (confirmed) | Written partnership only. Never ingest. |
| **Yourator** | Startup and digital roles | None documented | Terms page not retrieved | Partnership only. |
| **Meet.jobs** | International and referral-reward roles, pay always disclosed | None documented | Not retrieved | Partnership only; their disclosed-pay rule makes them the most attractive small partner. |
| **LinkedIn (TW)** | Multinational and senior roles | No public jobs API; LinkedIn's Talent partner programmes are for ATS vendors | Scraping forbidden | Only through an aggregator; never branded as LinkedIn in our UI. |

`IMPORT_FETCH_DENYLIST` already lists 104.com.tw, 1111.com.tw, cake.me and yourator.co for user imports. Add `518.com.tw`, `yes123.com.tw` and `meet.jobs` to it. `taiwanjobs.gov.tw` does not need an entry, because we read it through its open-data API. (the existing list is confirmed in TASK_PLAN WP-35; the additions are my recommendation)

### 3.7 Other government sources

- **Contact TAIWAN** (經濟部 / TAITRA, https://contacttaiwan.tw/): a matching portal for foreign professionals. No open dataset found. Partnership candidate for the Gold Card audience. (likely)
- **RICH職場體驗網** (教育部青年發展署): student work-experience and part-time openings. No open dataset found. (likely)
- Local government employment offices publish through 台灣就業通, so §3.1 already includes them. The interface document's samples show job-fair notices embedded in descriptions. (confirmed from samples)

---

## 4. The salary-disclosure rule and "面議"

- **The rule.** 就業服務法 第5條第2項第6款: when recruiting, an employer may not leave the pay range undisclosed for a vacancy whose regular monthly wage is under NT$40,000. In force since 2018-11-30. Penalty under 第67條: NT$60,000 to NT$300,000. https://law.moj.gov.tw/LawClass/LawSingle.aspx?pcode=N0090001&flno=5 and https://www.wda.gov.tw/News_Content.aspx?n=31&s=3514 (confirmed)
- **What it does and does not tell us.** A posting that says 面議 is lawful only if the job pays NT$40,000 or more, which is why boards attach "經常性薪資達4萬元以上" to such postings. That sentence is the employer restating the legal condition. It is not a pay figure, and enforcement is thin: 440 complaints and 55 fines in six years (likely; press citing the ministry). Our rule TW-03 is right: show "待遇面議" in the posting's words, treat pay as not disclosed, never display or filter on 40,000.
- **Pending change.** Ministry officials said on 2026-10-07 that an amendment will be pre-announced soon, setting the threshold at 1.75 × the minimum wage, about NT$50,000 with the 2027 monthly minimum wage of NT$30,900. Reports disagree on the rounding (to the thousand or to the ten-thousand). Not pre-announced yet, not passed, no effective date. https://udn.com/news/story/7269/9801603 and https://www.chinatimes.com/realtimenews/20261007004222-260405 (likely)
- **Consequences for the product.**
  1. Keep the tooltip's figure and "as of" date in config, not in bundle copy, so one edit follows the law.
  2. Make the floor-clause removal threshold-agnostic (`[4-9]萬` / `[4-9]0,000`), or 5萬 sentences will leak into card text the day boards change wording.
  3. Add 台灣就業通's wording to the negotiable patterns (see §6, item 1).
  4. The salary filter keeps excluding undisclosed pay by default with the "包含面議職缺" toggle. For Taiwan, show monthly TWD as posted. Multiplying a monthly figure by 12 understates local pay because 年終 and bonuses are customary; if an annual figure is ever shown, label it as 12 months of the posted monthly pay.

---

## 5. Searching and matching in Traditional Chinese

### 5.1 Query language

- Send JSearch `language=zh-TW` and a Traditional Chinese query for Taiwan demand: `{職稱} {縣市}` (e.g. `軟體工程師 台北`, `產品經理 新竹`). Keep one English query per role as a second variant, because the two return different employers.
- Vocabulary differs from Simplified, not only the script: 軟體 (not 软件/軟件), 資料 (not 数据), 網路, 程式, 專案, 行銷, 人資, 韌體, 演算法, 產品經理/PM, 工程師, 專員, 助理, 儲備幹部. `normalize/zhVariants.ts` already folds Taiwan terms to mainland terms for matching; the reverse direction (labels to query with) does not exist.
- The taxonomy (`taxonomy.v1.json`, 307 nodes) has `en` and `zh` only. `taxonomyLabel(id, 'zh-TW')` falls back to English (asserted in `taxonomy.test.ts`). Add a `zhHant` label and synonyms per L3 node, written by a Taiwan-native reviewer, and use it for both the UI and the Taiwan queries.
- Do not narrow Taiwan queries to `date_posted=week` for long-tail roles; one such query returned nothing. Use `month` and rely on our own freshness rules.

### 5.2 Occupation taxonomy

台灣就業通 uses 通俗職業分類. The 22 大類 codes seen in live data (confirmed):

`01` 經營／行政／總務 · `02` 業務／貿易／銷售 · `03` 人資／法務／智財 · `04` 財務／金融／保險 · `05` 廣告／公關／設計 · `06` 客服／門市 · `07` 工程／研發／生技 · `08` 資訊／軟體／系統 · `09` 品管／製造／環衛 · `10` 技術／維修／操作 · `11` 營建／製圖／施作 · `12` 新聞／出版／印刷 · `13` 傳播／娛樂／藝術 · `14` 教育／學術／研究 · `15` 物流／運輸／資材 · `16` 旅遊／餐飲／休閒 · `17` 醫療／美容／保健 · `18` 保全／軍警消 · `19` 清潔／家事／托育(保母) · `20` 農林漁牧相關 · `21` 行銷／企劃／專案 · `22` 其他職類

小類 are 6 digits (e.g. `080202` 軟(韌)體設計工程師, `080104` 網路安全工程師, `050313` 網頁設計師, `010206` 行政助理). I saw 292 distinct 小類 in about 2,600 rows. The full list is on JOBOOKS 工作百科 (https://jobooks.taiwanjobs.gov.tw/cl.aspx?n=3). Build a static map from 小類 code to our L3 taxonomy id; an open-data row then gets its role from the source's own code and needs no title guessing. Rows with no mapped code fall back to the title dictionary. The 大類 names are close to 104's public category tree, which helps users recognise them. (the map is my recommendation)

### 5.3 Geography

- Taiwan has 22 縣市 and 368 鄉鎮市區. Our city table has 20 Taiwan cities with district aliases for Taipei, New Taipei and Taoyuan only. Live strings such as `新竹縣竹北市`, `苗栗縣竹南鎮`, `台中市西屯區`, `臺南市善化區`, `桃園市不限` all resolved to the right city in `parseLocation`, but the district is discarded.
- Districts matter in Taiwan search (內湖, 南港, 竹北, 西屯, 楠梓, 善化 are job markets in their own right). Add a Taiwan district table keyed by 3-digit postal code (county, district, zh-Hant name, romanised name, centroid). It doubles as the `zipno` planner for §3.1 and as a filter level under the city. 中華郵政 publishes the 3-digit code list; confirm its licence before bundling, or key the table from the county and district names that the open-data rows already carry.
- Both 台 and 臺 forms appear (台北市 from 台灣就業通, 臺北市 from Google). The table already aliases both; keep doing that for every new row.
- County pickers in zh-TW should use the 縣市 names users know (台北市, 新北市 …), with 不限 meaning the whole county.

### 5.4 Matching notes specific to Taiwan

- **Titles are often bilingual or coded** ("Senior Software Engineer (AI / Agent) - 資深軟體工程師", "AI SERVER_規劃管理師PM_新竹市_09602"). Strip site codes and city tokens before the dictionary match; match on either language half.
- **Structured signals the open data gives for free:** 工作經驗 (無 / 1年以上 / 3年以上), 最低學歷 (不拘 / 高職 / 專科 / 大學), 職務性質 (全職/兼職), 工作時間 (日班 / 輪班 / 部份工時). Shift pattern is a first-class filter on Taiwanese boards and is worth exposing for these rows.
- **Pay:** monthly TWD is the norm; hourly for part-time. Only 0 of 30 JSearch rows carried pay, against 91.6% of open-data rows. A pay filter on Taiwan therefore mostly selects open-data rows; say so in the filter's helper text rather than letting the result set shrink silently.
- **Work authorisation:** the quote-backed `tw_work_permit_support` / `tw_gold_card` tags are correct as built. They will fire almost only on ATS and LinkedIn-sourced English postings.
- **Duplicates:** the same vacancy can arrive from 台灣就業通 and from 104 via JSearch. Company names come as full legal names (…股份有限公司), which `normalize/text.ts` already strips. Prefer the row with disclosed pay as canonical and keep both source links.
- **Source line:** show "104人力銀行 · 經由 Google 職缺搜尋" style provenance for JSearch rows and the OGDL attribution for open-data rows. Never imply a partnership with 104, 1111 or Cake.

---

## 6. Code review: what exists and what to change

Read: `server/src/features/jobs/sources/{index,types,twOpenData}.ts`, `sources/atsPublic/{contract,connectors,hooks,permitTags}.ts`, `ingest/{config,providers}.ts`, `ingest/adapters/rapidApi.ts`, `normalize/{salary,zhVariants,source,text}.ts`, `geo/*`, `taxonomy/*`, TASK_PLAN WP-16a/16b/42, CN_TW_LAUNCH_PLAN §4.2 and §8.

**Solid as built:** the adapter registry and the "no HTML from job boards" rule; the four ATS connectors with caps and closure detection; `TwCardMeta` with 面議 kept verbatim and the floor clause removed from card text; quote-backed permit tags with negation handling; `rapidApiCountry` forcing `tw` for Taiwanese cities; LinkedIn branding suppression; `PUBLIC_DISPLAY_PROVIDERS` defaulting to empty.

**Gaps and defects found:**

1. **Pay parser treats 台灣就業通's no-figure sentence as NT$40,000.** `parseSalaryText('依學經歷、證照核薪(每月經常性薪資達4萬元以上)', {country:'TW'})` returns `{min: 40000, currency: 'TWD', period: 'month', negotiable: false}`. `NEGOTIABLE_RE` does not know 依學經歷 or 核薪, so the floor clause is parsed as the pay. Fix: add `依學經歷|依學經歷、證照核薪|核薪` to the negotiable patterns and, in the adapter, set pay only from numeric `NT_L`/`NT_U` and pass `SALARYCD` as `salaryText` when they are `-`. Add the sentence to the salary tests.
2. **`twOpenData.ts` is a stub with the licence flag false.** The licence, fields and cadence are now confirmed (§3.1). Implement it as a `search`-kind `JobSourceAdapter` (provider `tw_open_data`, markets `['intl']`, `supportsCountry('TW')` only, unmetered or a generous daily cap), with its own standing queries per county/district rather than per role. `NormalizeProvider` and the source table in `normalize/source.ts` need the new provider. `TW_OPEN_DATA_JOBS_URL` can default to the documented endpoint.
3. **Attribution string is incomplete** against the OGDL Exhibit (§3.1).
4. **Taiwan queries are English-only and never set `language`.** `planner.ts` uses `node.en`; `rapidApiSearchParams` builds `"<q> in <city>"`. `ExternalSearchParams.language` exists but ingest does not fill it. Add a zh-TW variant for `country=TW` (label from the new `zhHant` field, city from `zhHant`, `language='zh-TW'`).
5. **No Traditional Chinese taxonomy labels** (0 `zhHant` entries). zh-TW users see English role names in pickers today.
6. **Floor-clause regexes hard-code 4萬 / 40,000** (`TW_FLOOR_CLAUSE_RE` in `atsPublic/hooks.ts`, `TW_FLOOR_RE` in `salary.ts`). Generalise before the threshold moves (§4).
7. **No district level** for Taiwan in `geo/cities.json` or on `RAJob` (§5.3).
8. **No seed for `RACareerSiteSource`.** The admin panel works but starts empty. Seed the 14 boards in §3.5 with `countryCode='TW'`.
9. **Provider health.** Active Jobs DB is out of quota and LinkedIn is unsubscribed (§2). The admin System panel should show this state per provider; today a Taiwan feed silently depends on JSearch alone.
10. **CN_TW_LAUNCH_PLAN paths are stale** for WP-TW-JOBS (`roboapply/v2/lib/sources/…`, `server/src/market/tw/salary.ts`); the code lives under `server/src/features/jobs/sources/` and `features/tw/`. Documentation only.

---

## 7. Recommendation: now, next, later

**Ship now (no contract, no new credential):**

1. Fix the pay-parser defect and generalise the floor regex (§6 items 1 and 6). This is a precondition for item 2.
2. Implement the 台灣就業通 adapter with county → district → category splitting, OGDL attribution, `STOP_DATE` as expiry, 小類 code → taxonomy map, and a daily sweep.
3. Query JSearch in Traditional Chinese for Taiwan (`language=zh-TW`, zh-TW role and city), keeping an English variant.
4. Add `zhHant` labels and synonyms to the taxonomy; show them in zh-TW.
5. Seed the Taiwan career-site sources from §3.5.

**Next (needs an owner decision or a payment):**

6. OPS-A3: upgrade Active Jobs DB off BASIC and subscribe the LinkedIn Job Search API, or decide to run Taiwan without them. Then measure their Taiwan coverage before raising budgets.
7. OPS-A4: add `tw_open_data` to `PUBLIC_DISPLAY_PROVIDERS` so Taiwan browse pages have licensed public inventory. Decide JSearch's status separately.
8. Taiwan district table and filter.
9. Salary-rule tooltip driven by config (threshold, source link, as-of date); watch for the ministry's pre-announcement.
10. Partnership outreach in this order: Meet.jobs (disclosed pay, small, international), Yourator, 104's partner programme, Cake (a competitor; least likely), 1111. Ask each for a feed with redisplay rights and deep links.

**Later:**

11. 事求人 adapter as a "公部門" segment, without the contact fields.
12. Contact TAIWAN partnership for Gold Card and foreign-professional roles.
13. Teamtailor / Workable / Recruitee connectors only if a Taiwan employer list justifies them. No Workday.

**Never:** fetching HTML or private JSON from 104, 1111, 518, yes123, Cake, Yourator, Meet.jobs or LinkedIn; using third-party scrapers of those sites (Apify actors and similar), which only moves the terms breach one step away.

---

## 8. Open questions

1. Does the owner accept my reading of OGDL v1 for commercial redisplay, or should Taiwan counsel confirm first (T-5)? The licence text is unambiguous on commercial use; the residual risk is personal data inside free-text descriptions and the provider's right to withdraw.
2. The real size of the 台灣就業通 inventory. 17,275 is a floor; a full district sweep will give the true number. It decides how much weight this source gets in Taiwan feed-count copy.
3. Whether the service tolerates a daily sweep of a few hundred requests. The document states only the 1,000-row cap. The dataset page lists a contact (02-8995-6030); a courtesy notice is cheap.
4. Do JSearch's terms allow showing its rows on public, indexable pages? Until answered, Taiwan SEO pages should draw on open data, recruiter-bank jobs with consent, and ATS boards.
5. Active Jobs DB and LinkedIn API coverage of Taiwan: unmeasured because of the account state.
6. Final text and effective date of the Article 5 amendment.
7. Whether 104's partner programme offers any job-read feed to a job-seeker product at all. Their published APIs suggest not.
8. Who writes and reviews the zh-Hant taxonomy labels (T-7 reviewer).

---

## 9. Sources

- 台灣就業通網站職缺清單 (dataset 44062): https://data.gov.tw/dataset/44062
- Interface document (2026-08-03): https://free.taiwanjobs.gov.tw/webservice_taipei/A17000000J-030144-Taiwanjobs-OpenData.pdf
- MOL open API description: https://apiservice.mol.gov.tw/OdService/openapi/OAS.html
- 政府資料開放授權條款 第1版: https://data.gov.tw/license
- 事求人機關徵才資料 (dataset 7229): https://data.gov.tw/dataset/7229
- 通俗職業分類 lookup (JOBOOKS): https://jobooks.taiwanjobs.gov.tw/cl.aspx?n=3
- 就業服務法 第5條: https://law.moj.gov.tw/LawClass/LawSingle.aspx?pcode=N0090001&flno=5
- Pay-disclosure rule in force 2018-11-30 (勞動力發展署): https://www.wda.gov.tw/News_Content.aspx?n=31&s=3514
- Threshold to rise to about NT$50,000 (聯合報, 2026-10-08): https://udn.com/news/story/7269/9801603
- Same (中時, 2026-10-07): https://www.chinatimes.com/realtimenews/20261007004222-260405
- Background on 面議 and enforcement figures: https://blog.interview.tw/article/taiwan-salary-negotiable-in-person-law-explained
- 104 developer centre: https://developers.104.com.tw/
- 104 JOB / Resume API for HR systems: https://ehr.104.com.tw/products/job-resume-api/
- 104 member terms: https://accounts.104.com.tw/terms
- 104 breach report (2026-10-06): https://finance.technews.tw/2026/10/06/104-corporation-hacked/
- 104 openings count (鉅亨): https://news.cnyes.com/news/id/6504689
- Cake terms of service (updated 2026-08-20): https://www.cake.me/terms-of-service
- Cake employer plans: https://www.cake.me/employers
- Greenhouse → Cake cross-posting: https://support.greenhouse.io/hc/en-us/articles/28263074749723-Cake-integration
- yes123 listing count: https://www.yes123.com.tw/wk_index/joblist.asp
- Contact TAIWAN: https://contacttaiwan.tw/
- Workday endpoint notes (third party): https://dev.to/udaninn/workday-job-boards-have-a-json-api-too-its-just-better-hidden-23fl
- ATS posting APIs overview (third party): https://cavuno.com/blog/ats-platforms-public-job-posting-apis
- Probed APIs: `boards-api.greenhouse.io/v1/boards/{token}/jobs`, `api.lever.co/v0/postings/{site}?mode=json`, `api.ashbyhq.com/posting-api/job-board/{org}`, `api.smartrecruiters.com/v1/companies/{id}/postings?country=tw`, `jsearch.p.rapidapi.com/search-v2`, `active-jobs-db.p.rapidapi.com/active-ats`, `linkedin-job-search-api.p.rapidapi.com/active-jb`
