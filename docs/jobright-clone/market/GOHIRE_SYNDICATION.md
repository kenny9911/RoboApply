# GoHire syndication endpoint: the contract and the work package

**For:** the engineer who builds the route in the RoboHire / GoHire backend (the second repository), and the owner who approves it. You need no other document to build it.

**Status (2026-10-12):** the route does not exist yet. This repository's side is built and tested against a stub server (bundle MKT-5E): the validated wire contract, the HTTPS reader, the mirror read for live search, and a read-only probe. Nothing in the RoboHire / GoHire repository was changed from here.

**Source of truth for the shape:** `server/src/features/jobs/ingest/adapters/syndication.ts` (`SyndicationPageSchema`, `SyndicatedJobSchema`, `SyndicationTombstoneSchema`). The field tables of section 4 are copied from it, and a test (`syndication.test.ts`, "the document lists every field of the schema") fails when the two differ. If this document and the schema ever disagree, the schema is right.

**Requirements served:** JC-2 (this repository) and JC-3 (the route) of `MARKET_STRATEGY.md` section 9.6; the ruling "GoHire bank transport: fix B" of section 8; owner steps 9 and 10 of section 7.

---

## 1. Why this route

GoApply's feed is filled by employer boards and by the GoHire recruiter bank. The bank cannot be read through its database from outside the mainland: the database endpoint has no TLS, and this code refuses a plaintext connection (rule CN-E-05). Three fixes were weighed (`JOB_SOURCES_CN.md` section 2.3); the ruling is the HTTPS route, because:

- no database credential leaves the mainland;
- the list of fields and the employer's consent are enforced where the data lives;
- `https://api.gohire.top` already serves valid TLS.

Until the route exists this repository reads the bank through `GET /api/v1/jobs` with an ordinary API key (section 13). That reader sees only the jobs the key's user may see, cannot learn that a job closed except by reading the whole listing, and stops reporting closures above 2,000 published jobs. The route below removes all three limits.

---

## 2. The route

