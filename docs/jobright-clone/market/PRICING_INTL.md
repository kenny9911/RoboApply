# International pricing (RoboApply, USD, Stripe; Taiwan with a TWD reference)

**Researched:** 2026-10-11. **Scope:** RoboApply (`roboapply.io`) only. GoApply prices and the Alipay rail are untouched by anything here.
**Confidence marks:** `confirmed` = read on the vendor's own page or in our code this session; `likely` = two or more dated third-party sources agree, or one authoritative secondary source; `inferred` = my reasoning from the evidence.
**Not legal or tax advice.** Section 7 lists what counsel and a tax adviser must sign off.

---

## 1. Summary: confirm or adjust

| SKU | Owner starting point | Recommendation | Verdict |
|---|---|---|---|
| Free | daily credits per PRODUCT_PLAN §6.2 | Keep. Raise free `autofill` from 5 to 20 a day (deterministic fills cost almost nothing and the main autofill competitor gives them away). | Confirm, one small adjust |
| Pro weekly (`pro_weekly`) | $9.99 / week | **$9.99 / week** | Confirm |
| Pro monthly (`pro_monthly`) | $24.99 / month | **$24.99 / month** | Confirm |
| Pro quarterly (`pro_quarterly`) | $59.99 / 3 months | **$54.99 / 3 months** (label computes to "Save 26%"). At $59.99 our own code prints "Save 19%", not the "Save 20%" the plan promises. | Adjust |
| 7-day pass (`pro_week_pass`) | $6.99 once | **$9.99 once** (same price as weekly, no renewal). Keep $6.99 only as the optional first-pass "Welcome price" through the existing offers seam. At $6.99 the pass strictly beats the $9.99 weekly plan, so the auto-renewing plan is only ever bought by mistake. | Adjust |
| Practice pack 5 (`practice_pack_5`) | $9.99 | **$9.99** ($2.00 per 20-minute credit) | Confirm |
| Practice pack 15 (`practice_pack_15`) | $24.99 | **$24.99** ($1.67 per credit), after the owner checks real voice cost per session (§5.6) | Confirm, with a cost check |
| Student monthly / quarterly (V2) | 30% off | **$17.49 / month, $37.99 / 3 months** (both compute to "30%") | Set |
| Taiwan | USD + TWD reference | Launch on USD with the reference line; real TWD list in V2: NT$299 / 749 / 1,650, pass NT$299, packs NT$299 / 749 | Set |
| Regional (PPP) prices | none | None at launch. Fixed local-currency price lists later; never Adaptive Pricing on subscriptions (§6.3). | Confirm |

Everything is configuration: `STRIPE_PRICE_<PLANKEY>` plus `STRIPE_PRICE_<PLANKEY>_CENTS` in `server/src/platform/billing/planCatalog.ts`. No code change is needed for any price above. The one optional code change is the `autofill` cap in `server/src/platform/credits/catalog.ts` (also changeable at runtime through AppConfig `credits.catalog.v1`).

---

## 2. What comparable products charge (2025–2026)

Prices are USD unless noted. "Wk/mo ratio" is the weekly price divided by the monthly price.

### 2.1 Job-search copilots and trackers (our direct set)

| Product | Weekly | Monthly | Quarterly | Longer | Free tier | Trial / refund | Confidence and source |
|---|---|---|---|---|---|---|---|
| **Jobright Turbo** | $17.99 | $39.99 (was $29.99 in 2025) | $89.99 | none public | about 2 tailored resumes, 2 cover letters, 4 autofills a day; 1 saved filter; 1 instant alert; copilot chat not capped | No trial. Refunds discretionary; reviewers report "all sales final" wording at times. No public pricing page. | likely. https://zplatform.ai/ai-reviews/jobright-ai/ ; https://outapply.com/blog/jobright-ai-pricing ; https://resumehog.com/blog/posts/jobright-ai-review-2026-is-this-job-search-copilot-worth-it.html ; https://www.trajobo.com/guides/jobright-review |
| Jobright interview passes | Company Pass $19.99 / 7 days | All-Access $39.99 / 30 days | — | — | preview only | one-time, no renewal | likely (our earlier bundle read plus FavTutor); see `docs/jobright-clone/research/network-tracker-interview.md` §4.1 |
| Jobright coaching | $69.99–$79.99 per 30-minute session | | | | | | likely. https://jobright.ai/coach-landing ; https://jobity.io/blog/jobright-review |
| **Simplify+** | $19.99 (a July 2026 review saw a $15.99 promo) | $39.99 ($31.99 promo) | $89.99 ($71.99 promo) | — | Autofill extension, tracker and matching are free with no stated cap | No trial. Non-refundable once active; pro-rated refund only for an accidental renewal reported within 24 hours (policy updated 2026-08-26). No public pricing page. | prices likely: https://www.wobo.ai/blog/simplify-review/ ; https://www.liftmycv.com/blog/simplify-jobs-review/ . Refund policy confirmed: https://simplify.jobs/refund-policy |
| **Teal+** | $13 / 7 days | $29 / 30 days | $79 / 90 days | none | Unlimited resumes, limited AI credits, top-5 keywords | Auto-renews; refund policy not published | likely (official page returns 403). https://toolradar.com/tools/teal-hq/pricing ; https://frontdeskreview.com/software/resume-builders/teal.md |
| **Huntr Pro** | — | $40 | $90 | $160 / 6 months | 100 tracked jobs, 2 tailored resumes, a few AI credits | No trial. Cancel in settings, runs to period end. No refund policy on the page. | confirmed. https://huntr.co/pricing |
| **Careerflow** | — | $23.99 Premium; $44.99 Premium Plus | offered | about $173 / year | 1 resume, 10 tracked jobs | — | likely. https://www.toolsforhumans.ai/ai-tools/careerflow ; https://resumehog.com/blog/posts/careerflow-review-2026-is-the-ai-career-copilot-worth-it.html |
| **JobCopilot** (auto-apply) | from $8.90 | about $28–39 | offered | — | none | No trial; 7-day refund only for technical failure. Page shows per-day prices ($0.93 / $1.05). | per-day prices confirmed: https://jobcopilot.com/pricing/ ; rest likely: https://www.dreamworkhq.com/blog/jobcopilot-review |
| **LoopCV** | — | €8.99 / €29.99 / €87.99 | 3-month billing, "save up to 25%" | — | free plan | priced in euros | likely. https://blog.fastapply.co/fastapply-vs-loopcv-review-and-comparison-2026 |
| **AIApply** | — | $29 toolkit; auto-apply sold separately at $49 / $99 | $199 / 3 months (Pro+) | $12 / month billed yearly | limited | — | likely. https://clickhired.ai/blog/aiapply-pricing-in-2026 ; https://jobity.io/blog/aiapply-review |
| **Sonara** | — | $23.95 every 4 weeks after a $2.95 14-day trial that converts automatically | — | $71.40 / year | none | paid trial that auto-converts | likely. https://blog.fastapply.co/sonara-pricing-2026 |
| **LazyApply** | — | — | — | $99 / $149 / $999 a year (15 / 150 / 1,500 applications a day); the old lifetime deal is gone | none | refund terms disputed between reviews | likely. https://www.dreamworkhq.com/blog/lazyapply-review |

