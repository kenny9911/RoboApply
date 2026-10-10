INT-04 · status: **complete** — all nine items are done and the review is resolved (nine findings fixed in code, one kept as a merge condition). Every gate is green, including the full suite. Nothing committed, pushed, stashed or switched; no schema, DDL or DML; no new dependencies; every changed file is inside the bundle's `owns`.

On the user's request ("launch the new version and let me try out"): this bundle does not launch anything. I started no dev server and did not touch the clone worktree; the changes sit uncommitted in `/Users/kenny/code/RoboApply/.claude/worktrees/wp-INT-04` for the orchestrator to merge and launch.

## Review resolution

1. **Unmet item 5 / inbox-only reminders bypass the gate (medium) — fixed.** The inbox-only branch now loads the person first and drops the fact (`skipped: no_user | other_brand | preference_off`) when there is no live account, the brand differs, or the reminder in-app channel is off. Not done: registered channels (web push, WeChat) still never see these, and inbox-only rows are not deferred by quiet hours — see the INT-07 request.
2. **`bulk()` ignores mode-off hidden entries (low) — fixed.** Hidden ids are answered like a foreign id (`invalid_request` / `not_owner`); nothing is written, no events, no feed signal. Covered in `modeOff.test.ts`, with the `partner_deeplink` counter-case.
3. **Reminder idempotency (low) — fixed, at-most-once.** The ledger row is written as `pending` before the send, then updated with the result, or deleted when deferred.
   - If the result update fails after a send, the row stays and the reminder is not re-sent.
   - If `notifyUser` throws, the row is kept and the run stops. I did not release it as the review suggested: the in-app row is written before the email, so a release could duplicate it and would abort every later run at the same fact.
   - If an inbox-only write fails, the row is released, the run continues, and it retries next hour (new `failed` counter in the result).
4. **`follow_up_due` sent as the "No reply for N days" email (low) — fixed.** The user-set follow-up date is always an inbox sentence (`tracker.followUpDue`, "Your follow-up date for Acme is today."). `followUpReminder` is used only for `no_reply_10d`, so days is always 10 or more.
5. **GoApply inbox-only reminders stored in English (low) — fixed on the server.** The stored title now comes from the server i18n loader: `tracker.inbox.*`, and `tracker.inboxCn.*` for GoApply in Simplified Chinese. One correction to the review: GoApply is not zh-only (its locales are `zh` and `en`), so a GoApply user who chose English gets English.
6. **"Write a cover letter" shown with AI consent off (low) — fixed.** `FilesSent` now requires the flag and `useAiConsent().allowed`, failing closed while unknown. An already attached letter is still listed.
7. **Closed proposal says "Your search changed…" (low) — fixed.** A `proposal_closed` 409 on the filter card shows the neutral `cards.proposalClosed` text and refreshes the saved searches. `filterDiff.conflictClosed` stays for a real version conflict.
8. **`/applications` treats any failed fetch as unknown (low) — fixed.** Only a 404 / `not_found` drops the id from the URL. Any other failure keeps `?entry=`, shows "This application did not load." and a "Try again" button. Tested for a 500, a timeout and offline.
9. **Feed signal awaited with no bound (low) — fixed.** `learn()` waits at most 1.5 s (`FEED_SIGNAL_TIMEOUT_MS`). `bulk()` sends signals deduped, 20 at a time in parallel, and starts no new batch after 3 s.
10. **Sort link on but `/jobs` does not read `?sort=` here (low) — confirmed, kept on.** Item 1(e) requires `sortLink = true`, so this stays a merge condition on INT-06 (see Requests). The cheatsheet sort question now follows the same switch, so rollback is one line: `ACTION_CARD_CAPS.sortLink = false`.

Unowned edits: none.

## Per-item result

