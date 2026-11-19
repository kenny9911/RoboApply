# RoboApply — Pulse

November 2026 · Implemented design system

RoboApply helps people make a considered next move, and most of the people making one are early in their careers. Pulse is the product's own brand, not a clone of another product's: blue-black ink on a cool-white ground, one sunny yellow, flat white tiles fitted edge to edge with narrow gaps, pill controls, and Space Grotesk headlines over DM Sans. Nothing is a gradient, nothing blurs, and nothing at rest casts a shadow.

Pulse was drawn on 2026-11-19 with two design skills used together. `design-taste-frontend` dealt the composition ("the well-kept board": one grid, filled tiles, no bands) and the palette ("blue-black and yellow"), and its inspector measured the result in a real browser at 1440, 768 and 390 px. `ui-ux-pro-max` recommended the same structure under another name (bento grids, block-based, flat fills), the type pairing (Space Grotesk with DM Sans) and the review rules (4.5:1 text, 44 px targets, visible focus, reduced motion). Where the two disagreed the reason is recorded: the first palette dealt was signal red, which is the colour of an error and of a rejected application in a tracker, so the palette was redrawn once; `ui-ux-pro-max` proposed violet, which RoboApply already wore as "Clarity" and which the taste skill bans as the default look of AI products.

Pulse replaces Desk (the resume.io clone of 2026-11-12; its teardown stays in [resume-io/TEARDOWN.md](resume-io/TEARDOWN.md) as the record of the layout the app still follows). It keeps Desk's token names, components and page recipes, so every screen restyled without a markup rewrite; only the marketing pages changed structure. Existing functionality, truthful claims, localization, accessibility and API boundaries remain applicable, as do the product rulings in `docs/roboapply/OVERHAUL_RULINGS.md` (no auto-submit, and the gap positioning).

## What makes it Pulse

| Decision | Rule |
| --- | --- |
| Tiles, not cards | A surface is a flat filled field. It is separated from what is under it by tone and at most a 1 px ring (`--e1`), never by a drop shadow. Tiles sit 8 px apart on the marketing board and 8–24 px apart in the app. |
| Bright, on purpose | Electric blue, a cobalt field, sunny yellow, on cool white or blue-black. The first Pulse palette (plum and raspberry, 2026-11-19) read as dark red and was replaced the next day. Orange, mint and periwinkle appear only as the cards of the 3D scene and as sticker tiles. Status colours always carry a word. |
| Yellow is spent, not sprayed | The sunny yellow is the strongest tile on a screen, the progress fill, a queue that needs the user, the selected tab of the Example. Navigation, borders and body text never take it. |
| Pills | Buttons, chips, the search field, segmented controls and the current page in the rail are fully round. Tiles and fields are 16–24 px. |
| Big type, few sizes | Marketing headlines run to 96 px in Space Grotesk at -0.045 em. The app keeps its titles at 26–32 px: a screen people work in is not a poster. |
| The brand plane | `--brand-plane` (cobalt) is a field in its own right: the statement tile, the first step, the footer. Type on it is `--on-plane` (white) in both themes. |

## Foundations

The production source of truth is `app/globals.css`. `styles/tokens.css` maps existing component aliases to these values; feature files never define a second palette. `styles/workspace.css` holds the shared composition (shell, page header, buttons, metrics, stage columns, resume cards). `components/features/marketing/marketing.module.css` holds the marketing board.

### Colour

