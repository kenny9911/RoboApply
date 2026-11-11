# RoboApply — Desk

November 2026 · Implemented design system

RoboApply helps people make a considered next move. Desk lays the product out the way resume.io's app does: a white canvas with cool grey recesses, navy ink, one blue for every action, a light-blue wash for where you are, 12 px corners and navy-tinted hairline shadows, with a goal dashboard as the signed-in home. Discovery is inviting; evaluation is grounded in evidence; operational screens are orderly.

The user asked on 2026-11-12 for RoboApply to be a clone of [resume.io](https://resume.io)'s web app. The teardown and the measured source values are in [resume-io/TEARDOWN.md](resume-io/TEARDOWN.md) (its colour, spacing, type and shadow tokens were read from resume.io's shipped token module; layout sizes were measured on the signed-in dashboard). The clone takes resume.io's layout, information architecture and palette; it keeps RoboApply's own name, logo, wording and artwork, and resume.io's proprietary typeface is replaced by Inter. Desk replaces the October "Paper" system (skillry.dev; [skillry-style-reference.md](skillry-style-reference.md)), which replaced Clarity and Fieldwork before it; it keeps their token names, components and page recipes, so every screen restyled without a markup rewrite. Existing functionality, truthful claims, localization, accessibility and API boundaries remain applicable, as do the product rulings in `docs/roboapply/OVERHAUL_RULINGS.md` (no auto-submit — so resume.io's "Auto Apply" becomes RoboApply's "Ready to apply", which prepares and the user submits — and the gap positioning).

## Reference synthesis

| Reference | Principle used | Product expression |
| --- | --- | --- |
| resume.io (app) | A goal dashboard as home, a person-first rail, one blue action, white cards on a white canvas with hairline shadows, large friendly type | The Dashboard (goal tabs, progress card, hero, job matches, ask bar), the rail with the profile ring, the light-blue active item, the `Upgrade` and `Ready to apply` header actions |
| Welcome to the Jungle | Candidate discovery with company context | Recognizable employers, searchable opportunities, role essentials before evaluation |
| Gem | Explainable evaluation with human judgment | Resume evidence beside gaps, criteria breakdown, actionable resume checks |
| Wellfound | Practical information before commitment | Salary, currency, work mode, location, source; undisclosed facts named explicitly |
| Teamtailor | Employer identity and authored storytelling | Editorial marketing and structured company/benefits context from actual postings |

See [the source-linked research](design-reference-research.md) for the recruiting-product sources and data limitations.

## Foundations

The production source of truth is `app/globals.css`. `styles/tokens.css` maps existing component aliases to these values; feature files never define a second palette. `styles/workspace.css` holds the shared composition (shell, page header, buttons, metrics, stage columns, resume cards).

### Colour

Three roles, never confused:

- **Ink** (`--text`) is navy and carries every title and label. **Action** (`--action`) is one blue for every primary button, link and focus ring: resume.io's Blue60 `#1170CD` (its lighter Blue50 `#1A91F0` is 3.31:1 on white, so it never carries text). In dark the action is the lighter Blue40 `#54AFF8`.
- **Canvas** (`--bg`, `--surface`, `--surface-2`, `--surface-3`) is the white page and cards with cool grey recesses (resume.io's Neutral5/10).
- **Highlight** (`--brand-mark`, with `--brand-plane` as the ink written on it) is a light-blue fill: plan and "Example" chips, the direct-posting badge, text selection and the brand tile. It is a **fill**, never a text colour, and it never carries state alone. "You are here" (the active nav item, the selected goal) is `--action-subtle` with the action colour and a heavier weight.
- **Decorative blue** (`--accent-line`, `--accent-track`) draws lines and fills that carry no text: progress bars, the selected row's edge. **Upgrade** (`--upgrade`) is the indigo of resume.io's paid-plan button.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--bg` | `#FFFFFF` | `#0F141E` | The canvas |
| `--surface` | `#FFFFFF` | `#161C28` | Cards and work areas |
| `--surface-2` | `#F7F9FC` | `#1E2532` | Recessed fills, stage columns, hover |
| `--surface-3` | `#EFF2F9` | `#273041` | Tracks, icon tiles, pressed fills |
| `--rule` | `#E7EAF4` | `#303848` | Hairlines |
| `--text` | `#1E2532` | `#F7F9FC` | Titles and primary copy |
| `--text-2` | `#495163` | `#D9DEEB` | Supporting copy |
| `--text-muted` | `#5E6679` | `#A3AABE` | Metadata (≥ 4.5:1 on every surface, the pressed `--surface-3` included) |
| `--action` | `#1170CD` | `#54AFF8` | Primary buttons, links, focus, selected segments |
| `--action-ink` | `#FFFFFF` | `#0F141E` | Content on action fills |
| `--action-subtle` | `#EAF6FF` | `#132D4B` | "You are here": the active nav item, selected goal, selection tint |
| `--brand-mark` | `#92CDFC` | `#92CDFC` | The highlight fill |
| `--brand-plane` | `#0F3871` | `#0C264C` | Ink on the highlight; the brand tile |
| `--accent-line` / `--accent-track` | `#54AFF8` / `#C3E5FE` | `#54AFF8` / `#10529B` | Progress fill and track, selected-row edge (no text) |
| `--upgrade` | `#282B8F` | `#5660E8` | The paid-plan button |
| `--ok` / `--warn` / `--danger` | `#217D47` / `#A85A0E` / `#DA0C22` | `#96D0AD` / `#F9BA44` / `#FE7D8B` | Labelled status, each with a `-subtle` fill |
| `--surface-glass` | `rgba(255,255,255,.72)` | `rgba(255,255,255,.04)` | Secondary buttons, stat cards, segmented tracks |
| `--tile-*` | resume.io's pastel steps (green, orange, blue, red, indigo, amber) | same | Sticker tiles; always with `--tile-ink` icons |

GoApply (`styles/brands/goapply.css`) keeps the same canvas and swaps the action to deep jade `#0E4A3E` (mint `#A6F2CC` in dark) and the highlight to mint `#9DF0C6` on a jade plane, with cool mint washes. `__tests__/brand/contrast.test.ts` computes every brand-token pair for both brands in both themes, including ink on the highlight.

**Washes.** `--grad-panel` is resume.io's light-blue panel (the dashboard hero); `--grad-soft` is a lighter version for introductions. `--grad-brand` is a flat blue, as resume.io's buttons are. Dense work areas and document paper stay on solid surfaces.

### Typography

Self-hosted **Inter** (variable, weights 100–900) carries the complete interface; resume.io's own face (TT Talent) is proprietary. Headlines differ from body by weight (600) and slightly tighter tracking. Source Han provides Simplified and Traditional Chinese glyphs. Resume document fonts remain the user's choice. The UI scale is 12 / 13 / 15 / 17 / 20 / 28 px, plus fluid page titles (28–34 px) and marketing headlines (40–72 px). resume.io sets its app larger (19 px body, 33 px titles); Desk keeps RoboApply's scale and uses the 17 px step where resume.io's rows and nav are read at a glance (nav items, progress rows, job card titles). Use `--font-ui` and `--font-display`, never literal font-family names that bypass `next/font`.

resume.io's uppercase tracked labels ("PROGRESS") are deliberately not copied (the design gate bans uppercase). Desk eyebrows and card labels are sentence case at 13 px in `--text-muted`.

### Geometry and elevation

The spacing scale is 4 / 8 / 12 / 16 / 24 / 32 / 48 / 64 px (resume.io's own). Cards, nav items and inputs use 12 px corners, sheets and panels 16 px; buttons and fields are nearly square (`--r-control`, 4 px), as resume.io's are; chips, goal tabs, search and badges stay pills. Main controls are 40 px on desktop and 44 px on mobile. Keep visible focus states (blue ring).

Elevation is resume.io's: navy-tinted shadows with the hairline built into the low step, so a card at rest (`--e1`) needs no separate border. `--e2` lifts, `--e-float` is for floating sheets and the ask bar, `--e3` for dialogs. No shadow ever takes a hue beyond the navy tint.

### Motion

State transitions run 120–240 ms. Cards lift on hover; overlays blur the page behind them. Animate a user action or a real loading state. Avoid perpetual decorative movement. Respect `prefers-reduced-motion`.

## The shell

One flat white sheet, as resume.io's app: a 240 px rail and the workspace share the canvas (navy in dark). The rail holds the brand tile, the person (`SidebarProfile`: the avatar inside a ring that fills to profile completeness, the name and the target role, opening /profile), then 40 px nav rows with 22 px grey icons; the current page is the light-blue wash with a blue label and icon. The workspace header is 72 px, white over the scrolling page, and carries resume.io's two calls to action (`Ready to apply`, `Upgrade`) before the search, Ask, inbox, theme, language and account buttons. The signed-in home is the Dashboard (`/dashboard`): a greeting, four goal tabs joined by short rules, a progress card beside a hero card for the selected step, the user's job matches as bordered two-column cards, and a floating ask bar. Below 760 px the rail leaves and the shared bottom navigation (Dashboard · Jobs · Applications · Resume · More) takes over.

## Reusable components

| Component | Responsibility | Usage |
| --- | --- | --- |
| `BrandSymbol` | Shared R / next-step glyph | Highlighter glyph on the ink tile across public, auth and workspace |
| `PageHeader` | Title, context, optional actions | Muted supporting copy below the title; eyebrow led by a small light-blue swatch |
| `Btn` | Native button/link with shared variants | `primary` flat blue block (4 px corners), default white hairline button, `violet` = light-blue highlight (the stronger of two adjacent CTAs), `ghost` |
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
- **Resume:** AI first, without hiding the user's own documents. The hub opens with AI tailoring (pick a saved job without a tailored version, or paste a posting; the promise that every new keyword, number or claim waits for the user's OK sits under the action) beside "Up next" (only what needs attention: details to verify, the main resume's check) and Assistant questions → the library, where each card's preview is the resume itself (the editor's paper, scaled) with its latest checklist result and target title edited in place, and a last cell for new resumes (upload, guided builder, template, LinkedIn PDF; a file can be dropped on it) → versions per job. A first visit with no resume replaces all of it with one start panel led by upload. AI entries render only when AI may run for the user (R-04). Editing happens in the workspace with contextual review. The resume paper remains visually separate from application chrome.
- **Applications:** actual stage counts as glass cards → actionable follow-ups → recessed stage columns of lifting cards. Dragging has a native stage-menu alternative. Unknown and loading states never masquerade as zero.
- **Interview prep:** one screen, not a wizard. Past practice → the job (the only required choice) → a pre-matched plan shown as editable chips with inline option trays → a launch dock that is live from the moment a job is chosen. During a live interview the screen is shaped like a call — the interviewer holds the stage, the candidate's own tile is pinned into it, coach and transcript share an on-demand rail, and mic / camera / end sit in a bottom control bar. Reports state the score once, lead with the single next action, and put recommendations, per-question review, recording and transcript behind one tab strip.
- **Settings / billing / admin:** grouped forms and operational tables share the same tokens, type scale, focus states, and spacing. Preserve existing save, error, pending, permission, and confirmation behavior.

## Responsive and accessible behavior

At 760 px, desktop navigation becomes the shared bottom navigation and the inset frame dissolves. Page padding decreases, metrics wrap to two columns, and creation cards become a vertical list. Company/role text may wrap; do not truncate the only copy of a qualification or salary. Long tables and stage collections may scroll within a clearly bounded region. Dialogs fit the viewport and keep their actions reachable. The shell includes a keyboard skip link.

All interactive controls have a visible label or an accessible name. Use `aria-expanded`, `aria-selected`, `aria-current`, and native form elements for actual state. Decorative marks are hidden from assistive technology. Preserve focus after filtering and avoid reordering an open item while someone is reading it. Verify 4.5:1 text contrast and both themes; state is never carried by a colour fill alone.

## Honest content and product boundaries

The current website serves candidates and administrators. This redesign does not add a recruiter ATS or an employer publishing product. Reference products are design inspiration, not evidence that RoboApply supports their features.

Company identity, benefits, qualifications, and source links come from existing job records. Do not invent salary periods, equity, hiring timelines, employee stories, response rates, or endorsements. The list API does not supply salary period; the full posting does. A score measures resume alignment, not hiring likelihood. Opening a posting is not evidence that an application was completed; keep the user's correction available.

New visible copy must be translated across all nine locales with `i18n-locale-sync`. Preserve placeholders and established machine strings. Documentation and internal design examples may use English.

## Validation

Run the smallest affected test first, then `npm test`, `npm run check`, and the frontend TypeScript check. Verify desktop, mobile, light, dark, and at least one CJK locale in a browser. Build using Node 24 after stopping any Next dev process sharing `.next`. Live backend, payment, and voice behavior require their services; component fixtures alone do not prove those integrations.

Run `node scripts/design-preview.mjs` to inspect the actual authenticated components with isolated fixture data at `http://localhost:3612/jobs`. The loopback-only harness blocks live API requests and visibly labels example data; it is not a substitute for end-to-end integration tests.

[The visual style guide](design-system.html) shows this system in light and dark, for both brands: tokens, type, controls, cards and the inset workspace. It is a standalone page served at `/design-system` by the design preview, so its token blocks are copies of `app/globals.css` and `styles/brands/goapply.css`; update them together. This document and `app/globals.css` remain authoritative.
