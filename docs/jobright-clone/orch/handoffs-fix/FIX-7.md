FIX-7 handoff (after review) — worktree `/Users/kenny/code/RoboApply/.claude/worktrees/wp-FIX-7`, branch `wp/FIX-7`, nothing committed. All gates are green. Nothing was checked in a browser (not allowed), so layout and the signed-in `/help/ranking` state still need a retest.

## Review resolution

1. **[medium] Non-work sections counted as years of work — fixed, with two deliberate departures.**
   - **Section words:** added the missing headings in `parse.ts` (certificates, licenses, credentials, professional development, affiliations/memberships, academics, academic experience, schooling, courses and certifications, leadership, community involvement, and Chinese 培训经历, 在校经历, 社会实践, 志愿者经历 and similar).
   - **Work headings:** new `isWorkHeading` in `entries.ts` excludes volunteer, academic, extracurricular, community and leadership experience sections, plus 社会实践/在校/志愿/社团. `isExperienceHeading` keeps its parity test with the reader.
   - **Guard that does not depend on the list:** a dated entry that is plainly a degree, certificate/diploma or membership stays body text.
   - **Departure 1 — research and teaching still count as work.** Excluding them would bring back "No dated experience found" for teachers and researchers, whose jobs sit under those headings. The reviewer did not reproduce a case for them.
   - **Departure 2 — the guard is narrower than suggested.** `educationFrom` reads "MA", "BS" and "Master" anywhere on a line, so it would drop "Designer — Acme, Boston, MA" and "Scrum Master". `member\b` would drop "Team Member — Target" and "Member of Technical Staff". `course|bootcamp` would drop "Bootcamp Instructor" and "… Golf Course". I wrote narrow patterns instead, with a test of 19 real job lines that must stay roles.
   - All the reviewer's cases now give 2.8 / "Not met" (Chinese case 5.3).
2. **[low] Sub-labels turned into sections — fixed, with a different rule from the one suggested.** A label word stays a body line when it repeats in the file, or when it sits in an experience section and is written differently from that section's heading (colon or capitals). The suggested "no trailing colon" rule would have read "Projects:" as body in a resume whose headings all end in a colon, counting project dates as work. The reviewer's resume now gives 12.8 years and title "Met". A label line, and the line under it, never join a role heading.
3. **[low] Numbered bullets without a space — fixed** with the suggested pattern. "1.负责接口开发" and "10.Designed" are bullets; "12.2019 – 03.2022" and "3.5 years" are not.
4. **[low] Sorts sentence regressing to English in eight locales — fixed with the reviewer's fallback.** The key is `landing.ranking.otherSorts` again; only the staged English value takes placeholders. Other locales keep their translated sentence until the next translation pass. The zh staging entry is removed: the merge script would have turned it into a GoApply-only override of brand-neutral copy.
5. **[low] Computed duration from the structured parse — fixed.** New `withReadableDates` in `parse.ts` replaces a `duration` holding no date range with `startDate – endDate` before the markdown is built (both the AI and GoHire paths). The input is not mutated.
6. **Unfixed: only 4 of ~8 hard skills — still not done, outside owns.** Confirmed on the QA files: 3 of 4 (figma, user research, prototyping; data visualization missing). The list is `server/src/features/resume/keywords/vocabulary.ts` (FIX-4). The only seam in my owns would need a model call in a tool that is designed to run none.
7. **Unfixed: `/help/ranking` shows Sign in to a signed-in user — rejected as a page defect, still unproven.** The QA helper explains the screenshot: `lib.cjs` `idle()` only tracks API requests, so after the bell step it returns at once on `/help/ranking`, about 1.5 s before the capture. That is consistent with `HybridShell` still being in its `loading` state. The remaining flash is in `components/v3/shell/HybridShell.tsx` (FIX-1). Needs a signed-in browser retest.
8. **Unowned edits:** none.

I checked that each new test fails when its fix is switched off.

## Per-finding result

**1. [MEDIUM] Landing language menu — fixed (unchanged since last handoff)**
- **Root cause:** menu items were `next/link`; the locale and message bundle belong to the root layout, which client navigation keeps mounted. `SiteChrome` also passed the nav landmark's label as the button name.
- **Fix:** items are plain `<a>` (full document load); the button names itself from `landing.header.lang_label`; `lang` and `aria-current` on items; the menu closes on `pagehide`.
- **Tests:** `components/landing/__tests__/LanguageMenu.test.tsx` (5), plus a header-label test in `home.test.tsx`.

**2. [MEDIUM] Free matcher false gaps — title and years fixed; hard-skill count not done (FIX-4)**
- **Root cause:** the requirement rows read titles and dated roles only from `###` entry headings, which an uploaded file never has.
- **Fix:** `server/src/features/tools/entries.ts` (`withEntryHeadings`) gives the rows a view with role lines as `### … — 2022.03 – present`. It is used in `runRequirementRows` only; the markdown the visitor keeps is unchanged.
- **Also fixed in `textToMarkdown`:** date-led lines were read as numbered bullets, and many section headings were not recognised.
- **Review hardening:** only work sections add years, the non-job guard, the label rule, no-space numbered bullets, and readable dates from the structured parse (see Review resolution).
- **Cache:** key is `v3`; it never shipped as anything else, so no further bump.
- **QA files:** `resume.txt` with `jd.txt` gives title pass, years `{required: 5, found: 9}`, education pass, skills 3 of 4.
- **Tests:** `entries.test.ts` (40), `parse.test.ts` (15).

