# RoboApply — Landing Claims vs Product Reality (Gap Analysis)

**Date:** 2026-07-11 · **Source:** read-only code audit of this repo (evidence paths inline) + the 2026-07 landing redesign.
**Purpose:** the founder's 6 marketing key points, what the shipped product actually supports, what the redesigned landing now claims, and the build list to close the gaps.

## Executive summary

RoboApply today is **two products at different maturity**: a genuinely deep, live, monetized **AI mock-interview studio** (LiveKit full-duplex voice, 18 personas / 28 formats / 18 domain playbooks, Tavily pre-research, two-phase graded reports, live coach, 9 interview languages, Stripe+Alipay credits) — and an **auto-apply agent that is architecture-complete but starved**: the queue UI is hard-gated off (`QUEUE_REVIEW_ENABLED = false`, `lib/jobApplying.ts:46`), queue "Send now" flips a DB status without submitting (`RAQueueService.ts:254-283`), Greenhouse runs in simulation without env keys (`GreenhouseAdapter.ts:141-177`), Lever is unimplemented (`RoboApplySubmitterService.ts:525-530`), and the nightly matcher reads an internal recruiter `Job` table that is **empty** on RoboApply's dedicated DB (`RoboApplyDailyMatcherService.ts:319-372`).

The **old landing page sold the unshipped product** (overnight auto-apply, $0/$19/$49 *apps-per-day* tiers) while checkout sells interview credits (Free/$15/$29) — a real-money integrity bug. The redesigned landing fixes this: consent-first framing, an explicit **AUTOPILOT · EARLY ACCESS** chip, the real plans, and the interview studio elevated to co-hero.

## The 6 key points × reality

| # | Founder claim | Reality in code | Landing v2 now says | Gap to close |
|---|---|---|---|---|
| 1 | Automate job applications | Engine exists end-to-end but can't deliver: no job inventory, simulated submission, queue hidden | Agent scouts/matches/drafts, **stages for your approval**; autopilot = EARLY ACCESS | P0 build list below |
| 2 | Optimize matching with elite jobs | Real LLM match scores w/ reasons vs user's resume (`RAJobMatchScorerAgent`, cached, staleness-aware); thin inventory; no "elite" curation; `replies` hardcoded 0 (`RAActivityService.ts:259`) | "Matching that reads your resume — not keyword bingo" | Continuous ingest (V2.5), curated sources if "elite" is wanted; measure replies |
| 3 | Find jobs, AI resume, auto-apply, interview practice | Find: partial (onboarding JSearch ingest + demo seeds; no continuous ingest — `RAJobIndexService.ts` header defers to V2.5). Resume AI: **fully live**. Auto-apply: gated. Interview practice: **fully live, deepest surface** | The full-loop grid, with apply carrying the EARLY ACCESS chip | Live ingest; real submission |
| 4 | AI video interviews, mock interviews, skills assessments, AI interviewer avatars | Voice interviews live; "video mode" = candidate webcam + recording, interviewer is an **orb**, no vision analysis (`InterviewerTile.tsx`); **skills assessments: zero surface** (Assessment tables are RoboHire leftovers); **no visual avatars** | "Live voice AI interviewer… camera-on mode adds real video-call pressure"; personas (not avatars); assessments **not claimed** | Avatar rendering (talking head), vision-based feedback, an assessments surface — all net-new builds |
| 5 | Comprehensive evaluations & feedback | **Fully supportable** — two-phase reports, per-question corrections + suggested answers, recommendations, transcript + recording (R2), 9 languages (`interview-engine/scoring/*`) | The report-card receipt section + studio features | Minor: plan cards promise "Full AI interview reports" as paid perk but nothing gates report depth by tier — align copy or gate |
| 6 | AI agents 24×7 while you sleep | Cron skeleton real (`vercel.json`: matcher 05:00, submitter hourly, digest hourly) but nothing to chew: no live board scanning; digest dormant; activity feed empty | Night-shift story kept as brand promise, consent-anchored; specific tool names (Greenhouse/Lever) removed | P0: continuous external ingest feeding the matcher |

## P0 — make the hero story true (before any paid marketing of auto-apply)

