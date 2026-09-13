# RoboApply redesign: reference research

Research date: 2026-09-11. Sources below are current official product pages and support documentation. The design applications are recommendations inferred from these sources, not claims that RoboApply already supports every feature.

## Current visual direction

The user’s latest instruction selects the color theme and gradient treatment of [Ashby’s growth page](https://www.ashbyhq.com/growth). The observed reference combines a near-white `#FCFCFE` canvas, dark `#141415` text, violet `#6857DB → #473BCE` action gradients, and very pale `#F3F2FF → #EBE9FE` lavender panels. These are observations of that page’s current treatment, not a claim to document Ashby’s entire brand system.

RoboApply’s **Clarity** system adapts that direction to its own candidate workflows: violet controls, neutral ink, lavender-to-blue supporting gradients, and a complete dark theme. This replaces the previous green Fieldwork palette. The light action fallback is `#4F3DCA` so filled controls and plain action text have predictable contrast. Positive evidence is blue, distinct from violet interactive states. The other product references below continue to inform discovery, evaluation, transparency, and company context.


## Reference responsibilities

| Reference | Verified principle | Application to RoboApply |
| --- | --- | --- |
| [Ashby](https://www.ashbyhq.com/growth) | A connected recruiting workspace with visible pipelines, repeatable stages, and pending next steps. | A stable product shell; consistent page heading, controls, list, detail, and action hierarchy; application stage visibility and actionable follow-up dates. |
| [Welcome to the Jungle](https://www.welcometothejungle.com/en) | Preference-based recommendations alongside company exploration; profiles describe the company with photos, video, and facts. | Make job discovery feel like evaluating a place to work. Put recognizable company identity and practical role facts beside fit evidence. Keep discovery controls legible. |
| [Gem application review](https://www.gem.com/product/ai-app-review) | Criteria-based ranking, plain-language explanations, relevant background, and human-controlled decisions. | Give resume evaluation an evidence panel: overall interpretation, strengths, missing evidence, criterion breakdown, and next action. Keep source context visible. |
| [Wellfound candidate experience](https://wellfound.com/candidates/overview) | Salary, equity, work preferences, and hiring signals appear before applying. | Present available pay, location, workplace arrangement, and posting recency together. Treat undisclosed data as unknown, never as a positive claim. |
| [Teamtailor employer branding](https://www.teamtailor.com/en/employer-branding/) | Branded, localized careers content makes a company recognizable across the candidate journey. | Use editorial storytelling in public surfaces, and structured benefits and company context in job details. Future employer-authored modules should have identity, attribution, and real content. |

## Structural recommendation

Keep the four existing candidate destinations: Jobs, Resume, Applications, Interview prep. Their names answer concrete candidate questions and already match desktop/mobile navigation. Refine the information hierarchy within them rather than multiplying destinations to imitate an enterprise ATS.

Use one repeatable workspace pattern: persistent navigation; page title and short context; clearly separated filters or controls; primary work area; contextual evidence or details. On wide screens, a focused work area can sit beside a smaller supporting panel. On mobile, the supporting panel follows the relevant content and every action remains reachable.

Maintain three related visual modes within one system:

- Public pages: editorial type scale, strong proposition, product evidence, deliberate pacing, and authentic human imagery when available.
- Discovery and preparation: generous readable content, clear company identity, compact metadata, supportive explanations, and restrained status color.
- Operational views: compact tables or pipeline columns with predictable alignment, visible state, and an efficient next action.

This applies Ashby's operational structure without letting its enterprise information density dominate the candidate experience. It applies WTTJ and Teamtailor's human context without placing decorative stories ahead of salary or work constraints.

## Existing surface map

| Surface | Existing implementation | Redesign priority |
| --- | --- | --- |
| Public landing | `components/landing/LandingContent.tsx`, `/`, `/[locale]` | Strong visual identity, understandable product demonstration, proof supported by actual behavior, a coherent candidate journey. |
| Authentication | `components/auth/AuthShell.tsx`, `/login`, `/signup` | Brand continuity, readable inputs, single clear form action, compact supporting story. |
| Product shell | `components/v3/shell/*` | Navigation rhythm, active state, readable utility controls, desktop/mobile consistency. |
| Jobs | `/jobs`, `MatchFeed`, `MatchCard`, `JobDetailModal` | Company and role first, compensation/work/location facts together, evidence in a distinct area, reliable loading and empty states. |
| Resume library | `/resume`, `ResumeCard`, `CreateCard` | One primary creation route, recognizable document previews, clear version and edit state. |
| Resume editor | `/resume/[id]`, `components/v3/resume-editor/*` | Document remains primary; tools and evaluation have clear hierarchy; issues navigate to the relevant content. |
| Applications | `/applications`, `components/v3/pipeline/*` | Stage and upcoming action readable at a glance; prioritize actual follow-ups and deadlines over decorative metrics. |
| Interview preparation | `/practice`, `/practice/[id]`, `/practice/[id]/report`, `components/v3/mock/*` | Clear setup sequence, confident live session controls, results that connect evidence to practice actions. |
| Settings/billing | `/settings`, `/settings/billing/history`, account/preferences components | Consistent forms, grouped information, clear saved/pending/error states. |
| Administration | `/admin` and detail routes | Apply shared tokens and controls while preserving operational density and role boundaries. |

## Evaluation experience

The current `RAJobMatchScoreView` already supplies `rationale`, `strengths`, `gaps`, four signal values, `generatedAt`, `resumeVariantId`, and staleness flags. These support a useful evidence presentation without inventing backend outputs. The default sequence should be an understandable fit interpretation, the strongest supporting evidence, explicit missing evidence, and detailed criteria. The current score is not a probability of being hired.

[Gem's match-score documentation](https://help.gem.com/external/ai-match-scores) explains its own criteria confidence interpretation. RoboApply should borrow the visible criterion-by-criterion review pattern, while using RoboApply's actual score semantics. Do not relabel its existing numeric signals as calibrated confidence or definitive qualification evidence.

The resume editor's existing `AnalyzerPanel` has issue severity, translated issue text, and jump-to-section behavior. Preserve this functional connection while improving presentation; a large score without actionable explanation is less useful than the existing issue list.

## Transparency and storytelling boundaries

The full v2 `RAJob` includes company name/logo, work type, location, salary range/currency/period, description, responsibilities, qualifications, benefits, posting date, and source link. Use those fields immediately. `RAJobListItem` omits salary period, so avoid implying an annual pay period in discovery when it has not been delivered. The card currently shows generated initials despite `companyLogoUrl` being available.

The v2 projection does not expose equity, employer-authored culture, team stories, recruiter response rate, or a hiring process timeline. These need real data before production UI can display them as facts. A source link and clearly structured benefits are an honest first application of the storytelling reference.

[Teamtailor's Team stories documentation](https://support.teamtailor.com/en/articles/7176287-team-stories) describes employee-created photos/video, captions, publication controls, and department/location associations. A future RoboApply equivalent therefore needs content ownership and publishing behavior, not just an attractive carousel.

[Wellfound search documentation](https://help.wellfound.com/article/777-setting-up-a-search) supports explicit compensation filters. Filter state should remain visible and reversible in RoboApply. Unsupported data should not be converted into a filter that appears functional.

## Scope risks

- The current App Router exposes candidate and admin experiences. The database includes company and recruiter-related models, but a recruiter or employer workspace is not present in this route inventory. A visual redesign can prepare reusable components for those roles; presenting a full ATS as implemented would overstate the current product.
- Existing application actions open an external employer posting and track candidate intent locally. Preserve accurate wording and the corrective action for users who did not complete an application.
- Current setup intentionally keeps navigation available and supports skipping. Preserve this behavior during any onboarding redesign.
- Every visible copy change needs all nine supported locale bundles and repository copy checks.
- Apply shared tokens across existing components before adding parallel button/card/form systems. New reusable patterns should accept real data and accessible labels rather than embed illustrative claims.