| | |
|---|---|
| Method and path | `GET /api/v1/syndication/jobs` |
| Host | the host that already serves valid TLS: `api.gohire.top` |
| Transport | HTTPS only. A request over plain HTTP must not be answered with data. **Do not answer with a redirect:** this side treats any 3xx as an error and never follows it, so the key is never sent to a second address. |
| Authentication | header `X-API-Key: <service key>` (the header the existing GoHire client of this repository already sends). The key is never put in the URL. |
| Scope | a **new scope limited to this route** (suggested name `syndication:jobs:read`). A key with this scope must work on no other route. An ordinary user key must **not** work here: it lists only that user's jobs and is the wrong authority for a cross-employer feed. Answer it with 403. |
| Caller | one service (GoApply's ingest). Read-only. The route writes nothing. |

---

## 3. The request

```
GET /api/v1/syndication/jobs?cursor=<updatedAt>|<id>&limit=<n>
X-API-Key: <service key>
Accept: application/json
```

| Parameter | Meaning |
|---|---|
| `cursor` | Optional. `<updatedAt ISO 8601>\|<job id>`: the position of the last entry this side has already received. This side always sends the time in UTC with milliseconds, for example `2026-10-05T01:00:00.000Z\|clx0abc123` (URL-encoded). Accept any ISO 8601 time with an offset. **Absent: answer from the beginning** (every job, oldest change first). This side reads from the beginning on its first sync, **once every 7 days** (section 5.5), after GoHire's posting-page address changes, and after its own maintenance has archived rows. |
| `limit` | 1 to 200. This side sends it on every request (200 by default; an operator can lower it). A page holds **at most `limit` entries, items and tombstones together.** A page with more is refused (`page_over_limit`). |

---

## 4. The response

HTTP 200, `Content-Type: application/json`, UTF-8, at most **5 MB** (a larger body is refused unread; see section 9).

```json
{
  "items": [ SyndicatedJob, ... ],
  "tombstones": [ { "id": "...", "updatedAt": "...", "reason": "closed" }, ... ],
  "nextCursor": "2026-10-06T02:00:00.000Z|clx0abc999",
  "hasMore": false
}
```

### 4.1 The page

| Field | Type | Key must be present | Meaning |
|---|---|---|---|
| `items` | list of `SyndicatedJob` | yes | Jobs that are listable now (section 5.1), in order. |
| `tombstones` | list of tombstones | yes | Jobs that are not listable now (section 5.2), in order. |
| `nextCursor` | string or null | yes | The position of the **last entry of this page**, as `<updatedAt>\|<id>`. Null only when the page is empty. |
| `hasMore` | boolean | yes | True when entries exist after `nextCursor` right now. |

### 4.2 A job (`SyndicatedJob`)

A job is exactly the columns this repository's database reader selects (`BANK_SYNC_SELECT`) plus four fields. "Key must be present" means the key must be in the object even when its value is null; a job without such a key makes this side reject the **whole page**. The other columns may be left out when empty (they are read as null), but sending every key is simpler and is what a serialised row gives you.

| Field | Type | Key must be present | Meaning |
|---|---|---|---|
| `id` | string | yes | The job's id. No white space and no `\|`, at most 200 characters. It is the key this side stores the job under: it must never change for a job. |
| `status` | string | yes | The job's status. Only `open` is listed; send the real value. |
| `publishedAt` | ISO 8601 time, or null | yes | When the recruiter published the job. Null means not published (such a job belongs in `tombstones`). |
| `updatedAt` | ISO 8601 time | yes | The **syndication change time** (section 5.4). The ordering key and the cursor key. |
| `title` | string or null | yes | The job title. |
| `description` | string or null | no | Duties. |
| `qualifications` | string or null | no | Requirements. |
| `hardRequirements` | string or null | no | Must-have requirements. |
| `niceToHave` | string or null | no | Preferred requirements. |
| `benefits` | string or null | no | Benefits. |
| `location` | string or null | no | The location as one line. |
| `locations` | list of `{ "city": string, "country": string }`, or null | no | Structured locations. Only `city` and `country` are read; any other key and any entry of another shape is dropped. |
| `workType` | string or null | no | On site, hybrid or remote, as the bank stores it. |
| `employmentType` | string or null | no | Full time, part time, internship and so on. |
| `experienceLevel` | string or null | no | The level the recruiter chose. |
| `education` | string or null | no | The education requirement: the bank's own value (`bachelor`, `associate`, ...) or the Chinese word (本科). |
| `headcount` | whole number or null | no | Openings (招聘人数). |
| `salaryMin` | number or null | no | Lower pay bound, as stored. |
| `salaryMax` | number or null | no | Upper pay bound, as stored. |
| `salaryCurrency` | string or null | no | ISO currency code. Do not send a default the recruiter did not choose: this side distrusts `USD` on a GoHire job unless the pay text says so. |
| `salaryPeriod` | string or null | no | The pay period, as stored. |
| `salaryText` | string or null | no | The pay as the recruiter wrote it (for example `15-25K·14薪`). |
| `companyName` | string or null | yes | The employer's name as shown on the job. A job with no employer name is not listed. |
| `requiredKeywordSet` | list of strings, or null | no | Required skills. |
| `company` | object or null | no | The employer record, section 4.3. |
| `employerVerified` | boolean | yes | True only when the bank's verified-employer record for this employer is valid now (section 6.1). |
| `syndicationConsentAt` | ISO 8601 time, or null | yes | When the employer's consent to show the job outside GoHire was recorded. Null when none is on record (section 6.2). |
| `validFrom` | ISO 8601 time or calendar day, or null | yes | Start of the posting's validity period (section 6.3). |
| `validUntil` | ISO 8601 time or calendar day, or null | yes | End of the posting's validity period (section 6.3). |

### 4.3 The employer (`company`)

Every key may be left out. Nothing else of the company record is read.

| Field | Type | Meaning |
|---|---|---|
| `id` | string or null | The company's id in the bank. |
| `name` | string or null | The company's name. |
| `logoUrl` | string or null | A public logo address. |
| `website` | string or null | The company's website. |
| `industry` | string or null | Industry. |
| `size` | string or null | Size band (for example `51-200`). |
| `headcount` | whole number or null | Employees. |
| `founded` | whole number or null | Year founded. |

### 4.4 A tombstone

| Field | Type | Key must be present | Meaning |
|---|---|---|---|
| `id` | string | yes | The job's id (same rules as a job's id). |
| `updatedAt` | ISO 8601 time | yes | The job's syndication change time. |
| `reason` | string or null | no | Why it is not listable: `closed`, `unpublished`, `draft`, `expired`, `consent_withdrawn`, `test_posting`, `deleted`. For your logs and ours; this side closes the job whatever the reason says. |