- **Ink** (`--text`) is blue-black and carries every title and label.
- **Action** (`--action`) is the primary button, links and the focus ring: electric blue `#2B4DFF` in light (5.8:1 under white), a lighter blue `#8098FF` in dark with blue-black ink on it.
- **Canvas.** In the app `--bg` is the cool-white ground and `--surface` is the white tile on it; `--surface-2` and `--surface-3` are recesses and pressed fills. The marketing pages reverse it (`--mkt-page` white, `--mkt-tile` tinted). In dark every step is lighter than the one under it.
- **Highlight** (`--brand-mark`, with `--brand-plane` as the ink written on it) is the sunny yellow fill: the action tile, the recommended plan, plan and example chips, text selection, the brand tile's glyph. A **fill**, never a text colour on a light surface, and it never carries state alone.
- **Decorative blue** (`--accent-line`, `--accent-track`) draws lines and fills that carry no text: progress bars, the profile ring, the selected row's edge. Yellow on white is too faint for them. **Upgrade** (`--upgrade`) is the cobalt field of the paid-plan button.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--bg` | `#F4F6FB` | `#07080F` | The app's ground |
| `--surface` | `#FFFFFF` | `#10121C` | Tiles and work areas |
| `--surface-2` | `#ECEFF7` | `#191C2A` | Recessed fills, stage columns, hover |
| `--surface-3` | `#E1E5F0` | `#24283A` | Tracks, count chips, pressed fills |
| `--rule` / `--rule-strong` | `#E0E4EE` / `#C8CEDD` | `#262A3C` / `#3D4259` | Hairlines and control borders |
| `--text` | `#0B0D1A` | `#FFFFFF` | Titles and primary copy |
| `--text-2` | `#3A3F54` | `#DADDEA` | Supporting copy |
| `--text-muted` | `#596079` | `#A4A9BF` | Metadata (≥ 4.5:1 on every surface, the pressed `--surface-3` included) |
| `--action` | `#2B4DFF` | `#8098FF` | Primary buttons, links, focus |
| `--action-ink` | `#FFFFFF` | `#05081F` | Content on action fills |
| `--action-subtle` | `#E4E9FF` | `#1B2452` | Selection tints, the selected goal |
| `--brand-mark` | `#FFD43B` | `#FFD43B` | The highlight fill |
| `--brand-plane` | `#1D32D8` | `#1D32D8` | Ink on the highlight; the cobalt field |
| `--accent-line` / `--accent-track` | `#2B4DFF` / `#DCE3FF` | `#8098FF` / `#1F2A63` | Progress fill and track (no text) |
| `--upgrade` | `#1D32D8` | `#2B4DFF` | The paid-plan button |
| `--ok` / `--warn` / `--danger` | `#1F7A46` / `#8A5A00` / `#BF3310` | `#8FD3AB` / `#F4C152` / `#FF9A7A` | Labelled status, each with a `-subtle` fill. Danger is a vermilion, kept well apart from the yellows |
| `--tile-*` | seven pale blues and bright pastels | same | Sticker tiles; always with `--tile-ink` icons |
| `--mkt-page` / `--mkt-tile` / `--mkt-tile-2` | `--surface` / `--surface-2` / `--surface-3` | `--bg` / `--surface` / `--surface-2` | The marketing board |
| `--on-plane` / `--on-plane-2` | white / white at 80% | same | Type on `--brand-plane` |

GoApply (`styles/brands/goapply.css`) keeps the same ground, tiles, type and shapes and swaps the action to deep jade `#0E4A3E` (mint `#A6F2CC` in dark) and the highlight to mint `#9DF0C6` on a jade plane. `__tests__/brand/contrast.test.ts` computes every brand-token pair for both brands in both themes, including ink on the highlight.

**No gradients.** `--grad-brand`, `--grad-brand-hover`, `--grad-soft` and `--grad-panel` keep their names because components paint with them, and each is now a single colour. Do not write `linear-gradient` in app chrome. The one exception is the loading shimmer bound to a request in flight.

### Typography

Two self-hosted variable faces: **DM Sans** (`--font-ui`, weights 100–1000) for everything that is read and **Space Grotesk** (`--font-display`, 300–700) for h1–h3, figures and tile titles. Source Han provides Simplified and Traditional Chinese glyphs. Resume document fonts remain the user's choice. The UI scale is 12 / 13 / 15 / 17 / 20 px, `--fs-stat` 30 px, `--fs-display` 26–32 px (app titles) and `--fs-hero` 36–96 px (marketing). The marketing sheet derives its section headings from `--fs-display` (×1.65, capped at 8vw) so a headline stays within two lines on a phone. Use `--font-ui` and `--font-display`, never literal font-family names that bypass `next/font`.

No uppercase labels, no monospace, no numerals as decoration ("01", "02"): order is carried by a real `<ol>`. A short label inside a tile sits under its title in sentence case at 13 px.

### Geometry and elevation

