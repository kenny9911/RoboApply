# USAJOBS fixtures

`search.json` is one answer of `GET https://data.usajobs.gov/api/Search` in the
shape the official reference documents. Nothing here was fetched from the API:
no key exists yet, and the API was not called.

Where the shape comes from (pages of `https://developer.usajobs.gov`, read on
2026-10-12):

- `/api-reference/get-api-search`: the query parameters, the JSON sample and
  the table of response fields.
- `/guides/authentication`: the three request headers (`Host`, `User-Agent`,
  `Authorization-Key`).
- `/guides/rate-limiting`: 500 rows a page, 10,000 rows a query, and that a
  search returns jobs open to the public unless more is authorised.
- `/api-reference/get-codelist-whomayapply` and
  `/api-reference/get-codelist-remunerationrateintervalcodes`: one sample value
  each (`15509` "Agency Employees Only"; `BW` "Bi-weekly").

The two items:

1. **The documented sample**, as the reference prints it: ids, title, links,
   location, organisation, categories, schedule, pay (`PA`, "Per Year"), the
   four dates and `WhoMayApply` are the page's own values. The page prints
   `...` for every long text; those texts, and the teaser sentence, are
   replaced by lines that start with `SYNTHETIC`. The refiner lists of the
   sample are left out.
2. **A SYNTHETIC item** in the same shape: a part-time post for agency
   employees only, paid by the hour, in two places. Its ids, names and texts
   are invented (the control number starts with `900000`). `WhoMayApply` uses
   the code-list sample value. Its rate interval (`PH`, "Per Hour") is NOT a
   documented value: the adapter reads the period from the item's own
   `Description` and the test says so.

`HowToApply` holds an obviously fake name, e-mail address and phone number in
both items. The adapter never reads that field (agency contact details are not
copied), and the test proves the three values are in no produced posting.

What the reference does not show, and so is not in the fixture: a `HiringPath`
list inside `UserArea.Details`. The adapter reads one when an answer carries
it; its test builds that item inline.