### 2.2 Resume tools

| Product | Monthly | Quarterly | Longer | Free tier | Refund | Student | Source |
|---|---|---|---|---|---|---|---|
| **Jobscan** | $49.95 | $89.95 | — | 5 scans a month | trial on quarterly (7 or 14 days; sources differ) | — | likely. https://jobshinobi.com/compare/jobscan-resume-scanner-review-2026 |
| **Rezi** | $29 | — | $149 lifetime | 1 resume, 3 PDF downloads, 1 AI interview | 30-day money back | none listed | confirmed. https://www.rezi.ai/pricing |
| **Kickresume** | $24 | $54 | $96 / year | 4 templates, no AI writer | 14-day money back, no questions | **free Premium for verified students** (ISIC / UNiDAYS) | confirmed. https://www.kickresume.com/en/pricing/ |

### 2.3 Interview practice

| Product | Price | Notes | Source |
|---|---|---|---|
| **Final Round AI** | $90–$150 a month; $180–$250 a quarter; $300 a year (sources conflict by date) | Refund only within 72 hours on first quarterly or annual purchase; monthly non-refundable | likely. https://ophyai.com/blog/career-advice/final-round-ai-pricing ; https://www.finalroundai.com/blog/final-round-ai-pricing |
| **LockedIn AI** | about $54.99 a month unlimited; about $69.99 a month credits plan | Monthly and quarterly non-refundable once started | likely. https://ophyai.com/blog/career-advice/lockedin-ai-review ; https://jobright.ai/blog/lockedin-ai-pricing/ |
| **interviewing.io** | from $179 per human mock session; $225–$339 for named-company interviewers | Human experts, not AI | likely. https://www.lodely.com/blog/interviewing-io-pricing |
| **Pramp (now on Exponent)** | 5 free peer-mock credits a month; Exponent membership $79–$99 a month | Peer practice | likely. https://igotanoffer.com/en/advice/pramp-alternatives ; https://www.lodely.com/blog/exponent-pricing |
| **Yoodli** | $8 / $20 a month billed yearly | 10 role-plays a week on the lower plan | likely (search summary of the vendor page). https://yoodli.ai/pricing |
| **Huru** | about $24.99 a month | — | likely. https://www.itechguides.com/products/huru/ |
| Google Interview Warmup | was free | Reported closed in April 2026 | likely (one source). https://www.aceround.app/es-419/blog/google-interview-warmup-free-alternative/ |

### 2.4 What the table says