A tombstone carries **nothing else**: no title, no employer, no text.

---

## 5. Semantics

### 5.1 What is an item

A job is an **item** when all of these hold at the moment of the response:

1. its status is `open` **and** it is published (`publishedAt` is set);
2. it names an employer and has a title;
3. its validity period, when it has one, has started and has not ended;
4. the employer has not withdrawn consent to syndication (section 6.2);
5. it is not a recruiter's test posting (section 6.4).

### 5.2 What is a tombstone

A **tombstone** says: this job is not listable now. It is sent for a job with a position after the cursor that is closed, filled, paused, unpublished, turned back into a draft, expired, consent withdrawn, a test posting, or deleted.

- **The minimum:** every job that was sent as an item at some time and is not listable now. Without it a job the bank closed stays open on this side.
- **The simplest way to meet it, and the recommended one:** the stream holds **every job of the bank in order, each as an item or as a tombstone.** Then a read from the beginning repairs this side completely, and the route stays stateless:

```
rows = jobs where (syndicationUpdatedAt, id) > cursor
       order by syndicationUpdatedAt, id
       limit n
for each row: listable now ? item : tombstone
```

Two consequences:

- **A hard-deleted job must still produce a tombstone** (keep a deletion log with the id and the time), or jobs must never be hard-deleted. A job that silently disappears stays open on this side.
- With the recommended form a draft that was never published also appears as a tombstone (an id and a time, nothing else). That is harmless and keeps the rule simple.

**A read from the beginning must return the tombstones too**, not only the open jobs: this side reads from the beginning to repair itself, and a job that closed while it was not looking is closed here only by its tombstone.

### 5.3 Order, cursor, `hasMore`

- Entries are ordered by `(updatedAt, id)`, ascending. Items and tombstones are two lists, but they are one ordered stream: a page is the next `limit` entries of that stream.
- The answer to `cursor=<t>|<i>` holds only entries with `(updatedAt, id)` strictly after `(t, i)`.
- `nextCursor` is the position of the last entry of the page. This side stores it and sends it back as the next `cursor`.
- **`nextCursor` must never sort before the `cursor` it answers.** This side refuses such a page (`cursor_regressed`) and writes nothing of it.
- **With `hasMore: true`, `nextCursor` must be after the `cursor` it answers.** A page that says "more" without moving would be asked for again for ever; this side refuses it (`cursor_stalled`).
- With `hasMore: false` this side stops and asks again at its next sync, 30 minutes later (section 9).
- **An id appears at most once per page.** If the same id is sent as an item and as a tombstone, this side keeps the entry with the later `updatedAt`; at the same time the tombstone wins.
- Compare ids as plain byte strings (`ORDER BY "updatedAt", id COLLATE "C"`), so the `WHERE` and the `ORDER BY` agree for every id. This side compares positions the same way: by time, then by id as a plain string.
- **Compare on the precision you send.** This side keeps times to the millisecond. If the column holds finer times, order and filter on the value truncated to milliseconds; otherwise the row at the cursor is "after" its own position and is returned again on every request.

### 5.4 `updatedAt` is the syndication change time

