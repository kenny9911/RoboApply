---
name: roboapply-design
description: Extend or redesign RoboApply interfaces using the Clarity design system, shared components, evidence-based matching, and transparent candidate workflows. Use for RoboApply page or component design work.
---

# RoboApply interface design

Read `docs/design-system.md` from the repository root for the current palette, typography, components, and page recipes. It supersedes the older overhaul's aesthetic choices. Read `docs/design-reference-research.md` when adapting recruiting-product references.

Preserve the recognizable pattern: clear editorial discovery, structured work areas, practical role information, then evidence and next action. Use existing `PageHeader`, `Btn`, `EmptyState`, `MetricGrid`, `Modal`, and feature components before introducing parallel patterns. Resolve colors and typography through `app/globals.css` tokens. Keep document styling separate from app chrome. The user selected Ashby-inspired violet actions, near-white canvases, and lavender-to-blue gradients. This replaces the earlier green Fieldwork palette and takes precedence over generic advice against purple gradients. Use `--grad-brand`, `--grad-soft`, and `--grad-panel` for the established gradient treatments; keep dense content on solid surfaces.

Make evaluation inspectable: connect strengths, missing evidence, and criteria to the resume or job posting. A numerical match is not a hiring probability. Show undisclosed salary/location honestly. The compact jobs list lacks salary period, and employer stories/equity/process data are not available in the current candidate API; don't fabricate them.

The implemented website serves candidates and administrators. New recruiter or employer workflows need their own data and permissions; reference products are design inspiration, not evidence that RoboApply supports their features.

Keep client state near the interaction, API calls in `lib/api`, and native accessible controls for filters, navigation, and forms. Preserve auth, saved state, upload recovery, application correction, and interview controls. Use the repository's locale-sync workflow for visible copy changes.

Verify the changed workflow and responsive layout in both themes. Run applicable repository tests and design/copy checks. Read relevant local Next.js guides before changing routes, layouts, fonts, or rendering boundaries.
