FIX-2 · handoff (after review)

Every review finding is resolved in `/Users/kenny/code/RoboApply/.claude/worktrees/wp-FIX-2` (branch `wp/FIX-2`, nothing committed), but the full test suite is not green: 6 tests in `__tests__/pages/settings.test.tsx` fail. That file is outside my owns, so I reverted my edit as instructed; its old assertions contradict fixes 6, 11 and 15. With the patch under Requests applied, the file passes 31/31 and the suite is fully green. Nothing was checked in a browser or on a production build.

## Review resolution

1. **[high] Tour lost on first arrival — fixed.**
   - Root cause as the reviewer described: the shell notes the page view in its own effect, after its children have already asked.
   - Fix in `lib/ui/popupGate.ts`: `usePopupGate` now notes its own pathname before it asks, so the shell's later call is a no-op. A route change alone does not make a mounted prompt ask again.
   - Tests: `lib/ui/popupGate.test.tsx` has 5 new cases that keep the shell's real effect order (plain and Strict Mode). New `components/features/onboarding/shellOrder.test.tsx` runs `TourOverlay` with the real gate. All 8 fail with the fix line removed.
2. **[medium] Finish banner missing on in-app return to /jobs — fixed** by the same change. `shellOrder.test.tsx` covers a warm-cache route change into `/jobs`, and leaving and returning.
3. **[medium] No-resume heading used the wrong count — fixed.**
   - `match.ts` now stores `searchCount` / `searchCountCapped`: the feed's own count for the default saved search, asked after the search is written and only when no resume was compared.
   - `ConfirmStep` uses only that number for "N jobs for your search". If it was not counted, the heading is "Your search is saved. Check these details." with no number.
   - The "these are open jobs" note no longer shows under a zero.
   - With every step skipped the heading now reads "We found 1,586 jobs for your search", never called a fit.
   - Tests: 6 new in `match.test.ts`; 5 new or rewritten in `onboarding.test.tsx`.
4. **[low] Korean heading spacing — fixed.** New `joinTitleTail` for the Account and Delete headings attaches the third part unless it starts with a Latin letter or digit; the search heading keeps `joinTitle`. A test checks all three headings in all nine bundles.
5. **[low] Confirmation word depended on a loader that does not exist — fixed inside this group.** Both danger dialogs now read the new key `accountV2.prefs.danger.confirmKeyword` (en `DELETE`, staged zh `删除`). The merge dry run shows it goes straight into `zh.json`, with 0 brand overrides. `settings.zh.json` is deleted. A test renders the delete dialog in Chinese for a phone account: it asks for 删除, refuses DELETE, and sends the stored address.
6. **[low] GoApply strings staged in English only — fixed.** `accountV2.zh.json` now carries Chinese for every staged `accountV2` key; a test asserts none falls back to English.
7. **Finding 7 (title typeahead), judged partly fixed — verified, no further change possible here.** `taxonomy.v1.json` has only `en` and `zh` labels, and `taxonomyLabel` returns English for every locale but `zh`. Role names in zh-TW/ja and Japanese input need taxonomy data (Requests → FIX-3).
8. **Unowned edit — reverted.** `__tests__/pages/settings.test.tsx` is back to its committed content; the change is under Requests → Orchestrator.

## Per-finding result

1. **[HIGH] 'Anywhere in {country}' zero-radius row — fixed.** One country now sets only `country`, with no location row. Test in `mapping.test.ts`.
2. **[HIGH] Confirm headline — fixed.** The heading shows one stored number:
   - Resume compared: the Good-fit-or-better count, with "out of the M jobs we compared".
   - No resume: the saved search's own size (`searchCount`), never called a fit.
   - Not counted: no number.
   - Still running: no number.
