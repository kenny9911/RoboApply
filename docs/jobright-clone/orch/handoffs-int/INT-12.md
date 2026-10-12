**INT-12 · status: complete; one cross-bundle test patch must be applied at merge.** All eight items are implemented and every review finding inside this bundle is fixed. `npm test` stays red on two INT-04 tests until the verified patch below is applied. Nothing is committed. I did not launch a dev server: this worktree holds only one of 13 parallel bundles, so the try-out has to start from the merged tree.

## Review resolution

1. **⌘K palette spends the job list's refresh budget (high) — fixed.** Confirmed in `FeedQueryService.ts` (`consumeRefresh`, 20 per 10 minutes).
   - Typing now sends nothing. With two or more characters a "Search jobs for “…”" row appears; Enter or a click runs one `queryFeed({ q })`.
   - The same search is answered from the cache for 10 minutes, and nothing refetches on focus or reconnect.
   - A 429 `feed_refresh_limited` shows its own message and no retry row.
   - An empty result now says the saved-search filters apply.
   - Also added: an Enter that confirms a Chinese/Japanese/Korean input candidate no longer triggers anything.
   - Each explicit search still costs one refresh; the lookup mode is a request to INT-05.
2. **Two failing tests in INT-04's `rail.test.tsx` (high) — confirmed, not mine to edit.** The patch is at `/private/tmp/claude-501/-Users-kenny-code-RoboApply/ca326177-3056-45db-a2e4-d92af4c9efdb/scratchpad/int12/INT-04-rail-test.patch`. `git apply --check` passes, and a temporary copy of the patched test ran 29/29 before I deleted it.
3. **Account deletion does not forget the device (medium) — fixed, in a different order than suggested.** The push step runs before the delete request. Run after it, as suggested, the push call returns 401 on the deleted session and sets off the stale-session redirect in `lib/api/client.ts`. Drafts, the bearer token and the cache (hard navigation) are cleared only on success. The header comment in `signOutCleanup.ts` is now accurate.
4. **"Sign out everywhere" has no pending state (low) — fixed.** The button is disabled from the click, a second click does nothing, drafts are cleared only on success, and a failure shows "You are still signed in. Try again." `AvatarMenu` now shows "Signing out…" and ignores repeat clicks.
5. **GoApply Chinese UI shows English for new labels (low) — partly addressed.** I staged Chinese for the four page-jumper keys in a new `i18n/staging/nav.zh.json`. Staged Chinese only reaches the app when the i18n merge runs, so the top bar still reads "Jump to a page…" until then. The other keys are a WP-91 request.
6. **Three unowned scripts point at deleted files (low) — confirmed, moved to Requests (INT-13).** This includes `scripts/job-search-harness.mjs:15`.
7. **GoApply phone-only accounts see a placeholder address (low) — interim fix in my files, plus a request to INT-01.**
   - The Account section hides the Email row for an address ending in `.invalid`, and the address no longer stands in for the name.
   - The delete modal asks such accounts to type DELETE instead of the address, and sends the stored address itself.
   - The modal also drops the "we will email you a confirmation" line for them.
8. **Unmet "bundle tests and typechecks":** all bundle tests and both typechecks pass. The only failures in the full suite are the two INT-04 tests in point 2.

## Per-item result

1. **No dead ends audit — done.** Web, server and `proxyPaths` parts as before; zero server stubs.
2. **Entry-point checklist — done.** All seven entry points exist, hide with their flag and target real pages.
3. **Ready flips — done.** Table below.
4. **Settings wiring — done.** As before; the page no longer uses the router for sign-out.
5. **Sign-out — done.** Avatar menu, "Sign out everywhere", account deletion and `auth_expired` all forget the device. Photos are not cleared.
6. **HybridShell CTA — done.**
7. **Dead web routes — done, except `hooks/useJobSearch.ts`.** `TailorModal.tsx` still imports it. The palette is on the feed wrapper with an explicit search.
8. **Deprecated billing pieces — done, two files kept.** `AppearanceSection.tsx` and `NotifSection.tsx` still have unowned test importers.

## Flips (each reverts by setting `ready: false` on that entry)

| Entry | Shows when |
|---|---|
| nav `ready`, `cn.ready` | `agent` |
| nav `cn.campus` | `jobs.campusCalendar` |
| nav `cn.referrals` | `cn.referralCodes` |
| nav `extension` | `extension` and a store id |
| nav `invite`, `cn.invite` | `invites` and brand in `INVITE_REWARD_BRANDS` |
| nav `coaching` | `coaching` and a coach roster |
| `SURFACES_READY.assistant` | `copilot` |
| settings `assistant` | `copilot` |
| settings `devices` | `extension` and a store id |
| settings `connections` | `hiringContacts` not `off` |
| settings `referrals` | `invites` and brand in `INVITE_REWARD_BRANDS` |

## Audit table