The cursor only moves forward, so **a change that alters what this route would return for a job must give that job a later `updatedAt`.** The job's own `updatedAt` column is not enough when a syndicated field comes from another record:

- the employer is verified, loses verification, or its verification runs out after six months;
- the employer gives or withdraws consent;
- the company's name, logo or facts change;
- the job's validity period changes, or starts (section 6.3).

Either bump the job row when such a record changes, or order by a computed time (the latest of the job's and those records' change times). The value you order by is the value you send as `updatedAt`.

What that buys on this side: every job arrives as posted by a recruiter (代招) until its employer is verified. The first sync after the job's `updatedAt` moved with `employerVerified: true` rewrites the stored job as direct from the employer, and the first one after verification ended turns it back. A job whose `updatedAt` did not move keeps its old label until the next read from the beginning (section 5.5), up to 7 days.

One more guard: **do not return entries newer than about five seconds.** A transaction that commits late can carry an `updatedAt` just before a cursor that was already handed out, and that row would be skipped for ever. Leaving the last few seconds for the next request closes the gap.

Validity ending is the one change that needs nothing from you: this side stores `validUntil` and stops listing the job at that instant by itself.

### 5.5 Why this side reads everything again every 7 days

A change cursor returns a job only when it changed. A job that stays open and untouched for months would never be sent again, and this side could not tell "still listed" from "no longer returned": its rule for mainland jobs archives a job it has not seen for 45 days. So once every 7 days this side asks **without a cursor** and reads the whole stream again. Every item confirms its job, every tombstone is applied again, and a job that was archived here while the bank still lists it comes back.

For the route this means: a read from the beginning must be an ordinary, cheap request (an index on the ordering columns), and it must return the same stream every time (section 5.2).

---

## 6. Field rules

### 6.1 `employerVerified`

From the bank's **verified-employer record**, never from anything else (not from a paid plan, an email domain or the recruiter's own claim). The five-ministry notice 《关于规范网络平台招聘类信息发布的通知》 (dated 2025-12-25) asks that posting accounts be verified by type and re-verified at least every six months (`JOB_SOURCES_CN.md` section 5.2). So `employerVerified` is true only while a verification exists that is not older than six months and has not been revoked.

**What `true` states:** the company named on the job is the verified employer and posts this job for itself. Do not send `true` for a job a recruiter or a staffing firm posts for a client, however well that recruiter's own account is verified: the record must be the employer's.

What this side does with it: `true` is the **only** thing that lets a GoApply card say 企业直招 (direct from the employer), and only when the employer named is not a staffing firm (this side checks the name against its own list as well). With `true` the job is stored as "not posted by an agency"; with `false` it is stored and shown as posted by a recruiter for the employer (代招). The label follows the value at every sync, in both directions (section 5.4). The value is never guessed on this side.

### 6.2 `syndicationConsentAt`

The time the employer's consent to show the job outside GoHire was recorded.

| State at the bank | What to send | What this side does |
|---|---|---|
| Consent on record | an item with `syndicationConsentAt` set | lists the job; it may also appear on public pages |
| No consent on record, and none refused | an item with `syndicationConsentAt: null` | lists the job to signed-in users only; never on a public page, in a sitemap or to a search engine |
| Consent withdrawn or refused | a **tombstone** (`reason: "consent_withdrawn"`) | closes the job |

If GoHire's own terms do not allow the middle row (showing a job to signed-in GoApply users without recorded consent), send such jobs as tombstones instead. The decision is GoHire's and is enforced at the source.

### 6.3 `validFrom`, `validUntil`

The posting's validity period (the same notice asks for a validity period or for postings to be kept current).

- `validUntil` becomes the job's stated deadline on this side: after it the job is no longer listed. A job with `validUntil: null` never closes by date here; it closes by tombstone.
- A value may be a time (`2026-12-31T18:00:00+08:00`) or a calendar day (`2026-12-31`). A calendar day is read in UTC+8 and `validUntil` runs **through the end of that day**.
- `validFrom` is carried and checked, but it does not delay listing on this side. **Do not send a job as an item before its validity starts** (rule 3 of section 5.1); send it as a tombstone until then and bump its `updatedAt` when it starts.