The spacing scale is 4 / 8 / 12 / 16 / 24 / 32 / 48 / 64 px. Radii are 10 (`--r-sm`), 16 (`--r-md`) and 24 px (`--r-lg`); controls are pills (`--r-control`). Main controls are 40 px on desktop and 44 px on mobile; marketing buttons are 48–52 px. Keep visible focus states (a 2 px ring in the action colour; on the highlight and the plane, an outline in the ink of that field).

`--e1` is a 1 px ring, not a shadow. `--e2` is the hover step (a firmer ring and a short drop). `--e-float` and `--e3` are the only real shadows, for what sits above the page: menus, sheets, the ask bar, dialogs.

### Motion

State transitions run 120–260 ms on `cubic-bezier(0.2, 0.8, 0.2, 1)`. Buttons press to 97%. A tile that is a link changes field on hover (to the highlight) instead of lifting. On the marketing board the first three tiles rise in on load and later blocks rise as they enter the viewport; the travel never includes opacity, so nothing is hidden when scroll-driven animation is unsupported. The app has no entrances: motion there is feedback. Respect `prefers-reduced-motion`.

## The shell

An open plane: a 240 px rail and the workspace share the cool-white ground, and everything the user works on is a white tile on it. The rail holds the brand tile (yellow glyph on cobalt), the person (`SidebarProfile`: initials on cobalt inside a yellow ring that fills to profile completeness), then 40 px pill rows with 20 px grey icons. The current page is a white pill with an ink label one step heavier and its icon in the action colour. Counts are quiet grey chips; only a queue that needs the user takes the highlight. The workspace header is 68 px, opaque, with no blur and no hairline, and carries `Ready to apply` and `Upgrade` before the search, Ask, inbox, theme, language and account buttons. The rail's top group is five destinations (Dashboard, Jobs, Applications, Resume, Interview prep); Profile and Settings sit in the lower group. The signed-in home is the Dashboard (`/dashboard`). Below 760 px the rail leaves and the shared bottom navigation takes over.

## Reusable components

| Component | Responsibility | Usage |
| --- | --- | --- |
| `BrandSymbol` | Shared R / next-step glyph | Yellow glyph on the cobalt tile across public, auth and workspace |
| `PageHeader` | Title, context, optional actions | Muted supporting copy below the title; eyebrow led by a small yellow dot |
| `Btn` | Native button/link with shared variants | `primary` flat pill in the action colour, default white pill with a hairline, `violet` = the sunny yellow highlight with cobalt ink (the stronger of two adjacent CTAs), `ghost` |
| `Tabs` | Segmented control | Pill track; the selected tab is the action pill |
| `MetricGrid` | Labeled summary of measured values | Flat white tiles 8 px apart, the figure in Space Grotesk; `—` for pending/unknown; only show zero after data has loaded |
| `EmptyState` | Explain an empty/error state and offer recovery | Dashed glass panel, sticker tile, specific next step, no invented activity |
| `Modal` / `Drawer` / `Sheet` | Focus management, escape, backdrop | Drawers float 8 px inset with 22 px corners on desktop; the scrim blurs |
| `MatchCard` / feed card | Company identity, role essentials, evidence, actions | 22 px card that lifts on hover; separate strengths and questions; preserve score semantics |
| `AnalyzerPanel` | Resume quality checks and section navigation | Group issues by severity, enable filters, navigate to the relevant document section |
| `Sidebar` / `MobileNav` | Shared destination model | Today, Jobs, Applications, Resume, Interview prep; the bottom bar holds Today, Jobs, Applications, Resume and More; admin remains role gated |
| `PrepareApplicationButton` | One tap from a job to an application being prepared | Adds the job to the list, shows the cost sheet, starts the preparation; becomes a link once the application exists; renders nothing when the `agent` flag is off |

React components accept data and action callbacks rather than hide API calls in generic UI primitives. Keep query and mutation ownership in feature hooks; use `lib/api` for requests. Preserve stable keys and native semantic controls. Default to server components unless interaction needs client state. Keep global styles centralized and component-specific interactions scoped.

## Page recipes