| Surface | Entry point | Result |
|---|---|---|
| `/jobs`, `/applications`, `/resume`, `/practice`, `/profile`, `/settings`, `/admin` | nav, both brands | ok |
| `/ready` | nav `ready`, `cn.ready` | ok; dark with `agent` off |
| `/campus` | nav `cn.campus` | ok; dark by `jobs.campusCalendar` |
| `/referrals` | nav `cn.referrals` | ok; flag `cn.referralCodes` |
| `/coaching` | nav `coaching` | ok; dark without a roster; off on GoApply |
| `/invite` | nav `invite`, `cn.invite` | ok on RoboApply; GoApply dark until INT-01 |
| `/extension` | nav `extension` | ok; dark until a store id is set |
| Assistant rail, `/assistant` | Topbar Ask | ok; flag `copilot`; fix request INT-04 (tests) |
| `/inbox` | message center | ok |
| `/settings`, `/settings#billing` | AvatarMenu | ok |
| `/jobs/[id]` | ⌘K job hit | ok; only with `jobs.feed`, on an explicit search |
| 15 settings sections | registry | ok; `referrals` blank while loading or failed — fix request INT-01 |
| 11 admin areas | AdminNav | ok |
| Marketing nav and footer | SiteChrome | ok |
| `/jobs/report` | `/jobs` header, Assistant card | ok; flag `competitiveness` |
| `/practice/questions`, `/practice/questions/[company]` | `/practice`, job checklist | ok; flag `interviewBank` |
| `/resume/letters` | resume hub tabs | ok |
| `/browse/*`, VisitorFeed | footer "Popular job lists" | ok; dark by `seo.browse`; 404 on GoApply |
| Server routes | `FEATURE_MOUNTS` | ok, zero stubs |

## Files (all under `/Users/kenny/code/RoboApply/.claude/worktrees/wp-INT-12`)

- **Created:**
  - `components/v3/shell/signOutCleanup.ts`
  - `__tests__/shell/noDeadEnds.test.tsx`, `__tests__/shell/entryPoints.test.tsx`
  - `server/src/features/noStubRoutes.test.ts`
  - `i18n/staging/nav.zh.json` (new this round)
- **Deleted:**
  - `app/(auth)/job-search/page.tsx`
  - `components/job-search/JobSearchWorkspace.tsx`, `JobResultCard.tsx`
  - `scripts/job-search-preview/` (3 files)
  - `components/v3/today/lib.ts`, `components/v3/account/planCatalog.tsx`
  - `__tests__/pages/job-search.test.tsx`, `__tests__/utils/discovery.test.ts`, `__tests__/components/PlanCatalog.test.tsx`
- **Modified this round:**
  - `components/v3/shell/`: `CommandPalette.tsx`, `AvatarMenu.tsx`, `signOutCleanup.ts`, `index.ts`
  - `components/v3/account/`: `deleteAccountModal.tsx`, `format.ts`
  - `components/v3/preferences/sections/IdentitySection.tsx`
  - `app/(auth)/settings/page.tsx`
  - `i18n/staging/nav.en.json`
  - `__tests__/shell/layout.test.tsx`, `__tests__/pages/settings.test.tsx`, `__tests__/components/AvatarMenu.test.tsx`
- **Modified earlier, unchanged this round:**
  - `app/(auth)/layout.tsx`
  - `components/features/settings/`: `SettingsPage.tsx`, `index.ts`, `registry.ts`, `sectionComponents.ts`
  - `components/features/search/`: `SettingsSection.tsx`, `SettingsSection.test.tsx`
  - `components/v3/shell/`: `HybridShell.tsx`, `Sidebar.tsx`, `Topbar.tsx`, `destinations.ts`
  - `components/v3/account/`: `billing.tsx`, `index.ts`
  - `components/v3/preferences/`: `controls.tsx`, `index.ts`
  - `components/v3/preferences/sections/`: `DangerSection.tsx`, `HuntSection.tsx`, `NotifSection.tsx`, `PrivacySection.tsx`, `ResumeSection.tsx`
  - `hooks/`: `useAccount.ts`, `useJobSearch.ts`, `usePreferences.ts`
  - `lib/api/client.ts`, `lib/proxyPaths.ts`
  - `__tests__/shell/`: `helpers.tsx`, `nav.test.tsx`, `settings.test.tsx`
  - `__tests__/lib/`: `clientAuthExpiry.test.ts`, `proxyPaths.test.ts`
  - `__tests__/routeShells/`: `routeShells.test.tsx`, `stubContracts.test.tsx`
- **Unowned edits:** none.

## Tests run

- **Bundle tests plus i18n staging tests:** 23 files, 819 passed. Command: `npx vitest run __tests__/shell __tests__/pages/settings.test.tsx __tests__/components/{AvatarMenu,MobileNav,Sidebar}.test.tsx __tests__/lib/{clientAuthExpiry,proxyPaths}.test.ts __tests__/routeShells __tests__/hooks/useSettingsSection.test.tsx components/features/search server/src/features/noStubRoutes.test.ts __tests__/lib/i18nStaging.test.ts __tests__/scripts/i18nMergeStaging.test.ts __tests__/brand/zhVariants.test.ts __tests__/scripts/checkCopy.test.ts`
- **`npm run typecheck:web`** and **`npm run typecheck:server`:** green.
- **`npm run check`:** all six checks green.
- **`npx vitest run --exclude ".claude/**"`:** 547 of 548 files, 10343 passed, 2 failed. Both failures are the INT-04 rail tests; the server timeouts from the earlier run did not recur.
- Extension not touched.