1. **Assistant client ↔ server contract — done.**
   - (a) `filter_diff` counts parse `CountView` and render with a source line; unknown shows "—", capped shows "N+". A 409 conflict renders the fresh card from `details.card`.
   - (b) `getNudge()` added; the rail calls it on mount and route change and passes only `nudge.kind` on.
   - (c) `done.content` replaces the streamed text; `save_failed` is retryable; cards read `data.status`; the memory card honours `consentRequired` and the 403.
   - (d) `AssistantOpenRequest` has `resumeId` and `scope`; a resume-scoped chat sends `resumeId` on every turn.
   - (e) `sortLink = true` and the cheatsheet sort question is back.
   - (f) Follow-ups link to `/applications?entry=<entryId>`.
2. **Assistant server seams — done.** The three cross-area reads are one object, `CROSS_AREA_DEFAULTS` in `copilot/areas.ts`. `networkService.createOutreachDraft` exists and `draft_outreach` is an `outreach` credit proposal. `copilotDailyBudgetUsd` is exported. `interview_prep` passes `{ write: true }` when the model sets `generate`. Confirmed: the 12-month purge exists as retention rule `assistant_messages` in `compliance/retention.ts`.
3. **People `companyName` — done.** Written at import, manual add and contacts sync; shown in a "People you imported" list under `/settings#connections`. `FollowUpDraftButton` was already exported.
4. **Tracker writers — done.** All six writers take the `trackerEntryLockKey` advisory lock and re-read inside the transaction. Tracker moves carry `payload.via = 'tracker'`. `recordInteraction` runs once per change, softly and time-bounded. `markApplied` returns `alreadyApplied`.
5. **Tracker reminders via `notifyUser` — done.** Deferred is retried, skipped is dropped, and inbox rows carry `tracker.followUp` / `tracker.interview`. Inbox-only facts now honour the same person, brand and in-app preference rules.
6. **Mode-off tracker readers — done.** `modeOff.test.ts` covers every reader and now `bulk`.
7. **Tracker drawer mounts — done.** `TailorButton`, `FollowUpDraftButton`, a resume download that passes `trackerEntryId`, and cover-letter rows. "Practice for this job" was already mounted.
8. **`/applications?entry=` — done.** Opening was already there; an unknown id is ignored with one line; a load failure keeps the link and offers a retry. The stale "four rungs" comment is corrected.
9. **Tracker CSV words in the i18n loader — done.** `tracker.csv.*` for any locale, `tracker.csvCn.*` for GoApply's ladder.

## Decisions to review

- **Reminders are at-most-once.** A crash between the ledger write and the send loses that one reminder instead of risking a duplicate. A deferred reminder whose ledger row cannot be deleted (after one retry) is also lost and logged.
- **Inbox-only reminders are written during quiet hours.** They are a silent message-center row, with no email or push.
- **Extension channel skips the tracker's feed signal.** `features/extension/service.ts` already records its own, so the tracker skips it to avoid a double count.
- **Small job counts are shown exactly,** with a source line that does not repeat N.
- **Inbox key is relabelled after delivery.** `notifyUser` stores the email template key, so the producer updates the row's `templateKey` afterwards (soft-fail).
- **Mode off hides, never deletes.** Hidden entries return when the mode allows postings.
- **GoApply Simplified Chinese strings live in `tracker.en.json`** (`csvCn`, `inboxCn`), because the loader only merges `staging/*.en.json`.

## Files

**Created**
- `server/src/i18n/email/staging/tracker.en.json`
- `server/src/features/tracker/csv.test.ts`
- `server/src/features/tracker/modeOff.test.ts`
- `hooks/copilot/useServerNudge.ts`
- `components/features/network/ConnectionsList.tsx`
- `components/features/tracker/ResumeForApplication.tsx`