3. **[HIGH] First-visit tour — fixed.** Two causes: the Strict Mode double request (a popup is its key) and the effect order with the shell (the hook notes its page view first).
4. **[MEDIUM] Background match overwrote the edited search — fixed with a guard; never reproduced.** Only a live request at stage `matching` or `confirm` writes the saved search.
5. **[MEDIUM] Profile 0% after onboarding — fixed.** `profileService.prefillFromResume` fills empty fields only when the resume step is saved; no model call.
6. **[MEDIUM] Settings › Account — fixed.** Name is the account name and editable; years 0 reads "Not set"; a bad LinkedIn value blocks Save; pronoun options come from the bundle.
7. **[MEDIUM] Title typeahead — partly fixed.** Traditional-Chinese input is also searched in its Simplified reading, and categories and role groups are named from the web bundle. Role names in zh-TW/ja and Japanese input are not done; they need taxonomy data (FIX-3).
8. **[MEDIUM] Two floating prompts — fixed.** The finish banner takes the page view's slot at the gate, and now also shows on in-app navigation.
9. **[MEDIUM] PDF before the consent answer — fixed.** The message names the real case (unanswered, not loadable, declined).
10. **[MEDIUM] `/auth/me` token fields — fixed.** `publicUserOf` builds `data.user` from an allowlist on `/me`, signup, login and login/2fa.
11. **[MEDIUM] Account deletion (GoApply) — fixed.** No Reason box; the email promise shows only with a real address and `notify.email` on; no raw provider id; the confirmation word is 删除 in Chinese.
12. **[LOW] Validation errors stay — fixed.** Messages follow the current field values.
13. **[LOW] Heading spacing and nav overflow — fixed,** including the Korean endings. The 621 px page width at 375 is the topbar (FIX-1).
14. **[LOW] Truncated reset/verify links — fixed.** Each shows a "link is not valid" message with a way to get a new one.
15. **[LOW] Invite section "did not load" — fixed.** The section shows loading, an error with "Try again", or unavailable.
16. **[LOW] Snapshot skills lower-case — fixed.** `displaySkill()` changes casing only.
17. **[LOW] Auth polish — fixed, except the analytics banner overlap** (Requests → FIX-8).

## Files changed

- **Server**
  - `server/src/features/onboarding/`: `mapping.ts`, `match.ts`, `contract.ts`, `defaults.ts`, `service.ts`, `repo.ts`, `snapshot.ts`, `zhFold.ts` (new)
  - `server/src/features/profile/service.ts`
  - `server/src/roboapply/routes/auth.ts`
- **Web**
  - `lib/ui/popupGate.ts`
  - `components/features/onboarding/`: `FirstVisitPrompts.tsx`, `OnboardingStepPage.tsx`, `steps/{BasicsStep,ConfirmStep,PreferencesStep,ResumeStep,TitlePicker}.tsx`
  - `components/features/auth/{PasswordResetViews,VerifyEmailView}.tsx`
  - `components/auth/{AuthShell.tsx,methods/EmailMethod.tsx}`
  - `components/features/growth/SettingsSection.tsx`
  - `components/v3/preferences/{controls.tsx,WipeDataModal.tsx,sections/{Identity,Danger,Hunt}Section.tsx}`
  - `components/v3/account/{deleteAccountModal,security}.tsx`
  - `app/(auth)/settings/page.tsx`
  - `styles/v3-preferences.css`
- **i18n staging**
  - `accountV2.en.json`, `auth.en.json`, `onboarding.en.json`
  - `accountV2.zh.json`, `auth.zh.json` (new)
  - `settings.zh.json` removed
- **Tests, new**
  - `lib/ui/popupGate.test.tsx`
  - `components/features/onboarding/shellOrder.test.tsx`
  - `server/src/features/onboarding/zhFold.test.ts`
  - `server/src/roboapply/routes/auth.publicUser.test.ts`
  - `app/(auth)/settings/account.test.tsx`
  - `components/auth/AuthShell.test.tsx`
  - `components/features/settings/SettingsPage.test.tsx`
- **Tests, extended**
  - onboarding `mapping` / `match` / `service` tests, `profile/routes.test.ts`
  - `onboarding.test.tsx`, `tour.test.tsx`, `goapply.test.tsx`
  - `auth.test.tsx`, `callback.test.tsx`, `invite.test.tsx`
- **Outside my owns:** none.

## Tests run

- `npx vitest run --exclude ".claude/**"`: 591 files; 11,906 passed, 6 failed, 1 skipped, 10 todo. All 6 failures are in `__tests__/pages/settings.test.tsx`.
- Same file with the Requests patch applied: 31/31 (checked, then restored).
- `npm run typecheck:server`: clean.
- `npx next typegen && npm run typecheck:web`: clean.
- `npm run check`: all six checks clean.
- `node scripts/i18n-merge-staging.mjs --dry-run`: valid; 21 new keys, 0 changed; 13 zh keys go to `zh.json`, 0 to brand overrides.
- Extension not touched.

## Requests

