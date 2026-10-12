**INT-08 · status: complete** — all nine items are implemented and all six review findings are fixed. All four gates are green in `/Users/kenny/code/RoboApply/.claude/worktrees/wp-INT-08`; the full suite needed retries because of machine load (see Tests run).

Nothing is committed and nothing was checked in a browser. I did not launch a dev server: this worktree holds one unmerged bundle of thirteen, so "launch the new version" is the orchestrator's step after the merge.

Two joins are needed after merge:
- **Keep flip:** set `KEEP_DECISION_HOLDS = true` in `server/src/features/admin/reports.ts` once INT-05 is in. A guard test fails until it matches the feed.
- **Invite-review audit row:** INT-01 must add the audit write in `server/src/features/growth/routes.ts`. Until then the new "Approved or rejected a held invite reward" filter entry finds no rows.

## Review resolution

1. **Invite console claimed both people were credited (medium)** — fixed.
   - `reviewOutcome(decision, error, status)` now reads the status the server stored: `rewarded` → both credited; `qualified` → friend only; `rejected` → not counted; `pending` → approved, credits still being added; `held` or no status → "That didn't save".
   - The help line now promises only the credits that are due.
   - Deviation from the suggested copy: the friend-only message does not say "10 rewards". The web has no sourced cap value, and `qualified` also happens when the inviter has no profile, so it reads "they have reached this year's limit for invite rewards, or their account has no profile".
2. **Second Keep recorded empty `clearedRules` (medium)** — fixed in `resolveReport`.
   - A restore row now carries the rules flagged now plus the rules every earlier restore of that job cleared (`clearedRuleSet`).
   - Deviation: the review suggested "since the last close". I carry across closes too, because a close does not put the flags back, so the next restore would still see none and drop them. A test covers restore → report → restore → close → restore.
3. **No audit row for invite reviews (low)** — done as far as this bundle owns it. `admin_invite_reward_reviewed` is added to `ADMIN_AUDIT_EVENTS`, `AUDIT_ACTIONS` and the audit labels. The write itself is a request to INT-01.
4. **GoApply count could include closed or flagged jobs (low)** — fixed in `findCandidates`.
   - `closedAt: null` now applies to both brands; the fraud exclusion applies to GoApply.
   - Deviation: the fraud filter is written out in `onboarding/repo.ts` with a parity test against `NOT_FRAUD_FLAGGED`, not imported. Importing the `onboarding-cn` index broke `components/features/resume/server/resumes.hub.test.ts`, and a deep import fails `server/src/features/boundary.test.ts`.
5. **Failed "fill in by hand" showed nothing (low)** — fixed. `CnResumeGate` takes `busy` and `error`; both buttons are disabled while saving and the error shows inside the gate with `role="alert"`. Two tests cover the failure-then-retry and the double-press.
6. **GoApply user stuck at stage `tour` via `/campus` (low)** — fixed. `/onboarding` sends a GoApply user at `tour` to `/onboarding/confirm`, which shows the first-value screen and completes onboarding. The rule is `onboardingIndexTarget` in `components/features/onboarding/flow.ts`. The INT-01 request stays.

**Unmet "D1 / D3 / plain language":** the two D3 statements are corrected by findings 1 and 4. D1 is unchanged: nothing submits or implies auto-apply.

**Unowned edits:** none; every path touched is in the bundle's `owns`.

## Per-item result

1. **#14 audit → `RAAdminAuditLog`** — done. `writeAdminAudit` keeps its signature and never throws. The System panel has an "Admin actions" view.
2. **#15 decisions → `RAJobReview`** — done. Keep, close and restore write one row each; the list shows the latest decision from either source. Keep is not surfaced as final while `KEEP_DECISION_HOLDS` is false.
3. **#13 held invite rewards** — done. `/admin/reports/invites`, linked from `AdminNav` on both brands, now with accurate outcomes.
4. **#16 CN referral moderate audit** — done. One audit row per moderation; an audit failure never fails the decision.
5. **#11 limits copies** — done. Join J3 is the three export lines in the `limits.ts` header plus deleting the marked block and its parity test.
6. **GoApply onboarding seam** — done, with one deliberate deviation.
   - `resume` was not added to `CN_ONBOARDING_STEPS`: INT-12's `__tests__/routeShells/stubContracts.test.tsx` pins that list to six steps. The gate wraps the resume screen in the page instead.
   - Already done before this bundle: the web saved confirm through `PUT /steps/confirm`.
7. **#6 `checkReferralFor` at done** — done. Called softly from `complete()` and `skip()`; a failure only logs.
8. **`feedRankingFor` removal** — done after a zero-importer grep.
9. **#50 stale comment** — done.

## Files

**Created**
- `app/(auth)/admin/reports/invites/page.tsx`
- `components/v3/admin/InviteRewardsConsole.tsx`
- `components/features/onboarding-cn/CnFirstValueScreen.tsx`
- `components/features/onboarding/goapply.test.tsx`
- `lib/api/onboardingCn.ts`
- `server/src/features/onboarding/repo.test.ts` (new this round)

