FIX-6 handoff (after review) — all three findings stay fixed and every review finding is resolved or moved to Requests. One gate is red by instruction: reverting the unowned page test leaves 1 failing test in the full suite, because that test asserts the unaffordable default that finding 3 calls a bug. Nothing was run in a browser (per the rules), so visual fixes are checked by tests and CSS reasoning only.

## Review resolution

1. **[medium] Interviewer markdown inline-only — fixed.** Confirmed. Interviewer lines, questions and hints now render through `Markdown block` inside a `<div>`, with no manual blank-line split.
   - A fenced block with a blank line stays one `<pre>`, lists keep their markers, and nothing block-level sits inside a `<p>`.
   - Code blocks wrap (`pre-wrap`, `overflow-x: auto`, `max-width: 100%`), and the turn list and card columns are `minmax(0, 1fr)`, so a long code line cannot widen the bubble at 375px.
   - The reviewer's `> :last-child { margin-bottom: 0 }` needs `!important`, because the primitive sets its margins inline; the report page already does the same.
   - Bold inside the 600-weight question gets a 700 step (also `!important`), since block mode pins bold to 600.
   - The user's own turn now has `white-space: pre-wrap`.
   - Test: `keeps a code block whole and a numbered list numbered`.
2. **[low] New strings English on GoApply until the merge — not fixable in my owns; moved to Requests.** Confirmed: `lib/i18n.ts` merges only staged English at runtime, and I own no `practice.zh.json` staging file.
3. **[low] Re-sent answer counted as a second answered question — fixed.** Confirmed. `scorerInput` now files each answer under the planned question in front of it and counts distinct questions.
   - An identical re-send is dropped, along with the repeated question.
   - Different answers to one question are scored as one answer, so the scorer's "n of total" stays right.
   - The GoApply report block reads the same cleaned transcript, so a retried answer's filler words count once.
   - Tests: 5 new, including a re-send plus one skip, a re-send plus four skips, and "a re-send scores the same as a single send".
4. **[low] One answer of five scores 74 — fixed, slightly beyond the suggestion.** Confirmed (74 reproduced). When the count of unanswered questions is known, overall = mean × (0.4 + 0.6 × coverage); per-dimension values are unscaled.
   - Measured for a zh session at difficulty 4: 88 / 74 / 62 / 50 / 39 for 0–4 skips.
   - My addition: when fewer than half the questions were answered, the summary (also the session note) is the skip-count line, and strengths fall back to the neutral line. Otherwise a 39 still read "a solid rep" and "on most answers".
   - Voice sessions pass no count and are unchanged (tested).
5. **[low] Written-practice prefix takes 469 of 2,000 characters — fixed.** Confirmed against `RAMockInterviewerAgent.ts:241,253`. The brief prefix is now one 146-character sentence. The type note is 95 characters, so note + the longest type description (103) fits the 200-character clip.
   - Tests: the note fits for every catalog type on both markets; an 1,800-character session brief keeps its closing format line after the cut.
6. **[low] Korean `strengthFallback` says "written" — fixed.** Now `답변하신 내용은 여기서부터 쌓아갈 수 있는 기반입니다.` A test checks all nine locales for medium-specific wording when called the way the voice engine calls it.
7. **Unowned edit `__tests__/pages/practice.test.tsx` — reverted** (that path only); the need is in Requests.

## Per-finding result

### 1. [MEDIUM] English / untrue report text, STT wording in a typed session — fixed
- **Root cause:** `RAMockService` carried its own English-only scorer that split on whitespace (a Chinese answer was "one word") and never saw skips, because empty turns are dropped on read. `CnReportView` always printed the speech-to-text note.
- **Fix:**
  - `RAMockService.score` calls the engine's `scoreTranscript` in the session language with the unanswered count.
  - Skips lower completeness, get their own Role-fit note in nine locales, are always a gap and never a strength.
  - Nothing answered returns 0 and the room shows "—".
  - A non-English canned turn is just the next question.
  - `CnReportView` takes `typed`.
- **After review:** distinct-question counting, coverage scaling and the Korean wording (items 3, 4, 6 above).
- **Tests:** `interviewScorer.test.ts` (14), `RAMockService.written.test.ts` (17), `CnReport.test.tsx`, `TextPracticeRoom.test.tsx`.

### 2. [MEDIUM] Video/Voice offered on GoApply text practice; raw `**bold**`; voice-only wording — fixed
- **Root cause:** the Format tray had no capability gate; turn text is markdown by contract but was rendered as plain text; the model was never told the practice is typed.
- **Fix:**
  - `PracticeSetupFlow` takes `formatChoice` (the page passes `setup.voice.available`).
  - AI text renders as block markdown; typed answers stay literal.
  - A written-practice note leads the type line and every turn's brief.
- **Tests:** `practicePage.test.tsx`, `TextPracticeRoom.test.tsx` (14), `RAMockService.written.test.ts`.
- The interviewer's wording is model output, so it is steered, not guaranteed.

### 3. [LOW] Unaffordable default length, "1 credits left", dead-end "get credits" — fixed, one part partly rejected
- **Fix:**
  - The default length is the type's own when affordable, otherwise the longest affordable one (`defaultPracticeMinutes`).
  - The verify-email banner shows only when no length is affordable or after a 402.
  - Four English strings are ICU plurals.
  - "Get credits" shows only when something is on sale; otherwise a new no-link sentence.
