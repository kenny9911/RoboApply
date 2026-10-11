# Employer job boards: what is read, how, and how to stop

**Written 2026-10-12 (MKT-5B).** Scope: the employer boards read by `ats_public`
(`server/src/features/jobs/sources/atsPublic/`, board sync in
`server/src/features/jobs/ingest/boards.ts`, cron `jobs-boards` every 5 minutes).
It is the operations and legal reference for strategy M-1, M-6, 1.4 tier 2, 1.5
and 1.6 (`docs/jobright-clone/market/MARKET_STRATEGY.md`). Not legal advice.

The product never submits an application (D1). Everything below reads public
postings and links out to the employer's own page.

## 1. Systems

| System (`ats`) | Endpoint | Documented for third parties | Board id | Switch |
|---|---|---|---|---|
| Greenhouse (`greenhouse`) | `GET boards-api.greenhouse.io/v1/boards/{token}/jobs` (then `?content=true&pay_transparency=true`) | Yes | board token | none |
| Lever (`lever`) | `GET api.lever.co/v0/postings/{site}?mode=json` | Yes | site name (case-sensitive) | none |
| Lever EU (`lever_eu`) | the same on `api.eu.lever.co` | Yes | site name | none |
| Ashby (`ashby`) | `GET api.ashbyhq.com/posting-api/job-board/{org}?includeCompensation=true` | Yes | organisation | none |
| SmartRecruiters (`smartrecruiters`) | `GET api.smartrecruiters.com/v1/companies/{id}/postings` (+ one request per posting text) | Yes | company identifier | none |
| Workable (`workable`) | `GET apply.workable.com/api/v1/widget/accounts/{slug}?details=true` | **No** (it is the listing Workable-hosted career pages call; it answers without a key) | account slug | `ATS_WORKABLE_DISABLED=true` turns it off |
| Recruitee (`recruitee`) | `GET {company}.recruitee.com/api/offers/` | Yes (Careers Site API, "no authorization") | sub-domain label, lower case | none |
| Personio (`personio`) | `GET {company}.jobs.personio.de/xml?language=en` | Yes (XML feed) | sub-domain label; `<label>.com` for a tenant on `jobs.personio.com` | none |
| 北森 (`beisen`) | `POST {tenant}.zhiye.com/api/Jobad/GetJobAdPageList` | **No, and not verified by us** | sub-domain label, lower case | **off** unless `CN_ATS_BEISEN_ENABLED=true` |

Every switch above is one environment variable; `ATS_PUBLIC_SOURCES_DISABLED=true`
stops every board read at once.

Rows are written with `sourceBoard` = the system id and `sourceName` =
`<company> · <system name>` (both Lever instances read "Lever"; a 北森 row reads
`<company> · 北森`). A row's market is its own location: mainland China is
GoApply's, everything else RoboApply's. A 北森 row is mainland only: no copy of
a 北森 posting is ever written to the international market (section 5.3), and a
北森 board is listed in GoApply's sources list, not in RoboApply's.

## 2. Rules that hold for every system

Each is enforced in code and has a test (`atsPublic.test.ts`, `boards.test.ts`).

1. **Allowed hosts only.** A request to a host outside the list is refused
   before it is sent (`http.ts` `assertApiHost`): the vendors' API hosts by exact
   name, and tenant hosts by one anchored pattern each
   (`<label>.recruitee.com`, `<label>.jobs.personio.de|com`). https only, no
   port, no credentials in the URL.
2. **No redirect is followed.** A host that answers with a redirect fails the
   read (`redirect`). That is how a Personio host that is not a customer's is
   recognised.
3. **We say who is asking.** Every request carries
   `RoboApplyJobs/1.0 (+<contact>)` or `GoApplyJobs/1.0 (+<contact>)`
   (`JOB_SOURCES_CONTACT`, `CN_JOB_SOURCES_CONTACT`). We never pose as a browser,
   and GoApply's requests never name RoboApply.
