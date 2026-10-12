FIX-5 handoff (updated after review). Worktree `/Users/kenny/code/RoboApply/.claude/worktrees/wp-FIX-5`, branch `wp/FIX-5`, nothing committed. 13 of 14 findings are fixed; finding 13 (Stop) is fixed on the server, but the Stop button still does not reach it until the orchestrator adds one wrapper in `lib/api/copilot.ts` (Request 1).

## Review resolution

- **Unfixed: 13, Stop is inert — confirmed, still needs Request 1.** `lib/api/copilot.ts` has no `stopTurn` and is outside my owns. Calling the URL from `hooks/` is not an option: `scripts/check-api-boundary.mjs` (part of `npm run check`) rejects raw `/api/v1/` literals outside `lib/api`. What I did inside my owns so the gap cannot ship unnoticed:
  - `hooks/copilot/stopTurn.ts` warns once in development when the wrapper is missing.
  - `stopTurn.test.ts` has an `it.fails` tripwire that goes red the moment the wrapper exists, with instructions in its title.
  - `rail.test.tsx` now asserts the Stop button calls `requestStopTurn('th_1')`. The POST itself can only be tested once the wrapper exists.
- **Medium: second click shows "Done." while the first apply is running — real, fixed.**
  - Server (`proposals.ts`): an in-process in-flight set; a closed proposal answers `status: 'applying'` until the apply has finished or failed. `listMessages` had the same flaw (it overlaid `applied` on a reload mid-apply) and now keeps such a card `pending`.
  - Client: only `FilterDiffCard` upgrades closed + `applied` to the applied state (`appliedWhenClosed`). `CreditActionCard` shows the closed line and calls new `ctx.refresh` → `chat.refreshCards()`, so the stored result card with its link appears. `MemoryAddCard` shows the closed line.
  - **Deviation from the reviewer:** for `applying` I did not use the neutral line. It says "Ask again for a fresh one", which on a paid action would create a second paid proposal. The card stays open with "This is already being worked on. If nothing shows up in a minute, try again."
- **Medium: Ask on a job page with a conversation under way — real, fixed.** `CopilotRail` passes `pageJobId` to `CopilotThread`. When the chat is about no job or another job, a line above the composer says so with a "New chat about this job" button. The prompt list offers the same button instead of "Open a job". I labelled it "New chat about this job" rather than "Ask about this job" because it replaces the conversation on screen (the old one stays in Chats).
- **Medium: early Stop is lost — real, fixed.** `CopilotService` tracks turns still in their checks (`startingTurns`). A Stop during the checks is noted for that turn only and aborts it before the model is called; the credit is released as `client_aborted`. I did not use the suggested 10-second window, because a Stop pressed just after a turn finished would have killed the next message.
- **Low: apply waits on card bookkeeping — real, fixed.** The card update is given `COUNT_AFTER_WAIT_MS` (4 s) in `applyFilter`, `applyCreditAction` and `applyMemory`, then finishes in the background.
- **Low: retried `updateCards` appends twice — real, fixed.** `syncCards` appends a result card only if its id is not already stored. `store.appendCard` (the conflict path) had the same flaw and is fixed too.
- **Low: rail composer CSS — real, fixed.** The thread takes `margin-bottom: calc(-1 * var(--sp-5))` while the composer is shown (`data-composer`), so the saved-chats and prompt-list views keep the drawer padding. I also added `min-height: calc(100% + var(--sp-5))` so a chat shorter than the rail gets the same spacing; that rule is not browser-verified. For the placeholder, the rail uses a short hint ("Ask a question") and the comment and test wording no longer claim an ellipsis.
- **Low: 8 parallel `scoreJob` reads — real, fixed.** `addedRows` reads the stored fits one after another. The match area has no batch read.
- **Unowned edits:** none.

## Per-finding result