1. **Continuous job ingest** into `RAJob` (JSearch/RapidAPI scheduled sweeps or board-partner feeds), replacing onboarding-only writes (`RAOnboardingRecommendService.ts:960`); exclude the ~200-row demo seed corpus from `/search` (it already is from onboarding recs).
2. **Real submission path**: configure `GREENHOUSE_API_KEY`/`BOARD_TOKEN` (exit simulation mode) and/or implement the Lever adapter; wire queue "send" through the submitter instead of the status flip.
3. **Re-enable the queue** (`QUEUE_REVIEW_ENABLED`) once 1+2 land — the consent layer the landing sells IS this queue (see re-enable checklist in the team memory: queue-hidden-for-launch).
4. **Wake the digest** (already real, keyed to runs) and stop hardcoding `replies: 0` — the landing's "morning report" claim depends on it.

## P1 — close the interview-suite claim gaps (founder point 4)

5. **AI interviewer avatar**: rendered talking-head (or stylized animated persona) in the interview room to honestly claim "AI interviewer avatars".
6. **Skills assessments**: net-new surface (timed question banks per domain, scored reports) if the founder wants the claim; otherwise drop it from all marketing.
7. **Vision feedback** in camera-on mode (eye contact/pacing) to upgrade "video interviews" from recording to analysis.
8. Gate report depth by tier or remove "Full AI interview reports" from paid-plan bullets (`PlanCatalog.tsx:59-64`).

## P2 — growth/positioning follow-ups (from the research)

9. Comparison/alternatives content (the Jobright playbook) in EN **and** the 8 locales where no competitor content exists; Google Search Console + Bing + Naver submission after deploy.
10. Review-platform presence (G2/Trustpilot/Product Hunt) — hard inclusion gates for AI-engine recommendations.
11. Real testimonials + measured outcomes (reply-rate) to replace market stats over time; only then add `aggregateRating` markup.
12. WhatsApp-shareable artifacts for LatAm (digest share cards); Naver/Kakao presence for KR.
13. Integrations are demo-stubs (`RAIntegrationsService.ts:16-20` — connect() just marks connected): ship real OAuth or hide the section.

## What the landing v2 already fixed

- Pricing now matches checkout (Free / Starter $15 / Growth $29, credits) — the $19/$49 apps-per-day tiers are gone.
- Every capability claim maps to live code (citations: CitationGuard is real — `RoboApplyAuthorAgent.ts`); autopilot carries an explicit EARLY ACCESS chip.
- "Avatars"/"skills assessments"/"elite jobs" are **not claimed**; video framed as camera-on pressure + recording playback.
- SEO/GEO surface added: per-locale URLs + hreflang cluster (gated to translated locales via `SEO_READY_LOCALES`), robots.txt welcoming AI crawlers, sitemap, JSON-LD entity graph (no fake ratings), llms.txt, extractable FAQ.

## Panel + persona addenda (2026-07-11 review round)

**Votes:** strategist 6.5, designer 7.5, headhunter 7 — all `accept-with-changes`; all blockers fixed same-day (fake "LIVE" telemetry → "SAMPLE SHIFT"; falsifiable "tonight 23:00 / tomorrow 9:02" promises removed; "MOST CHOSEN" → "RECOMMENDED"; 6% stat attributed; per-stat sources; FAQ q2/q7 scoped honestly; light-theme cool-slate token bug fixed; locale menus gated to translated locales). **Personas: 5/5 would sign up.**

Persona-driven roadmap signals (in priority order of repeated mention):
1. **Hearable interviewer before signup** (Maya + Priya): a 15–30s real session audio clip (or animated transcript) in the hero/studio section. Needs one good recorded session + a lightweight player. Highest-frequency ask.
2. **Inspectable sample shift** (Marcus): "See a sample shift" should open a real staged application — cover letter with visible per-claim citations, the match reasoning, the veto UI. Could ship as a static interactive demo before the queue re-enables.
3. **Trust/legal footer** (Yuki): privacy policy, terms, company/operator identity, support contact — *no /privacy or /terms routes exist in the app today*; JP page ultimately needs 特商法-style seller disclosure. Launch-blocking for paid conversion in JP/DE especially.
4. **Language visibility above the fold** (Diego): shipped same-day — the header globe now shows the active locale code; full locale menu + footer links gated to translated locales.
5. **Early-access join mechanism** (strategist): "rolling out in early access" needs an actual waitlist/toggle so the claim is operationally true.
