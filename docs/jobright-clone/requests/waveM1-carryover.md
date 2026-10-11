# Wave M1 carry-over requests

**Written at the M1 gate of the market wave, 2026-10-11.** Source: the seven handoffs `orch/handoffs-mkt/MKT-1A.md` … `MKT-1G.md`, the open "Market waves" entries of `requests/wavePAR-carryover.md`, `requests/orchestrator-queue.md` and the gate's own contract check. Everything below was **not built** at the gate: it belongs to a later bundle of the market wave, the i18n pass, the orchestrator at a later gate, or the owner. What the gate applied is listed at the end for context. `wavePAR-carryover.md` still applies for everything outside the market wave (its sections "Later fix work packages", "Owner" and "Counsel").

Nothing in M1 or at this gate was checked in a browser, against a running stack, a database or a real provider. No command reached Stripe: the clone `.env` holds a live key, which `getStripe()` now refuses outside production.

A bundle reads the section with its own id. An entry says what to do, where, and why; "handoff" names the M1 handoff that holds the full text.

---

## M2 bundles

### MKT-2A (Alipay wire parity)

1. PAR carry-over, payments 8 is yours unchanged: the ten differences PAR-6 measured (`orch/handoffs-par/PAR-6.md`, item 1 "Findings for the market wave"). Nothing in M1 touched `rails/alipayWorker.ts`, `fulfilPass.ts`, the Alipay callback route or `handleAlipayCallback`; the 55 tests named `A<n> …` pass unedited on the merged tree.

### MKT-2B (Stripe webhook lifecycle)

1. **Item 1 now has a second half, and you own the two files for it** (`orch/market-bundles.json` was updated at this gate: `server/src/platform/billing/stripeEnv.ts` and `stripeEnv.test.ts` are in your owns, for one line each). As merged in M1 a comma-separated webhook secret keeps the Stripe rail **closed** (`STRIPE_WEBHOOK_TRIES_EVERY_SECRET = false`), because `routes/stripeWebhook.ts` still hands the one raw string to `constructEvent`. In the **same change** that makes the route loop over `stripeWebhookSecrets(process.env)`: set the constant to `true` and flip the one assertion of the test `'the route does not try every secret yet (flip this with the route change, MKT-2B item 1)'` to `toBe(true)`. Every other test follows the constant (MKT-1A measured: with the constant true exactly that one test fails). Never do one half without the other. The exact route text MKT-1A verified in memory is in its handoff, "Requests → Orchestrator → 1 (a)"; note `deps.secret` stays the single-secret test seam. **Whitespace (review resolution at this gate):** while the constant is false the rail is also closed when the one string the route reads has whitespace anywhere (`whsec_…\n`, a leading or trailing space): the route passes the raw string and the SDK does not trim it. Your loop over `stripeWebhookSecrets()` trims each secret, so those shapes verify again and the flip of the constant stays correct (the test table "notOne" asserts `stripeWebhookCanVerify(env, true)` is true for them). A secret with whitespace INSIDE it verifies neither way and keeps the rail closed after the flip too (its own test); do not loosen that.
2. `planKeyForPrice(price)` is ready for price-first resolution (your item 2): swap the two operands in `resolvePlanFromStripe`. The test "subscription metadata still wins over the price" in `integration/RoboApplyBillingService.stripe.test.ts` pins today's order and is the one to flip. Keep metadata as the second source: an ignored pin maps to no plan in `planKeyForStripePrice`, and a subscriber on such a price is resolved by metadata.
3. `stripeHealth.ts` (your item 7) is the place for two checks MKT-1A left open: (a) retrieve each **pinned** price once and compare amount, currency and recurrence with the catalog (`getPlanCatalog('roboapply', env)` gives `stripePriceId` and `twdPrice.stripePriceId` for the pins that stand); a pin next to ONE wrong amount is still trusted today. (b) A synced price archived in the Dashboard: an instance that already resolved it keeps sending the archived id (502 at checkout until restart). Report it; do not repair it.
4. The webhook still writes `brand: 'roboapply'` on subscription and invoice events without reading the row (PAR-6 finding 10; your item 1 covers it). `findBillingOwnerByCustomer` accepts the id or the expanded customer and returns `subscription.brand`.
5. Seam shapes: `claimBillingEvent(db, userId, key, refType, now?)` (`now` optional), `ctx.now` is a function `() => Date`. Import new modules by file path: only MKT-2D owns `platform/billing/index.ts` in M2.
6. `STRIPE_BILLING_PORTAL_URL` is read nowhere and is not in `.env.example` (a test pins that).

### MKT-2C (subscription changes)

1. `switchPriceFor(stripe, stripeSub, target)` is async and returns `{ priceId, amountMinor, currency }`; your idempotency key `switch:<subId>:<planKey>:<prorationDate>` and `pending_if_incomplete` go on the `subscriptions.update` call in `confirmSwitch`.
2. You own `features/credits/{service,contract}.ts` in M2. `PlansResponse` has three optional members (`checkout.collectingEntity`, `refundPolicy`, `studentOffer`) that are required in `PlansResponseSent` (what `plans()` returns). Do not make them required in `PlansResponse` until item MKT-2E.1 below is done. `refundPolicy.version` is the PUBLIC label (`publicRefundPolicyVersion`); never send `REFUND_POLICY_VERSION` itself to a buyer.

### MKT-2D (refund engine)

1. `claimBillingEvent`, `ctx.now()` and `findBillingOwnerByCustomer` as in MKT-2B.5. You own `platform/billing/index.ts` in M2.
2. A stored refund decision keeps the full `REFUND_POLICY_VERSION`; anything a buyer can read (mail, page) uses `publicRefundPolicyVersion` from `features/credits/service.ts`. Both brands publish the same label today (`refund-v1-2026-10`); if the two rule sets ever differ, give them different names in `refunds.ts` before the suffix.

### MKT-2E (billing UI)