1. **[HIGH] Lost turn / filter-diff card never updates — fixed.**
   - **Root cause:** `saveTurn` and `updateCards` ran on default transaction limits with no retry, the credit release was logged once, and proposals of an unsaved turn stayed `pending`.
   - **Fix:** `COPILOT_TX_OPTIONS` plus `retryTransient` in `store.ts`; `settle()` retries credit release and commit; unsaved-turn proposals are closed and refused (`refuseUnsaved`).
   - **After review:** the in-flight `applying` status, bounded card bookkeeping, and idempotent card append described above.
   - **Tests:** `store.test.ts`, `service.test.ts`, `proposals.test.ts`, `cards.test.tsx`, `copilotHooks.test.ts`.
2. **[MEDIUM] Setup step 2 dead end; empty extension step — fixed.** `completeStep` lets "Check your search" pass when there is nothing to rate; Finish re-checks. The wizard drops the extension step unless `extensionIdFor(brand)` is set.
3. **[MEDIUM] Raw `profile.missing.*` keys — fixed.** New `MissingLabel.tsx`, used in setup step 1 and `KitAnswersPart`.
4. **[MEDIUM] Top-bar Ask has no job context — fixed.** An empty chat takes the job from `/jobs/<id>`. After review, a conversation under way gets the "New chat about this job" offer. Tests in `rail.test.tsx`.
5. **[MEDIUM] Rail reopens as a modal; composer gap — fixed.** `useRailMemory` no longer restores the open state; the floating button hides while a page field has focus; composer CSS as above.
6. **[MEDIUM] Wizard always opens at step 1 — fixed.** The start effect waits for `setup.isSuccess || setup.isError`.
7. **[MEDIUM] `<p>` inside `<p>` — fixed.** `PageHeader` renders `<div class="sub">` for element content.
8. **[MEDIUM] Three different fit results — labelled; partly rejected.** The Assistant already reads the same stored score as the job page. I infer (not reproduced) the numbers were that score at different times plus the tailoring's own before/after. The fit card now says it is a snapshot, with a "See your fit now" link; the kit labels Before/After as the fit at tailoring time.
9. **[MEDIUM] "Wrong job title" ratings ignored — fixed.** `dislikesOf` / `applyDislikes` in the agent `service.ts`. I also made "Company I don't want" exclude that company (same defect, not in the finding); say if you want that reverted.
10. **[MEDIUM] Job-list card contradicts the answer — fixed.** `search_jobs` gains `payListed`; the prompt says the card shows every job returned; rows show the work model.
11. **[MEDIUM] Assistant cannot see added jobs — fixed.** New tool `added_jobs` with stored fit; `search_jobs` with keywords also searches them. After review, fits are read one at a time.
12. **[LOW] Kit file name unstable — fixed.** `kitFileName` mirrors `buildExportFileName` (parity test); the client shows only the server's name.
13. **[LOW] "Stopped." live, full answer saved — server fixed; client not done, needs Request 1.** `POST /copilot/threads/:id/stop` → `CopilotService.stopTurn`; a stopped reply is stored with a `stopped` notice card; an early Stop is honoured.
14. **[LOW] "the company's page" for an aggregator link — fixed.** `isEmployerApplyPage`; otherwise the lead is neutral and names the host.

## Files changed

- `server/src/features/copilot/`: `store.ts`, `CopilotService.ts`, `proposals.ts`, `routes.ts`, `contract.ts`, `types.ts`, `areas.ts`, `prompt.ts`, `tools/jobs.ts`, `tools/registry.ts`, `tools/util.ts`, tests (new `__tests__/store.test.ts`)
- `server/src/features/agent/`: `service.ts`, `stateMachine.ts`, `deps.ts`, `contract.ts`, tests
- `components/features/copilot/`: `CopilotRail.tsx`, `CopilotThread.tsx`, `Cheatsheet.tsx`, `Composer.tsx`, `MessageList.tsx`, `SettingsSection.tsx`, `copilot.module.css`, `cards/{index,types,model,FilterDiffCard,CreditActionCard,MemoryAddCard,FitAnalysisCard,JobListCard}`, tests
- `components/features/agent/`: `SetupWizard.tsx`, `SetupSteps.tsx`, `KitParts.tsx`, `KitReview.tsx`, `fileName.ts`, new `MissingLabel.tsx`, `agent.test.tsx`
- `components/v3/primitives/PageHeader.tsx`
- `hooks/copilot/`: `useRailMemory.ts`, `useProposal.ts`, `useCopilotChat.ts`, `turnState.ts`, `index.ts`, `copilotHooks.test.ts`, new `stopTurn.ts` and `stopTurn.test.ts`
- `i18n/staging/assistant.en.json`, `i18n/staging/ready.en.json`