- **Marketing:** a board, not a sequence of bands. The first screen is three tiles: the statement on the cobalt plane (the h1, the page's largest type, and its supporting sentence), the action on the sunny yellow (what the product does in one line, `Start free`, `See an example`, the reassurance) and the labelled interactive Example. Then: how it works as four tiles in four fields, each carrying one line of the product's own output for the Example's made-up job, with the "made-up data" note under the row → every feature as a link tile that turns yellow on hover (a last row of one spans the board) → real counters → quick search → pricing with the claim on the left and the two plans on the right (the recommended plan on the highlight) → questions with the heading held beside the answers → the closing action tile flanked by two tiles that run off the edges → the cobalt footer with the name built as wide as the page. No eyebrow labels, no step numerals, no gradients, no sticky glass header. Samples are clearly labeled and never presented as the visitor's account data.
- **Login / signup:** a pale blue illustration tile (ink type, the hand-drawn path, yellow check stickers) beside a focused form of pill controls. Mobile prioritizes the form. Preserve Google sign-in, password behavior, return destinations, locale, and theme.
- **Today:** the signed-in home. The title states how many things wait for the user; the goal line sits under it. "Waiting for you" comes first, at most four cards of one fact and one action, and its first action is the screen's only primary button (when nothing waits, the first pick's button is). Then one lane per agent, labelled by its job, never by a name: a past-tense line of real counts, the lane's items, one action. A count that has not loaded is a dash. A lane that fails says so and offers Retry without blocking the others.
- **Jobs:** the search is one summary line with `Change search` until the user opens it, so the first job card is near the top. The card's primary action is `Prepare application` when the `agent` flag is on; `Apply on company site` is second. Then, as before: an unboxed introduction → measured collection summary → visibly labeled local filters → role and company identity → practical facts → evidence. Local filters explicitly operate on loaded results. Scores never imply a hiring probability.
- **Resume:** AI first, without hiding the user's own documents. The hub opens with AI tailoring (pick a saved job without a tailored version, or paste a posting; the promise that every new keyword, number or claim waits for the user's OK sits under the action) beside "Up next" (only what needs attention: details to verify, the main resume's check) and Assistant questions → the library, where each card's preview is the resume itself (the editor's paper, scaled) with its latest checklist result and target title edited in place, and a last cell for new resumes (upload, guided builder, template, LinkedIn PDF; a file can be dropped on it) → versions per job. A first visit with no resume replaces all of it with one start panel led by upload. AI entries render only when AI may run for the user (R-04). Editing happens in the workspace with contextual review. The resume paper remains visually separate from application chrome.
- **Applications:** one destination with two views behind one switch, Getting ready (`/ready`) and Sent (`/applications`). On Sent: actual stage counts as flat tiles → actionable follow-ups → recessed stage columns of flat cards. Dragging has a native stage-menu alternative. Unknown and loading states never masquerade as zero.
- **Interview prep:** one screen, not a wizard. Past practice → the job (the only required choice) → a pre-matched plan shown as editable chips with inline option trays → a launch dock that is live from the moment a job is chosen. During a live interview the screen is shaped like a call — the interviewer holds the stage, the candidate's own tile is pinned into it, coach and transcript share an on-demand rail, and mic / camera / end sit in a bottom control bar. Reports state the score once, lead with the single next action, and put recommendations, per-question review, recording and transcript behind one tab strip.
- **Settings / billing / admin:** grouped forms and operational tables share the same tokens, type scale, focus states, and spacing. Preserve existing save, error, pending, permission, and confirmation behavior.

## Responsive and accessible behavior

At 760 px, desktop navigation becomes the shared bottom navigation. Page padding decreases, metrics wrap to two columns, and creation cards become a vertical list. Company/role text may wrap; do not truncate the only copy of a qualification or salary. Long tables and stage collections may scroll within a clearly bounded region. Dialogs fit the viewport and keep their actions reachable. The shell includes a keyboard skip link.

All interactive controls have a visible label or an accessible name. Use `aria-expanded`, `aria-selected`, `aria-current`, and native form elements for actual state. Decorative marks are hidden from assistive technology. Preserve focus after filtering and avoid reordering an open item while someone is reading it. Verify 4.5:1 text contrast and both themes; state is never carried by a colour fill alone.

## Honest content and product boundaries

The current website serves candidates and administrators. This redesign does not add a recruiter ATS or an employer publishing product. Reference products are design inspiration, not evidence that RoboApply supports their features.

Company identity, benefits, qualifications, and source links come from existing job records. Do not invent salary periods, equity, hiring timelines, employee stories, response rates, or endorsements. The list API does not supply salary period; the full posting does. A score measures resume alignment, not hiring likelihood. Opening a posting is not evidence that an application was completed; keep the user's correction available.

New visible copy must be translated across all nine locales with `i18n-locale-sync`. Preserve placeholders and established machine strings. Documentation and internal design examples may use English.

## Validation

Run the smallest affected test first, then `npm test`, `npm run check`, and the frontend TypeScript check. For a visual change also run the taste inspector on what you touched (`node ~/.claude/skills/design-taste-frontend/scripts/inspect.mjs <url>`, with `--app` for a signed-in screen) and read its screenshots at all three widths; its known open findings are listed under "Open findings" below. Verify desktop, mobile, light, dark, and at least one CJK locale in a browser. Build using Node 24 after stopping any Next dev process sharing `.next`. Live backend, payment, and voice behavior require their services; component fixtures alone do not prove those integrations.

Run `node scripts/design-preview.mjs` to inspect the actual authenticated components with isolated fixture data at `http://localhost:3612/jobs`. The loopback-only harness blocks live API requests and visibly labels example data; it is not a substitute for end-to-end integration tests.

[The visual style guide](design-system.html) shows this system in light and dark, for both brands: tokens, type, controls, cards and the inset workspace. It is a standalone page served at `/design-system` by the design preview, so its token blocks are copies of `app/globals.css` and `styles/brands/goapply.css`; update them together. This document and `app/globals.css` remain authoritative.

## 3D and motion (home page)

The home page carries one idea in three dimensions: a job search is a mess of postings, and the product sorts it. `components/features/marketing/HeroScene.tsx` mounts an empty, `aria-hidden` layer; when it nears the viewport it loads three.js and `heroSceneRuntime.ts` as their own chunk (three is never in a page's first load).

- **Hero (`variant="board"`):** 24 instanced cards drift in loose, then fly into a tilted 6 × 4 board in the right half of the statement tile (under the copy on tablet and phone). The pointer lifts the cards under it and turns the board a few degrees; a click on the tile shuffles and re-sorts; scrolling pulls the board apart in depth.
- **Final call to action (`variant="stacks"`):** the same cards settle into one spiralled pile beside the copy. Desktop only.
- **Colours** are the `--scene-1…5` tokens, read at runtime. Cards are flat-lit (one key light, a room environment, neutral tone mapping, no shadows, no bloom, no gradient).
- **Rules:** the canvas never takes the pointer from the copy; pixel ratio is capped at 2; the loop stops when the layer is off screen or the tab is hidden; under `prefers-reduced-motion` the cards are drawn once, already sorted; without WebGL the tile is a plain colour field; everything is disposed on unmount.
- **Around it:** the headline's words rise in one after another (`RisingWords`), and cards lean a few degrees toward a fine pointer (`CardTilt`, `--tx`/`--ty`). Both are off under reduced motion.

## Open findings

Measured on 2026-11-19 by the taste inspector; recorded so nobody rediscovers them.

- **Pictures.** The marketing home has no photographs or footage. Its pictures are the product's own output (the Example and the four step fragments). The inspector's floor of four real pictures is not met.
- **Headline length.** The English h1 ("Find out why you're not getting interviews.") is two lines at 1440 and 768 px and three at 390 px. Getting it to two on a phone means shorter copy in nine locales, which is a product decision (ruling R2), not a style one.
- **Typeface.** The taste skill's sheet dealt another face; DM Sans and Space Grotesk are the `ui-ux-pro-max` pairing, chosen on purpose.
- **Resume paper.** The resume thumbnail keeps document typography (sizes under 11 px, an uppercase line) and a soft shadow under the sheet. It is the user's document, exempt from the chrome rules (ruling C25).
- **The style guide page** ([design-system.html](design-system.html)) has the new tokens, fonts and headline; some of its section captions still describe Desk's layout.
