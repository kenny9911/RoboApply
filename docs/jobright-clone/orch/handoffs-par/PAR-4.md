# PAR-4

Voice and video practice on the shared media plane. Worktree `/Users/kenny/code/RoboApply/.claude/worktrees/wp-PAR-4`, branch `wp/PAR-4`, base `3fa104e` (PAR-1 merged). Nothing committed, pushed or stashed. No schema change, no new dependency, no dev server, no browser, no call to a real provider. This is the handoff after the independent review; the "Review resolution" list is at the end.

Seven of the eight items are done. Item 8 is done in the code this bundle owns, but its last ACCEPT line ("a later phone verification does not grant a second") is **not met end to end**: two grants made at verification time live in PAR-3's files and need requests P3-A and P6-A. PAR-1 requests P4-1 and P4-2 are done, and two of the four carry-over entries.

Every test in a file PAR-4 owns is green (51 files, 736 tests; the worker suite 99 of 99). Both typechecks pass for the whole repository; `npm run check` passes. The full suite has 89 failures: the 84 that were already red at the base in other bundles' files, plus 5 in one PAR-5 file that this bundle turns red (listed below with the new assertions).

**Read first (orchestrator).**
1. **Item 8 needs two changes outside this bundle at merge** (P3-A in PAR-3's files, P6-A in PAR-6's). Until then a GoApply account that verifies an email and later binds a phone gets two free practices.
2. Five tests in `server/src/roboapply/services/SeekerAccountPurgeService.brand.test.ts` (PAR-5) go red at merge. See "Red tests for other bundles".
3. Three places follow the plan text instead of the bundle item text (precedence rule). See "Precedence".
4. Nothing has to be edited at merge for the LLM bundle: `getBlueprintModel` uses PAR-2's `getEnvModelSetting` when that export exists and the plain per-key read when it does not (tested both ways). PAR-2 must keep that export name (P2-A).

## Items

### 1. [P0] GoApply sessions run on the shared LiveKit project when it has no plane of its own (G7, G50, G58, G103): done

`server/src/interview-engine/config.ts`:
- `voiceStack(brand, stack?)` = `brandStack(brand, 'voice')` (always `shared` for RoboApply), or the plane pinned for the current session work (item 2). `voiceEnv` reads a member of the voice group wholly from the plane in use: `CN_NAME` on GoApply's own plane (undefined when unset, never the shared value), `NAME` on the shared one. LiveKit URL, key, secret, `LIVEKIT_AGENT_NAME`, the callback secret, `VOICE_PROVIDER`, the agent name and the callback base URL all go through it.
- `getLiveKitCreds` error text names the variables of the plane in use.
- `explicitCallbackBaseUrl`: shared plane = `INTERVIEW_ENGINE_CALLBACK_BASE_URL ?? BACKEND_PUBLIC_URL ?? PUBLIC_BACKEND_URL` for both brands; own plane = `CN_INTERVIEW_ENGINE_CALLBACK_BASE_URL` only.
- `getAgentCallbackSecrets()` lists each configured secret once.
- `providers/index.ts` `voiceAvailable` keeps its meaning (implemented provider plus credentials of the plane in use), so the drift matrix in `platform/flags.test.ts` still passes.
- **After review:** `routes/practiceGate.ts` offers voice only when the capability is on **and** a voice session can really start (`config.ts` `voiceRoutingProblem(brand)`: the checks `createSession` makes before it persists anything). Otherwise the reason is `voice_unavailable`, the setup offers the written practice, and `POST /practice/sessions` answers the same `503 ai_unavailable / voice_unavailable` body. RoboApply's gate is unchanged.

ACCEPT, tested: GoApply with only `LIVEKIT_*` set: `voiceAvailable('goapply')` is true and `getLiveKitCreds('goapply')` returns the shared credentials. With `CN_LIVEKIT_URL` set and `CN_LIVEKIT_API_KEY` missing it is not configured and throws naming `CN_LIVEKIT_API_KEY, CN_LIVEKIT_API_SECRET`.

Tests: `providers/__tests__/brandConfig.test.ts` (51), `providers/__tests__/providers.test.ts`, `routes/externalRoutes.practice.test.ts` (33), `components/features/practice/__tests__/practicePage.test.tsx`.

### 2. [P0] Dispatch the worker registered on the plane, and pin a session to its plane (G51): done

