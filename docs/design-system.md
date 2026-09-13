# RoboApply — Clarity

September 2026 · Implemented design system

RoboApply helps people make a considered next move. The interface is clear, composed, and practical: near-white canvases, deep neutral ink, violet actions, and soft lavender-to-blue gradients. Discovery is inviting; evaluation is grounded in evidence; operational screens are orderly.

The user explicitly selected the purple and gradient direction of [Ashby’s growth page](https://www.ashbyhq.com/growth), replacing the earlier green Fieldwork palette. This direction also supersedes the color, typography, and composition decisions in the earlier `docs/roboapply/OVERHAUL_RULINGS.md`. Existing functionality, truthful claims, localization, accessibility, and API boundaries remain applicable.

## Reference synthesis

| Reference | Principle used | Product expression |
| --- | --- | --- |
| Ashby | Purple gradient identity, light lavender surfaces, connected workflows, consistent hierarchy | Violet actions, softly shaded page introductions, persistent navigation, clear page context, application stages, reusable controls |
| Welcome to the Jungle | Candidate discovery with company context | Recognizable employers, searchable opportunities, role essentials before evaluation |
| Gem | Explainable evaluation with human judgment | Resume evidence beside gaps, criteria breakdown, actionable resume checks |
| Wellfound | Practical information before commitment | Salary, currency, work mode, location, source; undisclosed facts named explicitly |
| Teamtailor | Employer identity and authored storytelling | Editorial marketing and structured company/benefits context from actual postings |

See [the source-linked research](design-reference-research.md) for exact sources and data limitations.

## Foundations

The production source of truth is `app/globals.css`. `styles/tokens.css` maps existing component aliases to these values; feature files never define a second palette.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--bg` | `#FCFCFE` | `#171622` | Near-white / deep neutral page canvas |
| `--surface` | `#FFFFFF` | `#201E2D` | Primary work areas |
| `--surface-2` | `#F5F4FA` | `#292638` | Grouped controls and supporting panels |
| `--surface-3` | `#ECEAF4` | `#343046` | Muted surfaces |
| `--rule` | `#E2DFED` | `#403A55` | Quiet structural boundaries |
| `--text` | `#20202B` | `#F5F3FC` | Titles and primary copy |
| `--text-2` | `#525162` | `#CFCADC` | Supporting copy |
| `--text-muted` | `#656274` | `#B8B1C8` | Readable metadata |
| `--action` | `#4F3DCA` | `#B9ADFF` | Interactive emphasis |
| `--action-hover` | `#4031AF` | `#D0C7FF` | Interactive hover state |
| `--action-ink` | `#FFFFFF` | `#211A49` | Content on action fills |
| `--action-subtle` | `#EFEDFC` | `#332C50` | Selection and supporting emphasis |
| `--brand-mark` | `#F0ECFF` | `#F0ECFF` | Pale lavender identity detail |
| `--brand-plane` | `#30266B` | `#30266B` | Stable deep violet identity plane |
| `--ok` | `#315CB3` | `#A8C4FF` | Positive evidence, always labeled |

Use paired colors. Do not place white text on the dark-theme action fill. Success, warning, and error have separate semantic tokens; a match score is not an error state. Color accompanies an explicit label. Positive evidence uses blue; the brand and action system uses violet.

**Gradients.** Use `--grad-brand` for primary actions and identity emphasis: `#6857DB → #473BCE` in light mode, `#C7BCFF → #A99BFF` in dark mode. Use `--grad-brand-hover` for the hover state. Use `--grad-soft` (`#F6F5FF → #ECEAFF → #F1F5FF` in light mode) and `--grad-panel` (`#EFECFF → #E4DFFF → #E9F0FF`) for restrained lavender-to-blue introductions and supporting panels. Their dark equivalents use deep violet and blue, defined in the same token block. Keep dense work areas and document paper on solid surfaces. Pair gradient action fills with `--action-ink`, and check contrast at both ends. Do not add animation or rainbow color sequences to this treatment.

**Typography.** Self-hosted Instrument Sans carries the complete interface, using weight and spacing for hierarchy. Source Han provides Simplified and Traditional Chinese glyphs. Resume document fonts remain the user's choice. The UI scale is 12 / 13 / 15 / 17 / 20 / 28 px, plus fluid page titles (28–40 px) and marketing headlines (40–72 px). Readable paragraph measure is 60–68 characters. Use `--font-ui` and `--font-display`, never literal font-family names that bypass `next/font`.

**Geometry.** The spacing scale is 4 / 8 / 12 / 16 / 24 / 32 / 48 / 64 px. Controls use 8 px corners, cards 12 px, sheets 20 px. Operational cards may use tighter corners when nested in stage columns. Shadows are neutral and restrained. Main controls are 40 px on desktop and at least 44 px on mobile. Keep visible focus states.

**Motion.** State transitions run 120–240 ms. Animate a user action or a real loading state. Avoid perpetual decorative movement. Respect `prefers-reduced-motion`.

## Reusable components

| Component | Responsibility | Usage |
| --- | --- | --- |
| `BrandSymbol` | Shared R / next-step glyph | Same identity across public, auth, and workspace |
| `PageHeader` | Title, context, optional actions | Supporting copy sits below the title; actions remain a separate region |
| `Btn` | Native button/link with shared variants | One primary action per decision group, visible pending and disabled states |
| `MetricGrid` | Labeled summary of measured values | `—` for pending/unknown; only show zero after data has loaded |
| `EmptyState` | Explain an empty/error state and offer recovery | Specific next step, neutral illustration, no invented activity |
| `Modal` | Focus management, escape, backdrop, responsive dialog | Keep consequential action labels explicit |
| `MatchCard` | Company identity, role essentials, evidence, actions | Separate strengths and questions; preserve score semantics |
| `AnalyzerPanel` | Resume quality checks and section navigation | Group issues by severity, enable filters, navigate to the relevant document section |
| `Sidebar` / `MobileNav` | Shared destination model | Jobs, Resume, Applications, Interview prep; admin remains role gated |

React components accept data and action callbacks rather than hide API calls in generic UI primitives. Keep query and mutation ownership in feature hooks; use `lib/api` for requests. Preserve stable keys and native semantic controls. Default to server components unless interaction needs client state. Keep global styles centralized and component-specific interactions scoped.

## Page recipes

- **Marketing:** editorial proposition → interactive sample of actual capabilities → discovery and preparation journey → transparent pricing → questions and final action. Samples are clearly labeled. The sample is explanatory, never presented as the visitor's account data.
- **Login / signup:** an editorial brand panel and a focused form, with controls and reassurance together. Mobile prioritizes the form. Preserve Google sign-in, password behavior, return destinations, locale, and theme.
- **Jobs:** introduction → measured collection summary → visibly labeled local filters → role and company identity → practical facts → evidence. Local filters explicitly operate on loaded results. Scores never imply a hiring probability.
- **Resume:** distinct creation methods → document library → editing workspace with contextual review. The resume paper remains visually separate from application chrome.
- **Applications:** actual stage counts → actionable follow-ups → stage columns. Dragging has a native stage-menu alternative. Unknown and loading states never masquerade as zero.
- **Interview prep:** clear step sequence → role and format choice → review → launch. During a live interview, reduce navigation and prioritize connection, microphone, transcript, and end controls. Reports connect scores to specific evidence and next practice steps.
- **Settings / billing / admin:** grouped forms and operational tables share the same tokens, type scale, focus states, and spacing. Preserve existing save, error, pending, permission, and confirmation behavior.

## Responsive and accessible behavior

At 760 px, desktop navigation becomes the shared bottom navigation. Page padding decreases, metrics wrap to two columns, and creation cards become a vertical list. Company/role text may wrap; do not truncate the only copy of a qualification or salary. Long tables and stage collections may scroll within a clearly bounded region. Dialogs fit the viewport and keep their actions reachable. The shell includes a keyboard skip link.

All interactive controls have a visible label or an accessible name. Use `aria-expanded`, `aria-selected`, `aria-current`, and native form elements for actual state. Decorative marks are hidden from assistive technology. Preserve focus after filtering and avoid reordering an open item while someone is reading it. Verify 4.5:1 text contrast and both themes.

## Honest content and product boundaries

The current website serves candidates and administrators. This redesign does not add a recruiter ATS or an employer publishing product. The reusable patterns support those future surfaces, but they need role-specific data, workflows, and authorization before shipping.

Company identity, benefits, qualifications, and source links come from existing job records. Do not invent salary periods, equity, hiring timelines, employee stories, response rates, or endorsements. The list API does not supply salary period; the full posting does. A score measures resume alignment, not hiring likelihood. Opening a posting is not evidence that an application was completed; keep the user's correction available.

New visible copy must be translated across all nine locales with `i18n-locale-sync`. Preserve placeholders and established machine strings. Documentation and internal design examples may use English.

## Validation

Run the smallest affected test first, then `npm test`, `npm run check`, and the frontend TypeScript check. Verify desktop, mobile, light, dark, and at least one CJK locale in a browser. Build using Node 24 after stopping any Next dev process sharing `.next`. Live backend, payment, and voice behavior require their services; component fixtures alone do not prove those integrations.

Run `node scripts/design-preview.mjs` to inspect the actual authenticated components with isolated fixture data at `http://localhost:3612/jobs`. The loopback-only harness blocks live API requests and visibly labels example data; it is not a substitute for end-to-end integration tests.

Open [the visual style guide](design-system.html) for the palette, typography, controls, and example composition. It is an internal review artifact, not a production route.