### 6.4 Times

ISO 8601 **with an offset**: `2026-10-05T09:00:00+08:00` or `2026-10-05T01:00:00.000Z`. Millisecond precision is enough.

A time without a zone (`2026-10-05T09:00:00`) is not an error: this side reads it as UTC+8 (the mainland wall clock) and counts it, and the probe prints the count so you can fix it. Anything that is not ISO 8601 (`2026/10/05 09:00`, `10/05/2026`, epoch milliseconds, words) makes this side reject the whole page.

### 6.5 Test postings

Recruiters try the product with postings that are not jobs; the research note records 「测试简历匹配」 in the GoHire bank. They must not be published as items:

- a job with an empty employer name;
- a job whose title names no job: 测试, 测试岗位请勿投递, 内部测试职位, 测试简历匹配, `test`, `demo`.

**Do not drop every title that contains 测试.** 测试 is also the ordinary word for testing work, and 软件测试工程师 or 晶圆测试操作员 are real jobs. This side applies the same gate again to whatever arrives (a title that is nothing but 测试 / test / demo and filler is skipped and counted), so a test posting you let through is not shown. The exact rule is `isBankTestPosting` in `server/src/features/jobs/ingest/adapters/bank.ts`.

---

## 7. What must never be sent

Only the fields of section 4. In particular never: internal or recruiter notes, evaluation rules, passing scores, interview requirements, AI caches or insights, match scores, candidate data of any kind, the recruiter's or any other person's name, phone number, email or WeChat id, user ids, organisation or tenant ids, client keys, or anything about other customers of the bank.

This side strips every key it does not know before anything is logged or stored, so an extra field cannot reach GoApply's database. That is a second line of defence, not a reason to send it: the allow-list belongs at the source.

Free text (`description`, `qualifications` and so on) is the recruiter's own wording and may hold a phone number or a WeChat id. This side removes recruiter contact details from mainland postings before they are stored. If the bank can remove them first, do.

---

## 8. Errors

Answer errors as JSON with a code and a short message, and the matching status:

```json
{ "code": "invalid_cursor", "message": "cursor must be <ISO time>|<job id>" }
```

| Status | `code` | When |
|---|---|---|
| 400 | `invalid_cursor` | `cursor` is not `<ISO 8601 time>\|<id>` |
| 400 | `invalid_limit` | `limit` is not a whole number from 1 to 200 |
| 401 | `unauthorized` | no key, or a key that does not exist |
| 403 | `forbidden_scope` | a valid key without the syndication scope (every ordinary user key) |
| 429 | `rate_limited` | too many requests. A `Retry-After` header is good practice, but this side does not read it (section 9). |
| 500 / 503 | `internal_error` | anything else |

This side reads **only the status code** of an error and never repeats its body, so a message may be as helpful as you like but must not contain data. Any error (a 429 included) stops the sync without writing anything and leaves the stored cursor where it was. The sync is tried again **60 minutes later** from that cursor, and the error is shown to the operator as, for example, `http_403 key_lacks_scope`.

Never answer an error with HTTP 200, and never answer a missing page with an HTML page.

---

## 9. Rate and volume

What this side does, as built:

- **When it asks.** GoApply's ingest job runs every 10 minutes and looks whether the bank's sync is due. A sync that reached `hasMore: false` is due again **after 30 minutes**; a sync that ended in an error is due again **after 60 minutes**. Either is picked up by the first run of the ingest job after that. So on a quiet bank the route sees one request every 30 to 40 minutes.
- **A sync in progress.** While `hasMore` is true this side asks for the next page as soon as it has stored the previous one: one request at a time, never two in parallel, and **with no pause between pages**. How many requests a minute that is depends on how fast the route answers and on how long a page takes to store here; this side does not cap it. A sync that does not finish inside one run of the ingest job goes on in the next run (at most 10 minutes later) from its stored cursor.
- **A read from the beginning** is `entries / 200` requests of that kind in a row. It happens on the first sync, once every 7 days (section 5.5), when GoHire's posting-page address changes, and after this side's maintenance archived rows.
- **`Retry-After` is not read.** A 429 is an error like any other: the sync stops, keeps its cursor, and goes on 60 minutes later.
- **Each request has 20 seconds**, body included. A request that starts when less than that is left of this side's run gets what is left (never under 2 seconds); if it runs out of that shorter time, nothing is counted as an error and the same page is asked for again, at the latest in the next run. Only a request that had its full 20 seconds and did not finish is reported as failing.
- A page of 200 full postings should be far below the **5 MB** cap; if postings are unusually long, tell the operator of this side to lower `INGEST_BANK_PAGE`.

What that means for a rate limit on the key:

- Because the pages of one sync are asked back to back, **a limit of 60 requests a minute is not safe for a read from the beginning of more than about 60 pages (12,000 entries)**: the read can reach it, and each 429 costs the sync an hour.
- This side's own rate against a live route has not been measured (the route does not exist yet). Until it has, either set no per-minute limit for this key (it is one known caller, read-only, with one request in flight at a time), or set one that a single sequential caller cannot reach: several requests a second, for example 600 a minute.
- If the bank must hold this caller to a lower rate, say so before the key is issued. The change on this side would be a pause between pages, which is code (not built today), not a setting.

---

## 10. What the bank's schema needs (work in the second repository)

The route needs three facts the bank's schema did not hold when this repository last read it (`BANK_SYNC_SELECT` selects no such column). The wire names of section 4 are fixed; the column names below are **suggestions** for the engineer who knows that schema, and every addition is additive.

| Fact | Needed for | Suggested shape |
|---|---|---|
| A verified-employer record | `employerVerified` | per company: when it was verified, by which evidence, by whom, and when it was revoked, so "valid now" is `verified within six months and not revoked` |
| The employer's consent to syndication | `syndicationConsentAt`, and the withdrawn case | per company (or per job): when consent was recorded and when it was withdrawn |
| A validity period | `validFrom`, `validUntil` | two nullable times on the job |

Also needed, without a schema change of its own: a service-key scope limited to this route, the syndication change time of section 5.4, and a deletion log if jobs can be hard-deleted.

---

## 11. Acceptance list for the route (owner's side)

The route is done when every line holds on the production host:

- [ ] `GET https://api.gohire.top/api/v1/syndication/jobs?limit=5` with the scoped key answers 200 with `items`, `tombstones`, `nextCursor` and `hasMore`, over valid TLS, without a redirect.
- [ ] Every item holds the columns of section 4.2, with the ten keys that must be present, and **no other key**.
- [ ] Only jobs that are open **and** published are items; a closed, unpublished, re-drafted, expired or consent-withdrawn job arrives as a tombstone after the change.
- [ ] Entries are ordered by `(updatedAt, id)`; asking again with `nextCursor` returns the following entries and never one already sent; with no cursor the answer starts from the first job.
- [ ] Closing an open job, then asking with the earlier cursor, returns a tombstone for it. Publishing it again returns it as an item.
- [ ] A read with no cursor returns a tombstone for a job that was published once and is closed now.
- [ ] Changing an employer's verification or consent moves its open jobs after the current cursor (section 5.4).
- [ ] Test postings (an empty employer; titles such as 测试, 测试岗位请勿投递, 测试简历匹配) are not items. A real testing job (软件测试工程师) is.
- [ ] `employerVerified` is true only for an employer with a verification that is at most six months old; `syndicationConsentAt` comes from the recorded consent; `validUntil` comes from the posting's validity period.
- [ ] Times carry an offset.
- [ ] An ordinary user key answers 403; no key answers 401; the scoped key answers 401 or 403 on every other route.
- [ ] A request over plain HTTP returns no data.
- [ ] The probe of section 12.3 prints `Schema: OK` and `PASS`, and "Times sent without a zone" is 0.

---