4. **No session, no secret.** No cookie, token, signature, Referer or captcha
   answer is sent or computed. An answer that asks for one fails the read.
5. **One listing per board per sync.** 4 to 8 boards in flight
   (`ATS_BOARDS_CONCURRENCY`, default 6). A board that changed in the last 48
   hours is read every 2 hours, a quiet one every 12 or 24 hours.
6. **A failed read closes nothing.** Three hard failures in a row (not found, a
   refusal, a redirect, an answer in another shape) switch the source off; its
   postings are archived 48 hours later. Timeouts and 5xx answers only back off.
7. **Closure by listing diff.** A posting absent from a complete listing is
   archived (`source_removed`). A listing cut short by a cap or a safety stop
   closes nothing. A stated deadline (Greenhouse `application_deadline`,
   Recruitee `close_at`) is the posting's expiry. No employer-board posting is
   ever dropped for its age.
8. **Pay as stated.** A figure only where the board gives one (Greenhouse pay
   ranges, Lever, Ashby, Recruitee); otherwise the posting text is read for a
   pay line and nothing is estimated.
9. **Forbidden sources stay forbidden** (strategy 1.6): no career-site HTML, no
   Workday, no LinkedIn, Indeed or Glassdoor, no 104 / 1111 / Cake / Yourator,
   no mainland job board. **Moka boards are not read**: their answers are
   wrapped in an AES envelope, and reading them means defeating a technical
   measure. **飞书招聘 boards are not read**: their public endpoints are signed
   and captcha-gated. Neither has a connector, a host rule or a flag.

## 3. Answer size and write load

- One answer may hold up to 48 MB (`shared.ts` `MAX_RESPONSE_BYTES`; it was 15 MB).
  The largest board measured answered with 31.2 MB.
- On a system that answers with the whole board at once (Greenhouse, Ashby,
  Workable, Recruitee, Personio), a board whose last listing held 600 postings
  or more, **and a board that was never read** (its size is not known yet), is
  read and written **one at a time, inside one slot** (`LARGE_BOARD_POSTINGS`,
  `boards.ts` `isLargeBoard`, `largeBoardGate`): the next such answer is asked
  for only after the previous one was written and let go, so the larger limit
  never means two of them in memory together. Boards known to be small are read
  side by side as before.
- **Greenhouse is asked which postings it lists first.** When we already hold
  postings of a board, the listing without texts (`…/jobs`) is read. That
  answer names the postings and little else: it carries **no offices**, so it
  cannot say where a posting is and is never used to place one. It is compared
  with our rows by posting id only:
  - a listed posting we hold no row of (as `<board>:<id>` or as its mainland
    copy `<board>:<id>#cn`), or one edited after our copy (`updated_at`), makes
    the second request: the whole read, placed and written like any board's;
  - otherwise nothing is downloaded or rewritten: the rows of the listed
    postings are marked as seen ("Last checked" moves on), and the rows of a
    posting the board no longer lists are archived, both copies of it.

  This first step is taken only where every posting of the board is kept: the
  source is read for every country and the deployment writes both markets. A
  board read for some countries only, and every board on a deployment that
  writes one market, is read whole each time. Once a week per board the read
  is a whole read regardless, so a change in how we read a posting, or an edit
  that did not move `updated_at`, reaches every row within seven days.

## 4. Workable

Workable publishes no statement that third parties may read its widget listing.
The connector is on by default because the endpoint is the one its own career
pages call, answers without a key, and is read once per board per sync with our
User-Agent. **The owner decides** whether to keep it on. To turn it off:

```
ATS_WORKABLE_DISABLED=true
```

Workable sources are then passed over (`connector_disabled`), no request is
made, and their postings are left as they are. To take the postings out as
well, switch the sources off in the sources console.

## 5. 北森 tenant boards

### 5.1 State

**Off.** `CN_ATS_BEISEN_ENABLED` is unset. With the flag off:

