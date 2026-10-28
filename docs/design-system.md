# RoboApply — Paper

October 2026 · Implemented design system

RoboApply helps people make a considered next move. Paper makes that feel like a well-made studio notebook: a warm paper canvas, near-black ink for every action, one highlighter colour for momentum, one grotesque for every word, soft corners and pill controls. Discovery is inviting; evaluation is grounded in evidence; operational screens are orderly.

The user selected [skillry.dev](https://skillry.dev) as the visual reference on 2026-10-29. Its measured style is recorded in [skillry-style-reference.md](skillry-style-reference.md). Paper replaces the September "Clarity" palette (Ashby-inspired violet and lavender gradients), which itself replaced the green Fieldwork palette; it keeps Clarity's token names, components and page recipes, so every screen restyled without a markup rewrite. Existing functionality, truthful claims, localization, accessibility and API boundaries remain applicable, as do the product rulings in `docs/roboapply/OVERHAUL_RULINGS.md` (no auto-submit, the gap positioning). Its colour and type rulings (R3, R4) are superseded as described below.

## Reference synthesis

| Reference | Principle used | Product expression |
| --- | --- | --- |
| Skillry | Warm paper, ink actions, a single highlighter, one quirky grotesque, sticker tiles, an inset app sheet | Paper canvas, ink buttons, lime for "you are here" and momentum, Bricolage everywhere, coloured tiles on cards, the inset workspace |
| Welcome to the Jungle | Candidate discovery with company context | Recognizable employers, searchable opportunities, role essentials before evaluation |
| Gem | Explainable evaluation with human judgment | Resume evidence beside gaps, criteria breakdown, actionable resume checks |
| Wellfound | Practical information before commitment | Salary, currency, work mode, location, source; undisclosed facts named explicitly |
| Teamtailor | Employer identity and authored storytelling | Editorial marketing and structured company/benefits context from actual postings |

See [the source-linked research](design-reference-research.md) for the recruiting-product sources and data limitations.

## Foundations

The production source of truth is `app/globals.css`. `styles/tokens.css` maps existing component aliases to these values; feature files never define a second palette. `styles/workspace.css` holds the shared composition (shell, page header, buttons, metrics, stage columns, resume cards).

### Colour

Three roles, never confused:

- **Ink** (`--text`, `--action`) carries every label and every primary action. In light, primary buttons are solid ink; in dark the action becomes the highlighter.
- **Paper** (`--bg`, `--surface`, `--surface-2`, `--surface-3`) is the canvas, the cards and the recessed rail.
- **Highlight** (`--brand-mark`, with `--brand-plane` as the ink written on it) marks where you are and what has momentum: the active navigation item, plan and "Example" chips, the direct-posting badge, text selection, the brand tile and the closing CTA band. It is a **fill**, never a text colour (lime on paper is 1.04:1), and it never carries state alone: the active nav item is also semibold and dotted.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--bg` | `#F4F1E9` | `#121313` | Paper canvas / ink canvas |
| `--surface` | `#FBFAF6` | `#1B1C1C` | Cards and work areas |
| `--surface-2` | `#EBE7DE` | `#232525` | The rail frame, stage columns, recessed fills |
| `--surface-3` | `#E2DDD1` | `#2C2E2E` | Tracks, pressed fills |
| `--rule` | `#DCD8CF` | `#343636` | Hairlines (most borders mix `--text` at 8–16 % instead) |
| `--text` | `#121313` | `#F4F1E9` | Titles and primary copy |
| `--text-2` | `#3D3F3B` | `#CFCCC3` | Supporting copy |
| `--text-muted` | `#5F625B` | `#A7AAA4` | Metadata (≥ 4.58:1 on every paper surface) |
| `--action` | `#121313` | `#F4FF71` | Primary buttons, links, focus, selected segments |
| `--action-ink` | `#FFFFFF` | `#121313` | Content on action fills |
| `--action-subtle` | `#E6E2D7` | `#2A2C22` | Neutral selection tint |
| `--brand-mark` | `#F4FF71` | `#F4FF71` | The highlighter |
| `--brand-plane` | `#121313` | `#26281E` | Ink on the highlighter; the brand tile |
| `--ok` / `--warn` / `--danger` | `#2E6A47` / `#8A5512` / `#B03A2E` | `#8FD3A8` / `#E7C27D` / `#FF9C8F` | Labelled status, each with a `-subtle` fill |
| `--surface-glass` | `rgba(255,255,255,.55)` | `rgba(255,255,255,.04)` | Secondary buttons, stat cards, segmented tracks |
| `--tile-*` | sage, clay, sky, blush, mint, lilac, camel | same | Sticker tiles; always with `--tile-ink` icons (≥ 7:1) |

GoApply (`styles/brands/goapply.css`) keeps the same paper and swaps the action to deep jade `#0E4A3E` (mint `#A6F2CC` in dark) and the highlighter to mint `#9DF0C6` on a jade plane. `__tests__/brand/contrast.test.ts` computes every brand-token pair for both brands in both themes, including ink on the highlighter.

**Washes.** `--grad-soft` (a warm peach bloom) and `--grad-panel` (paper drifting toward the highlighter) are for introductions and supporting panels; `--grad-brand` is the ink (lime in dark) with a faint top highlight. The marketing hero uses a soft radial bloom of `--print-ink`. Dense work areas and document paper stay on solid surfaces.

### Typography

Self-hosted **Bricolage Grotesque** (variable, weights 200–800 with optical sizes) carries the complete interface; headlines differ from body only by weight (600) and tighter tracking, and the optical-size axis keeps small text regular. Source Han provides Simplified and Traditional Chinese glyphs; CJK headlines loosen tracking. Resume document fonts remain the user's choice. The UI scale is 12 / 13 / 15 / 17 / 20 / 28 px, plus fluid page titles (28–40 px) and marketing headlines (44–88 px, tracking −0.055em, line-height 0.94). Readable paragraph measure is 60–68 characters. Use `--font-ui` and `--font-display`, never literal font-family names that bypass `next/font`.

The marketing hero headline carries an offset **print shadow** — a hard, misregistered second ink (`--print-ink`) plus a faint ink echo, no blur. It is the one decorative type treatment; do not put it on app headings.

Skillry's monospace uppercase eyebrows are deliberately not copied (2.6:1 contrast at 11 px, and the design gate bans uppercase and mono). Paper eyebrows are sentence case at 13 px in `--text-muted`, led by a small highlighter swatch.

### Geometry and elevation

The spacing scale is 4 / 8 / 12 / 16 / 24 / 32 / 48 / 64 px. Buttons, chips, badges, search and segmented controls are **pills**. Inputs and cards use 16 px corners, sheets, panels and media 22 px, the CTA band 28 px. Main controls are 40 px on desktop and 44 px on mobile; the marketing hero pair is 48 px. Keep visible focus states (ink ring, lime in dark).

Borders are hairlines: ink mixed at 8 % (frames), 10 % (cards), 15–16 % (secondary buttons, inputs), dashed 18 % for empty states. Shadows are neutral and sized to the element: `--e1` rests, `--e2` lifts, `--e-float` for floating sheets and hovered cards, `--e3` for dialogs. `--e-print` is a hard offset block behind showcase panels (the landing Example). No shadow ever takes a hue.

### Motion

State transitions run 120–240 ms. Cards lift on hover; buttons nudge up 1 px; overlays blur the page behind them. Animate a user action or a real loading state. Avoid perpetual decorative movement. Respect `prefers-reduced-motion`.

## The shell

The workspace is an **inset sheet**: the rail sits on `--surface-2` and the main column is a `--bg` sheet with 22 px corners and an 8 % ink ring, 8 px off the window edge (in dark the rail is the lighter step and the sheet the ink). The sheet's topbar is translucent paper with a backdrop blur. Navigation items are 40 px pills; the current page is the highlighter. The brand tile is the highlighter glyph on the ink plane. Below 760 px the frame dissolves: the sheet is the screen and the shared bottom navigation takes over.

## Reusable components

| Component | Responsibility | Usage |
| --- | --- | --- |
| `BrandSymbol` | Shared R / next-step glyph | Highlighter glyph on the ink tile across public, auth and workspace |
| `PageHeader` | Title, context, optional actions | Muted supporting copy below the title; eyebrow led by the highlighter swatch |
| `Btn` | Native button/link with shared variants | `primary` ink pill, default glass pill, `violet` = highlighter pill (the stronger of two adjacent CTAs), `ghost` |
| `Tabs` | Segmented control | Glass pill track; the selected tab is the action pill |
| `MetricGrid` | Labeled summary of measured values | Separate glass cards; `—` for pending/unknown; only show zero after data has loaded |
| `EmptyState` | Explain an empty/error state and offer recovery | Dashed glass panel, sticker tile, specific next step, no invented activity |
| `Modal` / `Drawer` / `Sheet` | Focus management, escape, backdrop | Drawers float 8 px inset with 22 px corners on desktop; the scrim blurs |
| `MatchCard` / feed card | Company identity, role essentials, evidence, actions | 22 px card that lifts on hover; separate strengths and questions; preserve score semantics |
| `AnalyzerPanel` | Resume quality checks and section navigation | Group issues by severity, enable filters, navigate to the relevant document section |
| `Sidebar` / `MobileNav` | Shared destination model | Jobs, Resume, Applications, Interview prep; admin remains role gated |

React components accept data and action callbacks rather than hide API calls in generic UI primitives. Keep query and mutation ownership in feature hooks; use `lib/api` for requests. Preserve stable keys and native semantic controls. Default to server components unless interaction needs client state. Keep global styles centralized and component-specific interactions scoped.

## Page recipes

- **Marketing:** a centred hero — eyebrow, print-shadow headline, muted sub, ink and glass pills — with the labelled interactive Example below it on a print block → the four verbs on sticker-tile cards → features → real counters → quick search → transparent pricing (the recommended plan outlined in ink) → questions → the highlighter CTA band → a recessed footer. Samples are clearly labeled and never presented as the visitor's account data.
- **Login / signup:** a terracotta illustration tile (ink type, the hand-drawn path, highlighter check stickers) beside a focused form of pill controls. Mobile prioritizes the form. Preserve Google sign-in, password behavior, return destinations, locale, and theme.
- **Jobs:** an unboxed introduction → measured collection summary → visibly labeled local filters → role and company identity → practical facts → evidence. Local filters explicitly operate on loaded results. Scores never imply a hiring probability.
- **Resume:** distinct creation methods on sticker-tile cards (the recommended one outlined in ink) → document library → editing workspace with contextual review. The resume paper remains visually separate from application chrome.
- **Applications:** actual stage counts as glass cards → actionable follow-ups → recessed stage columns of lifting cards. Dragging has a native stage-menu alternative. Unknown and loading states never masquerade as zero.
- **Interview prep:** one screen, not a wizard. Past practice → the job (the only required choice) → a pre-matched plan shown as editable chips with inline option trays → a launch dock that is live from the moment a job is chosen. During a live interview the screen is shaped like a call — the interviewer holds the stage, the candidate's own tile is pinned into it, coach and transcript share an on-demand rail, and mic / camera / end sit in a bottom control bar. Reports state the score once, lead with the single next action, and put recommendations, per-question review, recording and transcript behind one tab strip.
- **Settings / billing / admin:** grouped forms and operational tables share the same tokens, type scale, focus states, and spacing. Preserve existing save, error, pending, permission, and confirmation behavior.

## Responsive and accessible behavior

At 760 px, desktop navigation becomes the shared bottom navigation and the inset frame dissolves. Page padding decreases, metrics wrap to two columns, and creation cards become a vertical list. Company/role text may wrap; do not truncate the only copy of a qualification or salary. Long tables and stage collections may scroll within a clearly bounded region. Dialogs fit the viewport and keep their actions reachable. The shell includes a keyboard skip link.

All interactive controls have a visible label or an accessible name. Use `aria-expanded`, `aria-selected`, `aria-current`, and native form elements for actual state. Decorative marks are hidden from assistive technology. Preserve focus after filtering and avoid reordering an open item while someone is reading it. Verify 4.5:1 text contrast and both themes; state is never carried by the highlighter alone.

## Honest content and product boundaries

The current website serves candidates and administrators. This redesign does not add a recruiter ATS or an employer publishing product. Reference products are design inspiration, not evidence that RoboApply supports their features.

Company identity, benefits, qualifications, and source links come from existing job records. Do not invent salary periods, equity, hiring timelines, employee stories, response rates, or endorsements. The list API does not supply salary period; the full posting does. A score measures resume alignment, not hiring likelihood. Opening a posting is not evidence that an application was completed; keep the user's correction available.

New visible copy must be translated across all nine locales with `i18n-locale-sync`. Preserve placeholders and established machine strings. Documentation and internal design examples may use English.

## Validation

Run the smallest affected test first, then `npm test`, `npm run check`, and the frontend TypeScript check. Verify desktop, mobile, light, dark, and at least one CJK locale in a browser. Build using Node 24 after stopping any Next dev process sharing `.next`. Live backend, payment, and voice behavior require their services; component fixtures alone do not prove those integrations.

Run `node scripts/design-preview.mjs` to inspect the actual authenticated components with isolated fixture data at `http://localhost:3612/jobs`. The loopback-only harness blocks live API requests and visibly labels example data; it is not a substitute for end-to-end integration tests.

[The visual style guide](design-system.html) shows this system in light and dark, for both brands: tokens, type, controls, cards and the inset workspace. It is a standalone page served at `/design-system` by the design preview, so its token blocks are copies of `app/globals.css` and `styles/brands/goapply.css`; update them together. This document and `app/globals.css` remain authoritative.