**3. [LOW] /help/ranking and mobile theme toggle**
- **Sign in for a signed-in user:** rejected as a page defect (item 7 above); route test that `/help` and `/help/ranking` use `HybridShell`.
- **Sort names:** fixed. The sentence interpolates the menu's own labels through `OTHER_SORTS`, with a parity test against `sortsFor()`. A new test over eight locales confirms each renders its own sentence, not the English one.
- **Mobile theme toggle:** fixed in the footer below 760 px ("Switch to dark/light"), on the same theme state. 3 tests.

**4. [LOW] Sitemap omits three feature pages — excluded on purpose, documented and locked**
- Gated feature pages are `noindex`, and a sitemap must not list noindex URLs.
- The rule is one predicate, `isFeatureIndexable` / `indexableFeaturePaths`, used by the sitemap route.
- Test: for both brands, sitemap feature URLs equal the indexable pages.

## Files changed
- `components/landing/LanguageMenu.tsx`, `components/landing/__tests__/LanguageMenu.test.tsx` (new)
- `components/features/marketing/SiteChrome.tsx`, `CompanyPages.tsx`, `catalog.ts`, `marketing.module.css`
- `components/features/marketing/__tests__/home.test.tsx`, `pages.test.tsx`, `routes.test.tsx`
- `app/sitemaps/[file]/route.ts`
- `server/src/features/tools/entries.ts` (new), `entries.test.ts` (new), `checks.ts`, `parse.ts`, `parse.test.ts`, `service.ts`, `fixtures.ts`
- `i18n/staging/landing.en.json` (`landing.zh.json` is back to its committed, empty state)

## Tests run
- `npx vitest run --exclude ".claude/**"`: 586 files, 11882 passed, 1 skipped, 10 todo.
- FIX-7 subset (landing, marketing, tools server and client, `languageSwitchers`): 15 files, 271 passed.
- `npm run typecheck:server`: clean.
- `npx next typegen && npm run typecheck:web`: clean.
- `npm run check`: exit 0.
- Extension untouched.

## Requests
**FIX-4** (`server/src/features/resume/`, `server/src/lib/candidateResumeIngest.ts`):
1. `keywords/vocabulary.ts`: add to `HARD_SKILLS_EN` 'design systems', 'usability testing', 'interaction design', 'accessibility', 'wcag', 'motion design', 'after effects', 'wireframing', 'information architecture'. This is the unfixed part of finding 2.
2. `keywords/keywordReport.ts` `parseDatePoint`: change `([a-z]{3,4})[a-z]*` to `([a-z]{3})[a-z]*` (full month names fall back to year-only), and add word boundaries to `/present|current|now|…/` ("Snowflake" reads as today).
3. `titleRow` / `resumeYears` read only `###` entries, so a signed-in keyword check on an uploaded, unedited resume has the same false gaps.
4. `resumeYears` counts any section whose heading contains "experience", including "Volunteer Experience" already in the editor's `###` shape. The tool view cannot change that.
5. `parsedResumeToMarkdown`: prefer `startDate`/`endDate` over a `duration` that holds no dates. The tool now normalises this itself; signed-in upload does not.

**FIX-1**:
1. `components/v3/shell/HybridShell.tsx`: while auth status is `loading`, do not show Sign in / Get started.

**Orchestrator**:
1. Merge and translate the changed `landing.ranking.otherSorts` into all eight non-English locales, keeping `{newest}`, `{bestFit}`, `{highestPay}`. The merge script drops the stale translations of a changed key, so merge and translate must ship together. Suggested zh: "“{newest}”“{bestFit}”“{highestPay}”都只按这一项排序。" No key needs removing.
2. `app/features/[slug]/page.tsx` (unowned): replace `def.gate !== null` with `!isFeatureIndexable(def)` so the page and sitemap share the rule.

## i18n keys
- Changed: `landing.ranking.otherSorts` — en: "{newest}, {bestFit} and {highestPay} each sort by that one thing only." (staged in `i18n/staging/landing.en.json`).
- Withdrawn: `landing.ranking.otherSortsNamed` (never merged).
- Reused, no change: `landing.header.lang_label`, `nav.theme_to_dark`, `nav.theme_to_light`, `jobs.workspace.sort.*`.

## Known gaps
- Browser retest needed: the language switch reload, the footer theme switch at 375 px in both themes and brands, the matcher through the real PDFService path, and signed-in `/help/ranking`.
- Hard-skill count is unchanged until FIX-4 extends the vocabulary.
- Until re-translation, pt's sorts sentence says "Melhor encaixe" while its menu says "Seus melhores encaixes", as before.
- Entry detection is heuristic and leans towards "Not listed":
  - Season dates ("Summer 2017"), roles written as bullets, and unrecognised experience headings stay "Not listed".
  - A certificate, degree or membership line directly above a job's lines keeps that job out too.
  - Under an unknown heading, a dated line matching none of the guard patterns (a talk, or "AWS Certified Solutions Architect, 2021 – 2024") still counts as a role.
  - A resume that writes "EXPERIENCE" in capitals and a real "Projects:" section with a colon has that section read as a label.
- The ranking page's sorts sentence names the three shared sorts; GoApply's fourth ("Applications closing soonest") is not mentioned, as before.