- `getInterviewAgentName(brand, stack?)`: own plane = `CN_INTERVIEW_ENGINE_AGENT_NAME` or GoApply's registry name; shared plane = `INTERVIEW_ENGINE_AGENT_NAME` or RoboApply's registry name, for both brands.
- `VoiceSeam` gains `stack?: 'own' | 'shared'`, stored in `liveMetrics.voiceSeam` as `{ v: 1, brand, provider, stack }` (no schema change). RoboApply seams and rows are unchanged. A row with no stored plane runs on the plane the environment selects at call time, as before.
- Pinning: `runOnVoiceStack(brand, stack, fn)` (an AsyncLocalStorage in `config.ts`) and `inSeam(seam, fn)` (`providers/brandScope.ts`). Prepare, connect, finalize, end, delete and report all run inside it, so the LiveKit client reads the credentials, agent name, callback secret and base URL of the session's plane for its whole life.

ACCEPT, tested: a GoApply room on the shared project dispatches `RoboApply-Interview` (or the name in `INTERVIEW_ENGINE_AGENT_NAME`), never `GoApply-Interview`. `CN_LIVEKIT_*` added or removed while a session is live does not move it.

Tests: `providers/__tests__/sessionSeam.service.test.ts` (36), `sessions/InterviewSessionService.practice.test.ts`.

### 3. [P0] Webhooks and worker callbacks on a project two brands share (G52, G58): done

- `configuredLiveKitPlanes()`: every configured LiveKit project by API key, with the brands whose new sessions use it. The shared project stays listed when GoApply has its own.
- `livekit/webhookReceiver.ts` `receiveBrandWebhook` returns `{ event, apiKey, brands }`. `InterviewSessionService` `webhookSignerMatches` accepts when the signing key is the key of the session's plane; when that plane can no longer be read, when the signer's brands include the session brand.
- `assertCallbackSecret` checks the secret of the session's plane. `parley/parleySessions.ts` `handleParleyWebhook` runs in the session's brand and plane.

ACCEPT, tested: with both brands on one key, `room_finished` and `egress_ended` for a GoApply session are processed and its callbacks are accepted with the shared secret; a webhook signed with another key is ignored, and a stray `CN_` secret with no plane is refused.

Tests: `livekit/webhookReceiver.test.ts`, `sessionSeam.service.test.ts`, `InterviewSessionService.practice.test.ts`.

### 4. [P1] Speech and interview models fall back to the shared catalog and routing (G3 interview part, G53, G54): done (routing changed after review)