1. **There are two price clusters.** Copilots and trackers with matching charge $39.99–$40 a month (Jobright, Simplify+, Huntr). Resume and career tools charge $24–$29 (Careerflow $23.99, Kickresume $24, Teal $29, Rezi $29). Our $24.99 sits at the bottom of the second cluster while offering the first cluster's scope. [inferred from §2.1–2.2]
2. **The weekly / monthly / quarterly ladder is the category standard.** Jobright, Simplify+, Teal and JobCopilot all sell it. Weekly-to-monthly ratios: Jobright 0.45, Simplify+ 0.50, Teal 0.45. Ours at $9.99 / $24.99 is 0.40. [confirmed arithmetic on likely prices]
3. **The standard quarterly discount is 25%.** Jobright ($89.99 vs $119.97), Simplify+ and Huntr ($90 vs $120) are all exactly 25%; Kickresume is 25%; Jobscan is 40%; Teal is the outlier at 9%. [confirmed arithmetic]
4. **Nobody in the copilot cluster offers a free trial; paid trials exist only where they auto-convert** (Sonara $2.95 → $23.95 every 4 weeks). [likely]
5. **Refund terms are the category's weak spot.** Simplify+ is non-refundable; Jobright is discretionary; Final Round AI and LockedIn AI refuse monthly refunds. Only resume tools give real guarantees (Kickresume 14 days, Rezi 30 days). Billing and cancellation dominate Jobright's one-star reviews (https://zplatform.ai/ai-reviews/jobright-ai/). A published refund rule is a differentiator. [likely]
6. **No direct competitor publishes regional or PPP prices.** Jobright and Simplify+ are USD only; LoopCV simply prices in euros. [likely]
7. **Student pricing is rare.** Kickresume gives Premium free to verified students; Jobright advertises none (https://outapply.com/blog/jobright-ai-pricing). [confirmed / likely]
8. **Two leaders hide their prices.** Jobright and Simplify+ have no public pricing page. Our public `/pricing` (PRODUCT_PLAN §6.1 rule 1) is a real point of difference. [likely]
9. **AI interview practice is expensive elsewhere.** $55–$150 a month for AI copilots, $179+ for one human session. A $2 practice credit is far below anything on the market. [likely]

---

## 3. Weekly versus monthly: what the evidence says

- A weekly price reads small but is the most expensive way to buy. $9.99 a week is about $43 a month (our code prints exactly this: `monthlyEquivalentMinor` gives $43). Jobright's $17.99 a week is about $78 a month. [confirmed in `lib/pricing.ts`]
- Weekly subscribers do not stay. RevenueCat's 2026 report puts 12-month retention of weekly plans at 1.7% for ordinary apps and 2.5% for AI apps, against 9.5% / 6.1% for monthly and 30.7% / 21.1% for annual; AI apps also see higher refund rates. Source: https://techcrunch.com/2026/03/10/ai-powered-apps-struggle-with-long-term-retention-new-report-shows ; https://revenuecat.com/state-of-subscription-apps/ . [likely; mobile-app data, directionally relevant to web]
- A job search is a short need, so a short plan matches honest demand. The risk is the user who forgets it. Each forgotten weekly renewal is a possible card dispute, and Stripe charges $15.00 per dispute (https://stripe.com/pricing, confirmed), which is more than the $9.99 charge.
- What we already do right (keep all of it): weekly is never preselected (`neverPreselected`), the monthly equivalent is printed beside it, a reminder goes out 2 days before each weekly renewal, and cancel is one click.
- **Conclusion:** keep the weekly plan at $9.99 but treat the non-renewing 7-day pass as the product we actually want short-term buyers to choose. That is why §5.4 prices the pass at the same $9.99 instead of below it. [inferred]

---

## 4. Our catalog and credits as built (what the prices attach to)

Read this session from the worktree:

- `server/src/platform/billing/planCatalog.ts`: RoboApply plan keys `free`, `pro_weekly`, `pro_monthly`, `pro_quarterly`, `pro_week_pass`, `practice_pack_5`, `practice_pack_15`, `student_monthly`, `student_quarterly`. A plan is sellable only when both `STRIPE_PRICE_<KEY>` and `STRIPE_PRICE_<KEY>_CENTS` are set. Optional Taiwan price: `STRIPE_PRICE_<KEY>_TWD` and `_TWD_CENTS` (NT$749 = `74900`, which matches how Stripe represents TWD: https://docs.stripe.com/currencies, confirmed).
- "Save N%" is computed from our own monthly price × 3 and **rounded down** (`savingsPercent`). Student discount is computed the same way against the regular plan.
- `server/src/platform/credits/catalog.ts`: 13 window buckets with Free and Pro caps per brand; admin override through AppConfig `credits.catalog.v1`.
- Practice credits: 1 credit = 20 minutes (`RA_MOCK_CREDIT_MINUTES`). Weekly: 1 per period. Monthly: 3 per period. Quarterly: 3 per month. Pass: 1 once. Packs: 5 or 15, valid 12 months.
- `server/src/platform/billing/rails/stripe.ts`: Stripe Checkout, `mode: 'subscription'` for renewing plans and `'payment'` for the pass and packs. **No `automatic_tax` and no `tax_behavior` is set** (see §7.5).
- `server/src/platform/billing/refunds.ts`: 14-day withdrawal for EU / EEA / UK / TW unless the waiver was ticked; packs refundable while unused; first purchase 7 days (weekly and pass: 48 hours) if fewer than 5 paid-only credits used; accidental renewal 3 days.
- `server/src/platform/billing/acknowledgements.ts`: unticked auto-renew box and the withdrawal waiver, stored as consent records with a hash of the exact sentence.
- `lib/pricing.ts`: display helpers only. The TWD reference line needs an admin rate with a source and an as-of date no older than 45 days.

Two small defects found while reading (neither is a price):

1. `lib/pricing.ts` `WITHDRAWAL_WAIVER_COUNTRIES` lists the EU 27, GB and TW. The server's `withdrawalRegion()` also treats IS, LI and NO (EEA) as the EU region. A buyer in Norway therefore never sees the waiver box while the server gives them the 14-day right. The outcome is safe for the buyer, but the two lists should match.
2. PRODUCT_PLAN §6.3 says the quarterly plan shows "Save 20%". (7,497 − 5,999) / 7,497 = 19.98%, and the code floors it, so the screen will say **"Save 19%"**.

---

## 5. Recommended ladder and rationale

### 5.1 Free (confirm; one adjust)

Keep PRODUCT_PLAN §6.2 as built. Against Jobright's free tier (about 2 tailored resumes, 2 cover letters, 4 autofills, 2 contact lookups a day, 1 saved filter, 1 instant alert) ours is equal or better on every line we can compare:

| Bucket | RoboApply Free | Pro (printed as "Up to …") |
|---|---|---|
| `fit_analysis` | 10 / day | 200 / day |
| `tailor` | 2 / day | 50 / day |
| `cover_letter` | 2 / day | 50 / day |
| `resume_check` | 1 / day | 20 / day |
| `rewrite` | 20 / day | 300 / day |
| `outreach` | 3 / day | 50 / day |
| `assistant` | 30 / day | 300 / day |
| `autofill` | 5 / day → **recommend 20 / day** | 100 / day |
| `ai_answer` | 10 / day | 200 / day |
| `job_import` | 10 / day | 50 / day |
| `ready_kits` | 3 / week | 30 / week |
| `competitiveness` | 1 / week | 3 / day |
| saved searches / instant alerts | 1 / 1 a day | 10 / as they arrive |
| `practice` | 1 after email verification + 1 for the checklist | per plan (§5.2–5.5) + packs |

Why raise `autofill`: Simplify gives form autofill away with no stated cap (§2.1), and a deterministic fill costs us no model call; the model-backed part is already metered separately as `ai_answer`. Five a day would make the extension feel worse than a free competitor on its core job. This follows PRODUCT_PLAN §6.1 rule 4 (meter the per-call commodity). [inferred; priority "should"]

### 5.2 Pro monthly: $24.99 (confirm)

- 37.5% under the copilot cluster ($39.99–$40) and level with the resume-tool cluster ($23.99–$29). A new brand cannot charge the leader's price, and it does not need to undercut the resume tools.
- Net after Stripe (2.9% + $0.30 card, 0.7% Billing; https://stripe.com/pricing): about $23.79 on a US card. In a VAT country with tax-inclusive pricing (§7.5) the net falls to about $19.60 at 20% VAT ($20.83 after tax, less fees).
- Entitlements: Pro column of §5.1; 3 practice credits per period (60 minutes).
- Default selection on the plan sheet (already so in `DEFAULT_SELECTION_ORDER`).

### 5.3 Pro weekly: $9.99 (confirm)

- Lowest weekly price among copilots (Jobright $17.99, Simplify+ $19.99, Teal $13; JobCopilot starts at $8.90).
- Ratio to monthly 0.40, slightly kinder than the market's 0.45–0.50; shown with "about $43 a month".
- Entitlements: Pro column; 1 practice credit per week (the plan grant sets the balance, so unused weekly credits do not pile up).
- Never preselected. Reminder 2 days before each renewal.

### 5.4 7-day pass: adjust $6.99 → $9.99 (or keep $6.99 as a first-pass welcome price)

The problem with $6.99: the pass and the weekly plan grant the same thing (7 days of Pro and 1 practice credit). At $6.99 against $9.99 the non-renewing pass is cheaper for every possible length of use. The auto-renewing weekly plan is then a strictly worse product that costs $3 more, which only an inattentive buyer picks. That contradicts the plan's own stance against paying-by-mistake revenue (PRODUCT_PLAN §6.4), and those buyers are the ones who dispute charges at $15 each.

Market evidence points the same way. Cheap entry passes exist only where they convert automatically (Sonara's $2.95 trial). Ours never converts, by design (F-BILL-05), so it has to earn its own margin. One practice credit alone costs us real voice minutes (§5.6).

Recommendation:

- **List price $9.99, once, no renewal.** The plan sheet can then say something true and unusual: the price is the same whether or not it renews. The "Switch to the 7-day pass instead?" link at cancel still makes sense.
- **If the owner wants a low-risk first purchase**, use the seam that already exists for it (`server/src/platform/billing/offers.ts`, PRODUCT_PLAN §6.4 "Welcome price"): first pass $6.99, once per account, ending 7 days after signup, no comparison price. That is an owner switch (OPS-B1), off today.
- **If the owner keeps $6.99 as the list price**, change one thing so the weekly plan is not dominated: remove the practice credit from the pass (`practice: null` for RoboApply's `pro_week_pass`). The weekly plan then buys a practice credit and continuity for the extra $3.

Three passes ($29.97) cost more than a month ($24.99), so the pass still hands longer searches to the monthly plan.

### 5.5 Pro quarterly: adjust $59.99 → $54.99

- At $59.99 the computed label is "Save 19%". To print a clean 20% the price would have to be $59.97 or lower.
- The category's quarterly discount is 25% (§2.4 point 3). $54.99 computes to 26% ((7,497 − 5,499) / 7,497 = 26.65%, floored). $55.99 computes to exactly "Save 25%" if the owner prefers the round label.
- Quarterly is the plan we want most. A typical monthly subscriber in this category leaves within one or two cycles (§3), so $54.99 collected once is more than the $24.99–$49.98 a churning monthly buyer pays. Giving up $5 against $59.99 buys a visibly larger saving on the plan with the best retention and the fewest renewal events. [inferred]
- It stays 39% under Jobright's $89.99.
- Entitlements: Pro column; 3 practice credits granted each month.
- Reminder 5 days before renewal. The one-time "switch to quarterly" suggestion after 30 days of monthly (already built) then shows a real $19.98 saving.
- Fallback if the owner keeps $59.99: change the PRODUCT_PLAN text to "Save 19%"; nothing else breaks.

### 5.6 Practice packs: $9.99 for 5, $24.99 for 15 (confirm, with one cost check)

- $2.00 and $1.67 per 20-minute credit. Against $55–$150 a month for AI interview tools and $179+ for a human session, the price is not the constraint.
- The constraint is cost. Our own rate-card defaults (`server/src/lib/rateCard.ts`) are $0.0077 per minute for speech-to-text and either $30 per million characters or **$0.18 per minute** for text-to-speech, before the interviewer model and the voice infrastructure. A 20-minute session where the interviewer speaks about 8 minutes costs roughly $0.40–$0.90 on the character rate but about $1.60 or more on the per-minute rate. At $1.67 per credit the 15-pack could run at or below cost on the per-minute rate. [inferred from defaults; real numbers are in the session cost report]
- **Owner check before launch:** read the average cost of the last 50 real sessions from the cost report. If it is above $1.00, keep the 5-pack and reprice the 15-pack to $27.99 ($1.87 per credit) or make it 12 credits for $24.99.
- Packs stay refundable while unused and valid 12 months.

### 5.7 Student (V2): $17.49 a month, $37.99 a quarter

- Both compute to "30%" with the floor rule: (2,499 − 1,749) / 2,499 = 30.01%; (5,499 − 3,799) / 5,499 = 30.9%. If quarterly stays $59.99, student quarterly is $41.99 (30.005%).
- Evidence for going deep rather than shallow: Kickresume gives verified students Premium free; Jobright has no student price while new graduates are its core audience. A real student price is a gap we can own.
- Verified school email (`.edu`, `.edu.<cc>`, `.ac.<cc>`, plus `STUDENT_EMAIL_DOMAINS`), re-verified once a year. Same entitlements as the base plan. No student weekly plan and no student pass.

### 5.8 The ladder on one screen

| Plan | Price | Per month | Renews | Practice credits | Stripe fee (US card) |
|---|---|---|---|---|---|
| Free | $0 | — | — | 1 + 1 | — |
| 7-day pass | $9.99 once | — | never | 1 | $0.59 |
| Pro weekly | $9.99 / week | about $43 | weekly | 1 / week | $0.66 |
| **Pro monthly** (default) | $24.99 / month | $24.99 | monthly | 3 / month | $1.20 |
| Pro quarterly | $54.99 / 3 months | $18.33 | every 3 months | 3 / month | $2.28 |
| Student monthly (V2) | $17.49 / month | $17.49 | monthly | 3 / month | $0.93 |
| Student quarterly (V2) | $37.99 / 3 months | $12.66 | every 3 months | 3 / month | $1.67 |
| Practice pack 5 | $9.99 once | — | never | 5 (12 months) | $0.59 |
| Practice pack 15 | $24.99 once | — | never | 15 (12 months) | $1.02 |

Fees: 2.9% + $0.30, plus 0.7% Stripe Billing on subscriptions; add 1.5% for a non-US card and 1% when the charge currency is converted (https://stripe.com/pricing, confirmed).

Env values for the recommended ladder (cents): `PRO_WEEKLY` 999, `PRO_MONTHLY` 2499, `PRO_QUARTERLY` 5499, `PRO_WEEK_PASS` 999, `PRACTICE_PACK_5` 999, `PRACTICE_PACK_15` 2499, `STUDENT_MONTHLY` 1749, `STUDENT_QUARTERLY` 3799.

---

## 6. Taiwan and other regions

### 6.1 TWD reference amounts (launch: charge in USD, show "約 NT$…")

Illustration at **NT$31.78 per US$1**, the Taipei interbank close of 2026-10-06 (https://focustaiwan.tw/business/202610060013, confirmed for that date). The admin must enter the Bank of Taiwan board rate with its source and date in AppConfig `fx.reference`; the line hides itself after 45 days. These figures are examples, not the values to hard-code.

| Plan | USD | Reference |
|---|---|---|
| 7-day pass | $9.99 (or $6.99) | 約 NT$317 (or NT$222) |
| Pro weekly | $9.99 | 約 NT$317 |
| Pro monthly | $24.99 | 約 NT$794 |
| Pro quarterly | $54.99 (or $59.99) | 約 NT$1,748 (or NT$1,906) |
| Practice pack 5 / 15 | $9.99 / $24.99 | 約 NT$317 / NT$794 |
| Student monthly / quarterly | $17.49 / $37.99 | 約 NT$556 / NT$1,207 |

### 6.2 Real TWD price list (V2, `STRIPE_PRICE_<KEY>_TWD`)

| Plan | TWD price | `_TWD_CENTS` | Against USD at 31.78 | Label it computes |
|---|---|---|---|---|
| 7-day pass | NT$299 | 29900 | −5.8% | — |
| Pro weekly | NT$299 | 29900 | −5.8% | 約 NT$1,296 a month |
| Pro monthly | NT$749 | 74900 | −5.7% | — |
| Pro quarterly | **NT$1,650** | 165000 | −5.6% | Save 26% (matches USD) |
| Practice pack 5 / 15 | NT$299 / NT$749 | 29900 / 74900 | −5.8% / −5.7% | — |
| Student monthly / quarterly | NT$519 / NT$1,150 | 51900 / 115000 | −6.6% / −4.7% | 30% / 30% |

Notes:
- PRODUCT_PLAN §6.3 proposed NT$1,790 for quarterly; that pairs with $59.99 and computes to "Save 20%" in TWD while USD shows 19%. Use NT$1,650 with $54.99 so both currencies show the same label.
- If the pass stays $6.99, its TWD price is NT$219.
- All within the plan's "parity within 10% of USD" target. Re-check when the rate moves 5%.
- A TWD charge settles to our USD balance with Stripe's 1% conversion fee on top of the 1.5% international-card fee. The NT$ list is about 6% under USD already, so Taiwan nets roughly 8% less per sale than a US card. That is acceptable for a real local price.
- Taiwan B2C tax: a foreign seller of electronic services must register for business tax once annual sales to Taiwan individuals pass **NT$600,000** (raised from NT$480,000; effective 2025-04-07 per KPMG's summary). Sources: https://www.worldjournal.com/wj/story/121347/8834622 ; https://kpmg.com/tw/zh/home/insights/2026/01/dispute-resolution-controversy-quarterly.html . [likely] `server/src/platform/billing/twRevenue.ts` already warns at 70%. After registration the displayed NT$ price must include 5% tax, so NT$749 nets NT$713.

### 6.3 Other regions: no PPP at launch

- None of the direct competitors does it (§2.4 point 6), so USD-only does not put us behind.
- Published uplift figures for PPP pricing (20–70%) come from vendors that sell PPP tooling and could not be traced to a primary study (https://fungies.io/purchasing-power-parity-saas-pricing-2026). [weak]
- Discount regions invite VPN arbitrage; the usual control is matching IP country, billing country and card country (https://kinde.com/learn/billing/optimization-and-revenue/localized-and-ppp-pricing/). Our `buyerCountry.ts` already prefers the edge country header, and Stripe reports card country, so the control is available later.
- **Do not switch on Stripe Adaptive Pricing for subscriptions.** It shows local currency automatically, but by default each renewal uses that day's exchange rate, so the renewal amount moves, and the buyer is shown a conversion fee starting at 2% (https://support.stripe.com/questions/adaptive-pricing-for-subscriptions ; https://stripe.com/pricing). Our auto-renew acknowledgement names a fixed price "every {period} at {price}"; a floating renewal would make that sentence untrue. Adaptive Pricing on the one-time pass and packs is acceptable later. [likely]
- **Later, in this order:** (1) fixed EUR, GBP, JPY and KRW price lists for the locales we already ship, as extra Stripe prices exactly like the TWD mechanism (needs the catalog's `LocalPrice` type widened beyond `'TWD'`); (2) one "emerging markets" list at about 50% for a named set of countries, gated on card country, only once there is traffic to justify it.

---

## 7. What must be true legally for auto-renewing plans

Status column: **Built** = present in the worktree code read this session; **Check** = may exist, verify in the INT browser pass; **Gap** = not found.

### 7.1 United States

| Requirement | Source | Status |
|---|---|---|
| Disclose all material terms clearly before taking billing details; get express informed consent before charging; give a simple way to stop recurring charges (ROSCA) | The FTC's 2024 "click-to-cancel" rule was vacated by the Eighth Circuit on 2025-07-08, but ROSCA and FTC Act §5 are enforced as before (Amazon paid $2.5 billion). The FTC reopened rulemaking in March 2026; no new rule yet. https://www.jonesday.com/en/insights/2026/05/ftc-revives-clicktocancel-rule-new-risks-for-subscription-businesses ; https://www.crowell.com/en/insights/client-alerts/clicking-all-the-right-boxes-ftc-moves-to-revive-click-to-cancel-rule-following-eighth-circuit-vacatur [likely] | Built: unticked "renews automatically every {period} at {price} until I cancel" box; one-click cancel; public `/cancel` |
| California Automatic Renewal Law as amended (AB 2863, contracts from 2025-07-01): express affirmative consent to the renewal terms; **keep proof for 3 years or 1 year after the contract ends, whichever is longer**; annual reminder; cancel in the same medium used to sign up; clear notice of price changes; no misstatement of any material fact | https://btlaw.com/en/insights/alerts/2025/california-expands-automatic-renewal-law-new-requirements-now-in-effect ; https://fenwick.com/insights/publications/california-tightens-requirements-for-automatically-renewing-subscriptions [likely] | Mostly built. **Gap:** our record is "kept 3 years". A subscriber who stays 30 months needs the record until month 42. Change retention to the later of 3 years after consent and 1 year after the subscription ends. |
| Retention offers at cancel must not block cancelling | same sources | Built: primary Cancel button completes in one click; the pass link is secondary and shown once |
| Treat California's rule as the floor for every US state; New York City has its own cancel rule dated 2026-10-01 | https://www.jonesday.com/en/insights/2026/05/ftc-revives-clicktocancel-rule-new-risks-for-subscription-businesses [likely, single source for the NYC date] | Policy choice: apply everywhere |
| Restate the renewal terms next to the pay button | ROSCA "before obtaining billing information" | Check: our box is on our plan sheet; add Stripe Checkout `custom_text` near the submit button repeating period, price and "cancel any time in Settings or at /cancel" |

### 7.2 European Union and EEA

| Requirement | Source | Status |
|---|---|---|
| 14-day right of withdrawal for distance contracts | Consumer Rights Directive 2011/83/EU, summary at https://webgate.ec.europa.eu/e-justice/639/EN/consumer_rights_directive_201183 [confirmed as general rule] | Built in `refunds.ts` |
| **The waiver sentence may not work for a subscription.** The "you lose the right once it starts" exception (Art. 16(m)) is for digital content. A subscription service falls under the service rule: the right is lost only when the service is **fully performed** (Art. 16(a)); if the buyer asked us to start during the 14 days and then withdraws, they owe a proportionate amount, not the whole price. Commentary notes real uncertainty for digital-service subscriptions. | https://www.legislation.gov.uk/eudr/2011/83/article/16 ; https://lawwwing.com/en/withdrawal-button-subscriptions/ [likely; counsel must confirm] | **Gap in policy.** Our box says "I lose my right of withdrawal once I use paid features" and `refunds.ts` then refuses. Safer default until counsel rules: with the box ticked, an EU / EEA / UK buyer who withdraws inside 14 days gets a pro-rata refund for unused days; without it, a full refund. The pass (fully performed after 7 days) and used practice credits can keep the current rule. |
| Consent must be a positive act; a pre-ticked box or a line in the terms is not enough | Commission guidance as summarised at https://reedsmith.com/en/perspectives/2014/06/how-new-eu-guidance-on-the-consumer-rights-directi [likely] | Built: boxes are unticked |
| **Online withdrawal function** ("withdraw from contract" control, available through the withdrawal period, two steps, automatic confirmation) for contracts concluded online, applying from **2026-06-19** (Directive (EU) 2023/2673, new Art. 11a) | https://www.gtlaw.com/ar/insights/2026/5/eu-consumer-law-new-withdrawal-button-requirements-for-online-contracts ; https://www.iubenda.com/en/blog/the-new-online-withdrawal-function-what-eu-directive-2023-2673-means-for-your-business/ [likely; already in force] | **Check / probable gap.** `/cancel` ends a subscription; it is not labelled or built as a withdrawal with refund. Add a "Withdraw from contract" entry on `/settings/billing` and `/cancel` for 14 days after each EU / EEA purchase that calls the existing refund calculator and emails a confirmation. |
| Prices shown to consumers include VAT | CRD pre-contract information (total price inclusive of taxes) | **Gap:** see §7.5 |
| Easy cancellation reachable without signing in (Germany's cancellation button, France's three-click rule) | General knowledge; not re-verified this session [inferred] | Built in substance (`/cancel` in every footer); counsel to confirm the German button wording in the `de` locale |

### 7.3 United Kingdom

- Today: 14-day cancellation under the Consumer Contracts Regulations 2013; same handling as the EU row above.
- The DMCC Act subscription regime (pre-contract information, reminder notices, cooling-off, easy exit) now starts in **January 2027**, brought forward from spring 2027 in August 2026; secondary legislation and guidance are still pending. Sources: https://www.tlt.com/insights-and-events/insight/dmcc-act-subscription-contracts-regime-brought-forward-by-the-pm-what-do-businesses-need-to-know ; https://www.lewissilkin.com/insights/2026/09/15/key-takeaways-the-subscription-shake-up-are-you-ready-for-january-2027-102o14n [likely]
- Our reminders (5 days / 2 days before renewal, annual reminder after 12 months) and one-click cancel are the right shape. Re-check the reminder timing against the final regulations before January 2027.

### 7.4 Taiwan

- Consumer Protection Act Art. 19 gives a 7-day right to cancel distance purchases. The exception for intangible digital content and "online services completed once provided" applies only if the consumer agreed beforehand **and** was clearly told the right is excluded, and the government reads the exception narrowly. Sources: https://www.ey.gov.tw/Page/24C4B877E850ED4E/d09b1f97-08be-4e98-9726-3417fce28004 ; https://www.legis-pedia.com/dictionary/53 [likely]
- A multi-week subscription is hard to describe as "completed once provided", so do not rely on the waiver in Taiwan either. We already give 14 days there, which is more than the law's 7. Use the same pro-rata rule as §7.2 when the box is ticked. [inferred; counsel]
- Business-tax registration at NT$600,000 a year (§6.2).

### 7.5 Tax on the price (EU, UK, Taiwan and US states)

- **Finding:** `server/src/platform/billing/rails/stripe.ts` creates Checkout Sessions with no `automatic_tax`, and prices carry no `tax_behavior`. Today no tax is calculated or collected on any sale. [confirmed in code]
- A seller outside the EU has **no** VAT threshold for digital services to EU consumers: VAT is due at the buyer's country rate from the first sale, normally through one Non-Union OSS registration. The UK likewise has no threshold for overseas sellers. Sources: https://stripe.com/en-cy/guides/tax-registration-process-europe ; https://support.taxually.com/support/solutions/articles/80001155457 ; https://community.hmrc.gov.uk/customerforums/vat/15f99cef-69c1-ee11-a81c-000d3a0d1900 [likely; tax adviser must confirm for our entity]
- **Pricing consequence:** set `tax_behavior: inclusive` on every Stripe price for consumer-facing honesty (the price on `/pricing` is the price charged) and turn on Stripe Tax where we are registered. $24.99 then nets about $21.00 in Germany (19%), $20.83 in the UK or France (20%), $19.99 in Sweden or Denmark (25%), $23.80 in Taiwan (5%). US states that tax SaaS add tax on top (exclusive) as is customary there, or we absorb it; adviser's call.
- **Two routes for the owner:** (a) register (Non-Union OSS, UK VAT, later Taiwan) and use Stripe Tax at 0.5% per transaction; or (b) Stripe Managed Payments, where Stripe acts as merchant of record and handles indirect tax, for 3.5% on top of payment fees (https://stripe.com/pricing, confirmed fee; eligibility for our entity not checked). On $24.99 route (b) costs about $0.87 a sale and removes the registrations.

### 7.6 Refund terms to print on `/pricing` (already coded; confirm the text)

- First purchase: refund within 7 days (weekly plan and pass: 48 hours) if fewer than 5 paid-only credits were used.
- Renewal charged by mistake: refund within 3 days.
- Practice packs: refund while no credit from the pack is used.
- EU / EEA / UK / Taiwan: 14 days, per §7.2 and §7.4.
- This is more generous than Simplify+ (non-refundable; 24 hours for accidental renewal) and clearer than Jobright (discretionary). Say it plainly on the page; do not name them.

---

## 8. Open questions

1. **Stripe key in the clone worktree is a live key.** `.env` holds an `sk_live_` secret, while the README (OPS-A9) expects test-mode prices attached with an `sk_test_` key. No `STRIPE_PRICE_PRO_*` values are set. Decide whether INT runs on a test key (recommended) before anyone creates prices.
2. Real average cost of one 20-minute practice session (decides the 15-pack price, §5.6).
3. Counsel: the withdrawal waiver for subscriptions in the EU, UK and Taiwan (§7.2, §7.4), and the German cancellation-button wording.
4. Tax route: own registrations plus Stripe Tax, or Stripe Managed Payments (§7.5). Which legal entity sells RoboApply decides the registrations.
5. Whether the owner wants the low first-pass price ($6.99) through the Welcome-price seam, or no offer at all (§5.4).
6. Jobright and Simplify+ prices are in-app only; our figures are third-party readings from June–October 2026 and may be A/B variants. Re-check by signing in before quoting them internally again.
7. Teal's and Careerflow's official pricing pages could not be fetched (403 / 404); their figures are third-party.
8. Whether student verification should also accept ISIC / UNiDAYS for countries where school emails are not `.edu`-style.

---

## 9. Sources

Competitor pricing
- Jobright: https://zplatform.ai/ai-reviews/jobright-ai/ ; https://outapply.com/blog/jobright-ai-pricing ; https://www.trajobo.com/guides/jobright-review ; https://resumehog.com/blog/posts/jobright-ai-review-2026-is-this-job-search-copilot-worth-it.html ; https://www.wobo.ai/blog/jobright-review/ ; https://jobright.ai/coach-landing
- Simplify+: https://simplify.jobs/refund-policy ; https://www.wobo.ai/blog/simplify-review/ ; https://www.liftmycv.com/blog/simplify-jobs-review/ ; https://www.resumly.ai/answers/simplify-jobs-review
- Teal: https://toolradar.com/tools/teal-hq/pricing ; https://frontdeskreview.com/software/resume-builders/teal.md ; https://tealhq.helpscoutdocs.com/article/30-changing-canceling-your-teal-subscription
- Huntr: https://huntr.co/pricing
- Careerflow: https://www.toolsforhumans.ai/ai-tools/careerflow ; https://resumehog.com/blog/posts/careerflow-review-2026-is-the-ai-career-copilot-worth-it.html
- Jobscan: https://jobshinobi.com/compare/jobscan-resume-scanner-review-2026
- Rezi: https://www.rezi.ai/pricing
- Kickresume: https://www.kickresume.com/en/pricing/
- Final Round AI: https://ophyai.com/blog/career-advice/final-round-ai-pricing ; https://www.finalroundai.com/blog/final-round-ai-pricing ; https://www.interviewcoder.co/blog/final-round-ai-review
- LockedIn AI: https://ophyai.com/blog/career-advice/lockedin-ai-review ; https://jobright.ai/blog/lockedin-ai-pricing/
- interviewing.io, Pramp, Exponent: https://www.lodely.com/blog/interviewing-io-pricing ; https://igotanoffer.com/en/advice/pramp-alternatives ; https://www.lodely.com/blog/exponent-pricing
- Yoodli, Huru: https://yoodli.ai/pricing ; https://www.itechguides.com/products/huru/
- LazyApply: https://www.dreamworkhq.com/blog/lazyapply-review
- Sonara: https://blog.fastapply.co/sonara-pricing-2026
- AIApply: https://clickhired.ai/blog/aiapply-pricing-in-2026 ; https://jobity.io/blog/aiapply-review
- JobCopilot: https://jobcopilot.com/pricing/ ; https://www.dreamworkhq.com/blog/jobcopilot-review
- LoopCV: https://blog.fastapply.co/fastapply-vs-loopcv-review-and-comparison-2026

Subscription behaviour
- https://techcrunch.com/2026/03/10/ai-powered-apps-struggle-with-long-term-retention-new-report-shows ; https://revenuecat.com/state-of-subscription-apps/

Stripe
- https://stripe.com/pricing ; https://docs.stripe.com/currencies ; https://support.stripe.com/questions/adaptive-pricing-for-subscriptions ; https://stripe.com/blog/adaptive-pricing-for-subscriptions ; https://stripe.com/en-cy/guides/tax-registration-process-europe

Law and tax
- US: https://www.jonesday.com/en/insights/2026/05/ftc-revives-clicktocancel-rule-new-risks-for-subscription-businesses ; https://www.crowell.com/en/insights/client-alerts/clicking-all-the-right-boxes-ftc-moves-to-revive-click-to-cancel-rule-following-eighth-circuit-vacatur ; https://btlaw.com/en/insights/alerts/2025/california-expands-automatic-renewal-law-new-requirements-now-in-effect ; https://fenwick.com/insights/publications/california-tightens-requirements-for-automatically-renewing-subscriptions
- EU: https://webgate.ec.europa.eu/e-justice/639/EN/consumer_rights_directive_201183 ; https://www.legislation.gov.uk/eudr/2011/83/article/16 ; https://www.gtlaw.com/ar/insights/2026/5/eu-consumer-law-new-withdrawal-button-requirements-for-online-contracts ; https://www.iubenda.com/en/blog/the-new-online-withdrawal-function-what-eu-directive-2023-2673-means-for-your-business/ ; https://lawwwing.com/en/withdrawal-button-subscriptions/ ; https://reedsmith.com/en/perspectives/2014/06/how-new-eu-guidance-on-the-consumer-rights-directi ; https://support.taxually.com/support/solutions/articles/80001155457
- UK: https://www.tlt.com/insights-and-events/insight/dmcc-act-subscription-contracts-regime-brought-forward-by-the-pm-what-do-businesses-need-to-know ; https://www.lewissilkin.com/insights/2026/09/15/key-takeaways-the-subscription-shake-up-are-you-ready-for-january-2027-102o14n ; https://community.hmrc.gov.uk/customerforums/vat/15f99cef-69c1-ee11-a81c-000d3a0d1900
- Taiwan: https://www.ey.gov.tw/Page/24C4B877E850ED4E/d09b1f97-08be-4e98-9726-3417fce28004 ; https://www.legis-pedia.com/dictionary/53 ; https://www.worldjournal.com/wj/story/121347/8834622 ; https://kpmg.com/tw/zh/home/insights/2026/01/dispute-resolution-controversy-quarterly.html
- Exchange rate: https://focustaiwan.tw/business/202610060013

Regional pricing
- https://fungies.io/purchasing-power-parity-saas-pricing-2026 ; https://kinde.com/learn/billing/optimization-and-revenue/localized-and-ppp-pricing/

Internal
- `docs/jobright-clone/PRODUCT_PLAN.md` §5.20, §6 ; `docs/jobright-clone/research/business-growth-seo.md` §4, §12 ; `docs/jobright-clone/research/network-tracker-interview.md` §4.1 ; `server/src/platform/billing/{planCatalog,refunds,acknowledgements,offers,fxReference,twRevenue,buyerCountry}.ts` ; `server/src/platform/billing/rails/stripe.ts` ; `server/src/platform/credits/catalog.ts` ; `server/src/lib/rateCard.ts` ; `lib/pricing.ts`
