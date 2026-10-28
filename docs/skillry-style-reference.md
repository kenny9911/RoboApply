# Skillry — UI/UX style reference

Captured 2026-10-29 from https://skillry.dev (signed in) as the reference for
RoboApply's "Paper" redesign. Values are computed styles read from the live
site, not estimates. Pages studied: home, `/skills` (marketplace), a skill
detail page, the Categories mega menu, the account menu, `/dashboard` (My
Skills) and `/settings/profile`, in light and dark.

This file records what Skillry does. What RoboApply takes from it, and where it
deliberately differs, is in [design-system.md](design-system.md).

## 1. Personality in one line

A studio catalogue printed on warm paper: near-black ink, one highlighter
colour (electric lime), one quirky grotesque, big soft corners, and hand-drawn
illustration tiles in muted earth tones. Calm and editorial in structure,
playful in a few deliberate places.

| Trait | How it shows |
| --- | --- |
| Warm, not clinical | Cream canvas `#F4F1E9` instead of white. Cards are a lighter cream, never pure white |
| Ink-first | Primary text, primary buttons, the selected tab and the selected stat card are all near-black `#121313` |
| One highlighter | Lime `#F4FF71` marks money and momentum: Upgrade, Free, Most popular, the active nav item, the closing CTA band |
| Crafted | Hand-drawn line illustrations on colour tiles, an offset "print" shadow on the hero title, hard offset block shadows on showcase panels |
| Soft geometry | Pill buttons and chips, 18–22 px card corners, 20 px panels |
| Quiet chrome | Hairline borders at 8–16 % ink, translucent white fills, large low-opacity shadows |

## 2. Colour

Light is the default. Dark inverts the canvas and promotes lime from accent to
primary.

| Token (shadcn names on the site) | Light | Dark | Role |
| --- | --- | --- | --- |
| `--background` | `#F4F1E9` | `#121313` | Page canvas |
| `--foreground` | `#121313` | `#F4F1E9` | Primary ink |
| `--card` / `--popover` | `#FBFAF6` | `#1B1C1C` | Cards, menus |
| `--muted` / `--sidebar` | `#EBE7DE` | `#252727` / `#1B1C1C` | Sidebar, footer, recessed areas |
| `--muted-foreground` | `#666962` | `#A7AAA4` | Secondary copy |
| `--primary` | `#121313` | `#F4FF71` | Primary buttons, selected states |
| `--primary-foreground` | `#F8F6EF` | `#121313` | Text on primary |
| `--secondary` / `--accent` | `#F4FF71` | `#2A2C22` / `#F4FF71` | Highlighter |
| `--border` | `#1213131F` (12 % ink) | `#F4F1E924` | Hairlines |
| `--input` | `#12131329` (16 % ink) | `#F4F1E92E` | Field borders |
| `--ring` | `#121313` | `#F4FF71` | Focus |
| `--destructive` | `oklch(58% .22 27)` | `oklch(70.4% .191 22.2)` | Errors |
| `--radius` | `0.875rem` | — | Base radius (14 px) |

Other recurring values:

- Translucent fills: `rgba(255,255,255,.55)` for secondary buttons and unselected
  stat cards, `.60` for the segmented control track, `.30` for empty states.
- Panel fill on detail pages: `#FFFDF8`.
- Count chip: 6 % ink fill with 55 % ink text.
- Illustration tile colours (muted earth): sage olive, terracotta `≈#D9714F`,
  steel blue `≈#6F95B8`, blush `≈#E8C3C3`, seafoam `≈#B8CFC4`, lavender
  `≈#C9C6DD`, forest teal `≈#5C9178`, camel `≈#D4A986`, cornflower
  `≈#5F8FD0`, rose `≈#B3577A`, salmon `≈#E8908A`.
- Hero wash: a very soft peach radial gradient behind the headline.

Measured contrast (WCAG 2.x):

| Pair | Ratio | Verdict |
| --- | --- | --- |
| Ink on cream | 16.49 | AAA |
| Muted `#666962` on cream / tan / card | 4.95 / 4.52 / 5.34 | AA, tan is borderline |
| Ink on lime | 17.18 | AAA |
| Lime against cream (shape, not text) | 1.04 | A lime fill on cream has no edge of its own |
| Mono eyebrow at 40–45 % ink | 2.55–2.94 | **Fails** |
| Inactive segment label (55 % ink on 60 % white) | 4.08 | **Fails** at 13 px |
| Dark: muted `#A7AAA4` on `#121313` | 7.91 | AAA |

## 3. Typography