## 12. What this repository does with the answer

So that you know what each choice on your side causes.

### 12.1 The reader (`syndication.ts`, `bank.ts`)

- The endpoint is the bank's transport **whenever `GOHIRE_SYNDICATION_URL` is set**. It then wins over the interim list reader and over the database; `GOHIRE_BANK_TRANSPORT=off` still switches the bank off. No database address is needed.
- The URL must be https. Plain http is accepted for `localhost` and `127.0.0.1` only (a stub or a tunnel on the same machine). Any other URL is refused before a request is made, and the operator sees `syndication_url_not_https`.
- One request per page: the key in `X-API-Key`, a 20 second limit, a 5 MB cap, no redirect followed.
- The page is validated before anything is logged, mapped or stored. A page that does not fit is **one error and writes nothing**: there is no partial page. The error names fields and codes (`items[].updatedAt: not_iso`), never a value.
- Every item passes the same gates as a row read from the database: open and published, a named employer, inside its validity, not a test posting, and a real posting page (see 12.2). A job that fails a gate is closed and counted, not written.
- Each tombstone archives the stored job with the reason `bank_closed`. The job comes back, with its history, as soon as the bank sends it as an item again.
- Stored on each job: market `cn`, source `GoHire`, the bank's own priority among duplicates (a GoHire job outranks the same job read from an employer's board), the employer signals, `validUntil` as the deadline, and the link of 12.2.

### 12.2 The posting page

A bank job is listed **only when GoHire has a candidate-facing page for it** (`GOHIRE_PUBLIC_JOB_URL_TEMPLATE`, https, containing `{id}`). Today `https://www.gohire.top/jobs/<id>` renders "Page not found", so without that setting every job of the route is synced, counted and held, and none is shown. The page is separate work in the second repository and is as necessary as the route.

### 12.3 The probe

`scripts/gohire-syndication-probe.mjs` makes **one** GET of one page with the configured URL and key and checks it with the same contract. It prints counts (items, tombstones, verified, with consent, with a validity end, times without a zone), the page's cursor, and schema problems by field name. It prints no job text, no company name and no key, and it writes nothing.

```
node --env-file=.env scripts/gohire-syndication-probe.mjs --limit 50
```

Exit code 0: the page fits. 1: it does not, or the endpoint could not be read. 2: a setting is missing.

### 12.4 Settings on this side (GoApply deployment)

| Variable | Meaning | Default |
|---|---|---|
| `GOHIRE_SYNDICATION_URL` | The route's full address, `https://api.gohire.top/api/v1/syndication/jobs`. When set it is the bank's transport. | unset (the transports of section 13) |
| `GOHIRE_SYNDICATION_KEY` | The scoped service key for the route. | unset: `GOHIRE_API_KEY` is used |
| `GOHIRE_PUBLIC_JOB_URL_TEMPLATE` | GoHire's candidate-facing posting page, https, containing `{id}`. | unset: bank jobs are held |
| `GOHIRE_BANK_TRANSPORT` | `db`, `api` or `off`. Only `off` matters once the URL is set. | unset |
| `RA_CROSSBANK_CROSS_TENANT_CONFIRMED` | Must be `true` on a deployment that is not GoHire's own (the existing guard, unchanged). | `false` |
| `INGEST_BANK_PAGE` | Entries asked for per page (never more than 200 on this route). | 200 |
| `INGEST_BANK_RESYNC_DAYS` | Days after which the bank is read again from the beginning (section 5.5). A whole number from 1 to 30. | 7 |
| `CN_HR_LICENCE_HOLDER`, `CN_HR_LICENCE_NUMBER` | The licence line shown with GoHire jobs. Set only with the real licence (owner step of section 14). | unset: no licence line |

### 12.5 Live search

While the bank is read over HTTPS, GoApply's live cross-bank search reads GoApply's own copy of the bank (the synced jobs) and never opens the bank's database. A job the route has not sent is therefore not searchable; one it closed stops being searchable at the next sync. The search log carries the copy's age.

---

