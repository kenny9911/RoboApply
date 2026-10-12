# WP-70 fixtures

Hand-built, anonymized reproductions of public pages, kept to the structure
the hosts render (ids, names, `data-*` attributes, class names). Employers and
roles are fictional; no personal data. Scripts never run (JSON-LD blocks are
data only).

- `workday/`, `smartrecruiters/`, `icims/`, `workable/`, `taleo/`,
  `successfactors/`: application forms, at least three per adapter. Multi-page
  forms (Workday, Taleo, SuccessFactors) have one file per page; each page is
  filled on its own.
- `generic/`: one saved form per requested host in `GENERIC_SITES`
  (`<site name, lower case>.html`), plus pages that must not be treated as
  application forms.
- `boards/`: job pages on boards that are read only after a toolbar click
  ("Check fit" / "Save job"). They keep the parts a reader must ignore (the
  signed-in member, other listings, ratings) so tests can prove nothing else
  is read.

SmartRecruiters' current form uses declarative shadow DOM
(`<template shadowrootmode="open">`); `loadIntlFixture` attaches those roots
the way a browser does when it parses the page.
`smartrecruiters/oneclick-shadow.html` puts the controls directly in the form
component's own shadow root (not in child components), which the field lister
must also read.

## Not yet checked against live pages

These files were written from the hosts' documented and commonly seen markup,
not saved from live pages. Selectors such as Workday's `data-automation-id`,
SuccessFactors' `fbclc_*` ids, Taleo's `flowTrail`, SmartRecruiters' `spl-*`
components and the board class names are only proven against this markup.
Before release (R6, WP-94/INT): open each host in a browser, save an
anonymized DOM snapshot of the same page, diff it against the fixture here,
update the fixture and the adapter where they differ, and run the Playwright
e2e.
