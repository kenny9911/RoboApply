# Public ATS board fixtures (WP-42)

## Documented-shape fixtures (committed)

Response bodies in the documented shape of each public posting API, trimmed to
the fields the connectors read plus a few they ignore. Company names, ids and
text are fictional (no real employer's postings are stored in the repo).

| File | Endpoint |
|---|---|
| `greenhouse.json` | `GET https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true` |
| `lever.json` | `GET https://api.lever.co/v0/postings/{site}?mode=json&skip=0&limit=100` |
| `ashby.json` | `GET https://api.ashbyhq.com/posting-api/job-board/{org}?includeCompensation=true` |
| `smartrecruiters-list.json` | `GET https://api.smartrecruiters.com/v1/companies/{id}/postings?limit=100&offset=0` |
| `smartrecruiters-detail.json` | `GET https://api.smartrecruiters.com/v1/companies/{id}/postings/{postingId}` (keyed by posting id) |

These were written from the vendors' public API documentation, not recorded
from a live board (WP-42 ran without network access). The contract tests
that pin exact values (`connector contract: Greenhouse/Lever/Ashby/SmartRecruiters`)
use them.

## Recorded responses (to be added by OPS / INT)

`record.ts` records one real response per vendor through the connectors' own
HTTP layer (only the four API hosts, no redirects), keeps the full response
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