## 13. Until the route exists

With `GOHIRE_SYNDICATION_URL` unset nothing changes: this repository reads the bank as the parity wave built it.

- **The interim list reader** (`GET <GOHIRE_API_BASE>/api/v1/jobs?status=open&sortBy=aging&limit=50&page=N` with `GOHIRE_API_KEY`). It sees **only the jobs the key's user may see**, reads at most 40 pages (2,000 published jobs) per pass, learns of a closure only when a complete pass no longer lists the job, and cannot state `employerVerified` or `syndicationConsentAt`: every job read this way is shown as posted by a recruiter (代招) and to signed-in users only.
- **The database**, when its address requires TLS. The production endpoint does not offer TLS, so this transport is off there.

Both keep working after the route is live; setting the URL is the switch, and unsetting it is the way back.

---

## 14. Owner steps, in order (`MARKET_STRATEGY.md` section 7)

1. **Item 9.** Approve this work package for the RoboHire / GoHire backend: the route (sections 2 to 9), the schema additions (section 10), and the candidate-facing posting page (12.2).
2. **Item 9.** Issue a service key with the new scope and hand it over outside any repository.
3. **Item 10.** Confirm that GoHire's entity holds a 人力资源服务许可证 with 网络招聘服务 in scope, and supply `CN_HR_LICENCE_HOLDER` and `CN_HR_LICENCE_NUMBER`. Without them GoApply shows no licence line; a made-up one is never shown.
4. Decide the middle row of section 6.2 (may a job without recorded consent be shown to signed-in GoApply users).
5. Run the probe (12.3) against production. Fix what it reports until it prints `PASS` with no time sent without a zone.
6. Set `GOHIRE_SYNDICATION_URL`, `GOHIRE_SYNDICATION_KEY`, `GOHIRE_PUBLIC_JOB_URL_TEMPLATE` and `RA_CROSSBANK_CROSS_TENANT_CONFIRMED=true` on the GoApply deployment (section 12.4). Without the last one the bank stays switched off there, whatever the other three say. The next sync reads the bank from the beginning.
7. Check the admin Sources page of GoApply: the GoHire bank reads "Read from its job feed" (the syndication transport), with its counts and no error.

---

## 15. An example page (synthetic)

No real job, employer or person. One item and one tombstone.

```json
{
  "items": [
    {
      "id": "clx0example0001",
      "status": "open",
      "publishedAt": "2026-10-01T09:00:00+08:00",
      "updatedAt": "2026-10-05T09:00:00+08:00",
      "title": "后端开发工程师",
      "description": "负责后端服务开发。",
      "qualifications": "三年以上后端经验。",
      "hardRequirements": null,
      "niceToHave": null,
      "benefits": "五险一金。",
      "location": "深圳",
      "locations": [{ "city": "深圳", "country": "CN" }],
      "workType": "onsite",
      "employmentType": "full_time",
      "experienceLevel": "mid",
      "education": "本科",
      "headcount": 3,
      "salaryMin": 15000,
      "salaryMax": 25000,
      "salaryCurrency": "CNY",
      "salaryPeriod": "monthly",
      "salaryText": "15-25K·14薪",
      "companyName": "示例科技有限公司",
      "requiredKeywordSet": ["go", "postgresql"],
      "company": {
        "id": "clx0examplecompany1",
        "name": "示例科技有限公司",
        "logoUrl": null,
        "website": "https://example.cn",
        "industry": "互联网",
        "size": "51-200",
        "headcount": 120,
        "founded": 2015
      },
      "employerVerified": true,
      "syndicationConsentAt": "2026-09-01T10:00:00+08:00",
      "validFrom": "2026-10-01",
      "validUntil": "2026-12-31"
    }
  ],
  "tombstones": [
    { "id": "clx0example0000", "updatedAt": "2026-10-06T10:00:00+08:00", "reason": "closed" }
  ],
  "nextCursor": "2026-10-06T10:00:00+08:00|clx0example0000",
  "hasMore": false
}
```
