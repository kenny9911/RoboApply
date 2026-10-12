# Public ATS board fixtures (WP-42)

## Documented-shape fixtures (committed)

Response bodies in the documented shape of each public posting API, trimmed to
the fields the connectors read plus a few they ignore. Company names, ids and
text are fictional (no real employer's postings are stored in the repo).

| File | Endpoint |
|---|---|
| `greenhouse.json` | `GET https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true&pay_transparency=true` (the listing WITH texts; the listing without them has another shape, see `greenhouse-list.json` below) |
| `lever.json` | `GET https://api.lever.co/v0/postings/{site}?mode=json&skip=0&limit=100` |
| `ashby.json` | `GET https://api.ashbyhq.com/posting-api/job-board/{org}?includeCompensation=true` |
| `smartrecruiters-list.json` | `GET https://api.smartrecruiters.com/v1/companies/{id}/postings?limit=100&offset=0` |
| `smartrecruiters-detail.json` | `GET https://api.smartrecruiters.com/v1/companies/{id}/postings/{postingId}` (keyed by posting id) |

These were written from the vendors' public API documentation, not recorded
from a live board (WP-42 ran without network access). The contract tests
that pin exact values (`connector contract: Greenhouse/Lever/Ashby/SmartRecruiters`)
use them.

### Added by MKT-5B (JI-8)

| File | Endpoint | Shape taken from | Read on |
|---|---|---|---|
| `greenhouse.json` (first posting) | the list call with `pay_transparency=true` | the keys a live board sends when the employer has set neither: `pay_input_ranges: []`, `application_deadline: null` (two boards read once each, key names and types only) | 2026-10-12 |
| `greenhouse-list.json` | `GET …/v1/boards/{token}/jobs` (the listing WITHOUT texts) | the key names one live board answered with: `absolute_url`, `application_deadline`, `company_name`, `data_compliance`, `first_published`, `id`, `internal_job_id`, `language`, `location` (`name` only), `metadata`, `requisition_id`, `title`, `updated_at`, and `meta.total`. It has **no `offices`, no `departments` and no `content`** (the documentation says `content=true` adds those), so it never says where a posting is beyond `location.name`. Values are fictional | 2026-10-12 |
| `greenhouse-pay.json` | `GET …/v1/boards/{token}/jobs?content=true&pay_transparency=true` | `pay_input_ranges` (`min_cents`, `max_cents`, `currency_type`, `title`, `blurb`) and `application_deadline` from the sample under "Retrieve a job" in docs.greenhouse.io/job-board.html. A populated range was not seen on a list call, only the key | 2026-10-12 |
| `lever-eu.json` | `GET https://api.eu.lever.co/v0/postings/{site}?mode=json&skip=0&limit=100` | the same documented shape as `lever.json`, with the EU instance's hosts (github.com/lever/postings-api names both instances). No live EU board was on hand (0 of 74 tried on 2026-10-11) | 2026-10-12 |
| `workable.json` | `GET https://apply.workable.com/api/v1/widget/accounts/{slug}?details=true` | the key names and value types one public account answered with (read twice; no text was kept). Workable does not document this endpoint for third parties | 2026-10-12 |
| `recruitee.json` | `GET https://{company}.recruitee.com/api/offers/` | the sample answer in docs.recruitee.com/reference/offers (Careers Site API, "no authorization") | 2026-10-12 |
| `personio.xml` | `GET https://{company}.jobs.personio.de/xml?language=en` | developer.personio.de/v1.0/reference/get_xml ("Retrieve open positions"); element names, `additionalOffices` and the two `createdAt` spellings confirmed on Personio's own public board (names and types only) | 2026-10-12 |

Every company, id and text in these files is fictional or marked SYNTHETIC.

### `beisen.json` is SYNTHETIC and unverified

`beisen.json` was built by hand. **No 北森 board was ever called**, by a person
or by this code. Its key names (`Data`, `Count`, `Id`, `JobAdId`, `JobAdName`,
`Duty`, `Require`, `LocNames`, `Kind`, `Salary`, `PostDateInt`, `PostDate`,
`ChangeDate`, `Category`, `WorkWeChatQrCode`) are those of the one source the
research note cites for this system: the connector and its tests in the
open-source OpenHire project (MIT licence, github.com/gzchenhao/openhire,
`src/openhire/ats/beisen.py`, `tests/test_beisen.py`; read 2026-10-12). That is
a third party's reading of the portal, not vendor documentation.
`ContactPhone` and `ContactWeChat` are NOT field names of the board: they stand
for "any other key" in the test that no unread key ever reaches a stored row.
The phone numbers and ids in the file are placeholders, not anyone's.
Its `places` block is one more SYNTHETIC page, for where a posting is: a
mainland city the place table does not know, the whole country, places on both
sides of the border, places outside the mainland only, the word for "abroad",
and no place at all.

**Before `CN_ATS_BEISEN_ENABLED` is ever set to true** (it needs counsel's
sign-off first, see `docs/job-search/ATS_BOARDS.md`), ops must:

1. record one real response of one tenant board whose employer is on the
   curated list (by hand, once, with our identifying User-Agent and no cookie,
   token, signature or Referer);
2. replace the posting text and every contact detail before committing it,
   keeping each key and value type as recorded;
3. run the connector tests against it and re-verify the mapper
   (`connectors/beisen.ts`): the request body keys, the paging, `Count`, the
   two date fields, the pay text, the posting page URL, and whether the portal
   answers at all without a Referer (we do not send one);
4. only then read the campus (校招) category: its `Category` value and page
   path are not in the source above and are not guessed.

## Recorded responses (to be added by OPS / INT)

`record.ts` records one real response per vendor through the connectors' own
HTTP layer (only the allowed API hosts, no redirects; it knows the four systems
of WP-42: Greenhouse, Lever, Ashby, SmartRecruiters), keeps the full response
structure with the first 3 postings, and writes:

- `<vendor>.recorded.json` (SmartRecruiters: `{ list, details }`)
- `recorded-meta.json`: endpoint, board token, recording date, postings listed/kept

```
npx tsx server/src/features/jobs/sources/atsPublic/__fixtures__/record.ts \
  --greenhouse <token> --lever <site> --ashby <org> --smartrecruiters <companyId>
```

The `connector contract: recorded responses` tests run every recording through
its connector (every listed posting must map, with a title, an https link, a
description and the company + board source name). Until a vendor is recorded,
its test is a `todo`. Pick public boards whose postings may be stored in the
repo, or replace the posting text before committing while keeping every key
and value type as recorded.

| Vendor | Recorded from | Date |
|---|---|---|
| Greenhouse | not yet | — |
| Lever | not yet | — |
| Ashby | not yet | — |
| SmartRecruiters | not yet | — |