## Tests run

- `npx vitest run --exclude ".claude/**"`: 586 files, 11895 passed, 1 expected fail (the Stop tripwire), 1 skipped, 10 todo.
- `npm run typecheck:server` and `npx next typegen && npm run typecheck:web`: clean.
- `npm run check`: all six green.
- The three new `proposals.test.ts` tests were run red against the pre-fix code, then green. The other new tests were not run red first.
- Extension not touched. No `next build`, dev server or browser, per the rules.

## Requests

1. **Orchestrator — `lib/api/copilot.ts` (unowned). Stop does not work without this.**
   - Add:
     ```ts
     /** `copilot.stopTurn` — POST /api/v1/roboapply/copilot/threads/:id/stop */
     export function stopTurn(id: string, opts?: CallOptions): Promise<CP.StopTurnResponse> {
       return call<CP.StopTurnResponse>('POST', `/api/v1/roboapply/copilot/threads/${seg(id)}/stop`, opts);
     }
     ```
   - The `TRIPWIRE` test in `hooks/copilot/stopTurn.test.ts` will then go red, by design. In `hooks/copilot/stopTurn.ts`, replace the by-name lookup and the dev warning with `import { stopTurn } from '../../lib/api/copilot'`, and delete the tripwire test.
   - Optionally add `stopTurn` to the `copilotApi` object and the endpoint list in that file's header.
2. **FIX-4** — label `TailorResult`'s Before/After as the fit at tailoring time. Optionally let the resume export take the kit's job for naming; an untailored kit resume downloaded before "Open application" gets no company or job in its name.
3. **FIX-4 / FIX-1** — the floating Ask button can still cover the resume editor's "Next note" when no field is focused; that page needs bottom-right clearance.
4. **FIX-1 / orchestrator (i18n)** — merge and translate the keys below. `assistant.composer.placeholderShort` must stay short in every locale (the rail box is narrow).

## i18n keys

- **assistant (new, first pass):** `cards.applying`, `cards.waitForAnswer`, `cards.notSaved`, `cards.notice.stopped`, `cards.fit.snapshot`, `cards.fit.openJob`, `cards.jobList.workModel.{remote,hybrid,onsite}`, `cards.jobList.addedByYou`, `cheatsheet.needsJob`, `cheatsheet.openJobs`, `tools.added_jobs`
- **assistant (new, this pass):** `cards.inProgress`, `cheatsheet.needsJobHere`, `context.noJob`, `context.otherJob`, `context.askPageJob`, `composer.placeholderShort`
- **ready (new):** `setup.calibrate.later`, `setup.calibrate.laterNote`, `setup.calibrate.noFeed`, `review.resume.fitNote`, `review.open.leadNeutral`, `review.open.host`
- **ready (changed):** `intro.point_open`

## Known gaps

- **Per-process state.** The `applying` status, Stop, early Stop and the unsaved-turn memory live in one server process. On another serverless instance a second click during a running apply is still told `applied`: the filter card would then show "Changes applied" early, while credit and memory cards show the closed line. A cross-instance fix needs a real `applying` proposal state in the database.
- **Background card update.** After the 4 s wait the stored-card update continues after the response; a platform that freezes the function at response time may drop it. The proposal row is still correct, so a reload shows the right status, but the result card may be missing.
- **Nothing was verified in a browser** (both brands, light/dark, 375/1280). The reviewer measured the margin rule in Chromium; my `min-height` addition and Safari/Firefox sticky behaviour are unchecked.
- `added_jobs` rows carry no pay (the import list does not have it); the model is told to use `get_job`.