- **Orchestrator**
  - **Apply the test patch to `__tests__/pages/settings.test.tsx`.** It is saved at `/private/tmp/claude-501/-Users-kenny-code-RoboApply/ca326177-3056-45db-a2e4-d92af4c9efdb/scratchpad/FIX-2-settings.test.patch` (`git apply` from the worktree root). It makes four edits:
    1. Replace the `#referrals` test "a section whose area renders nothing…" with one that expects `invite-settings-error` to contain "We couldn't load your invites." and a "Try again" button, and no `settings-section-empty` (timeout 15 s).
    2. In `fillDeleteAccount`, replace the line that types into the placeholder "Tell us why you are leaving (required)" with `expect(within(modal).queryByText('Reason')).toBeNull();`.
    3. In the GoApply phone-account test, delete the line that types into that same placeholder.
    4. In "the dead controls are gone", change `expect(name).toHaveAttribute('readonly')` to `expect(name).not.toHaveAttribute('readonly')`.
  - Merge and translate staging. For `accountV2.prefs.danger.confirmKeyword`, use the word each locale already types today: de `LÖSCHEN`, es `BORRAR`, fr `SUPPRIMER`, pt `APAGAR`; and zh-TW `刪除`, ja `削除`, ko `삭제`. Until that pass, de/es/fr/pt show `DELETE` in both danger dialogs (hint and check agree).
  - `server/src/services/AuthService.ts` `buildPublicUser`: drop token, expiry, `providerId` and Stripe columns at the source.
  - `server/src/roboapply/v2/services/RAPreferencesService.ts`: validate `links.linkedin` server-side.
  - `server/src/roboapply/routes/account.ts` `POST /delete`: accept an optional `reason` if product wants the field back.
- **FIX-1 (bundles)**
  - Remove unused keys in all nine bundles: `settings.identity.new_grad`, `settings.danger.reasonLabel`, `settings.danger.reasonPlaceholder`, `settings.danger.error.reasonRequired`, and `settings.danger.delete_data_confirm_keyword` once the new key is translated.
  - Replace the three-part settings headings with one `title` key per section, so translators own the spacing.
- **FIX-3**
  - `feed/sql.ts` `locationSql`: read a row with a country, no city and `radiusKm` 0 as the whole country. Onboarding still writes such rows when two or more countries are picked.
  - Taxonomy: add zh-Hant and ja labels and synonyms to `taxonomy.v1.json`, return them from `taxonomyLabel(id, locale)`, index them in `searchTaxonomy`.
  - `POST /search-profiles/count` silently ignores `fitTier`; reject it or document it.
- **FIX-4**
  - `hooks/resume/useResumeTour.ts` calls `requestPopup` directly in a mount effect, so it has the same effect-order race on in-app navigation to `/resume`. Switch it to `usePopupGate`, or call `notePageView(pathname)` before the request.
- **FIX-8**
  - The analytics banner overlaps "Already have an account? Sign in" at 1280×900.

## i18n keys added (none changed)

- **`accountV2.prefs.identity`:** `name_ph`, `name_save_failed`, `pronouns_she`, `pronouns_he`, `pronouns_they`, `years_unset`, `linkedin_invalid`
- **`accountV2.prefs.danger`:** `confirmKeyword`, `signedOutNow`
- **`accountV2.prefs.security`:** `phoneNote`, `wechatNote`, `otherNote`
- **`auth`:** `verify.requestNew`, `brand.feature_interview_written`
- **`onboarding.confirm`:** `titleSearch`, `titleSearchCapped`, `titleSearchNone`, `titleUncounted`, `searchNote`, `countNoteCompared`
- **`onboarding.resume.errors`:** `consentUnanswered`
- **Staged zh:** all twelve `accountV2.prefs` keys above, plus `auth.brand.feature_interview_written`

## Known gaps

- Match results stored before this change have no `searchCount`, so a no-resume user mid-setup sees "Your search is saved" with no number until "Finding jobs" runs again.
- The tour is an essential popup at announcement priority; a survey, extension prompt or offer asking in the same 50 ms can still take the page view, and the tour then shows on the next visit to `/jobs`. That priority rule is unchanged.
- Finding 4 was never reproduced; the guard removes the only writer a queued run had.
- Accounts that finished onboarding before this change keep an empty profile; there is no backfill.
- Role names in zh-TW/ja stay English, and Japanese input finds nothing, until the taxonomy data arrives.
- New strings render in English outside en and zh until the translation pass.
- The `zhFold` character table covers only the characters the taxonomy's Chinese phrases use.
- "Change password" and "Send code" measured about 1.0 contrast in the 375 px QA log; not in my findings, untouched.