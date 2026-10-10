FIX-1 · handoff (after review)

All six findings are fixed in code except the 404 console error, which still needs a two-line change in `app/layout.tsx` (outside my owns). Both unowned edits are reverted and all gates are green. Nothing was checked in a browser (not allowed here); the phone layout rests on CSS guard tests, font-metric arithmetic and the reviewer's Chromium measurements.

## Review resolution

1. **[medium] Visitor's 404/error button English in eight locales — fixed, by a different route than suggested.**
   - The pages now read the already-translated `seo.job.notFound.home` instead of a new `errors.go_site_home`. Those are the same nine values the reviewer listed.
   - I did not add the key to the bundles because the rules allow bundle edits only to fix or remove existing entries.
   - `i18n/staging/errors.en.json` is deleted, so no new key exists and `i18n/staging/index.ts` needs no regeneration.
   - New tests in `app/errorPages.test.tsx`: every string these pages use is in all nine bundle files and is not English outside `en`; the visitor link is localized in every locale; the zh 404 contains no Latin letters. 5 of 18 fail if the path is pointed back at `errors.go_site_home`.
2. **[low] 404 console error — not done; needs `app/layout.tsx`.** See Requests. `ThemeBootScript.tsx` is ready and tested but not wired.
3. **[low] "Applicatio / ns" at 360px — fixed as suggested.**
   - `.now` now uses `overflow-wrap: normal` plus `text-overflow: ellipsis`; `hyphens: auto` stays.
   - The comment is updated and a guard test forbids `overflow-wrap: anywhere` and `word-break: break-all` on that rule.
   - The "Applicati…" result is the reviewer's Chromium measurement; I could not re-measure it.
4. **[low] Campus deadlines on unlisted surfaces — confirmed, moved to Requests.** Both extra sites call `format.dateTime` without a zone: `JobOverview.tsx:33` (FIX-3) and `GoApplyHome.tsx:61` (FIX-7).
5. **[low] Onboarding header loses its brand name at ≤340px — fixed, more widely than suggested.**
   - Every topbar rule I added is now scoped to `.main > .topbar`, not only the 340px one.
   - I also restored the `.crumbs { max-width: 90px }` rule at ≤380px that I had removed, so the onboarding header is styled exactly as at HEAD.
   - Guard tests: no rule starts with a bare `.topbar >`; nothing outside `.main > .topbar` hides `.crumbs`; `Topbar` is a direct child of `main.main`.
6. **Unowned edits — both reverted.**
   - `i18n/staging/index.ts`: restored; no longer needed.
   - `__tests__/components/AvatarMenu.test.tsx`: restored. It still pins `monogramFor('') === 'RA'`, so `monogramFor` stays as a deprecated export that nothing renders (`initialsFor(source) || 'RA'`). The trigger uses the new `initialsFor`, which returns `''`. Cleanup is under Requests.

## Per-finding result

**1. [HIGH] Topbar at 375px — fixed**
- **Root cause:** `.search` and `.icon-btn` set `display` in stylesheets imported unlayered, so the Tailwind `max-[760px]:hidden` / `hidden max-[760px]:grid` utilities never applied.
- **Fix:** the swap lives in `styles/v3.css` (`.top-actions .search-compact` hidden by default; at ≤760px the pill is hidden and the icon button shown). `Topbar.tsx` uses plain classes.
- **Phone width:** the six controls keep their size and the page name gives way. Several words wrap at the space onto two lines; a single long word is hyphenated where the browser can, otherwise it stays on one line with an ellipsis. Under 340px the name is hidden.
- **Also fixed (not in the finding):** by arithmetic the topbar overflowed at about 761–930px. The pill is now the one shrinkable item and its ⌘K cap is hidden at 761–1000px.
- **Test:** `components/v3/shell/topbarResponsive.test.ts` (16).

**2. [HIGH] Envelope with `data: null` — fixed**
- **Root cause:** `data?.data ?? data` in `lib/api/client.ts`.
- **Fix:** exported `unwrapEnvelope()`. `{success, data: X}` returns X for any X including null, 0, false and ''. A bare `{data: X}` with non-null X still unwraps.
- **Side effect:** void handlers (`route()` sends `data: null`) now resolve `null` instead of the envelope. I found no caller that reads the envelope.
- **Test:** `lib/api/client.test.ts` (9).

**3. [MEDIUM] Brand time zone — fixed**
- **Root cause:** `timeZone={brand.defaultTimezone}` in `app/providers.tsx`.
- **Fix:** `useViewerTimeZone()` via `useSyncExternalStore`. Server render and hydration use the brand default; the browser's zone applies straight after, with the brand default as fallback.
- **Test:** `app/providers.test.tsx` (6), including a hydration case with no hydration error.

**4. [LOW] 404 and error pages — fixed except the console error**
- **Localized:** `app/not-found.tsx` and `app/error.tsx` read translated strings through `components/v3/shell/errorCopy.ts`, which falls back to English instead of throwing.
- **Visitor link:** a visitor gets the home link (`/`) in their language; a signed-in user gets "Go to Jobs" (plus the home link on the 404).
- **Retry:** "Try again" calls Next's `retry` and falls back to `reset`.
- **global-error:** carries its own nine-locale copy, held equal to the bundles by a test.
- **404 body:** the "Go to your jobs…" sentence is removed from `errors.not_found_body` in all nine bundles.
- **Console error:** not fixed; see Requests.
- **Tests:** `app/errorPages.test.tsx` (18), `components/v3/shell/ThemeBootScript.test.tsx` (6).