One family does everything: **Bricolage Grotesque** (400 and 600 loaded), a
grotesque with optical sizes and slightly quirky letterforms. Monospace
(`ui-monospace`) appears only in uppercase eyebrows and code prompts.

| Role | Size / line | Weight | Tracking | Notes |
| --- | --- | --- | --- | --- |
| Hero | 84 / 0.92 | 600 | −0.06 em | Offset print shadow: `2.9px 3.8px 0 #E9A78B, 4.6px 5.9px 0 rgba(18,19,19,.12)` |
| Section headline | 40–48 / 1.05 | 600 | ≈−0.04 em | "Every Skill is designed in-house" |
| Page title (app) | 32 / 1.2 | 600 | −0.035 em | Dashboard, Profile |
| Detail title | 36 / 1.04 | 600 | −0.045 em | Skill page |
| Marketplace title | 24 / 32 | 600 | −0.025 em | With a count chip beside it |
| Rail heading | 20 / 28 | 600 | −0.025 em | "Featured Agent Skills" |
| Body | 16 / 24 (14–15 in panels) | 400 | 0 | Muted colour for descriptions |
| UI label / button | 13–14 / 20 | 600 | 0 | Buttons are semibold, never bold |
| Card title | 13 / 16 | 500 | 0 | 65 % ink |
| Filter row | 12.5 / 19 | 400 | 0 | 62 % ink, count right-aligned |
| Group label | 11–12 / 16 | 500–600 | 0 | 40–70 % ink |
| Eyebrow | 11–12, uppercase, mono | 400 | 0.18 em | 40–45 % ink |
| Badge | 10, uppercase | 600 | 0.015 em | On lime |