- **Partly rejected:** the 375px chip row is a deliberate horizontal scroller, not page overflow. The real defect was missing `scroll-padding-inline` on the three snap rows, now added.
- **Tests:** `lib/mockInterviewCredits.test.ts` (5), `practicePage.test.tsx`.

## Files changed
All under `/Users/kenny/code/RoboApply/.claude/worktrees/wp-FIX-6/`:
- `server/src/roboapply/v2/services/RAMockService.ts`, `RAMockService.written.test.ts` (new)
- `server/src/interview-engine/scoring/interviewScorer.ts`, `interviewScorer.test.ts` (new)
- `app/(auth)/practice/page.tsx`
- `components/v3/mock/PracticeSetupFlow.tsx`, `PracticeSetupFlow.module.css`, `index.ts`
- `components/features/practice/TextPracticeRoom.tsx`, `practice.module.css`, `setupNotices.ts` (comment only)
- `components/features/practice/__tests__/TextPracticeRoom.test.tsx`, `practicePage.test.tsx`
- `components/features/practice-cn/CnReportView.tsx`, `index.ts`, `__tests__/CnReport.test.tsx`, `__tests__/practiceSetupCn.test.tsx`
- `lib/mockInterviewCredits.ts`, `lib/mockInterviewCredits.test.ts` (new)
- `i18n/staging/practice.en.json`, `practiceCn.en.json`, `practiceCn.zh.json`

No unowned path is modified.

## Tests run
- `npx vitest run --exclude ".claude/**"`: 587 files, 11,863 passed, **1 failed**, 1 skipped, 10 todo. The failure is `__tests__/pages/practice.test.tsx > uses the server-authored minutes-per-credit rate…` (see Requests).
- Group tests (practice, practice-cn, credits, scorer, written service): 12 files, 163 passed.
- `npm run typecheck:server`: clean.
- `npx next typegen && npm run typecheck:web`: clean.
- `npm run check`: all six checks clean.
- Extension untouched; its gates were not run.

## Requests

**Orchestrator — apply the page-test patch (blocks the vitest gate)**
- Apply `/private/tmp/claude-501/-Users-kenny-code-RoboApply/ca326177-3056-45db-a2e4-d92af4c9efdb/scratchpad/FIX-6-practice-page-test.patch` to `__tests__/pages/practice.test.tsx`. I applied it temporarily to confirm it passes (6/6), then restored the file.
- What it changes in that one test:
  - render with `{ intlLocale: 'en' }` only, so the staged English is used;
  - after picking Frontend Engineer, expect the length chip to read `15 min`, Start enabled, no alert;
  - then open the chip, pick `50 min`, and expect the existing alert "This interview needs 5 credits and you have 1.5.", Start disabled, and "Use 15 min instead" to re-enable it.

**Orchestrator / FIX-1 — i18n merge (do not ship GoApply before it)**
- `practiceCn.report.fillers.noteTyped`: zh is staged (`根据你输入的回答统计。`); suggested zh-TW `根據你輸入的回答統計。`; the other six locales need translating.
- `practice.setup.insufficientCreditsNoPurchase`: suggested zh `这场面试需要 {required} 个额度，你还有 {balance} 个。`, zh-TW `這場面試需要 {required} 個額度，你還有 {balance} 個。`; the other six need translating.
- The four changed English plural strings need no change in the other eight bundles.

**FIX-1 — native review of server scorer strings**
- In `interviewScorer.ts`: `roleFit.skipped` and `strengthFallback` for zh-TW, ja, ko, es, fr, pt, de. I wrote them; none has had a native read.

**Orchestrator (no group owns `server/src/roboapply/v2/agents/` or `RAInterviewPromptService.ts`)**
- Add a first-class `medium: 'text' | 'voice'` input to the prompt generator and the interviewer agents, then drop `WRITTEN_PRACTICE_TYPE_NOTE` and `WRITTEN_PRACTICE_BRIEF`.
- Owner decision: the Focus chip on GoApply text practice still reads "Live Coding … in a shared editor" (from `raMockCatalog.ts` and `practice.setup.types.technical.*`).
- `components/v3/primitives/Markdown.tsx` sets block spacing and bold weight inline, which is why two `!important` rules were needed; moving those to a stylesheet would remove them.

## i18n keys
- **New:** `practice.setup.insufficientCreditsNoPurchase` (en); `practiceCn.report.fillers.noteTyped` (en + zh).
- **Changed (English only, ICU plural):** `practice.setup.creditCost`, `creditsRemaining`, `insufficientCredits`, `flow.costShort`.
- **Server-side scorer strings** (nine locales, not in the bundles): new `roleFit.skipped`, reworded `strengthFallback` (Korean changed again in this pass), English `roleFit.thin` plural.

## Known gaps
- The overall score in a written practice is no longer the plain mean of the five dimensions when questions were skipped; the Role-fit note is what explains the difference.
- `nextTurn` still stores a re-sent answer twice; only scoring and the GoApply report block de-duplicate it.
- If both question generators fail, `FALLBACK_BANK` still serves English questions in a non-English session.
- Voice sessions do not pass an unanswered count, so "Engaged with every prompt" can still appear there.
- `PracticeReportEnd` still links to the plan sheet at balance 0 regardless of what is on sale; the setup's "Get credits" link still points at `/settings#billing`.
- Report prose follows the interview language, not the UI locale, matching the voice engine.