- a 北森 source cannot be added or imported (`connector_disabled`);
- no host rule for `zhiye.com` exists, so no request to that domain can be built;
- no connector object exists (`connectorFor('beisen')` throws);
- a source that exists is passed over and its postings are left as they are.

Nobody has called a 北森 board from this repository, by hand or by code. The
wire shape in `connectors/beisen.ts` comes from one third-party source (the
OpenHire project's connector, MIT licence, read 2026-10-12), not from vendor
documentation. The committed fixture is synthetic.

### 5.2 Before the flag is turned on

All of these, in this order:

1. **Counsel's memo** on reading employer boards in the mainland under
   反不正当竞争法 (2025) Art. 13(3): robots and terms as a management measure,
   link-out against substitution, the takedown process, and whether GoApply's
   entity needs its own 备案 (strategy 7, item 14). If
   `PUBLIC_DISPLAY_PROVIDERS` is ever to include `ats_public`, the memo must
   cover public pages too: that setting would cover 北森 rows like every other
   employer-board row.
2. **A curated tenant list**: employers checked one by one, each tenant
   validated against its live board by a person. A tenant is added by hand or
   by import; it is never discovered from a link and never seeded.
3. **One recorded real response**, with the posting text and every contact
   detail replaced, committed as the fixture; the mapper re-verified against it
   (`__fixtures__/README.md` lists what to check, including whether the portal
   answers without a Referer: we do not send one).
4. `CN_JOB_SOURCES_CONTACT` set to an address the operator of a board can write to.
5. Then `CN_ATS_BEISEN_ENABLED=true` on the GoApply deployment.

### 5.3 Rules while it is on

| Rule | Value | Where |
|---|---|---|
| Tenants read at the same time | 2, whatever `ATS_BOARDS_CONCURRENCY` says | `boards.ts` `beisenGate` |
| Least time between two requests to one tenant | 30 minutes, whoever asks ("Check now" and the check of a candidate included) and whatever became of the earlier request (see below) | `schedule.ts` (header, `tenantAskedRecently`, `withTenantFloor`, `firstReadAfterSwitchOn`), `boards.ts` `stampTenantAsked` and the lease, `service.ts` `runNow` |
| Postings per tenant and run | `CN_ATS_BEISEN_MAX_POSTINGS_PER_RUN`, default 200 (1 to 2,000). A capped listing closes nothing | `connectors/beisen.ts` |
| Pages of one tenant | one after the other, 50 postings a page | `connectors/beisen.ts` |
| When a listing counts as complete | only when we hold as many distinct postings as the board says it lists (`Count`). A portal that repeats rows, or counts its pages differently, is incomplete and closes nothing | `connectors/beisen.ts` `listPass` |
| Who is asking | always `GoApplyJobs/1.0 (+<contact>)` | `boards.ts` `signingMarket` |
| Market | mainland China only (see below) | `connectors/beisen.ts`, `sync.ts` `withoutInternationalCopies` |
| Hire type | 社招 only (the one category the source confirms). The 校招 category value is not known and is not guessed | `BEISEN_PASSES` |
| Never stored | the QR-code field (it is not even requested), any phone, WeChat id or e-mail field, and contact details typed into the posting text | `mapBeisenPosting`, then the mainland ingest hook |
| Pay | as posted. A bare pair such as `35-57` is kept as words and is never filterable | normalizer |
| Dates | a zone-less time is Beijing time; year 0001 is "no date" (the row shows 最后核验, never 发布于) | normalizer |
| Login, captcha, signature | never. An answer that asks for one is a hard failure | `http.ts`, `connectors/beisen.ts` |
| Source line | `来源：<company> · 北森`, the original link and 最后核验 on every row | feed source line |

A deployment that writes no mainland posting (RoboApply alone) never asks a
tenant board.

**Mainland only, in detail.** A tenant board is a mainland employer's own
board, so a posting is in mainland China unless it says otherwise:

- every posting is handed on with China as its stated country, so a city our
  place table does not know (昆山, 义乌) and a posting for the whole country
  (全国) are still mainland postings;
- a place name is taken out only on positive evidence that it is elsewhere:
  the name itself resolves to another country (Hong Kong, Macau and Taiwan
  included), or it says "abroad" (海外, 境外, 国外);
- a posting with places on both sides keeps its mainland places; a posting
  whose every place is elsewhere is dropped and counted;
- what is handed on is checked against the router itself, and anything it
  would not write as exactly one mainland row is dropped and counted; a second
  check in the board read takes out any copy for the international market.

So a posting in 上海 and 香港 is one GoApply row located in 上海, and RoboApply
never stores a 北森 row.

**The 30 minutes, in detail.** The time a tenant is asked is written to its
source before the request leaves, so it is there even when the run is cut off,
runs out of time before it can save anything, or dies. The lease leaves out a
tenant asked under 30 minutes ago and holds a leased tenant for 30 minutes (15
for other boards); a tenant that was read and could not be saved in time is not
handed back to the next run. A candidate has no read time, so the time of its
next possible request is written before its check is sent, and switching it on
by hand keeps that time. "Check now" answers `tenant_floor`, with no request,
inside the 30 minutes.

## 6. Removal on an employer's request (takedown)

An employer, or the vendor on its behalf, may ask that its board is no longer
read. Act the same day. There are two ways; both archive the postings and stop
the reads.

**A. Switch the source off** (any system). Sources console, the board's row,
"Turn off". Its open postings are archived at once (`source_removed`) in both
markets. To make sure it is not proposed again from a posting's link, use
"Remove" instead: a removed board is remembered and never comes back by itself.

**B. Put the tenant on the denylist** (mainland tenant boards; holds even if
somebody adds the source again):

```
CN_ATS_TENANT_DENYLIST=tenant-a,tenant-b
```

Lower-case tenant ids, separated by commas. From the next board sync (at most
5 minutes after the deployment has the variable) the tenant is never asked
again, by the sync or by "Check now", and its open postings are archived
(`source_removed`). Every board sync does this before it reads anything, by
the postings themselves (`boards.ts` `archiveDeniedTenants`): it does not wait
for the tenant's own next read, and it holds when the source is switched off,
when it is not in the list at all, and on a deployment that reads no board.
The source's last problem reads `tenant_denied` once the sync next comes to it
(up to a day later; that line is display only). The list is honoured whether
or not `CN_ATS_BEISEN_ENABLED` is set.

Then:

1. confirm in the sources console that the board shows no open jobs;
2. answer the requester with the date and what was done;
3. record the request (who asked, when, which board) with the legal contact.

Archived postings leave the feed, search and recommendations. What a user had
already saved stays in that user's own tracker.

## 7. Environment variables

| Variable | Meaning | Default |
|---|---|---|
| `ATS_PUBLIC_SOURCES_DISABLED` | `true` stops every employer-board read | off |
| `ATS_BOARDS_CONCURRENCY` | boards read in flight (4 to 8) | 6 |
| `ATS_SR_DETAILS_PER_RUN` | SmartRecruiters posting texts per board and run | 100 |
| `ATS_DISCOVERY_VALIDATIONS_PER_RUN` | candidate boards checked per run | 20 |
| `ATS_WORKABLE_DISABLED` | `true` turns the Workable connector off | off (the connector is on) |
| `CN_ATS_BEISEN_ENABLED` | `true` registers the 北森 connector; needs counsel's sign-off first | off |
| `CN_ATS_BEISEN_MAX_POSTINGS_PER_RUN` | hard cap per 北森 tenant and run | 200 |
| `CN_ATS_TENANT_DENYLIST` | comma list of tenant ids that are never read | empty |
| `JOB_SOURCES_CONTACT`, `CN_JOB_SOURCES_CONTACT` | the contact in the User-Agent, per brand | the brand's own site |
