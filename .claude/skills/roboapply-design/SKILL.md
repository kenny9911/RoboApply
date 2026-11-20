---
name: roboapply-design
description: Extend or redesign RoboApply interfaces using the Pulse design system (blue-black ink on a cool-white ground, electric-blue actions, a cobalt plane, a sunny yellow highlight, Space Grotesk over DM Sans, flat tiles and pills, a three.js home scene), shared components, evidence-based matching, and transparent candidate workflows. Use for RoboApply page or component design work.
---

# RoboApply interface design

Read `docs/design-system.md` from the repository root for the current palette, typography, components, page recipes and open findings. It supersedes Desk (the resume.io clone), Paper (skillry.dev's warm paper and lime) and the September Clarity (violet) palette. `docs/design-system.html` is the living style guide (served at `/design-system` by `node scripts/design-preview.mjs`). Read `docs/design-reference-research.md` when adapting recruiting-product references.

Preserve the recognizable pattern: clear editorial discovery, structured work areas, practical role information, then evidence and next action. Use existing `PageHeader`, `Btn`, `Tabs`, `EmptyState`, `MetricGrid`, `Modal`, and feature components before introducing parallel patterns. Resolve colours and typography through `app/globals.css` tokens; GoApply overrides only the brand tokens in `styles/brands/goapply.css` (jade and mint). Keep document styling separate from app chrome.

Pulse in short: bright on purpose (the owner rejected plum and pink as "dark red, depressing"), for a young, agentic product. Flat filled tiles separated by tone and at most a 1 px ring; no gradients, no shadow at rest, no glow. Pill controls; 10 / 16 / 24 px corners. Space Grotesk for headlines and figures, DM Sans for everything read, sizes only from `--fs-*`, no uppercase or monospace labels. `--action` (electric blue; a lighter blue in dark) is the primary button, links and focus. `--brand-plane` (cobalt) is a field with white `--on-plane` type, and the ink written on the highlight. `--brand-mark` (sunny yellow) is a fill — the strongest tile, a queue that needs the user, the selected Example tab, the Great-fit meter — never a text colour on a light surface and never the only signal of state. Lines that carry no text use `--accent-line` (the action colour). Sticker tiles (`--tile-*`) keep their pastel in both themes, with `--tile-ink` on them. On a yellow or cobalt field, focus rings and selection switch to the field's ink.

The home page's 3D scene lives in `components/features/marketing/HeroScene.tsx` and `heroSceneRuntime.ts` (lazy chunk, low-power GPU, still under reduced motion, everything released on unmount). Keep three.js out of every page's first load.

Make evaluation inspectable: connect strengths, missing evidence, and criteria to the resume or job posting. A numerical match is not a hiring probability. Show undisclosed salary/location honestly. The compact jobs list lacks salary period, and employer stories/equity/process data are not available in the current candidate API; don't fabricate them.

The implemented website serves candidates and administrators. New recruiter or employer workflows need their own data and permissions; reference products are design inspiration, not evidence that RoboApply supports their features.

Keep client state near the interaction, API calls in `lib/api`, and native accessible controls for filters, navigation, and forms. Preserve auth, saved state, upload recovery, application correction, and interview controls. Use the repository's locale-sync workflow for visible copy changes.

Verify the changed workflow and responsive layout in both themes and both brands. Run `npm run check` (the design gate rejects raw font sizes, uppercase, brand-token box-shadows and literal font families) and the applicable tests, including `__tests__/brand/contrast.test.ts`. Read relevant local Next.js guides before changing routes, layouts, fonts, or rendering boundaries.