**5. [LOW] Locale bundle leftovers — one bundle fix; the rest is not in the bundles**
- **Fixed:** `applications.column.aria` is an ICU plural in en/es/fr/pt/de.
- **Not bundle strings:** the mixed punctuation, "Anywhere" and the saved-searches message are produced in code (see Requests).
- **Test:** `i18n/messages/bundles.test.ts` (5).

**6. [LOW] Avatar "RA" — fixed**
- **Root cause:** the trigger rendered `monogramFor()`, which returned 'RA' for no source; "UU" came from abbreviating the phone-account placeholder `u-…@users.goapply.invalid`.
- **Fix:** the trigger uses `initialsFor`, which returns '' for no source or a `.invalid` address, and then shows `IconPerson`.
- **Test:** `components/v3/shell/AvatarMenu.test.tsx` (7), including one that fails if the trigger calls `monogramFor` again.

## Files changed (all within owns)

- **Modified:** `components/v3/shell/Topbar.tsx`, `components/v3/shell/AvatarMenu.tsx`, `styles/v3.css`, `styles/workspace.css`, `lib/api/client.ts`, `app/providers.tsx`, `app/error.tsx`, `app/global-error.tsx`, `app/not-found.tsx`, all nine `i18n/messages/*.json`.
- **New in `components/v3/shell/`:** `NotFoundView.tsx`, `errorCopy.ts`, `errorPage.styles.ts`, `globalErrorCopy.ts`, `ThemeBootScript.tsx`, `AvatarMenu.test.tsx`, `ThemeBootScript.test.tsx`, `topbarResponsive.test.ts`.
- **New tests elsewhere:** `app/errorPages.test.tsx`, `app/providers.test.tsx`, `lib/api/client.test.ts`, `i18n/messages/bundles.test.ts`.
- **Outside owns:** none.

## Tests run (worktree `/Users/kenny/code/RoboApply/.claude/worktrees/wp-FIX-1`)

- `npx vitest run --exclude ".claude/**"`: 591 files, 11885 passed, 1 skipped, 10 todo.
- `npx next typegen && npm run typecheck:web`: clean.
- `npm run typecheck:server`: clean.
- `npm run check`: all six checks clean.
- Extension untouched.

## Requests

- **Orchestrator — `app/layout.tsx`** (finishes finding 4): add `import { ThemeBootScript } from '../components/v3/shell/ThemeBootScript';` and replace the inline theme `<script dangerouslySetInnerHTML=… />` in `<head>` with `<ThemeBootScript />`. Then load `/no-such-page` in dev on both brands and confirm a clean console and no theme flash.
- **Orchestrator — `__tests__/components/AvatarMenu.test.tsx`** (cleanup only): change the two `'RA'` expectations to `''` and import `initialsFor` instead of `monogramFor`; then delete the deprecated `monogramFor` export and the test that counts its occurrences in `components/v3/shell/AvatarMenu.test.tsx`.
- **FIX-3:**
  - `components/features/job/JobOverview.tsx:33` (campus apply window): pass `timeZone: CAMPUS_TIME_ZONE` from `components/features/campus/format.ts`, as `EventCard.tsx:61` does.
  - `components/features/network/ConnectionsList.tsx:50` and `PeoplePanel.tsx:63`: pass `timeZone: 'UTC'` for the date-only `connectedOn`.
  - `components/features/feed/JobCard.tsx:281,287` type `: ` after `t('whatsMissing')` / `t('whatLinesUp')`; move the punctuation into the message.
  - `server/src/features/search/SearchProfileService.ts:73` sends English `Up to ${max} saved searches on this plan`; send a code plus `max` and render an ICU plural on the client.
  - The "Anywhere" location comes from job data (likely `server/src/features/jobs/geo/parseLocation.ts`), not a bundle, and needs a translated label.
- **FIX-7:**
  - `components/features/marketing/GoApplyHome.tsx:61` (used for `applyClosesAt` at line 76): pass `timeZone: CAMPUS_TIME_ZONE`; this also stops the text changing after hydration.
  - GoApply `/en` landing has a Chinese `<title>`, and app pages are titled only with the brand name (`lib/brand/metadata.ts` has no owner this round).
- **FIX-8:**
  - `onboarding-cn/OpportunityPanel.tsx:52`, `CnFirstValueTour.tsx:113`, `CnConfirmStep.tsx:92`: pass `timeZone: CAMPUS_TIME_ZONE`.
  - `components/features/compliance/WhyThisJob.tsx:24` types `: “{evidence}”`; this is the zh-TW mixed punctuation.
- **FIX-2:** `settings.usage.actionCount` cannot be pluralized in the bundle alone because `components/v3/account/usage.tsx:69,75` passes a pre-formatted string as `count`.
- **Unowned:** `pages/404.tsx` is still English with the old palette.

## i18n keys

- **Added:** none. The staged `errors.go_site_home` from the previous handoff is withdrawn.
- **Changed in all nine bundles:** `errors.not_found_body` (second sentence removed).
- **Changed in en/es/fr/pt/de:** `applications.column.aria` (ICU plural).
- **Read from a second place:** `seo.job.notFound.home` is now also the visitor's button on the 404 and the route error page; a wording change there changes both.

## Known gaps

- Until the layout change lands, the 404 console error remains.
- The one-line ellipsis for a long English page name was measured by the reviewer in Chromium only; Safari and Firefox are unchecked. The worst case is a clipped word without the "…", not an overflow.
- `next build` was not run, so prerender of `/_not-found` and `/_global-error` is unverified.
- Until the Requests above land, campus deadlines on those five surfaces follow the viewer's zone and can show a different day from the calendar card for a GoApply user outside UTC+8.
- Server-rendered timestamps on public pages paint in the brand zone and switch after hydration.
- global-error paints English first, then the reader's language.