1. Once every `PlansResponse` literal in the web tests carries `collectingEntity`, `refundPolicy` and `studentOffer`, tell MKT-2C (or MKT-4A in M4) that the three members can become required in `features/credits/contract.ts` and `PlansResponseSent` can go. One literal outside your owns blocks it today: `components/features/billing-cn/__tests__/billingCn.test.tsx:72` (a `checkout` literal without `collectingEntity`).
2. PAR carry-over, payments 10 (an in-flight WeChat Pay order under the kill switch has no dedicated return page): yours when you rework `CheckoutReturn.tsx`. It needs a server fact the web does not have (WeChat Pay set up but closed for new orders).
3. `useCheckoutAttempt` / `newAttemptKey` are exported from `hooks/credits` if the switch or resume calls need an attempt key. A page restored from the back-forward cache keeps its key (a buyer who pays, presses Back and clicks Continue repeats the key and gets the first session): decide whether `pageshow` with `persisted` should renew it.
4. The closed-state rule MKT-1B chose (a plan row that is off sale always says "Not available yet", also under GoApply's kill switch) is one condition in `PlanPicker.tsx` `renderOption`; see Owner 5.
5. **A student plan on RoboApply `/pricing` leads an unverified buyer to a dead end (review finding, low; not built at the gate).** RoboApply's `GET /billing/plans` lists the student plans for every caller while the `student` capability is on (the contract comment in `features/credits/contract.ts` now says so; GoApply sends them to a verified student only). Once the Stripe rail is ready: (a) `PricingPage.tsx` `PlanCard` shows "Sign up to buy" / "Choose plan" on the two student cards for everyone, with none of the "confirm a school email" wording GoApply's Student price block prints; (b) a signed-in, unverified buyer who follows it lands on a plan sheet where `initialSelection` picks `student_monthly` from the raw response while `visiblePlans` hides it, so Continue stays disabled with nothing said. Fix: in `PlanCard`, for `plan.requiresFlag === 'student'`, print `credits.pricing.studentOffer.how` and show the checkout link only to a verified student (`useStudentStatus` from `components/features/account-v2`, enabled only when signed in: on a public page an anonymous call must not run), otherwise a link to `/settings/billing` where `StudentVerification` sits; and make `initialSelection` choose from the offered list (`hooks/credits/usePlans.ts`). `PricingPage.tsx` has no owner in M2 (Orchestrator 3). See Owner 19 for the listing rule itself.
6. `lib/pricing.ts` `displayPrice` gives a student plan no "Save N%" (`isStudentPricedPlan`; the server's `savingsPercent` returns null for it too). Keep both when you touch the sheet; see Owner 18.

### MKT-2F (every consumer reads the one fit)

1. **`jobs/detail/defaultService.ts` `explainNow`** passes `fit.dimensions` to `explainMatch`. Drop a part for which `isByFilters(d)` is true (exported from `match/index.ts`), as the feed does. Without it the job page's explanation lists a not-compared line ("Not enough to compare the location, pay or work setup." since this gate) for a job whose location only repeats the person's filter. Do this before M1 reaches users.
2. **The not-compared line on the job page.** Applied at this gate (review finding): `DimensionList.tsx` reads the new key `fit.compared.notCompared` ("Not enough to compare.", staged), true for both kinds of fit. The old `fit.compared.notStated` ("…so it doesn't count toward the score.") was false for a quick estimate (a part that cannot be compared counts at the prior) and is read by nothing now. A new key, not new English under the old one: staged English does not replace the eight translated bundles at runtime, so a reworded key would have kept the old sentence in every other language until the i18n pass. Optional for you: split the line by `fit.kind` ("…so this part counts as a typical value" for an estimate, "…so it doesn't count toward the score" for an AI fit) with two new keys; `DimensionList.tsx` is not in your owns (MKT-4E owns the directory in M4): ask the orchestrator for it or pass the wording as a prop from `JobFit.tsx`.
2a. **"Why this job" (`compliance/explainMatch.ts`, no owner before MKT-4A).** Applied at this gate: a not-stated role, industry or logistics part emits `legal.explain.notCompared.<part>` ("Not enough to compare …", en and zh staged) instead of `legal.explain.notStated.<part>` ("The posting does not say …"), because under estimate v2 the missing side is as often the person's (no role evidence gives a student `title_level: null` on every card). `skills` and `career_path` keep `notStated`. Better, and yours if you pass the fact: give `explainMatch` which side is missing (`postingStates(job)` or `Fit.confidenceReason`) and say "The posting does not say …" (the old keys are still in every bundle) only when the posting's side is the missing one, with a second key for "Your profile does not show …". Also applied: `ExplainMatchInput.tier` (optional). Pass the fit's tier wherever you call `explainMatch` (the feed and `jobs/detail` `explainNow` do), so the headline names the tier on the card.
3. Rename the local `fitOf` in `resume/tailor/TailorService.ts` so the SM-4 grep (`fitOf` in `server/src`) is empty.
4. For the job page use `fitToView(await getFit(userId, jobId), { locale })`: a single-job `Fit` carries the stored prose, a list `Fit` does not.
5. `Fit.estimateReason` on a list is `no_resume`, `ai_off` or null; a list does not check the caps. `Fit.basis.jobContentHash` can be null on a `getFits` row and `Fit.stale` on a list knows about a changed posting only when the row stores its hash: read both with a default.
6. Harness (MKT-1D): a registry read is `read(userId, jobId, ctx)` with `ctx = { world, scenario }`; build each surface on the fakes of `ctx.world`. INV-3 runs twice (`estimate`, `ai`). Keep every name of `REQUIRED_FIT_SEAMS` and add `onboarding_result` as a tenth. `enforced.test.ts` is one call: `registerInvariants({ enforce: 'M2' })` from `./invariants.eval.js`. `fit.ts` must keep `createFitService(deps | service | { service })`.
7. The gate labelled the evidence ref `logistics_by_your_filters` (`components/features/match/labels.ts`, key `fit.compared.evidence.logistics_by_your_filters` staged, a test in `match.test.tsx`). Nothing to do; do not remove it when you edit the staging file.
8. PAR carry-over "Later fix work packages" 8 (`MatchFitView.rewriteBlocked`) names `match/contract.ts` and `MatchService.scoreJob`: you own the contract in M2, MKT-4G owns the service in M4.

### MKT-2G (skill vocabulary)

Nothing from M1.

### MKT-2H (search document and embeddings)

1. **Write `RAJob.contentHash = jobContentHash(row)`** (from `match/index.ts`) in the same statement as the search document, and again whenever the title, the qualifications or description head, or the skills change. Lists read only this column for the posting's hash: while it is empty a list serves a stored AI score as current (`stale: false`, `basis.jobContentHash: null`) and only the job page and the precompute cron notice a changed posting. The recipe reads the first 8,000 characters of `descriptionPlain`, so `left("descriptionPlain", 8000)` is enough input.
2. You own `enrich/service.ts` and `workers.ts`: `reconcile()` returns `{ update, report, companyIndustry }`; `EnrichDeps.setCompanyIndustry` is optional; `selectTaxonomyCandidates` takes the held role as a 4th argument; keep `agent.js` imported before `service.js` in `enrich/index.ts` (a test guards the order).
3. Enrichment-added skills move the job hash, so each re-enrichment re-scores the rows scored since the last one (the old score serves meanwhile). If that cost matters, the hash recipe is a contract of `MARKET_TASK_PLAN.md` 3.3: change it there before you store it.
4. You own `server/src/features/feed/` in M2. PAR carry-over 7a (the visitor list `FeedQueryService.publicList` keeps a hard 45-day window for every row, while the signed-in feed applies the age floor to aggregator rows only) is in your files; the rule is JI-10 (MKT-3C item 5, MKT-5C). If you touch `publicList`, give it the `ageFloor` form; otherwise leave it for MKT-5C, which owns `FeedQueryService.ts` in M5.
5. The 150 ms feed gate has no measurement (`latency feed_p95_ms: not_built`). MKT-1F measured CPU only: one window's `getFits` costs about 8 ms more than the estimate loop it replaced and one stored-score query, as before.

---

## M3 bundles

### MKT-3A (ingest core, quota)

1. The quota contract is exported from `jobs/ingest/index.ts` since this gate (`PROVIDER_QUOTA_CONFIG_KEY`, `parseProviderQuota`, `serializeProviderQuota`, `daysToReset`, `usageKey`, the three types). The snapshot key is a free string and, for a map, the KEY is what is written (`activejobs` and `activejobs:cn` stay two entries). Counts must be numbers: a header value left as a string parses back as `null`.

### MKT-3B (planner, source registry)

1. `sources/registry.ts` `KIND` has no entry for `tw_open_data`, `tw_gov_jobs`, `usajobs`, `activejobs_feed`, so `jobSourceKind` answers `'search'` and the default transport `'rapidapi'` for them. Add the entries in the change that registers the adapters.
2. `providerQueryLabels(roleId, { market, country })` is ready as the contract says: up to three texts per language, abbreviations of three letters or fewer and whole-title-only words dropped, a `zh-TW` item only once a Traditional label exists.
3. PAR carry-over 1 (`'linkedin'` in the `JobProvider` union, JI-2) is still open; the list of files that name the literal is there. `PROVIDER_META.linkedin` cannot go while the literal is in `platform/brand/registry.ts` (no owner in any phase: a Request to the orchestrator, then `npm run gen:brand`). `companies/service.ts` `API_BOARDS` is plain strings that label stored `sourceBoard = 'linkedin'` rows: it does not block the removal and must stay.
4. `sources/index.ts` exports `SourceCostModel`, `adapterCostModel`, `adapterEnabledFor`, `sourceUserAgent`, `JOB_SOURCES_CONTACT_ENV`, `SOURCE_USER_AGENT_MAX` since this gate. `adapterEnabledFor` trusts the adapter: it does not check `adapter.markets`.

### MKT-3C (posting identity and lifecycle; owns `normalize/`, `upsert.ts`, `maintain.ts`)

1. **Applied at this gate, in your files (keep it):** `NormalizedJob.titleMatchScore`, `taxonomyIdsForTitle` returns `score` and takes the better of the title as written and its mainland reading, and `upsert.ts` writes `titleMatchScore` and replaces the role of an enriched row only on a decisive title or a changed title (`ROLE_FROM_INGEST`; SQL snapshot and tests in `upsert.test.ts`). The column is a 4-byte float: `>= 0.9::real`, never a bare `0.9`.
2. **A wrong currency (pre-existing, found by MKT-1C, not fixed):** `currencyFromText` in `salary.ts` tests `S\$` before `US\$` and `A\$` before `CA\$`, so `US$90,000 - US$110,000 a year` on a row whose pay comes from text is stored as **SGD** and `CA$90,000` as **AUD**. Fix: `['SGD', /(?<![A-Za-z])S\$|\bSGD\b/i]`, `['AUD', /(?<![A-Za-z])A\$|AU\$|\bAUD\b/i]`, `['BRL', /(?<![A-Za-z])R\$|\bBRL\b/i]`, with a test for `US$`, `CA$`, `AU$`, `S$`. A provider currency field wins over the text, so only text-derived pay is affected.
3. `NO_DATE_EXPIRY_PROVIDERS` in `identity.ts` does not list the new providers (`tw_open_data`, `tw_gov_jobs`, `usajobs`, `activejobs_feed`), so a row without `expiresAt` expires 45 days after `postedAt`. JI-10 says an age cut-off never drops open-data rows: decide per source in your item 5.
4. `sponsorshipProvider`, `locationDistrict`, `workShift` and `NormalizeContext.companyDomains` are on the input types and read by nothing (your items 3 and 6). `NormalizedJob.headcount` is carried and still not written by the upsert (the column exists since SCHEMA-8).
5. `normalize/zhVariants.ts` `foldTwToCn` lacks common title characters (內, 顧, 問, 講, 廚, 術, 門), so 室內設計師 and 顧問 stay unknown; `features/onboarding/zhFold.ts` holds a second, fuller table. One table should serve both.
6. `normalize/index.ts` exports `CJK_NEGOTIABLE_SOURCE`, `TW_FLOOR_CLAUSE_SOURCE`, `TW_FLOOR_OTHER_PAY_BEFORE_SOURCE`, `TW_FLOOR_STATUTE_SOURCE` since this gate (for MKT-3D.1 below).
7. PAR carry-over 6 (dedupe priority: bank outranks board, JI-5 / JC-7) and 7a (posting age on the remaining readers, JI-10) are yours by your items 2 and 5. **7b is assigned to you at this gate** (it had no bundle): a bank row stored with the old `…/jobs/<id>` link while its bank HAS a posting-page template and the bank's sync is not running is still listed with a dead link. Root fix, in `maintain.ts`: archive open rows of a bank whose adapter is not enabled as `no_apply_target` (the upsert already revives that close reason when the source lists the row again). The read-side alternative has to change `bankListable`, `bankListableWhere` and the feed SQL together, outside your owns.
8. A provider-stated role (`taxonomyIdsForProviderRole`) carries no stored marker: see MKT-3E.3.
9. **Applied at this gate, in your file (keep it; review finding, high):** `salary.ts` `TW_FLOOR_CLAUSE_SOURCE` recognised the Art. 5 clause only when 以上 followed the amount directly, so "面議（經常性薪資4萬/月含以上）" and "面議（經常性薪資達4萬元）" were stored as a disclosed NT$40,000 minimum. The pattern is now built from four parts (`TW_FLOOR_LEAD`, `TW_FLOOR_AMOUNT` with an optional 元 and `/月`, `TW_FLOOR_ABOVE` with a bracketed or bare 含, `TW_FLOOR_NOT_LONGER`) and has two forms: with the statute's term 經常性 the tail 以上 is optional; without it 以上 stays required ("月薪4萬" is a figure). A new clause kind `statute_open` (statute term, no 以上) is the clause only next to "pay not listed" wording, in any market, and is not by itself "pay not listed" ("經常性薪資5萬元" alone stays a stated amount); `statute` (with 以上) is unchanged. A range or a longer number that starts like the threshold ("經常性薪資4萬~6萬", "4萬5千") is never the clause. Tests: two blocks in `salary.test.ts` ("the clause with a period marker, an unbracketed 含 or no 以上 …").

### MKT-3D (employer boards; owns `sources/atsPublic/`)

1. `sources/atsPublic/hooks.ts` holds character-for-character copies of four pay-wording strings, kept in step by a test. Import them from `'../../normalize/index.js'` instead (exported since this gate; `CJK_NEGOTIABLE_SOURCE` is the hook's `TW_NEGOTIABLE_SOURCE`) and drop the four `toBe` lines of the lockstep test "JT-1: the card and the pay parser read the same wording…" in `atsPublic.test.ts` (keep its text-agreement half). The clause pattern was widened at this gate in both copies (MKT-3C.9): the hook's four private part constants (`TW_FLOOR_LEAD`, `TW_FLOOR_AMOUNT`, `TW_FLOOR_ABOVE`, `TW_FLOOR_NOT_LONGER`) go with the copy. Keep the rule in `hasStatuteClause` that the statute's term makes a text "pay not listed" by itself only when the match ends in 以上 (the parser's kind `statute`, not `statute_open`); if you want one rule in one place, ask MKT-3C to export a predicate from `normalize/index.ts` instead of the pattern.
2. User-Agent: call `sourceUserAgent(market, env)` from `'../index.js'` with the market of the request; never read `JOB_SOURCES_CONTACT` yourself (each brand reads its own name).
3. PAR carry-over 2 (one board feeding both sites; `RACareerSiteSource.countries` exists since MKT-0) is your items 1 and 4.

### MKT-3E (Taiwan open data; owns `taxonomy/` in M3)

1. `synonyms.zhHant` is read by nothing (`match.ts` builds its phrases from `en` and `zh` only; the collision test does not include `zhHant`). `taxonomyNodeLabel` is exported from `taxonomy.ts` but not from `taxonomy/index.ts`.
2. `seniorityFromTitle('行銷經理')` answers `lead_staff` and `業務代表` matches no role (both showed in the harness's zh-TW personas; `level.ts` is MKT-3C's, the labels are yours). Two harness personas have a recent title today's matcher cannot place (`初階業務代表`, `フルスタックエンジニア`).
3. A role mapped from a provider's occupation code carries no stored marker, so enrichment treats it like any role: the model may overrule it when the title is not decisive, and since this gate a refresh keeps the enriched role unless the title is decisive or changed. If official codes must win, the row needs to say where its role came from (Schema requests below) and `enrich/titleEvidence.ts` `roleFromTitle` plus `ingest/upsert.ts` `ROLE_FROM_INGEST` are the two places to honour it. Decide with your item 6.
4. MKT-1E departed from strategy 2.5 on 管培生 (see Owner 9): if the owner restores it as a role alias, it is one line in `taxonomy.v1.json`.
5. The raw `matchTitle` does not read Traditional Chinese; callers outside ingest, enrichment and the backfill (feed title filters, SEO paths) behave as before for Taiwan titles. Your Traditional labels are the real fix.
6. On your first real sweep count `salaryDisclosed` against the `NT_L` / `NT_U` fields: the JT-1 patterns were written from the research note's quoted sentence and the wording in the tests, never checked against real data. The forms added at this gate ("經常性薪資4萬/月含以上", "…達4萬元/月以上", "…達4萬元" with no 以上) come from a reviewer's recollection of a job board's negotiable wording and were not checked against live rows either: on the first sweep list the pay texts that contain 經常性 and still parse to a figure.
7. User-Agent as MKT-3D.2.

### MKT-3F (provider health)

1. Quota contract as MKT-3A.1 (you are the reader).

### MKT-3H (runbooks)

1. `STRIPE_TEST_RECIPE.md` must say: only `sk_test_` / `rk_test_` keys work outside production; ONE webhook secret until MKT-2B's route change is merged (then a list); a restricted key needs write access to Products and Prices (the first checkout of each plan creates `ra_pro`, `ra_pro_student`, `ra_pro_week_pass`, `ra_practice_pack` and the price under `ra_<planKey>_<currency>_<amount>_incl`); never archive an `ra_…_incl` price by hand, change the catalog amount instead. Nothing of MKT-1A was seen against Stripe: every parameter is asserted on a fake.

---

## M4 bundles

### MKT-4A

1. PAR carry-over payments 11 (`RABillingRefund` retention) and 12 (MKT-0 O-6, the unique on `RABillingConsentArchive`) are yours, unchanged.
2. You own `features/credits/{service,contract}.ts` in M4: see MKT-2E.1 for the three optional members.

### MKT-4B

1. `claimBillingEvent` and `findBillingOwnerByCustomer` as in MKT-2B.5. A stored or printed refund decision: MKT-2D.2.

### MKT-4C

1. If MKT-2E did not finish MKT-2E.1, it is yours (you own the web credit fixtures in M4).

### MKT-4D (enrichment v3; owns `enrich/`)

1. As MKT-2H.2. The industry cues (`quotes.ts` `INDUSTRY_TOPIC_CUES`) are narrow by design: a hospital, a bank or a law firm gets no industry rather than a near one, and a posting that states its business in other words is dropped as `industry:off_topic` and logged. Widen the lists from real drops, not from guesses.
2. The "a later phrase wins" rule for Chinese titles reads "A兼B" and "A/B" titles (会计兼出纳) as B; both score under 0.9, so the model decides. "Associate Architect" / "Associate PM" are unknown ("associate" is not a level word). "<X>研发工程师" with an X the tree does not know is unknown at ingest.

### MKT-4E (skills in the estimate; owns `components/features/match/` in M4)

1. INV-7's posting carries no `skillIds`, lists `Relational databases`, `PostgreSQL`, `Postgres` and `TypeScript`, and the resume lists PostgreSQL. The literal path must report `state: 'related'` with `via` PostgreSQL and treat the two spellings as one skill.
2. `keywordRows.ts` calls `titleOverlap`, so its title row now compares the posting's role with the roles the person's record shows, not with the saved search. Confirm that is what the three-state check wants.
3. `splitSkills` and `Fit.skills` separate `softSkills`; `keywordRows` still lists soft skills in its skills row.
4. `DimensionList.tsx` can show a by-filters logistics part in its own words instead of the generic not-stated sentence (`isByFilters` is the test; the evidence line is already labelled). If MKT-2F did not split the not-compared line by fit kind (MKT-2F.2; the line reads `fit.compared.notCompared` since this gate), it is yours.
5. A suite that changes or adds files under `eval/fixtures/` must write the ranking baseline again in the same change (`npm run eval:match -- --write-baseline`); `fixtures.test.ts` fails otherwise.

### MKT-4F (feed, hybrid retrieval)

1. A live value carries `scope: 'live'`. Retrieval variants for the live pool are `RETRIEVAL_VARIANTS` in `eval/live/snapshot.ts`; that file has no owner after M1 (ask the orchestrator). Live recall of hybrid against recency needs the lexical, dense and fused variants added there.
2. A suite that measures the feed ORDER (where the stated goal may count) is the place to gate career changers: on the fit order their NDCG@10 is 0.38 (intl) and 0.34 (cn), reported and not gated, because the labels follow the wanted role and INV-2 forbids the fit to read it. Report them with `subset: CAREER_CHANGER_SUBSET`; a new gate that should not read them needs `exceptSubsets`.
3. The latency suite (`feed_p95_ms`) is yours to build or to hand to the owner's running stack (Owner 12). Baseline rule as MKT-4E.5.

### MKT-4G (scorer v4)

0. **Tier hysteresis sits on the other path than strategy I5 describes (review finding, low; not changed at the gate, see Owner 20).** As built by MKT-1F's item, `assembleFit` keeps the STORED tier of an AI row whose total is recomputed without a model call (logistics answers or weights changed) until the total is 3 points past an edge (`hysteresisTier`), and a new model result takes its own tier. So a card can show "78 / Great fit" while `/help/ranking` prints "Great fit 80 and up", and the Great view lists it. Strategy I5 reads "a displayed tier changes only when the score crosses a threshold by at least 3 points, or inputs changed": a recompute IS changed inputs (the exempt case), and the noise the rule is for comes from a new model result. If the owner chooses the strategy's reading: `assembleFit` uses `tierForScore(score, config.tiers)` for a recomputed row, and your re-score path keeps the stored tier when the new result is within 3 points of the edge it crosses (tests to move: `fit.test.ts` "hysteresis…", `MatchService.test.ts:220`). The "Why this job" headline no longer disagrees with the card either way (`ExplainMatchInput.tier`, applied at this gate).
1. The AI path still passes `logisticsDimension` (the facts) to the scorer and to the total: decide whether a filter-guaranteed logistics part counts at the prior there too. `spearman_human` has a metric and a gate and no producer. Baseline rule as MKT-4E.5.

---

## M5 bundles

### MKT-5C

1. PAR carry-over 7a, if MKT-2H left `publicList` alone (MKT-2H.4).

### MKT-5E

1. PAR carry-over 4 (the GoHire syndication endpoint and the assumed contract of the interim reader) is yours, unchanged.

### MKT-5H (env examples and the final pass over the plan documents)

1. `.env.example`, Stripe block, once MKT-2B has merged and `STRIPE_WEBHOOK_TRIES_EVERY_SECRET` is true: remove the interim sentences ("Until phase M2 of the market wave (MKT-2B) is merged the webhook route verifies with a single value: set one secret, not a list. Until then a list keeps Stripe payments closed (…)" above `STRIPE_WEBHOOK_SECRET=`, and "Until then, when both names are set only ROBOAPPLY_STRIPE_WEBHOOK_SECRET is used to verify, so never leave it blank in front of a real STRIPE_WEBHOOK_SECRET." above `# ROBOAPPLY_STRIPE_WEBHOOK_SECRET=`) together with the test "warns that until phase M2 the webhook is verified with one value, that a list keeps payments closed, and which name wins". Add that the billing portal configuration is created by code.
2. `.env.example` and `deploy/cn/cn.env.example`, `JOB_SOURCES_CONTACT` / `CN_JOB_SOURCES_CONTACT`, once M3 has merged: remove "Sent by the job-source adapters from phase M3 of the market wave; before that the variable has no effect." in both files and the matching `expectHas` line. The line "# Taiwan open data (licence pending verification; WP-42 stub stays off)" is rewritten when MKT-3E replaces the stub.
3. `__tests__/deploy/envExample.test.ts`: extend `M1_LITERAL_NAMES` / `M1_PATTERN_NAMES` (or add M2 to M5 lists beside them). `M1_SHELL_ONLY_NAMES` (new at this gate) holds names that are documented in prose and must have NO `NAME=` entry (`EVAL_LIVE`). `commentAbove(text, '# NAME=')` returns the comment block over an entry.
4. `ARCHITECTURE.md`: the four paragraphs headed "**Market wave (2026-10).**" (sections 4.3, 4.7, 4.8, 7.1) are still "planned, phase Mx" text (search `planned, phase M`); the paragraph under 4.5 added at this gate and the one in 2.1 are as built. The design-time table of 7.1 still shows `autofill` free 4 and the old plan keys; section 4.4 still names `linkedin 150` among the daily budgets and Appendix A lists `INGEST_LINKEDIN_DAILY_CALLS`.
5. `PRODUCT_PLAN.md` section 6.2 lists fewer buckets than strategy section 3 (`ai_answer` and `competitiveness` are missing).
6. `.env.example`, Alipay block, still reads "The rail's own credential, as STRIPE_SECRET_KEY is Stripe's"; Stripe now needs a webhook secret as well.
7. The legacy lines `STRIPE_ROBOAPPLY_*_PRICE_ID` stay active and empty: `server/src/lib/rateCard.ts` and `mockInterviewPlans.ts` still read them for the legacy starter / growth / premium rows.

---

## Orchestrator

**At the M2 gate**

1. Confirm MKT-2B did both halves of MKT-2B.1 (the route loops AND the constant is true), or neither. Then `MARKET_TASK_PLAN.md` 3.1 (row "Stripe env helpers") and section 5 (the M1 webhook-secret row) lose their "as built" interim wording.
2. `npm run eval:match -- --enforce M2`. The ranking baseline was written at this gate from the merged fit order (`fixtures/baselines.json`: NDCG@10 0.951479 intl, 0.941762 cn; NDCG@20 0.963831 intl, 0.959775 cn; fixtures hash `5b4aa710…`). A `ranking` row that fails is a finding for the bundle that changed the order, with the persona-level numbers from `--json <file>`; accepting a lower value is the owner's decision and is done by `--write-baseline`, never by editing the file. A `language` row that fails is a finding about Traditional Chinese or cross-language resumes, not about the harness.
3. Files with no owner in a later phase that a later bundle may need: `server/src/features/match/eval/live/snapshot.ts` (MKT-4F.1), `components/features/match/DimensionList.tsx` in M2 (MKT-2F.2), `server/src/platform/brand/registry.ts` (MKT-3B.3), `server/src/features/jobs/ingest/verifyFeed.ts`, `components/features/marketing/PricingPage.tsx` in M2 (MKT-2E.5), `server/src/features/compliance/explainMatch.ts` before M4 (MKT-2F.2a).

**i18n merge and translate (one pass, after the last market phase; adds to the lists of `wavePAR-carryover.md`)**

`node scripts/i18n-merge-staging.mjs --dry-run` at the end of this gate: **valid; 691 new keys, 10 changed, 0 removed; 382 zh keys go to `zh.json`, 0 to the GoApply override** (after the review resolution: five new keys, three of them with zh).

4. New in M1: `credits.pricing.samePriceAsWeekly`, `credits.pricing.refund.{first,renewal,packs,withdrawal}`, `credits.pricing.studentOffer.{title,row,how}` (zh staged too, GoApply shows them); `billingCn.pricing.passNote`, `billingCn.pricing.practicePerMonth`, `billingCn.pricing.refund.{first,packs,oneTime,entity}` (en and zh); `fit.compared.evidence.logistics_by_your_filters` (staged at this gate). Changed in M1: `landing.ranking.fit.body` (a second time at this gate: one sentence on how a job with a full analysis is placed under Best fit). New from the review resolution at this gate: `legal.explain.notCompared.{title_level,industry,logistics}` (en and zh staged; GoApply's "Why this job"), `fit.compared.notCompared`, `landing.home.pricing.notOpen` (RoboApply's home; GoApply's `landing.cnHome.pricing.notOpen` existed).
5. Rules for the translator: the refund strings use ICU plurals on `{days}`, `{hours}`, `{months}`; `billingCn.pricing.refund.oneTime` takes `{days}` as an already formatted list ("7, 30, and 90"); keep 一次性付款 · 到期不自动续费 and 收款主体：{entity} verbatim in zh; no pricing string may gain a digit, a percent sign, a currency symbol or a brand name (`pricingPage.test.tsx` scans the staging files); `fit.compared.evidence.logistics_by_your_filters` keeps `{text}` last.
6. Keys no component reads any more (remove from all nine bundles after the merge; grep each first): `landing.pricingPage.refund1` to `refund4`, `landing.pricingPage.passRefund1`, `passRefund2`, `landing.pricingPage.notSet`, and, since this gate, `landing.home.pricing.notSet` and `landing.cnHome.pricing.notSet` (the home pricing card no longer says "Price not set yet"; the staged copies in `i18n/staging/landing.en.json` and `landing.zh.json` go with them). Since the review resolution also `fit.compared.notStated` (replaced by `fit.compared.notCompared`). Do NOT remove `legal.explain.notStated.{title_level,industry,logistics}` yet: nothing emits them today, and MKT-2F.2a may bring them back for the case where the posting's side is the missing one; remove them at the last pass only if `EXPLAIN_KEYS` still lacks them.
7. `i18n/staging/_pending-translation.json` still holds the old English of `landing.ranking.fit.body` (the file is cumulative and stale; compute the real gap per locale).
8. GoApply shows every new key in English until the merge.

**Schema requests for the orchestrator**

None is required by M1. One optional, additive request (MKT-1E; needed only if MKT-3E decides that a provider's occupation code must win over the model, MKT-3E.3, and it would let the roles backfill replace its "held by a retired word" heuristic with a stored fact):

```prisma
// server/prisma/schema/ra-jobs.prisma, model RAJob
/// Who set the role: 'title' (deterministic match), 'model' (enrichment), 'provider' (an occupation code of the source).
taxonomySource String?
```

Apply it only together with a bundle item that writes it (ingest: `'title'` or `'provider'`; enrichment: `'model'` or `'title'`); a column nothing writes says nothing.

**Before the branch is deployed (adds to `orchestrator-queue.md`)**

9. Every database needs the M0 push before it runs the M1 code: the feed and match projections select `RAJob.skillIds`, `contentHash`, `lang`, `requirements`, `titleMatchScore`, `RAJobMatchScore.jobContentHash`, `rubricVersion`, and ingest now writes `RAJob.titleMatchScore`.
10. The deploy re-enriches every live row once (`ENRICH_VERSION` 1 → 2; MKT-1E's estimate from the research note's figures, not a measurement: 1,400 to 1,500 model calls on the clone index, inside one day of `ENRICH_DAILY_JOBS`).

---

## Owner

**Stripe (RoboApply)**

1. A `sk_test_` key and a `stripe listen` secret for the clone `.env` (strategy §7 item 2). Until then RoboApply on the dev stack shows prices and cannot open a payment: the live key in the clone `.env` is refused outside production, by design.
2. Before the first production deploy of this code: (a) confirm ONE webhook secret is set next to the key on Vercel (`STRIPE_WEBHOOK_SECRET` or `ROBOAPPLY_STRIPE_WEBHOOK_SECRET`; not a list until MKT-2B is merged). A deployment with a key and no webhook secret now **stops selling** (plans listed, `payments_disabled`, one warning line); before M1 it would have taken money and never fulfilled. (b) Say whether production runs on Vercel: `VERCEL_ENV=production` is the only production signal, so a production elsewhere must set `STRIPE_ALLOW_LIVE_KEY_OUTSIDE_PRODUCTION=true`. (c) If the key is restricted, give it write access to Products and Prices: the first checkout of each plan creates its Product and Price in that Stripe account.
3. A deployment with no price variable now **sells every plan at the catalog amounts** ($9.99 / $24.99 / $54.99, pass $9.99, packs $9.99 / $24.99, student $17.49 / $37.99). A deployment that set the old pair (`STRIPE_PRICE_<KEY>` + `_CENTS`) keeps its prices.
4. Choices MKT-1A made that you may overrule: English `custom_text` on Stripe's payment page for every locale (the page chrome follows the app locale); a 60-second idempotency bucket for a client that sends no `Idempotency-Key`.

**Pricing page and plan sheet**

5. The closed-state rule: a plan row that is off sale always says "Not available yet", also when payments are closed altogether (PAR-6 showed the tag only while other plans could still be bought). It adds the tag to GoApply's rows under the kill switch. To restore "said once", it is one condition (`&& paymentsOpen`) in `PlanPicker.tsx` `renderOption`.
6. Counsel: the GoApply refund lines on `/pricing` are now printed (`i18n/staging/billingCn.zh.json`, `pricing.refund`); when counsel clears the GoApply refund rules the stored version loses its `-pending-counsel` suffix in `refunds.ts` (the public label does not change).
7. The home pricing card and `/pricing` never say "Price not set yet" any more (strategy M-13); say if a deployment should ever be able to state that.

**Matching**

8. Confirm the logistics prior of 50 and the logistics rule (a check met only through your own filter is not compared and counts at the prior; the visa check is never filter-guaranteed). The four other priors are replaced by a market's own mean at 200 scored values; logistics never is.
9. 管培生: MKT-1E did not make it an alias of a role (no node is a management-trainee role; filing it under one states a category the posting does not, D3). It is stripped like a level word, so "销售管培生" is a sales title and a bare 管培生 stays unknown. Strategy 2.5 names it in the mainland alias layer: overrule with one line in the data file if you want it.
10. Under "Best fit" a job with an AI score of 70 and an estimate of 60 sorts on 65 until a market has its calibration map (500 pairs). A sharper case: a card showing 78 (AI, estimate 50) ranks on 64 and is listed BELOW an unscored card showing 66. Say if Best fit should sort on the shown number instead. Until you do, the copy states the blend (review resolution at this gate): one sentence added to `/help/ranking` (`landing.ranking.fit.body`, staged: "…a job with a full analysis is placed halfway between its quick estimate and its analysed score, so its place in the list can differ from the number on its card") and to the published factor text (`RANKING_FACTORS[fit].what`). If you choose the shown number, both sentences go. Also open: an AI row whose estimate is null ranks on the raw AI score next to rows that are blended (`fitForRank`).
11. A quick estimate with low confidence keeps its Good or Great badge on the card in the Everything view and is left out of the Good and Great views (strategy 2.4 as written; a student with no resume can see "Great, quick estimate" on a card that the Great filter then hides). The alternative is to limit a low-confidence estimate to Possible, which also puts most postings that list no skills at Possible. A job with no fit at all still passes the Good and Great views (F-FILT-05). Decide which you want.
12. Record the feed's p95 on a running stack before and after this merge (the 150 ms gate has no measurement), and choose `EVAL_JUDGE_MODEL`, confirm the minimum of 30 audited pairs (`JUDGE_TRUST_MIN_PAIRS`) and run the first `EVAL_LIVE=1 npm run eval:match -- --live` (it has never touched a real database or model).
13. The labelled title sets (300 per market) and the constructed ranking labels are engineer-written and synthetic. GoApply relevance on a real mainland corpus is still unmeasured (strategy 2.5 release gate). Since the review resolution the harness prints the taxonomy rows as `authored labels` (a new label kind: written by the engineer of the code under test), never `human labels`; `human` is kept for a recruiter's grading. The 0.996 / 0.9925 precision is therefore a regression guard on cases the team thought of, not a measurement of real titles: a recruiter-graded sample is what would make it one.

**Data (run after the deploy, dry run first)**

14. `npm run backfill:pay -- --market intl` (and `cn`): read the dry run, then `--apply`. It depends on nothing else.
15. `npm run backfill:roles -- --market intl` (and `cn`): since this gate ingest keeps an enriched role on refresh, so `--apply` is no longer blocked. It makes no model call itself; it queues `job.enrich` items that drain inside the daily budget and skips rows a model already decided.

**Taiwan pay parser (confirm or reject; each is one place in `normalize/salary.ts`)**

16. The statute's own clause ("每月經常性薪資達4萬元以上") is "pay not listed" by itself, in any market and country, also on a row whose country is CN (Taiwanese employers post mainland jobs with that sentence). The `40,000` digit form takes the same optional lead-in as the `萬` form, so on a Taiwan row "面議，月薪 60,000 以上" is stored as not disclosed, words kept. These are conservative losses by design. Added at the review resolution: with the statute's term the clause is also recognised with a month marker or 含 before 以上 ("經常性薪資4萬/月含以上") and, next to 面議 / 依公司規定 wording only, with no 以上 at all ("面議（經常性薪資達4萬元）"). Without such wording "經常性薪資5萬元" stays a stated amount. Say if the statute's term with a round threshold amount should always be "pay not listed", wording or not.
17. GoApply's job-source User-Agent contact is `CN_JOB_SOURCES_CONTACT` (default `https://www.goapply.top`); RoboApply's is `JOB_SOURCES_CONTACT`. Set both to a monitored mailbox or page before M3 turns the adapters on.

**From the review resolution at this gate**

18. **Student plans carry one label, the student percentage, and no "Save N%"** (strategy 4.1 / 4.2 as written). Before the fix Student Quarterly printed "Save 49% compared with paying monthly" (学生季卡: 41%), a comparison with three months of the REGULAR monthly price that no student pays. If you want a saving line on the student quarterly plans, the true one compares with the student monthly plan: 27% on RoboApply ($37.99 against 3 × $17.49) and 20% on GoApply (¥69 against 3 × ¥29). It is one argument in `planViews.ts` (`savingsPercent(p, studentMonthly)`) and in `lib/pricing.ts` `displayPrice`, plus the strategy tables.
19. **One listing rule for student plans on both brands.** GoApply lists them for a verified student only and publishes the prices to everyone else (`studentOffer`); RoboApply lists them for every caller and refuses the purchase without a confirmed school email. `features/credits/service.ts` calls this an owner decision (P7). Until it is one rule, MKT-2E.5 closes the dead end on RoboApply's `/pricing`.
20. **Tier hysteresis (strategy I5).** Built as the MKT-1F item says (a recomputed stored row keeps its tier within 3 points of an edge; a new model result takes its own), which is the reverse of the strategy's sentence. Effect: a card can show a number and a tier that disagree with the thresholds `/help/ranking` publishes (78 / Great). Choose: keep it (then `/help/ranking` should say a tier can lag the score by up to 3 points), or the strategy's reading (MKT-4G.0).

---

## Applied at the gate (for context)

Red at the start: 1 test (`server/src/platform/credits/EntitlementService.test.ts`). Green at the end. No test named `A<n> …` was edited and none was red; `fulfilPass.ts`, the Alipay callback route and `handleAlipayCallback` were not edited.

- **Seam fix in a test (the code was right by strategy M-13, M-25 and §4.3):** `EntitlementService.test.ts`: "Get Pro" on RoboApply needs the Stripe rail ready (a usable key and a webhook secret); no price variable is needed. MKT-1A's replacement, with the four new names in the env list the test blanks.
- **Seam fix in code, MKT-1E to ingest:** a model's role override was undone by the next ingest refresh. `normalize/types.ts`, `normalizeProviderJob.ts` (`taxonomyIdsForTitle` returns the score, better of two readings), `ingest/upsert.ts` (`titleMatchScore` written; the role of an enriched row replaced only on a decisive or a changed title), SQL snapshot and tests. One addition to MKT-1E's text: a changed title also lets ingest's role in (the stored role was decided for another title; a changed posting is re-enriched).
- **Requests applied:** area index exports for the MKT-1C contracts (`sources/index.ts`, `ingest/index.ts`, `normalize/index.ts`); `verifyFeed.ts` names the `activejobs` board's provider by rule; `JOB_SOURCES_CONTACT` is in `BRAND_OWN_ENV`; the evidence ref `logistics_by_your_filters` has its label and staged string; the home pricing card no longer says "Price not set yet"; the shared credit fixture says free autofill 20; `package.json` aliases `backfill:roles` and `backfill:pay`; the `pay.stripe` comment in `flags.ts`.
- **Env examples brought in line with the merged code** (`.env.example`, `deploy/cn/cn.env.example`, `__tests__/deploy/envExample.test.ts`): only `sk_test_` / `rk_test_` are test keys; a webhook secret list keeps payments closed until the route tries each secret (the earlier text said it opened checkout); the RoboApply secret name is read first; a non-Vercel production needs the override; an invalid price override and a pin next to two differing amounts are ignored and logged; `EVAL_LIVE` is a shell switch with no entry; the judge differs from the scorer of the market being judged; `MATCH_PRIORS` and the data-derived priors; `CN_JOB_SOURCES_CONTACT` in both files.
- **Documents:** `MARKET_TASK_PLAN.md` (3.1, 3.2, 3.3 contract rows, section 5 env rows and the M1 gate row, each marked "as built"); `ARCHITECTURE.md` 4.5 (the 0.9 rule, `titleMatchScore`, `weak_title_match`, the ingest refresh rule, the industry field and its quote rule); `market/JOB_SOURCES_CN.md` §2.1 and §8 rule 3 (a bank row is listed only when its posting-page template is set); `orch/market-bundles.json` (MKT-2B owns `stripeEnv.ts` and its test for the constant; one sentence added to its item 1; `check-bundles.mjs` reports 0 problems).
- **New test:** `__tests__/contracts/billingPlans.seam.test.ts` feeds the real response of the server's plans service, through JSON, to the web's own reader (`plansBillingFacts`) for both brands.
- **Harness:** `fixtures/baselines.json` written from the merged fit order with `npm run eval:match -- --enforce M1 --write-baseline` after the gate passed (MKT-1D request 1).
- **Contracts checked field by field and found in agreement:** `GET /billing/plans` additive fields (names, types, null rules); the `Idempotency-Key` header (pattern on both sides, the web's `POST /billing/checkout`, the server's read in `roboapply/routes/billing.ts`, the Stripe key shape) and `X-Robo-Locale` to the Checkout locale for all nine app locales; `stripeRailReady` behind `pay.stripe`, the rail's `isConfigured`, plan sellability and `proSellable`; the feed's one `getFits` call per window on the production fit service; the M0 columns in `JOB_SELECT` and `FEED_COLUMNS`; the fit seams the harness binds (`npm run eval:match -- --enforce M1` exits 0: INV-1, 2, 4, 5, 6, 8, 9, 10 pass, INV-3 and INV-7 pending by design).
- **Review resolution (cross-review findings, same gate; each with a test that failed before):**
  - *Stripe (medium):* `stripeEnv.ts` `stripeWebhookCanVerify` requires the one string the route reads to hold no whitespace and no comma (a trailing newline opened the rail while every webhook answered 400), and a secret with whitespace inside it verifies neither way; four cases in `stripeEnv.test.ts`; one sentence in `.env.example` and the `MARKET_TASK_PLAN.md` 3.1 row.
  - *Pricing (medium, two findings):* a student plan carries no "Save N%" (`planCatalog.ts` `savingsPercent`, `lib/pricing.ts` `displayPrice` / `isStudentPricedPlan`); tests on both brands, the TWD price, `/pricing` and the plan sheet. Owner 18.
  - *Taiwan pay (high):* MKT-3C.9 (`normalize/salary.ts`, `sources/atsPublic/hooks.ts`, tests in `salary.test.ts` and `atsPublic.test.ts`).
  - *"Why this job" (medium):* `legal.explain.notCompared.*` for role, industry and logistics (MKT-2F.2a); `ExplainMatchInput.tier` passed by the feed and the job page (low finding on the headline).
  - *Job page (medium):* `DimensionList.tsx` reads `fit.compared.notCompared` (MKT-2F.2).
  - *Harness (medium, low):* label kind `authored` for the taxonomy rows (`gates.ts`, `taxonomy.suite.ts`, README); the suite and `precision.test.ts` file a title through ingest's own `taxonomyIdsForTitle` (new seam). `npm run eval:match -- --enforce M1` prints the same four values (0.9960 n=250, 0.8333 n=300, 0.9925 n=266, 0.8867 n=300) and exits 0.
  - *Home (low):* `PricingSummary` says the namespace's `notOpen` by itself while `paymentsOpen` is false, so RoboApply's home says "Paid plans can't be bought yet." as GoApply's does.
  - *Guard proof (low):* `stripeSingleClient.test.ts` also scans `app/`, `lib/`, `components/`, `hooks/`, `interview-agent/`, `extension/src/` and the root source files (`proxy.ts`, `next.config.mjs`, …).
  - *Ranking copy (low):* Owner 10. *Contract comments (low):* `features/credits/contract.ts` and the `PlanPicker.tsx` header state the student listing rule the code has; RoboApply prices are catalog defaults.
  - *Carried over, not built:* MKT-2E.5 (student card on `/pricing`), MKT-4G.0 and Owner 20 (hysteresis), Owner 19 (one student listing rule).
