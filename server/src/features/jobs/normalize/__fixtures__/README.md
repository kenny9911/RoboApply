# Normalizer fixtures

Anonymized provider rows shaped like the real payloads (field names and value
formats from Active Jobs DB / LinkedIn Job Search API (Fantastic Jobs), JSearch,
the RoboHire / GoHire recruiter `Job` table and public ATS boards). Every
company, person, id, URL and description is invented; no row is copied from a
real posting. Languages: English (`en`), Simplified Chinese (`zh`) and
Traditional Chinese as used in Taiwan (`zh-TW`).

## The licensed feed (Active Jobs DB window sync, MKT-5A)

| File | What it is |
|---|---|
| `fantastic.json` | Rows in the field names the search route returned before the vendor's v1 API (`date_validthrough`, `linkedin_org_*`, `remote_derived`). Kept as they are: stored and cached rows still carry these names, and the mapper reads both. |
| `fantastic-feed.json` | **SYNTHETIC.** Four rows of the new-jobs route in the v1 field names (`date_valid_through`, integer `id`, `domain_derived`, `ai_visa_sponsorship`, `ai_taxonomies_a`, `org_linkedin_*`). Built from the documented field list, not from a response: the OpenAPI document `https://data.fantastic.jobs/openapi` (schema `ActiveAtsJob`) and the page "Field changes old to new API" on `developer.fantastic.jobs`, both read on 2026-10-12. The free plan was used up, so no response could be recorded. |
| `fantastic-expired.json` | **SYNTHETIC.** An answer of the expired route: a bare array of the vendor's internal job ids (integers), as the vendor's "Expired Jobs" page describes it. The first id is a row of `fantastic-feed.json`, the second a row of `fantastic.json`; the other two are ids we never stored. |

The rows carry fields the mapper must never copy (`org_linkedin_*`,
`org_crunchbase_*`, `org_logo_permalink`, `ai_hiring_manager_name`,
`ai_hiring_manager_email_address`): `adapters.fantastic.test.ts` asserts that
none of them reaches the normalizer's input.

When a paid plan exists: record ONE page of `GET /v1/active-ats` (or
`/active-ats` on the marketplace) with `limit=5`, replace every company name,
person, id, URL, domain and description by an invented one, keep the field
names and value formats exactly, and drop the word SYNTHETIC from the line
above. Never commit a real posting's text.