Headlines are short and declarative ("Connect your agent", "Simple access to
every Skill"), often split across two lines with a manual break.

## 4. Shape, borders, elevation

| Element | Radius |
| --- | --- |
| Buttons, chips, badges, segmented control, search | Pill |
| Detail-page CTAs (Buy, Copy install prompt) | 18 px |
| Inputs (44 px tall) | 18 px |
| Stat cards, nav items | 18 px |
| Media cards (thumbnails) | 22 px |
| Panels, settings cards, empty states, app inset | 20 px |
| CTA band | ≈24 px |
| Icon tiles | 20 % (squircle-like) |

Borders are always hairlines in ink alpha: 8 % (sidebar edge, app inset ring),
10 % (cards, panels), 12 % (general), 15–16 % (secondary buttons, inputs),
dashed 15 % for empty states. A selected pricing card swaps to a 2 px ink
border.

Shadows are wide, soft and neutral, sized to the element:

| Use | Shadow |
| --- | --- |
| Badge on media | `0 3px 10px rgba(17,18,18,.12)` |
| Active segment | `0 4px 12px rgba(18,19,19,.18)` |
| Primary CTA | `0 10px 26px rgba(18,19,19,.22)` |
| Selected stat card | `0 16px 40px rgba(17,18,18,.18)` |
| Floating panel | `0 16px 48px rgba(17,18,18,.07)` |
| Showcase panel ("print") | Hard offset block `8px 10px 0` in 10–22 % ink |

No coloured glows anywhere.

## 5. Layouts

**Marketing.** A dismissible black promo bar (lime link) over a sticky 64 px
header: `rgba(244,241,233,.92)` with `backdrop-filter: blur(24px)`, logo tile at
left, plain text nav with chevron dropdowns, pill search, lime Upgrade chip and
round icon buttons at right. Hero is centred: headline, two marquee rows of
illustration tiles, then a black primary pill and a translucent secondary pill,
then a "Works with" logo stack. Below: horizontally scrolling rails of media
cards (title + muted one-line description + "View all →" link), a two-column
"made in-house" story with checklist, an install panel with hard offset shadow,
a testimonial marquee, three pricing cards (middle one ink-bordered with a lime
CTA and a "Most popular" lime badge), an FAQ split (heading left, accordion
right), a full-width lime CTA band with a logo grid, and a tan multi-column
footer.

**Marketplace (`/skills`).** 236 px filter sidebar on the canvas with an 8 %
right hairline: grouped checkbox rows with right-aligned counts. Content:
title + count chip, one-line muted subtitle, a segmented sort control at right
(pill track, active segment is a black pill), then a 4-column grid of media
cards. Cards lift slightly on hover and reveal like/save buttons.

**Detail.** Breadcrumb, a scrolling column of screenshots at left, a sticky
purchase panel at right (`#FFFDF8`, 20 px radius, soft shadow): "Pick" badge,
title + version, muted description, status pill, stat row with icons, price
with black CTA, a lime subscription upsell card, then paired actions (black
primary, outline secondary).

**App shell (dashboard, settings).** The sidebar sits on tan `#EBE7DE` and the
main content is an *inset panel*: cream, 20 px radius, 1 px 8 % ink ring, 8 px
margin from the window edge. Sidebar: logo, nav items 40 px tall with 18 px
radius, the active item filled lime with ink text, small group labels, and a
user card pinned to the bottom. The panel's top bar holds a sidebar toggle and
a breadcrumb at left and round icon buttons at right. Page header: 32 px title
plus a muted one-line subtitle. Stat cards in a row: the selected one is solid
ink with white text, the rest translucent white with hairlines. Sections have a
16 px semibold heading, muted description, a right-aligned "Browse all ↗" link
and a hairline rule. Empty state: dashed panel, small icon square, semibold
title, muted line, outline pill button.

**Settings card.** Title + muted description, field, then a tan footer band
with helper text at left and a small black pill "Save" at right.

**Menus.** The mega menu blurs and dims the page behind it; the panel has a tan
left rail (active item = white pill) and a two-column grid of cream tiles with
coloured icon squares, ending in a lime "Browse all" pill. The account menu is
a small cream popover: name, email, icon rows, Log out.

## 6. Components (measured)

| Component | Spec |
| --- | --- |
| Primary button | Ink fill, white text, pill, 48 px (hero) / 40 px (forms), 14 px/600, `0 20px` padding |
| Secondary button | `rgba(255,255,255,.55)` fill, 1 px 15 % ink border, ink text, pill |
| Highlight chip | Lime fill, ink text, pill, 32 px, 12 px/600, leading icon |
| Count chip | 6 % ink fill, 55 % ink text, pill, 24 px, 12 px/600 |
| Badge | Lime, pill, 24 px, 10 px/600 uppercase, small shadow |
| Segmented control | Track: pill, 60 % white, 1 px 10 % ink border, 4 px padding. Item: 32 px, 13 px/600. Active: ink pill, white text, shadow |
| Input | 44 px, 18 px radius, 75 % white fill, 1 px 16 % ink border, 14 px text, 3 px focus ring |
| Nav item | 40 px, 18 px radius, 14 px/600 when active; active = lime fill |
| Stat card | 80 px, 18 px radius, `14px 16px` padding, icon in a 32 px square, value 18 px/600, label 12 px |
| Media card | 22 px radius thumbnail with 1 px 10 % ink border, title 13 px/500 below, meta icons right |
| Filter row | 29 px, 14 px radius, 12.5 px text, count at right |
| Empty state | Dashed 15 % ink border, 30 % white fill, 20 px radius, centred |
| Accordion | Hairline-separated rows, 15 px/600 question, plus / × toggle at right |

## 7. Imagery and icons

- Illustrations: black hand-drawn line art (hands holding objects, simple
  diagrams) on flat muted earth-tone squircles. They carry the brand far more
  than colour does.
- UI icons: thin outline icons (≈1.5 px stroke, Lucide-like), 16–18 px.
- Product imagery is always inside rounded media frames with a hairline.
- Logos are grouped in tiles (CTA band) or overlapping circles ("Works with").

## 8. Motion and interaction

- Cards lift on hover (small translate + shadow) and reveal secondary actions.
- Menus open over a blurred, dimmed page.
- Two marquee rows drift slowly in the hero, and the testimonials scroll.
- Transitions are short and eased; nothing bounces.

## 9. UX patterns worth keeping

1. **One primary action per region**, always ink; secondary actions are visibly
   quieter (translucent, hairline).
2. **Lime is reserved for commercial or momentum moments**, so it keeps its
   pull: upgrade, free, most popular, the current location in the app.
3. **Counts beside titles** ("617 Skills") and **counts beside filters** let
   people predict results before clicking.
4. **Section header pattern** everywhere: heading, one muted sentence,
   "View all →" at the far right.
5. **Inset app panel** separates the workspace from navigation without heavy
   borders.
6. **Settings cards with footer bands** put the rule ("Please use 3–30
   characters") next to the Save button.
7. **Empty states are invitations**: icon, one line, one button.

## 10. Where Skillry falls short (do not copy)

- Mono uppercase eyebrows at 40–45 % ink: 2.6–2.9:1 contrast at 11–12 px.
- Inactive segmented-control labels: 4.08:1 at 13 px.
- 10 px uppercase badges and 12.5 px filter text sit below a 12 px, on-scale
  type floor.
- Lime on cream has no edge (1.04:1); it reads only because of the ink text
  inside it, so lime must never be the only signal of state.
- The hero relies on a looping marquee; looping motion needs a reduced-motion
  fallback.