**Modified — server**
- `server/src/features/copilot/`: `areas.ts`, `contract.ts`, `index.ts`, `proposals.ts`, `types.ts`, `tools/actions.ts`, `__tests__/{areaFakes.ts,tools.test.ts,proposals.test.ts}`
- `server/src/features/network/`: `index.ts`, `service.ts`, `store.ts`, `contactsSync.ts`, `testkit.ts`, `connectionsCsv.test.ts`, `contactsSync.test.ts`, `service.test.ts`
- `server/src/features/tracker/`: `service.ts`, `reminders.ts`, `csv.ts`, `contract.ts`, `index.ts`, `routes.ts`, `service.test.ts`, `reminders.test.ts`, `facts.test.ts`, `routes.test.ts`

**Modified — web**
- `lib/api/copilot.ts`, `hooks/shared/useOpenAssistant.ts`
- `hooks/copilot/`: `index.ts`, `nudges.ts`, `turnState.ts`, `useCopilotChat.ts`, `useCopilotAvailability.ts`, `useProposal.ts`, `streamTurn.test.ts`, `copilotHooks.test.ts`
- `hooks/network/useNetwork.ts`, `hooks/tracker/useTracker.ts`
- `components/features/copilot/`: `CopilotRail.tsx`, `CopilotThread.tsx`, `MessageList.tsx`, `Cheatsheet.tsx`, `cards/{model.ts,index.tsx,FilterDiffCard.tsx,CreditActionCard.tsx,MemoryAddCard.tsx,ActionCard.tsx,ApplicationsCard.tsx}`, `__tests__/{cards.test.tsx,rail.test.tsx,wireCards.ts}`
- `components/features/network/`: `ConnectionsImport.tsx`, `index.ts`, `network.test.tsx`
- `components/features/tracker/`: `TrackerDrawer.tsx`, `index.ts`, `tracker.test.tsx`
- `app/(auth)/applications/page.tsx`, `__tests__/pages/applications.test.tsx`
- `i18n/staging/{assistant,people,applications}.en.json`

**Deleted:** none.

## Tests

- `npm run typecheck:server` and `npm run typecheck:web`: clean.
- `npm run check`: all six checks clean.
- Bundle paths: **46 files, 1264 passed, 4 todo.**
  `npx vitest run server/src/features/copilot server/src/features/network server/src/features/tracker server/src/features/cn/tracker server/src/features/cn/jobs server/src/platform/email components/features/copilot components/features/network components/features/tracker components/features/offers hooks/copilot hooks/tracker __tests__/pages/applications.test.tsx __tests__/contracts`
- `npx vitest run --exclude ".claude/**"`: **550 files, 10086 passed, 1 skipped, 26 todo**, run after the final edit. The earlier load timeouts did not recur.
- No test touches the network or a database. `extension/` was not touched.

## Requests

- **Orchestrator — merge condition:** merge INT-04 only together with INT-06's `/jobs` `?sort=` reader, and add a gate check that `/jobs?sort=newest` selects that order. If INT-06 slips, set `ACTION_CARD_CAPS.sortLink = false` in `components/features/copilot/cards/ActionCard.tsx`.
- **INT-06:** make `/jobs` read `?sort=<FeedSort>` in the same merge. `/jobs/added?import=<importId>` is unchanged.
- **INT-07:**
  - add an in-app-only mode to `notifyUser` (no email template needed), so the tracker's inbox-only reminders go through the same call and reach web push and WeChat; the local person/preference check in `tracker/reminders.ts` can then go;
  - add `inAppTemplateKey` to `NotifyUserInput`, so the post-delivery relabel can go;
  - add a `dedupeKey` to `NotifyUserInput` (the tracker would pass `tracker.reminder:<entryId>:<key>`);
  - add `inbox.templates.tracker.followUpDue` (`{company}`) and `inbox.templates.tracker.deadline` (`{company}`, `{days}`) to `i18n/staging/inbox.en.json`. This is no longer blocking: the stored sentence is already localized.