## Requests

- **INT-04 / orchestrator (blocks gate 4 after merge):** apply the patch named in point 2. It retargets the two pre-flip tests to `{ flags: { copilot: false } }` and drops one `vi.stubEnv('NEXT_PUBLIC_SHOW_ALL_NAV', 'true')`.
- **INT-05 (feed owner):** add a lookup mode to `feed.query` (for example `lookup: true`) that skips the refresh budget, the feed session and the saved-search filters. The palette can then search as you type again.
- **INT-01:**
  - Expose `emailIsPlaceholder` on `/auth/me`; then replace the web-side `.invalid` check in `components/v3/account/format.ts`.
  - `GrowthSettingsSection` renders nothing while loading or on error.
  - Adding `'goapply'` to `INVITE_REWARD_BRANDS` lights `cn.invite` and GoApply `#referrals`.
  - `TwoFactorSettings` is mounted and hides itself until the sign-in gates are wired.
- **Owner of `lib/api/account.ts` and `server/src/roboapply/routes/account.ts`:** the delete modal requires a reason, but `deleteAccount(confirmEmail)` never sends it. Either send and store it or stop requiring it.
- **INT-10 / join J6:** `TailorModal.tsx` still imports `hooks/useJobSearch.ts`; delete the hook with that import.
- **INT-07:** drop the `NotifSection` import from `notifications.test.tsx`, then delete `NotifSection.tsx`.
- **INT-13 / orchestrator:**
  - Delete `scripts/job-search-preview.mjs` and the `jobSearchPreview` branch in `scripts/design-preview.mjs` (lines 24 and 56–57).
  - Drop `__tests__/pages/job-search.test.tsx` from `scripts/job-search-harness.mjs:15`.
  - `__tests__/brand/chrome.test.tsx` imports `AppearanceSection`; drop it, then delete the file.
  - `styles/v3-account.css` `.ra-billing-currency*` rules are dead.
  - `components/job-search/format.ts` is imported only by its test.
- **WP-91 / WP-92:** run the i18n merge and the locale sync for `nav` in the same merge as INT-12, zh and zh-TW first.
- **WP-95/96:** `connections` now appears for every user on both brands and says importing is unavailable. Check the new palette flow and "Signing out…" in a browser at 375 and 1280, light and dark.

## i18n

- **Added to `i18n/staging/nav.en.json` this round:**
  - `nav.signing_out`
  - `nav.settingsNotes.sign_out_failed`
  - `nav.palette.search_jobs`, `.empty_jobs`, `.refresh_limited`
- **Added earlier:**
  - `nav.source.label.user_reports`
  - `nav.jump_aria`, `nav.jump_placeholder`
  - `nav.palette.placeholder_pages`, `.empty_pages`, `.error`
  - `nav.settingsNotes.intent_sub`, `.group_lists`, `.lists_sub`, `.save_failed`
  - `nav.settingsEmpty`
- **Staged Chinese in `i18n/staging/nav.zh.json`:** `nav.jump_aria`, `nav.jump_placeholder`, `nav.palette.placeholder_pages`, `nav.palette.empty_pages`.
- **Obsolete (no code reference left):**
  - `settings.identity.upload_photo`, `.photo_hint`
  - `settings.hunt.intent_sub`, `.group_hard_rules`, `.musthaves_sub`, `.dealbreakers_sub`, and the roughly 50 pre-WP-20 `settings.hunt.*` keys
  - all `settings.notif.*` except what `settings.nav.notif` uses
  - `settings.privacy.*` except `group_blocklist`, `blocked_label`, `blocked_sub`, `reason_byyou`, `remove`, `add_company`, `add_ph`, `add_confirm`
  - `settings.credits.title`, `.unit`, `.note`
  - `settings.billing.*` except what the invoice page uses
  - `settings.plan.*` except `starter`, `growth`, `premium`, `premiumPlus`, `free`
  - `settings.danger.reset_title`, `.reset_desc`, `.reset_btn`, `.title`
  - `settings.profile.title`, `.memberSince`; `settings.usage.recentItem`; `settings.security.title`

## Env vars introduced

None. `extension` and `devices` read the existing `NEXT_PUBLIC_EXT_ID` / `NEXT_PUBLIC_CN_EXT_ID`.

## Known gaps

- A failed "Sign out everywhere" or account deletion leaves this device's push notifications off until the user turns them on again.
- Dead code left in place because it was outside the item list: `components/v3/shell/SettingsRailGroup.tsx`, `hooks/useSettingsSection.ts` and its test, `components/v3/account/usage.tsx`, and unused exports in `sections.tsx`, `security.tsx` and `hooks/useAccount.ts`.
- `PaymentFailedBanner` in the layout adds one `/billing/plan` request per app load on RoboApply.
- Nothing was verified in a browser.