- Speech: `tryGetCnSpeechConfig(brand)` is null unless both CN speech models are set; then every model must be `dashscope/…`. `providers/speech.ts` uses the shared catalog and STT otherwise. `resolveBrandSessionStt` keeps STT in the same set as the session's stored voice.
- **Interview models, after review** (`config.ts` `resolveLiveWorkerModel`): on a gateway worker (the shared plane, or a LiveKit Inference worker on GoApply's own project) the live model is the first of `CN_LLM_INTERVIEW_LIVE_MODEL`, `LLM_INTERVIEW_LIVE_MODEL`, GoApply's interview model, the shared interview model that LiveKit Inference serves. One of GoApply's **own** selectors with no LiveKit Inference equivalent (qwen, kimi, glm, doubao, minimax, deepseek-v4-flash) is passed over, so it never turns voice off: it stays the backend model (plan and report) and the live turns run on the shared interview model. An effort set for a passed-over CN live model is not applied to the shared model. A **shared** selector with no equivalent is still the same 503 for both brands. Only when no shared model is left does the CN selector become the error. `voiceConfigProblems` says which CN variable is not used for live turns.
- On GoApply's own plane with a CN interview model the domestic model is sent as-is (unchanged).
- `CN_LLM_DOMESTIC_ONLY` / `CN_RESIDENCY_STRICT`: the interviewer must be a domestic model on GoApply's own plane. **After review** this no longer shows as a voice option that fails: the gate reports `voice_unavailable`, the written practice is offered, and the reason is logged once.
- `getBlueprintModel`: RoboApply unchanged. GoApply goes through the shared resolver (`getEnvModelSetting('LLM_INTERVIEW_BLUEPRINT_MODEL', brand)`, plan §3.3) when that export exists, else CN value, else the shared one; then its interview task model.
- Worker: no code change. `interview-agent/src/backends/__tests__/backends.test.mjs` has four tests for GoApply sessions on the shared worker and for the refusals of the domestic-only worker.

ACCEPT, tested: a GoApply voice session with only the shared env is created (status `preparing`) with a zh voice from the shared catalog and the shared STT; with the two CN models set the DashScope path is unchanged. Added: `CN_LLM_INTERVIEW_MODEL=qwen/qwen-max` with `LLM_INTERVIEW_MODEL=openai/gpt-5.5` on the shared plane gives backend qwen-max and worker `openai/gpt-5.5`.

Tests: `brandConfig.test.ts`, `providers/__tests__/mergedLlmResolver.test.ts` (new, 6: the same answers with PAR-2's resolver present, including a re-spelled `dashscope/qwen-max` route), `providers.test.ts`, `sessionSeam.service.test.ts`, `backends.test.mjs`.

### 5. [P1] Recordings and transcripts use the shared bucket when GoApply has none (G55): done (strict rule added after review)

- `getR2Creds` reads the storage group through `brandEnv`; one info line per process says which store GoApply uses.
- `getEarlierR2Creds` and `storage/r2Storage.ts` `deleteObject`: once GoApply has its own bucket, deletes also clear the shared bucket for its earlier sessions (keys carry the session id).
- **After review, `CN_RESIDENCY_STRICT`** (plan §4: mainland storage required): `config.ts` `getR2WriteCreds` / `interviewStorageWriteBlocked`, `r2Storage.canStore()`. GoApply under the strict switch without `CN_S3_BUCKET` writes nothing new: no egress upload, no transcript or report file, and the setup says recording is not available. The transcript stays in the database, so the practice and its report work. Reads and deletes still use `getR2Creds`, so earlier recordings in the shared bucket still play and are still deleted on time, and the account purge is not blocked. RoboApply is never affected. `voiceConfigProblems` names it (kind `storage`).

ACCEPT, tested: GoApply with only `S3_*` set: `isR2Configured('goapply')` is true and RoboApply's client is shared; with `CN_S3_BUCKET` and its keys artifacts go to that bucket; an own bucket with a missing key is not configured.

Tests: `storage/r2Storage.test.ts` (16), `features/interview/retention.test.ts` (21), `brandConfig.test.ts`, `sessionSeam.service.test.ts`, `externalRoutes.practice.test.ts`.

### 6. [P1] Camera and video recording behave the same on both brands (G8, G56, G104): done

- `getInterviewMediaPolicy`: `{ cameraPublish: true, recordVideo: true }` for both brands; `{ false, false }` for GoApply only when `CN_INTERVIEW_CAMERA_PUBLISH` is set and is not a true value.
- The policy reaches the client from the server: session detail `cameraPublish`, `GET /practice/setup` `media`, the connection. All optional in `lib/api/interviewEngine.ts` (absent = allowed).
- `components/v3/mock/liveConnection.ts`: the `market` term is gone from `cameraPlan`. `app/(auth)/practice/[id]/page.tsx` no longer reads the brand. `RecordingConsentSheet.tsx` hides the camera opt-in when the server records no video.
- Video frames are recorded only with a live `interview_recording` and `interview_video` grant (unchanged).

ACCEPT, tested: a GoApply video practice publishes the camera track; with both consents the recording is video; without the video consent it is audio only; `CN_INTERVIEW_CAMERA_PUBLISH=false` restores local preview and audio only, on GoApply alone.

Tests: `__tests__/pages/practice-live-brand.test.tsx`, `components/v3/mock/__tests__/liveSeam.test.tsx`, `InterviewSessionService.practice.test.ts`, `sessionSeam.service.test.ts`, `practicePage.test.tsx`, `externalRoutes.practice.test.ts`.

### 7. [P1] Parley transport, web research and the requirements preview on GoApply (G9, G57, G105): done (name check added after review)

- `createSession` uses `input.transport` for every brand (except under the opt-in domestic-only wall).
- `webSearch.ts`: both `market === 'cn'` returns removed; `assertNoPiInPayload` stays and a refusal or a failed search is a quiet null.
- `RAInterviewPromptService.ts`: the market test around the research step is removed. **After review:** `RAInterviewPromptInput.knownValues` and `withSearchKnownValues(values, fn)`; the research query is checked against them. The first-party written practice passes the account name (`externalRoutes.ts` → `startTextPractice({ knownValues })` → the `textStart` seam, which runs `RAMockService.start` inside `withSearchKnownValues`, because that service does not forward values).
- `app/(auth)/practice/page.tsx`: the preview is shown on both brands.

ACCEPT, tested: on GoApply the setup page shows and runs the market-requirements preview; the blueprint is built with web evidence; a query carrying an email, a mainland phone number, an id number or the account name is not sent, on the live path and on the first-party written practice; a search failure gives a role-based preview, never an error.

Tests: `webSearch.test.ts`, `routes/previewRoutes.test.ts`, `practicePage.test.tsx`, `features/cn/interview/__tests__/promptServiceCnBranch.test.ts` (17), `mockServiceCn.test.ts` (16), `InterviewSessionService.practice.test.ts`.

Limit: the older `POST` route in `server/src/roboapply/v2/routes/mock.ts` calls `RAMockService.start` directly and passes no name (neither file is in any bundle). Request O-C.

### 8. [P1] First free practice: verified email or verified phone on GoApply (G69): owned code done; ACCEPT not met end to end

`ensureFirstPracticeGrant`: `emailOk` and `phoneOk`. RoboApply is unchanged (email only). GoApply is verified when either holds, with the existing reason key of the one that holds, phone first. Before granting it asks whether the other key already holds a grant (`practiceDeps.hasPracticeGrant`, a read of `RACreditLedger` by the key `platform/credits/practice.ts` writes) and then returns `already_granted`. If that read fails nothing is granted.

**What is not met:** "a later phone verification does not grant a second". Verified in the code: `server/src/features/auth-cn/hooks.ts:38-39` (`grantPhoneCredit`, key `phone_verified`, called at bind time) and `server/src/features/auth/service.ts:236` (key `email_verified`, called when the link is clicked) each insert their own ledger row with no look at the other key. With D5's email-first sign-up this is the normal path: sign up by email, click the link (credit 1), bind a phone later (credit 2). PAR-3's worktree changes neither grant (its diff of `auth/service.ts` has no grant change; `hooks.ts` is untouched). A narrow window also remains inside this bundle: the read and the grant are two steps, so a setup request racing a bind can grant under both keys. Neither can be closed from files PAR-4 owns: the grants are PAR-3's, the ledger is PAR-6's. Requests P3-A and P6-A give the exact change.

Tests: `InterviewSessionService.practice.test.ts` ("first free practice (C42)", 9 tests) cover every grant made through `ensureFirstPracticeGrant`.

### PAR-1 requests

- **P4-1: done** (items 1, 2, 4, 5).
- **P4-2: done, extended after review.** `voiceConfigProblems(brand)` returns plain sentences (variable names and model ids, never a secret or a URL): a half-set voice or speech group; `CN_LIVEKIT_URL` without its key or secret; the own plane without `CN_LIVEKIT_AGENT_CALLBACK_SECRET`; the own plane without `CN_INTERVIEW_ENGINE_CALLBACK_BASE_URL` outside production while the shared base URL is set; the CN speech pair while voice runs on the shared worker (which then needs `DASHSCOPE_API_KEY`); the domestic-only `GoApply-Interview` worker without a domestic model or without the DashScope pair; a CN interview model the gateway worker does not run; a configuration no voice session can start on; the strict switch without a bucket. `warnVoiceConfigProblemsOnce` logs each once, from the practice gate and from session create, and never throws.

### Carry-over (`requests/waveFIX-carryover.md`, PAR-4)

1. `medium: 'text' | 'voice'` as a first-class input: **not done**. It needs the interviewer agents and `RAMockService.ts`, none in PAR-4's owns. Request O-A.
2. Native review of the scorer strings: nothing to code (owner).
3. The setup's "Get credits" link points at the plan picker: **done**. Voice sessions pass no unanswered count: **not done** (scorer design, unrelated to parity). `FALLBACK_BANK` English questions: in `RAMockService.ts`, not owned.
4. `i18n/staging/practice.zh.json`: **done**.

### Precedence (document over item text)

1. **Webhook match.** The item says the signer's brands include the session brand. Plan §3.5 says the signing API key is the key of the plane the session runs on. Implemented per the plan.
2. **Interview routing.** The item says `cnInterviewLlmRouting` runs whenever `CN_LLM_INTERVIEW_MODEL` or `_LIVE_MODEL` is set. Plan §3.5 puts a GoApply session without `CN_LIVEKIT_URL` on the shared worker, which is a LiveKit Inference worker. So the raw domestic model is sent only on GoApply's own plane. On the shared plane a CN model with a LiveKit Inference equivalent is used live; one without is used for the plan and the report only (D5 rule 1 and P1: a China override never turns a capability off).
3. **Storage under the strict switch.** The item has no strict rule for interview artifacts. Plan §4 defines `CN_RESIDENCY_STRICT` as "mainland storage required" and §3.6 refuses uploads without a CN bucket under it. Implemented for new interview artifacts (item 5).

## Files changed

53 modified, 2 new, all inside PAR-4's owns (checked against `parity-bundles.json`).

- Server engine: `server/src/interview-engine/config.ts`, `webSearch.ts`, `providers/{index,brandScope,livekitCloud,livekitSelfHosted,sessionSeam,speech,types}.ts`, `livekit/{webhookReceiver,liveKitClient,egress}.ts`, `sessions/InterviewSessionService.ts`, `storage/r2Storage.ts`, `parley/parleySessions.ts`, `prompt/interviewPromptService.ts` (comments), `routes/{externalRoutes,webhookRoutes,serialize,practiceGate,previewRoutes}.ts`
- `server/src/features/interview/retention.ts` (comments), `server/src/roboapply/v2/services/RAInterviewPromptService.ts`
- Server tests: `providers/__tests__/{brandConfig,providers,sessionSeam.service}.test.ts`, `livekit/webhookReceiver.test.ts`, `sessions/InterviewSessionService.test.ts` (storage mock only), `sessions/InterviewSessionService.practice.test.ts`, `storage/r2Storage.test.ts`, `webSearch.test.ts`, `routes/{externalRoutes.practice,previewRoutes}.test.ts`, `features/interview/retention.test.ts`, `features/cn/interview/__tests__/{promptServiceCnBranch,mockServiceCn}.test.ts`
- Web: `app/(auth)/practice/page.tsx`, `app/(auth)/practice/[id]/page.tsx`, `components/v3/mock/{liveConnection.ts,DeviceCheck.tsx,PracticeSetupFlow.tsx,YourTile.tsx}`, `components/features/practice/RecordingConsentSheet.tsx`, `lib/api/interviewEngine.ts`
- Web tests: `__tests__/pages/practice-live-brand.test.tsx`, `components/v3/mock/__tests__/liveSeam.test.tsx`, `components/features/practice/__tests__/practicePage.test.tsx`
- Worker: `interview-agent/src/backends/__tests__/backends.test.mjs`, comments in `interview-agent/src/backends/{config,llm,speech}.ts`, `interview-agent/deploy/cn/README.md`, `interview-agent/deploy/cn/worker.env.example`
- New: `i18n/staging/practice.zh.json`, `server/src/interview-engine/providers/__tests__/mergedLlmResolver.test.ts`

Changed in the review pass: `config.ts`, `routes/{practiceGate,externalRoutes}.ts`, `storage/r2Storage.ts`, `livekit/egress.ts`, `sessions/InterviewSessionService.ts`, `RAInterviewPromptService.ts`, `interview-agent/deploy/cn/README.md`, and the tests `brandConfig`, `mergedLlmResolver` (new), `sessionSeam.service`, `externalRoutes.practice`, `r2Storage`, `InterviewSessionService` (mock), `InterviewSessionService.practice`, `promptServiceCnBranch`, `mockServiceCn`.

## Tests run

| Command | Result |
|---|---|
| `npx vitest run server/src/interview-engine server/src/features/interview server/src/features/cn/interview components/v3/mock components/features/practice components/features/practice-cn __tests__/pages/practice-live-brand.test.tsx` | 51 files, 736 / 736 |
| `npx vitest run server/src/platform/flags.test.ts server/src/roboapply/v2/services` (not owned; the capability drift matrix and the written-practice service) | pass |
| `npm --prefix interview-agent test` | 99 / 99 |
| `npm --prefix interview-agent run typecheck` | exit 0 |
| `npm run typecheck:server` | exit 0 |
| `npx next typegen && npm run typecheck:web` | exit 0 |
| `npm run check` | exit 0 |
| `npx vitest run --exclude ".claude/**"` (final) | 623 files, 12,936 tests: 12,836 passed, 1 skipped, 10 todo, 89 failed in 41 files = 84 red at the base in 40 files of other bundles + 5 below. No failing file is in PAR-4's owns |

## Red tests for other bundles

Turned red by PAR-4, all in `server/src/roboapply/services/SeekerAccountPurgeService.brand.test.ts` (**PAR-5**). The file pins "GoApply objects never touch the shared store", which D5 ends for interview artifacts. The review pass adds none.

- "without the CN store the account is held (never cleaned from, or orphaned in, the intl store)" (item 5): with only `S3_*` set GoApply uses the shared bucket, so the purge is not blocked and both sessions are cleaned from it. Assert `blocked: true` only when no store is usable for the brand (nothing set, or `CN_S3_BUCKET` set with a key missing).
- "a GoApply session's objects go through CN_S3_* …", "the purge runs in the account brand, yet each session is cleaned in its own …", "a GoApply account's session with neither column nor seam …": with both stores configured each GoApply key is deleted once in the CN store and once in the shared store (10, 8 and 8 deletes instead of 5, 4 and 4). Assert that every key is deleted in the CN store, and that the shared-store deletes carry only that session's own keys.
- "a failed delete in the CN store keeps the account for the next run": still blocked with `artifacts=4`; `h.deletes` now holds the four shared-store deletes instead of being empty.

## Pre-existing failures

- 84 tests in 40 files outside PAR-4's owns: the PAR-1 list minus PAR-4's 11. None is in a file this bundle owns or touched.
- `interview-agent/test/connect-timeout.test.mjs` "a ws:// connect … fails fast with ETIMEDOUT" is a local network timing test: it failed in the first run of this bundle and passes in the final one. Its source and test are untouched.

## Requests

### PAR-2
- **P2-A. Keep the export `getEnvModelSetting(envName, brand)` in `server/src/lib/llm/llmModels.ts`.** `interview-engine/config.ts` looks it up by that name at call time (`Reflect.get` on the module namespace, so it compiles and runs before and after the merge). After the merge the lookup can be replaced by a plain import; nothing else changes. `providers/__tests__/mergedLlmResolver.test.ts` states the behaviour config.ts relies on: a GoApply selector may come back as a full route (`dashscope/qwen-max`, `openrouter/openai/gpt-5.5`).

### PAR-3
- **P3-A. One first-practice entitlement on GoApply (item 8, review finding 3).** `server/src/features/auth-cn/hooks.ts` `grantPhoneCredit` and `grantVerificationCredit` in `server/src/features/auth/service.ts` must call the helper of P6-A instead of `grantPracticeCredit(userId, reason, reason)`: `grantFirstPracticeCredit(userId, 'phone_verified', brand)` and `grantFirstPracticeCredit(userId, 'email_verified', brand)`. Without the helper: for a GoApply user, skip `grantPhoneCredit` when a `committed` or `reserved` ledger row `'<userId>:practice:email_verified'` exists, and skip the email grant when `'<userId>:practice:phone_verified'` exists. Test: email grant, then phone bind, one credit; and the reverse order.
- **P3-B.** `practiceGate` still asks `phoneBindingRequired(userId)` from `features/auth-cn`. Plan §3.7 makes binding required only when a phone can be bound; until that lands a GoApply email account with no SMS provider is refused practice with `phone_binding_required`.

### PAR-5
- **P5-A.** The five tests above.
- **P5-B. Contract check.** GoApply records video only with a live `interview_video` grant. Until the consent catalog offers it on GoApply a video practice records audio only (tested). The comment at `server/src/features/compliance/consents.ts:291` still says GoApply is audio only, always.
- **P5-C. Startup (P5-6).** `warnVoiceConfigProblemsOnce('goapply')` (exported from `server/src/interview-engine/config.ts`, never throws) called in `runStartupAssertions` when the deployment serves GoApply puts the voice, speech, worker and storage lines in the boot log. Today they are logged at the first practice setup or session create.
- **P5-D. Disclosures.** On the shared stack GoApply practice audio goes to the shared LiveKit project and its speech vendors, recordings to the shared bucket (not under `CN_RESIDENCY_STRICT`), and a role query (no personal information, no account name) to the web-search vendor. `egressPolicy.ts` still refuses that vendor for GoApply on a strict mainland deployment; the search then degrades to no evidence.

### PAR-6
- **P6-A. One helper for the first free practice (item 8, review finding 3).** In `server/src/platform/credits/practice.ts`, exported from the index: `grantFirstPracticeCredit(userId, reason: 'email_verified' | 'phone_verified', brand: BrandId): Promise<PracticeGrantResult>`. RoboApply: exactly `grantPracticeCredit(userId, reason, reason)`. GoApply: inside the one `store.transaction` that inserts the ledger row, first read the sibling key (`'<userId>:practice:<other reason>'`); when it is `committed` or `reserved` return `already_granted` and insert nothing. A per-user lock in that transaction (or one shared uniqueness key for the pair) closes the race between a bind and a practice setup. `ensureFirstPracticeGrant` (`interview-engine/sessions/InterviewSessionService.ts`, the default `grantPracticeCredit` and `hasPracticeGrant` deps) then calls the helper and drops its own ledger read; `auth-cn/hooks.ts` and `auth/service.ts` call it too (P3-A).

### PAR-10
- **P10-A.** Document the variables below. Facts for the docs: a `CN_` voice value is read only together with `CN_LIVEKIT_URL` (the callback secret included); the shared worker serves GoApply by default; a CN interview model that LiveKit Inference does not serve plans and scores the practice while the shared model runs the live turns; under `CN_LLM_DOMESTIC_ONLY` or `CN_RESIDENCY_STRICT` GoApply voice needs its own plane and offers the written practice until it has one; under `CN_RESIDENCY_STRICT` recordings need `CN_S3_BUCKET`.
- **P10-B.** Operator note: after setting `CN_S3_BUCKET`, earlier GoApply recordings stay in the shared bucket. They are still deleted on time, but their playback links stop. Copy the `interviews/<sessionId>/` objects if they should stay playable.

### Orchestrator
- **O-A.** Carry-over item 1 (`medium` as an input) needs a grant for `server/src/roboapply/v2/agents/RAMockInterviewer*`, `RAInterview*` and `server/src/roboapply/v2/services/RAMockService.ts` (also home of `FALLBACK_BANK`).
- **O-B.** `routes/practiceGate.ts` answers "voice available" for RoboApply without asking the capability or `voiceRoutingProblem`, while GoApply asks both. Left as is (RoboApply must not regress). One rule for both would let a RoboApply deployment without LiveKit or without an interview model offer the written practice instead of failing at create.
- **O-C. (review finding 5)** `server/src/roboapply/v2/services/RAMockService.ts` (`start`, around line 728) and `server/src/roboapply/v2/routes/mock.ts:79` are in no bundle. Add `knownValues?: ReadonlyArray<string | null | undefined>` to the `start` input, pass it into `raInterviewPromptService.generate({ …, knownValues })`, and have the route pass `[req.user.name]`. The first-party practice route already covers its own calls through `withSearchKnownValues`.

### Owner
- Camera video on GoApply is on by default behind the two per-session consents (plan §8 item 4). `CN_INTERVIEW_CAMERA_PUBLISH=false` restores audio only.
- `CN_RESIDENCY_STRICT` now also stops new GoApply recordings and transcript files from going to the shared bucket (plan §4). Earlier objects there are kept until their retention date.
- **Decision wanted:** under `CN_RESIDENCY_STRICT` the interview model is forced domestic and onto GoApply's own plane, and storage onto its own bucket. Speech is not forced: a strict deployment with its own plane and a gateway worker but no DashScope pair would send speech to the shared vendors. Say if strict mode should also require the CN speech pair.

## Schema requests

None. The plane is stored in the existing `InterviewSession.liveMetrics` JSON.

## Env variables added or redefined

| Name | Meaning | Default |
|---|---|---|
| `CN_INTERVIEW_CAMERA_PUBLISH` | new. Set and not a true value: GoApply keeps the camera a local preview and records audio only | on (same policy as RoboApply) |
| `CN_LIVEKIT_URL` | redefined: starts GoApply's own media plane. Then `CN_LIVEKIT_API_KEY`, `CN_LIVEKIT_API_SECRET`, `CN_LIVEKIT_AGENT_CALLBACK_SECRET`, `CN_VOICE_PROVIDER`, `CN_INTERVIEW_ENGINE_AGENT_NAME`, `CN_INTERVIEW_ENGINE_CALLBACK_BASE_URL` are read, with no shared value mixed in. Without it they are ignored (and named in a warning) | unset: the shared LiveKit project and worker |
| `CN_LIVEKIT_AGENT_CALLBACK_SECRET` | redefined: required on GoApply's own plane (the shared secret is not read there); a warning names it when missing | none |
| `INTERVIEW_ENGINE_AGENT_NAME` | redefined: the worker dispatched on the shared plane for both brands | `RoboApply-Interview` |
| `INTERVIEW_ENGINE_CALLBACK_BASE_URL`, `BACKEND_PUBLIC_URL`, `PUBLIC_BACKEND_URL` | redefined: also the callback base for GoApply sessions on the shared plane; not used on its own plane | request origin in production, localhost in dev |
| `LIVEKIT_AGENT_CALLBACK_SECRET` | redefined: the secret of the shared worker, accepted for both brands' sessions on the shared plane | none |
| `CN_INTERVIEW_ENGINE_STT_MODEL` + `CN_INTERVIEW_ENGINE_TTS_MODEL` | redefined: optional DashScope pair (both needed); then `_STT_FALLBACK_MODELS`, `_TTS_VOICE`, `_TTS_VOICE_MALE`. On the shared plane the shared worker then needs `DASHSCOPE_API_KEY` | unset: the shared voice catalog and STT |
| `CN_LLM_INTERVIEW_MODEL`, `CN_LLM_INTERVIEW_LIVE_MODEL`, `CN_LLM_INTERVIEW_LIVE_REASONING_EFFORT`, `CN_LLM_INTERVIEW_BLUEPRINT_MODEL` | redefined: optional per-key overrides. On GoApply's own plane a domestic live model is sent as-is. On a LiveKit Inference worker a CN model with an equivalent runs live; one without plans and scores only, and the shared interview model runs the live turns | unset: the shared `LLM_INTERVIEW_*` values |
| `CN_S3_BUCKET` (+ `CN_S3_*`) | redefined for interview artifacts: optional own bucket; naming the shared bucket there is no longer refused | unset: the shared bucket |
| `CN_LLM_DOMESTIC_ONLY`, `CN_RESIDENCY_STRICT` | effect added here: GoApply's live interviewer must be a domestic model on its own plane; without that plane voice is reported unavailable and the written practice is offered; its sessions do not use Parley | off |
| `CN_RESIDENCY_STRICT` | effect added here: new GoApply recordings and transcript files need `CN_S3_BUCKET`; without it none is stored | off |
| `INTERVIEW_ENGINE_PARLEY_PILOT` | redefined: applies to GoApply users too | off |

## i18n keys added or changed

- `i18n/staging/practice.zh.json` (new file): `practice.setup.insufficientCreditsNoPurchase` = `这场面试需要 {required} 个额度，你还有 {balance} 个。` (carry-over item 4; the English key is already staged).
- No English string was added or changed, in the first pass or the review pass. The copy that parity touches already exists and is shown by condition (`practice.live.cam.localOnly*`, `practice.recording.sheet.videoNotOffered`, `practice.gate.voiceUnavailable`, the two first-practice notices).

## Known gaps

- **First free practice can be granted twice on GoApply** until P3-A and P6-A are applied (item 8).
- **Not checked in a browser or against a running stack** (the bundle rules forbid both). To retest after the merge on both brands, light and dark, 375 px and 1280 px: the device check and live room of a GoApply video practice, the same with `CN_INTERVIEW_CAMERA_PUBLISH=false`, the recording sheet, the requirements preview on the GoApply setup page, and the setup under `CN_LLM_DOMESTIC_ONLY=true` with no `CN_LIVEKIT_URL` (written practice offered, no voice option). No layout or style was changed.
- **A real GoApply voice session on the shared project has not been run.** The control plane and the worker's model building are tested separately with fakes; plan §7 step 4 is the end-to-end check.
- **The account name on the older v2 mock route** is not checked (O-C).
- **Playback after a bucket move** (P10-B): deletes reach the earlier store, reads do not.
- **The speech set is pinned by the stored voice, not by a stored field.**
- **A session's own plane with the domestic-only worker but no CN models** is refused by the worker with `worker_config` and named by `voiceConfigProblems`; the control plane cannot know which backend a worker runs. The same holds for the shared worker without `DASHSCOPE_API_KEY` when the CN speech pair is set (named, not detectable).
- `voiceConfigProblems` is logged at first use, not at boot (P5-C).
- RoboApply's practice gate does not ask the routing check (O-B).

## Review resolution

1. **Undone item 8 (first free practice, second grant).** Verified, real, not fixable in owned files. `hooks.ts` and `auth/service.ts` grant with no look at the other key, and PAR-3's worktree changes neither. Item 8 is now reported as not met end to end; requests P3-A and P6-A carry the exact change and the test, and the race inside the bundle is named.
2. **Finding 1 (medium): a CN model with no LiveKit Inference equivalent turned every GoApply voice start into a 503.** Verified and fixed as proposed, in one place (`config.ts` `resolveLiveWorkerModel`): the CN model stays the backend model, the worker model comes from the shared selector, and `voiceConfigProblems` says which CN variable is not used live. Added beyond the proposal: an effort set for a passed-over CN live model is not applied to the shared model. Tests: `brandConfig.test.ts` (the reviewer's case and five more model families), `mergedLlmResolver.test.ts`, `externalRoutes.practice.test.ts`.
3. **Finding 2 (medium): under the wall the setup offered voice, every start was a 503, nothing was logged; storage under strict.** Verified and fixed. `config.ts` `voiceRoutingProblem(brand)` (routing, the wall, GoApply's own speech set); `practiceGate` uses capability AND no routing problem, so the setup offers the written practice and `POST /practice/sessions` answers `503 ai_unavailable / voice_unavailable`; the message is a `worker` line in `voiceConfigProblems`. Storage: implemented instead of deferring it to the owner, because plan §4 defines it. It is a rule for new writes (`getR2WriteCreds`), not a null from `getR2Creds` as proposed: that null would have blocked the account purge and the retention sweep and left earlier recordings in the shared bucket past their date.
4. **Finding 3 (medium): two free practices at verification time.** Same as 1. Requests P3-A and P6-A rewritten with the helper signature and the transaction rule.
5. **Finding 4 (low): two silent configurations.** Verified and fixed: a `voice` line for the own plane without `CN_LIVEKIT_AGENT_CALLBACK_SECRET`, a `worker` line for the CN speech pair on the shared worker. Also added the case the finding mentions in its text: the own plane without `CN_INTERVIEW_ENGINE_CALLBACK_BASE_URL` outside production while the shared base URL is set. Tests in `brandConfig.test.ts`; the worker README says it too.
6. **Finding 5 (low): the written-practice query was not checked against the account name.** Verified and fixed further than proposed: `knownValues` on `RAInterviewPromptInput` as proposed, plus `withSearchKnownValues`, so the first-party written practice is covered now without waiting for a change in `RAMockService.ts`. The older v2 route stays a request (O-C). Tests: `promptServiceCnBranch.test.ts`, `mockServiceCn.test.ts` (through the real `RAMockService.start`), `InterviewSessionService.practice.test.ts`, `externalRoutes.practice.test.ts`.
7. **Finding 6 (low): `getBlueprintModel` read past PAR-2's resolver.** Verified. Fixed so that no edit is needed at merge: the resolver is looked up by name at call time and used for GoApply when it exists (P2-A). `mergedLlmResolver.test.ts` runs config.ts with the resolver present; `brandConfig.test.ts` without it.
8. **Unowned edits:** none found by the review, none now (55 changed paths checked against the bundle's owns).

Handoff file: `/Users/kenny/code/RoboApply/.claude/worktrees/jobright-clone/docs/jobright-clone/orch/handoffs-par/PAR-4.md`