- **INT-03:** drop the extension service's own `recordInteraction` calls for save and "I submitted"; the tracker's extension skip can then go. `trackerService.markApplied` now returns `alreadyApplied`.
- **INT-05:** keep the lock key format `ra_tracker_entry:<userId>:<jobId>` (`tracker/service.ts` loads `trackerEntryLockKey` lazily from `jobs/detail/index.js`). Optional: `countView` could drop `sampleSize` for exact counts.
- **INT-08:** `copilotDailyBudgetUsd` and `DEFAULT_COPILOT_DAILY_BUDGET_USD` are exported from `features/copilot/index.ts` for J3.
- **INT-09:** `interview_prep` now calls `prepService.planForJob(userId, jobId, locale, { write: true })` when the model sets `generate`; it relies on the Prisma-backed job-set index.
- **INT-10:** confirm `/resume/<id>/check?issue=<id>` focuses the issue. The drawer imports `DownloadModal` from `components/v3/resume-editor/DownloadModal` and `coverLetterHref` / `newCoverLetterHref` from `components/features/coverletter/links`.
- **INT-13:** legacy `/v2/jobs/:id/apply` in `roboapply/v2/routes/jobs.ts` still answers `{ trackerEntry }` without `alreadyApplied`.
- **Orchestrator joins:**
  - J1/J2: swap entries of `CROSS_AREA_DEFAULTS` in `copilot/areas.ts`, then delete `salaryStats.ts`, `createPrismaNudgeSignals` and `store.primaryResumeId`; update the allow-list in the tools test "the only direct Prisma reads…".
  - J7: `ResumeAssistantRequest` in `EditorTools.tsx` can be dropped.
  - J8: `server/src/features/tracker/modeOff.test.ts` exists.
- **`i18n/staging/clean.remove.json` (unowned):** add the obsolete keys below if they ever reached `i18n/messages`. They were staging-only when I checked.
- **WP-92:** translate `tracker.inbox.*` and `tracker.csv.*` in the server email bundles for zh-TW and the other locales.

## i18n keys

**Added — `assistant`**
- `context.resume`, `errors.save_failed`, `cheatsheet.groups.find.sort`
- `cards.proposalClosed`
- `cards.filterDiff.{countNow,countAfter,showCapped,conflictClosed}`
- `cards.credit.outreach.{open,kept}`
- `cards.memory.{consentNeeded,full}`

**Added — `people`:** `settings.list.{title,private,role,more,loadingMore,error}`

**Added — `applications`:** `drawer.{next_steps,download_resume,letter_attached,letter_open,letter_none,letter_write,file_letter}`, plus new in this pass `drawer.{entry_load_error,entry_retry}`

**Added — server `tracker`**
- `tracker.csv.{header,stage,outcome}.*` and `tracker.csvCn.{header,stage,outcome}.*`
- new in this pass: `tracker.inbox.{unnamed,noReply,followUpDue,interview,deadline}` and `tracker.inboxCn.{unnamed,noReply,followUpDue,interview,deadline}`

**Obsoleted:** `assistant.cards.filterDiff.count`; `applications.reminders.{no_reply,follow_up_due,interview_tomorrow,deadline_soon}`.

Kept as asked: `applications.follow_up.{write_cta,grounding,open_mail}`.

## Env vars introduced

None.

## Known gaps

- Nothing was viewed in a browser (375 / 1280 px, light / dark, both brands), per the gate rules. New UI to check: the drawer's "Next steps" row and cover-letter rows, the filter-diff count lines and closed text, the outreach draft block, the "About this resume" label, the connections list, and the "did not load / Try again" line on `/applications`.
- The Assistant sort link depends on INT-06 (see the merge condition).
- The default `loadPerson` reader in `reminders.ts` (alerts recipient and preference repos over Prisma) is exercised only through an injected fake.
- RoboApply zh, zh-TW and other non-English locales read English for the stored inbox-only sentences and the CSV export until WP-91/92 translate them.
- The outreach draft text is returned to the confirming click only. After a reload the card says the draft is on the job's People tab and links there.
- The legacy `/v2/tracker` router answers its own 404 shape for a hidden entry. It is covered at the service seam, not over HTTP, because that router is outside this bundle.