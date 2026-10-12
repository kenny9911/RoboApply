# Mainland portal form fixtures (WP-71)

Hand-built, anonymized reproductions of the application-form markup of each
supported portal family: Moka (Ant Design), Beisen (Element UI), Feishu
recruiting (ByteDance UD) and Dayee (label/value and column-header tables),
plus three pages for the label-heuristic generic adapter (one of them a page
that must NOT be treated as an application form). Company and role names are
fictional; there is no personal data.

**They were written from the UI kits' public markup conventions, not saved
from live portal pages** (no network access while WP-71 was built). Before the
GoApply build ships, refresh each one from a live application page (File →
Save Page As, "HTML only"; delete scripts, tracking and employer text that the
form structure does not need; keep ids, names and class names) and re-run
`npm --prefix extension test`. The INT browser pass should open one real form
per portal with the unpacked GoApply dev build.

Pages added after review (same conventions, also hand-built):

- `beisen/cards.html`: one Element UI form per section card, a search form
  styled as a form above them, 学习经历 / 主要社会关系 / 紧急联系人 sections, the
  submit bar after the cards, a consent dialog and footer links.
- `dayee/search-header.html`: a keyword search form before `#applyForm`, and a
  证明人 (referee) table.
- `moka/header-search.html`: an Ant Design search form in the nav bar, an
  education block under a heading the field map does not know (求学经历), an
  unknown section asking 姓名 / 手机 again, a test-score question, and 证明人
  labels inside an internship row.
- `generic/header-form.html`: a `<header><form>` search before the application form.