**Modified**
- `server/src/features/admin/`: `audit.ts`, `contract.ts`, `index.ts`, `limits.ts`, `moderation.ts`, `overrides.ts`, `reports.ts`, `routes.ts`, `system.ts`, `__tests__/routes.test.ts`, `__tests__/services.test.ts`
- `server/src/features/cn/referrals/`: `routes.ts`, `routes.test.ts`
- `server/src/features/onboarding/`: `contract.ts`, `defaults.ts`, `index.ts`, `match.ts`, `match.test.ts`, `repo.ts`, `routes.ts`, `routes.test.ts`, `service.ts`, `service.test.ts`
- `server/src/features/onboarding-cn/`: `contract.ts`, `index.ts`, `personalization.ts`, `routes.ts`, `onboardingCn.test.ts`
- `components/v3/admin/`: `AdminNav.tsx`, `ReportsConsole.tsx`, `SystemConsole.tsx`, `console.module.css`, `index.ts`, `__tests__/console.test.tsx`
- `components/features/onboarding/`: `OnboardingStepPage.tsx`, `TourOverlay.tsx`, `flow.ts` (new this round), `steps/MatchingStep.tsx`, `onboarding.test.tsx`
- `components/features/onboarding-cn/`: `api.tsx`, `index.ts`, `types.ts`, `CnResumeGate.tsx`, `__tests__/onboardingCn.test.tsx`
- `app/(onboarding)/onboarding/page.tsx`, `hooks/useAdmin.ts`, `lib/api/admin.ts`, `__tests__/pages/admin.test.tsx`
- `i18n/staging/admin.en.json`, `i18n/staging/onboardingCn.en.json`

**Deleted:** none.

## Tests run

| Command | Result |
|---|---|
| `npx vitest run server/src/features/{admin,cn/referrals,onboarding,onboarding-cn} components/v3/admin components/features/{onboarding,onboarding-cn} __tests__/pages/admin.test.tsx __tests__/contracts` | 21 files, 852 passed, 1 todo |
| `npm run typecheck:server` | clean |
| `npm run typecheck:web` | clean |
| `npm run check` | all six checks clean |
| `npx vitest run --exclude ".claude/**"` | 550 files, 10043 passed, 1 skipped, 25 todo |

The full suite went green on the fifth run after the last code change. The four runs before it failed only on 5–10 second timeouts in files outside this bundle, with machine load averages between 100 and 250 from the parallel bundles; no assertion failed. The files that timed out:
- `server/src/features/auth/legacyAuth.test.ts`
- `server/src/features/legacyPrecedence.test.ts`
- `server/src/roboapply/v2/routes/{index.unmounted,jobs.score,legacyAiGates}.test.ts`
- `server/src/test/areaStubs.test.ts`
- `components/features/practice/__tests__/server/externalRoutes.practice.test.ts`

All of them pass when run on their own.

## Requests

- **Orchestrator (join, INT-05 ↔ INT-08):** after INT-05 merges, set `KEEP_DECISION_HOLDS = true`. After the flip, `admin.console.reports.decisionHelp` is unused.
- **Orchestrator (J3):** follow the header of `server/src/features/admin/limits.ts`.
- **INT-01 (growth owner) — invite review audit:**
  - Where: `createInvitesAdminRouter` `POST /:id/review`, after `reviewReferral` resolves or throws the 409 "approved, credits pending".
  - Call: `writeAdminAudit(createPrismaAuditStore(), { adminId, subjectUserId: inviteeUserId, eventType: ADMIN_AUDIT_EVENTS.inviteRewardReviewed, payload: { referralId, decision, status } })`.
  - `reviewReferral` returns only `{ id, status }`, so the route needs the invitee id from the service.
  - Once written, add "invite reward decisions" to `admin.console.audit.sub`.
- **INT-01 — tour route:** `/auth/me.onboarding.nextRoute` for a GoApply user at `tour` should be `/onboarding/confirm`. Any redirect that uses it still lands on the first-value page, so the app-shell fallback modal on `/jobs` and `/resume` remains the only catch there.
- **INT-05:** re-enrichment should leave out `RAJobReview.clearedRules` of the job's latest `restore` row; that row now always carries the whole cleared set. Optionally export `enrichBudgetKey` from `features/jobs/enrich/index.ts` so the last mirror can go.
- **INT-02:** `createPrismaAuditStore()` now writes `RAAdminAuditLog` with `adminId` and `subjectUserId` as columns. The old `{ profileIdFor, write }` fake still works.
- **INT-07 / INT-12:** optional — mount `TourOverlay` on `/campus`. It is no longer needed for the `/onboarding` entry.
- **INT-11:** `RAAdminAuditLog` has no retention row or data-export decision.
- **INT-10:** the "PDF after a decline" follow-up waits on the upload route's force-local-parser flag.
- **WP-91/92:** translate the keys below.
- **WP-95/96:** browser-check `/admin/reports/invites`, `/admin/system?view=audit`, the GoApply resume gate (including a failed save), confirm → tour → first-value route, and `/onboarding` at stage `tour`.

## i18n keys

**Added (`admin.en.json`)**
- `admin.console.nav.inviteRewards.{title,sub}`
- `admin.console.system.views.audit`
- `admin.console.reports.decisionHelpHolds`
- `admin.console.audit.*`, including `action.admin_invite_reward_reviewed` (new this round)
- `admin.console.inviteRewards.*`, including `outcome.approved_friend_only` and `outcome.not_counted` (new this round)

**Changed text**
- `admin.console.system.sub`
- `admin.console.inviteRewards.help` (this round)
- `onboardingCn.confirm.foundJobs` (en only)

**Obsolete:** none now; `admin.console.reports.decisionHelp` after the Keep flip.

## Env vars introduced

None.

## Known gaps

- Audit rows written to `SeekerActivityLog` before this change are not migrated or listed.
- International scam-flagged jobs still count as onboarding candidates on RoboApply; the review asked for the GoApply exclusion only.
- `rankingModeForUser`, `feedSortFor`, `personalizedChoice` and `rankingModeFor` remain in `onboarding-cn`; the item asked only for `feedRankingFor`.
- GoApply still has a `matching` stage when the feed is off; the screen passes quickly with its search lines marked skipped.
- A role or city label containing a comma cannot be sent to the cn snapshot route, so the panel shows no count.
- The remaining `it.todo` in my test paths is pre-existing and not mine to flip.