# Employer-board seeds: method, counts, and what a fresh deployment gets

**Validation date: 2026-10-11.** Bundle MKT-4S (requirements JI-3, JC-4, JT-5; `MARKET_STRATEGY.md` M-1, 1.2 "Company list for tier 0", 1.3, 1.4; ruling D3).

Every number in sections 2 and 3 was measured on that date and can be traced to `scripts/board-seeds/report-2026-10-11.json` (what each board answered) or to the output of `node scripts/board-seeds/build-seeds.mjs --report scripts/board-seeds/report-2026-10-11.json` (what the seed files hold). They are counts of that day, never live numbers. Section 4 is read from the code, and says where it estimates.

---

## 1. Method

**A candidate is a guess. The live board decides.**

1. `scripts/board-seeds/candidates.jsonl` holds 1,409 guesses of the form "this employer hosts its careers on this job-board system under this board id" (1,431 lines: a SmartRecruiters board has one line for each country it is asked for with the API's country filter, 23 such lines in all, see below). They are employers widely known to use Greenhouse, Lever, Ashby or SmartRecruiters. Most board ids are the employer's name in lower case: the route `JOB_SOURCES_INTL.md` 4.5 calls "probing by name", accepted only when the board's own company name matches.
2. `scripts/board-seeds/validate.mjs` asks each candidate's board once, read-only, on the documented public endpoint the server's connector already uses (Greenhouse boards API, Lever postings API, Ashby posting API, SmartRecruiters company postings). No key, no other host, no career-site HTML, nothing of the forbidden list of strategy 1.6. At most 2 requests in flight per host, at least 300 ms between requests to one host, one retry after a network error, never a retry of a 404, and a hard cap of requests per run.
3. A candidate is **valid** only when the board answers 200 with at least one posting and passes the name check. Where the answer states the company (Greenhouse, SmartRecruiters), that name must equal the intended employer once case, punctuation and legal forms are set aside. Where it states none (Lever, Ashby), the board id must equal the employer's name set the same way. A board id that does not spell the name can be listed for an employer in the candidates file, but that is the file speaking, not the board: it gives the employer's name only together with `aliasSource`, a document of this repository that confirms whose board it is. Without one the board is still a live board with postings; it is seeded under its board id, the placeholder the server already knows, and the guessed employer is stored nowhere (section 2.5).
4. The report keeps, per board: the company name as the answer stated it, the number of postings, and the number per ISO country, **from location fields only**. No posting title or text is stored anywhere.
5. `scripts/board-seeds/build-seeds.mjs` writes the three seed files from the report and from nothing else. `seeds.test.ts` re-runs it and fails if a file differs from what the report says.

**Which file a board goes into.** `seeds.cn.json`: at least one posting located in mainland China. `seeds.tw.json`: at least one in Taiwan. `seeds.intl.json`: at least one anywhere else (or with no place its location fields name). A board with postings in several of these is in several files; the server merges them into one source per board (`seeds.ts`). `postings` in a file is the board's count for that file's place.

**Mainland and Taiwan counts are a floor.** The script that reads locations (`places.mjs`) names mainland China or Taiwan only when every place in a location line agrees and the line ends on a place there. Where the server's own parser would let one part of a line win, the script places nothing, and the posting is counted for the international file only. A test compares the two on more than 50,000 generated lines: the script never places a line in mainland China or Taiwan that the server would not. So the server will route at least as many postings to GoApply and to Taiwan as these counts say. The floor holds for every entry of the mainland and the Taiwan file, with the one limit named in the next paragraph for two long SmartRecruiters listings.

**Which rule read which board.** The location rule was tightened during the day, each time after a look at real location lines showed it placing a line the server would not ("Canton, CT 06019" is Connecticut, not Guangzhou).

- *Greenhouse, Lever, Ashby.* Every board that had shown a mainland or Taiwan posting was read again after the tightening (63 boards; the 19 on Lever and Ashby once more under the final rule for a country the board states). A board that had shown none was not read again: the later rules can only have left such a board's count at zero or found a posting the first rule missed, so its zero is a floor too.
- *SmartRecruiters.* The whole listings were counted by the country code the API states for each posting. The final rule is narrower: it does not count a posting stated as CN or TW whose own location line names a place elsewhere. So every SmartRecruiters board of the mainland file (14) and of the Taiwan file (7) was asked once more in the last run, with the API's country filter, which is the listing the server reads for that file, and under the final rule: 21 listings, 22 requests. **All 21 still list a posting there**, the three smallest included (Believe 1, NBCUniversal 1, Primark 2). The count in a seed file is that answer's. Three counts fell, by 19 postings in all: AbbVie 149 to 148, NielsenIQ 20 to 9, Wabtec 16 to 9. Those 19 are stated as CN by the API and the rule found a word in their location line that it reads as a place elsewhere. No location line is stored, so which word is not known; a line such as "Guangzhou, GD, China" is one the rule declines, because it cannot tell a province code from a country code. The server, which weighs the stated country, may well route them to GoApply.
- *The one limit.* A listing asked with the country filter is read one page (100 rows) at a time, and when every row of the first page is in that country the rest is taken as the API's own count. That applies to two listings: BoschGroup for CN (100 rows read under the final rule, 1,221 taken from the API's count) and SGS for TW (100 read, 214 from the API's count). For those 1,435 postings the country is the one the API states. Every other SmartRecruiters row counted for mainland China or Taiwan was read.
- *The international counts of SmartRecruiters boards* are still those of the whole listings, by the stated country.

**Name review.** 30 boards answered with a name that did not equal the guess. Each was looked at one by one by the bundle's engineer (an AI agent; the 21 aliases are listed in `candidates.jsonl` and marked in the report, so a person can check them). 17 were the same employer under another spelling (with its legal form, a describing word, or a shorter name the company uses) and got a documented alias; one more matched once "PBC" was added to the legal forms. 12 were left invalid (section 3.4). The rule for that judgement is in `scripts/board-seeds/README.md`.

---

## 2. Counts on 2026-10-11

### 2.1 Candidates tried and boards that answered

| Job-board system | Candidates tried | Valid boards | Not found (404) | No postings | Name not matching | Postings on valid boards |
|---|---:|---:|---:|---:|---:|---:|
| Greenhouse | 695 | 315 | 350 | 18 | 12 | 34,667 |
| Lever (api.lever.co) | 229 | 36 | 190 | 3 | 0 | 3,728 |
| Ashby | 288 | 129 | 149 | 10 | 0 | 7,188 |
| SmartRecruiters | 123 | 40 | 0 | 83 | 0 | 60,474 |
| Lever, EU host | 74 | 0 | 74 | 0 | 0 | 0 |
| **All** | **1,409** | **520** | **763** | **114** | **12** | **106,057** |

SmartRecruiters answers 200 with an empty list for an id nobody has, so its misses show as "no postings". The 74 EU-host candidates are the European employers that answered 404 on the main Lever host; none is on the EU host either.

The table counts boards. The report's own `summary` counts candidate lines, so a SmartRecruiters board asked again per country appears there more than once (1,431 lines, 540 valid).

**Requests made: 1,958 in all.** 1,940 by the validator, recorded in the report (ten runs: 800, 641, 77, 194, 80, 84, 1, 31, 10 and 22; the last one is the SmartRecruiters re-read of section 1), and 18 outside it while the script was being built and checked (one first look at a Greenhouse answer, nine in a trial run on seven existing seeds, six to see which location lines two rules had placed, two to measure the size of a full answer). All were GET requests to the five hosts above.

### 2.2 The seed files

| File | Boards | Postings | Greenhouse | Lever | Ashby | SmartRecruiters |
|---|---:|---:|---|---|---|---|
| `seeds.intl.json` (anywhere but mainland China and Taiwan) | 505 | 47,651 | 313 boards / 28,889 | 35 / 3,598 | 128 / 6,325 | 29 / 8,839 |
| `seeds.tw.json` (Taiwan) | 41 | 806 | 22 / 360 | 8 / 63 | 4 / 14 | 7 / 369 |
| `seeds.cn.json` (mainland China) | 52 | 1,996 | 28 / 202 | 8 / 90 | 2 / 39 | 14 / 1,665 |

Merged, the three files are **512 sources**: Greenhouse 313, Lever 36, Ashby 128, SmartRecruiters 35. 436 boards are in the international file only, 22 in the international and the Taiwan file, 35 in the international and the mainland file, 12 in all three, 5 in the mainland and the Taiwan file only (long SmartRecruiters boards read for those two countries), and 2 in the Taiwan file only. Which of the files a deployment loads depends on the brands it serves (section 4): 512 sources where both brands are served or RoboApply alone is, 52 on the mainland stack.

Of the 520 valid boards, 8 are in no file: three whose single answer is over the connector's limit or close to it (section 3.1) and five long SmartRecruiters boards without a mainland or Taiwan posting (section 3.2).

Every one of the 42 entries that were there before (26 mainland, 14 Taiwan, 2 international) answered again and is kept, with the note of its first confirmation and today's facts.

### 2.3 Against the targets of the bundle

| Target | Measured | |
|---|---|---|
| International: at least 400 valid boards | 505 | met |
| International: at least 20,000 postings | 47,651 | met |
| Mainland China: at least 50 boards with a mainland posting (strategy 1.4, the bar for GoApply's production launch) | 52 | met, with a margin of 2 |
| Taiwan: at least 30 boards with a Taiwan posting | 41 | met |

What is thin:

- **The mainland bar is met with two boards to spare, and nineteen of the 52 hold one or two postings.** Each of the 52 was read under the final location rule and listed a mainland posting that day (section 1), so the 52 is a measured floor and not an estimate. It is still thin: seven boards list exactly one mainland posting and twelve list two, and a board whose last mainland posting closes no longer counts. One of the 52, `lever/octoenergy`, is a live board whose employer nothing confirms; it is listed under its board id (section 2.5).
- **Mainland China is one employer deep.** Bosch Group lists 1,321 of the 1,996 mainland postings. The other 51 boards hold 675, and 25 of the 52 list fewer than 5.
- **Taiwan likewise.** SGS (314), Coupang (154) and Ubiquiti (84) hold 552 of the 806; 22 of the 41 boards list fewer than 5.
- **Lever.** 36 of 229 guesses answered (16%); 190 board ids do not exist on the main host, and none of the 74 tried on the EU host does.
- **SmartRecruiters.** Board ids there are not predictable from a name (`Ubisoft2`, `NBCUniversal3`), so guessing by name finds one in three.
- **Industries.** Not measured: the report holds no industry. The candidate list was written mostly from technology, finance and games employers, with some health, consumer, industrial, media, education, research and non-profit names, so the answer cannot be broader than that. Most large employers in healthcare, retail, manufacturing and the public sector use systems with no public API (section 5).

### 2.4 Shape of the international list

| Postings on the board | Boards | Postings |
|---|---:|---:|
| 500 or more | 14 | 10,352 |
| 100 to 499 | 116 | 25,125 |
| 20 to 99 | 220 | 10,717 |
| 5 to 19 | 123 | 1,387 |
| 1 to 4 | 32 | 70 |

The largest: Delivery Hero 945, Devoteam 945, Databricks 890, Veeva 883, Primark 871, Wabtec 759, Equinox 738, Stripe 724, ServiceNow 696, Anthropic 645.

By country, as a statistic only: United States 24,302, United Kingdom 3,238, India 1,794, Canada 1,722, Germany 1,439, France 1,095, Singapore 1,040, Spain 1,000, Brazil 755, Australia 739, Japan 659, and 103 more countries; 2,764 postings name no place the script understands ("Remote", "EMEA"). A posting located in two countries counts in both. This breakdown routes nothing. For the boards that were not read again after the location rule was tightened that day, it was counted with the first version of the rule, which split a line at more separators. The mainland and Taiwan counts of every board follow the final rule (section 1). A board's count in the international file is what its last whole read placed outside those two places or could not place; for a SmartRecruiters board that read went by the country the API states.

### 2.5 How each seeded board's name was confirmed

| How | Boards |
|---|---:|
| The board states the company, and it equals the intended employer | 327 |
| The board states the company under another spelling, documented as an alias | 21 |
| The system states no company (Lever, Ashby); the board id is the employer's name | 160 |
| The system states no company; a document of this repository confirms the board id for the employer | 3 |
| The system states no company and nothing confirms whose board it is: listed under its board id | 1 |

The 3 of the fourth row are `lever/shopback-2` (ShopBack), `lever/crypto` (Crypto.com) and `ashby/kraken.com` (Kraken). No answer of the board confirms those names; `JOB_SOURCES_TW.md` 3.5 does, the candidates file names it as their `aliasSource`, and each entry's note repeats it. A test checks that the document exists and names the board id and the employer.

The 1 of the last row is `lever/octoenergy`. The candidates file guesses that it is Octopus Energy's board, but the id does not spell that name ("octoenergy" against "octopusenergy") and no document in the repository confirms it. The board answered with 151 postings (149 outside mainland China and Taiwan, 2 in mainland China), so it is seeded as what it is: a live board, under the name `octoenergy`. That is the placeholder the server uses for a source registered without a name (`hasPlaceholderName`): the company shown on its postings is "octoenergy" until an admin names the source in the console, or a later list carries a confirmed name, which then replaces the placeholder by itself (section 4). Six more guesses of the same kind are in the candidates file and did not answer (`blockchain`, `mistral`, `1komma5grad`, `legalontech`, `xiaopeng`, `ziphq`); if one answers at a refresh it is treated the same way, never seeded under the guessed name.

---

## 3. What is not in the files, and why

### 3.1 Valid boards the server could not read as built, or is close to not reading: not seeded

A Greenhouse or Ashby board sends every posting text in one answer, and the connector refuses an answer over 15,728,640 characters (`MAX_RESPONSE_BYTES`). A refused answer is a hard failure: the third in a row switches the source off, and its open postings are archived 48 hours later. Nothing alerts anyone but the log and the sources console. So a board is seeded only when it has room to grow.

| Board | Postings | Measured |
|---|---:|---|
| `greenhouse/spacex` (SpaceX) | 2,725 | the full answer is 31,155,380 characters (11,433 a posting): twice the limit |
| `greenhouse/andurilindustries` (Anduril Industries) | 2,491 | not measured; at SpaceX's size per posting about 28 million characters |
| `ashby/openai` (OpenAI) | 815 | the full answer is 14,219,219 characters (17,447 a posting): 90% of the limit. About 87 more postings of that size and the board sync refuses it |

The builder's caps are posting counts, because a count is what the report holds. A count is only a stand-in for a size: a posting takes from about 7,700 characters of an answer (Stripe, by the note in `shared.ts`: 5.6 MB for 728 postings) to 17,447 (OpenAI, measured that day). The caps therefore leave more than a quarter of the limit free at the densest answer measured for each system: a Greenhouse board over 1,000 postings is left out (11.4 million characters at SpaceX's density, 73% of the limit) and an Ashby board over 650 (11.3 million at OpenAI's density, 72%). A test holds the caps to the connector's limit. The largest boards that are seeded: Databricks on Greenhouse (892 postings listed) and Airwallex on Ashby (526). A board that grows past its cap is taken out of the files at the next refresh, and the builder says so; on a deployment that already has it the board sync's own rule above applies.

OpenAI comes back the day the connector's limit is raised (requested from MKT-5B), by rebuilding with `--ashby-max`.

### 3.2 Long SmartRecruiters boards: seeded for mainland China and Taiwan only, or not at all

SmartRecruiters lists 100 postings a request and needs one more request per posting text. A board of more than 1,000 postings is not read whole from a seed list; where it has postings in mainland China or Taiwan it is read for that country alone, with the API's own country filter.

| Board | Postings | Seeded for |
|---|---:|---|
| BoschGroup | not read whole | CN (1,321), TW (4), as before (strategy JT-5) |
| AbbVie | 1,888 | CN (148), TW (18) |
| TurnerTownsend | 3,372 | CN (66), TW (18) |
| Eurofins | 2,578 | CN (10), TW (3) |
| HMGroup (H&M Group) | 1,910 | CN (10), TW (5) |
| SGS | 4,641 | TW (314) |
| AccorHotel | 6,434 | not seeded (no posting in CN or TW with the API's country filter) |
| SopraSteria1 | 2,069 | not seeded |
| Securitas | 1,255 | not seeded |
| Alten | 1,183 | not seeded |
| Dominos (Domino's) | 24,844 | not seeded |

Reading any of them whole is the owner's decision (section 7).

### 3.3 Lever EU

No connector reads `api.eu.lever.co` yet (JI-8, bundle MKT-5B), so such a board could not be seeded. None of the 74 tried answered, so there is nothing to hand over.

### 3.4 Boards that answered under another name: not seeded

| Board | Postings | The board states | Why it is left out |
|---|---:|---|---|
| `greenhouse/xai` | 305 | SpaceXAI | another name than the guess (xAI) |
| `greenhouse/intercom` | 106 | Fin | a product name, not the employer's |
| `greenhouse/consensys` | 10 | MetaMask | a product name |
| `greenhouse/rubrik` | 132 | Rubrik Job Board | a label, not a company name |
| `greenhouse/tide` | 91 | Careers at Tide | a label |
| `greenhouse/cognite` | 54 | Cognite - AI for Industry | a label |
| `greenhouse/chicagotrading` | 24 | CTC Lateral - Website & LinkedIn | a label |
| `greenhouse/fiveringsllc` | 17 | Five Rings LLC - Careers | a label |
| `greenhouse/rga` | 12 | R/GA Careers Page | a label |
| `greenhouse/watershed` | 8 | Watershed Informatics | another company |
| `greenhouse/codeorg` | 5 | CodeAI | another company |
| `greenhouse/palmetto` | 1 | Palmetto Animal Hospital | another company |

The six "label" boards and the first three are live boards of real employers. An admin can add them by hand in the sources console with the right company name; the seed list stores a name only as the board states it.

---

## 4. How the seeds reach a fresh deployment

Read from `seeds.ts`, `ingest/boards.ts`, `atsPublic/schedule.ts`, `connectors.ts` and `cron/handlers.ts` as they are on this branch. Nothing here was run against a database.

**No manual step.** The cron `jobs-boards` runs every 5 minutes. Its first step is `loadCareerSeeds`: on a database that has never seen the list it creates the sources (origin `seed`, switched on, due at once); `jobs-plan` calls the same loader once a day. The loader does work only when the list changed (its hash is in `AppConfig`), never brings back a board an admin removed, and leaves a board an admin switched off or renamed as it is.

**Which files a deployment loads: those of the markets it serves.** The markets are those of the deployment's brands (`BRAND_LOCK`, else `ALLOWED_BRANDS`, else both).

| The deployment serves | It loads | Sources | A SmartRecruiters board is read for |
|---|---|---:|---|
| Both brands (no scope set: local development, and production on the day GoApply is opened there) | all three files | 512 | everything its files name; whole when the international file names it |
| RoboApply alone (`ALLOWED_BRANDS=roboapply`) | `seeds.intl.json` and `seeds.tw.json` | 512 | the same, without CN: BoschGroup for TW alone |
| GoApply alone (the mainland stack, `deploy/cn`: `ALLOWED_BRANDS=goapply`, its own database and its own `jobs-boards` cron) | `seeds.cn.json` | 52 | CN alone |

The rule is in one place (`seedFilesFor` in `seeds.ts`); the hash and the list of boards ever offered are those of the list the deployment loads. Why it exists: a board that is read whole feeds both sites, and the board sync drops the postings of a market the deployment does not serve. Without the rule the mainland stack would create all 512 sources and read every one of them at least once a day, 460 of them boards that had no mainland posting on the validation date, to throw away everything they list (about 38,000 postings a pass). With it the mainland stack reads the 52 boards that listed a mainland posting: 8,792 postings a pass, of which 1,996 are in mainland China. The other 6,796 come with the 38 Greenhouse, Lever and Ashby listings, which have no country filter and must be read whole; the 14 SmartRecruiters boards are asked for CN alone. A value of `ALLOWED_BRANDS` that names no brand resolves to RoboApply alone (the existing fail-closed rule), never to the mainland list.

The day a deployment starts serving a second brand its list grows, and the next `jobs-boards` run brings the sources to it (tested): no board is added twice, and a SmartRecruiters board that was read for TW alone is then read for CN as well.

**On a database that already holds the 38 seeded boards of M3** (simulated on the in-memory database with the M3 files; not run on a real one):

- Both brands, or RoboApply alone: the first run adds the 474 new sources. Six SmartRecruiters boards M3 had seeded for mainland China alone are in the international file too, so their `countries` become empty and the whole board is read (WesternDigital, Continental, NielsenIQ, Wabtec, Ubisoft2, Canva). AbbVie and Eurofins are read for Taiwan as well (on a RoboApply-only deployment for Taiwan alone, as BoschGroup is).
- The mainland stack: the first run adds 24 sources and BoschGroup is read for CN alone. Ten boards M3 seeded that have no mainland posting are not in the mainland list any more (`stripe`, `ramp`, `ubiquiti`, `binance`, `asteralabs`, `piccollage`, `crypto`, `okx`, `dcard`, `kraken.com`). The loader never switches a source off, so they stay as they are and are read as before; an admin can switch them off in the sources console.
- **Names.** M3 seeded four boards under their board id because Lever and Ashby state no name: `ramp`, `veeva`, `airwallex`, `weride`. A name that is just the board id is the placeholder, never an admin's choice, so the loader replaces it with the name the list now holds (Ramp, Veeva, Airwallex, WeRide). A name an admin gave stays. Postings already written under the board id keep that company name until the board sync writes them again.

What the board sync needs: the cron entry (it is in `vercel.json` and in the mainland CronJob file), `ATS_PUBLIC_SOURCES_DISABLED` not set, and for the writes of a brand: the brand is served by the deployment, `JOB_PROVIDERS_<BRAND>` does not leave out `ats_public`, and for GoApply `CN_RECRUITMENT_INFO_MODE` is not `off`.

**What one run reads.** There is no fixed number of boards a run. A run has 240 seconds and stops starting work when 20 are left. It leases 12 due boards at a time (twice `ATS_BOARDS_CONCURRENCY`, default 6, range 4 to 8), reads their listings 6 in flight, writes them one board at a time, and leases the next 12, until the time is used or nothing is due. Boards never read come first.

**How long the first full read takes: hours, not days.** The write speed on a real database was not measured in this wave or the last, so this is arithmetic on stated assumptions, not a measurement:

- Listings, 512 sources. 477 of them are Greenhouse, Lever or Ashby boards: one request each (Lever about 60 pages in all). The write is a handful of batched statements per board and market, not one per posting. At 3 seconds a listing and 2 seconds a write a run covers about 85 boards, and all 512 are read in 6 to 7 runs, about 35 minutes. At 10 seconds a write it is about 20 boards a run and a little over 2 hours.
- SmartRecruiters texts. The 35 SmartRecruiters sources hold about 10,900 postings to read a text for, 100 per board and run, 4 requests in flight on that host. BoschGroup's 1,325 need at least 14 runs, 70 minutes; all of them together a few hours.
- The mainland stack, 52 sources: the listings in one or two runs; BoschGroup's 1,321 mainland texts in at least 14 runs, 70 minutes.

Under no reading of these numbers does the first full read take a day, so no change to the board sync is requested. After that a board is read every 2 hours while it changes, every 12 hours when it changed in the last 14 days, else every 24 hours.

**Enrichment is slower than ingest.** Every new posting queues one enrichment, and the model budget is 8,000 jobs a day per market (`ENRICH_DAILY_JOBS`). A posting over the budget is not dropped: its rule-based parts are written at once and the model pass waits for the next day. So the mainland list is enriched within the first day, and the international list of about 48,000 postings in about a week.

**After the first day** (if the seeds are the only source, and counting what the boards listed on 2026-10-11):

- **RoboApply**: about 48,000 open postings from 512 employer boards in more than 100 countries, half of them in the United States; every one opens the employer's own posting. With the default budget about 8,000 carry the model's enrichment, the rest their rule-based fields. This is the default feed before any user searched. It is not the whole market, and the feed header must not say so (strategy 1.2).
- **Taiwan** (inside RoboApply): 806 postings from 41 of those boards, most of them at SGS, Coupang and Ubiquiti, besides the 台灣就業通 open-data sweep, which is its own source.
- **GoApply**: at least 1,996 postings located in mainland China, of which 1,321 are Bosch Group's. On the mainland stack they come from the 52 boards of the mainland file. On a deployment that serves both brands every board that is read whole feeds both sites, so a mainland posting a board opens later is listed too; a board posting located in both markets is written once for each.

Fewer than the counts may be listed: a posting without a usable apply link is not written, and a twin of another source's posting is listed once.

---

## 5. What these lists cannot cover

- **Employers on systems with no public API**: Workday, iCIMS, Oracle, SuccessFactors, ADP, UKG, Paylocity. That is most large enterprises, healthcare, retail and finance. They come only with the licensed feed (strategy M-2), never from a seed list.
- **Workable, Recruitee, Personio, Lever EU**: no connector yet (JI-8, MKT-5B). The validator knows only the four systems the server reads, plus the Lever EU host for reporting.
- **Boards nobody guessed.** A list built from names holds the employers its author knows. The larger routes of strategy 1.2 are still open: discovery from the apply links of ingested postings (built in M3, it needs traffic), and a candidate list from Common Crawl host patterns and the open-apply slug lists (M3 gate, Operations 24). Such a list has board ids without employer names, and this validator checks a name by design; for Greenhouse and SmartRecruiters the server's own candidate check (`validateCandidates`, through `POST /import`) is the tool, as Operations 24 says.
- **Company identity on Lever and Ashby.** Their answers state no company. A board id that is a common word (`light`, `unit`, `column`) is seeded under that word as its name: true for whichever employer holds the id, and nothing more is claimed. A board id that does not spell its employer's name carries that name only when a document of this repository confirms it; otherwise the board id itself is the name (section 2.5).
- **Change.** A count is of 2026-10-11. Boards close, rename and move. The board sync switches a source off after three failed reads; the lists themselves change only when the validation is run again.

---

## 6. Running it again

The commands are in `scripts/board-seeds/README.md`. In short: add guesses to `candidates.jsonl`; run `validate.mjs` with a new `--date` and a new report file until it exits 0 (about 1,400 requests plus the pages of long listings); read the `name_mismatch` lines and add an alias only where the README says it is honest; give a SmartRecruiters board that shows a mainland or a Taiwan posting a line with `countries` for that country and run once more (one request each; the seed test names a board that lacks one); run `build-seeds.mjs` without `--write`, then with it; run the tests; put the new counts into this document. The validator is run by hand and never by a test, a build or a cron.

---

## 7. For the owner

**A proposed launch criterion per market** (M3 gate, Owner 20; accept or change). Each is counted on the deployment (the admin sources console lists the boards and their last read; the count of open postings is a query on the index), not in a seed file:

| Market | Proposed criterion | The seeds measure today |
|---|---|---|
| International (RoboApply) | At least 400 employer boards switched on and read without error in the last 48 hours, and at least 20,000 open postings from employer boards in the index | 505 boards, 47,651 postings |
| Taiwan | At least 30 employer boards with a posting located in Taiwan and at least 500 such postings, and the open-data sweep finished once | 41 boards, 806 postings |
| Mainland China (GoApply) | The strategy's 50 employer boards with a mainland posting, and at least 500 mainland postings outside the largest employer | 52 boards; 675 postings outside Bosch Group |

The second half of the mainland line is new. Without it the bar of 50 boards is met by a list in which one employer holds two thirds of the postings.

**Decisions.**

1. Read the long SmartRecruiters boards whole (section 3.2)? Each read lists the whole board again (47 requests for SGS, 249 for Domino's) and each new posting costs one more request. If yes, add the board in the sources console with no countries, or raise `--sr-max` and rebuild.
2. SpaceX, Anduril and OpenAI (section 3.1) need a larger answer limit in the connector first; the request is with MKT-5B. OpenAI (815 postings) fits today with a tenth of the limit to spare. To have it before the limit is raised, add `ashby/openai` in the sources console and watch it: about 87 more postings and its reads are refused, and the third refusal switches it off.
3. Add the nine live boards of section 3.4 by hand, with their company names?
4. Name `lever/octoenergy` in the sources console (the candidates file guesses Octopus Energy), or add the document that confirms it as `aliasSource` and rebuild, or switch the board off. Until then its 151 postings show the company "octoenergy" (section 2.5).
5. Set `JOB_SOURCES_CONTACT` before the first production run, so the board sync names a mailbox. The validation run of 2026-10-11 named the site.

**For information.** With 313 Greenhouse boards the seed passes the threshold of requirement JI-7 (200 enabled boards of one system): once the licensed feed runs, it will leave Greenhouse postings to our own boards. Ashby (128), Lever (36) and SmartRecruiters (35) stay under it, so their postings would still come from the feed as well. On the mainland stack the seed holds 28 Greenhouse boards.
