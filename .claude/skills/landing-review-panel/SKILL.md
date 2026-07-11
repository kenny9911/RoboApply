---
name: landing-review-panel
description: Run a multi-agent review panel over a marketing/landing page — 3 professional experts (market strategist, product designer, headhunter/domain consultant) who vote accept/revise/reject, plus N in-character user personas who walk the page and report friction. Use when a landing page (or major marketing surface) changed and needs structured review before shipping — e.g. "review the landing page", "run the panel", "persona-test this page".
---

# Landing Review Panel

A structured, adversarial review harness for marketing surfaces. Experts vote; personas react in character; you fix `blocker`/`major` findings and re-run only what changed.

## 1. Prepare materials (agents can only judge what they can Read)

- **Screenshots**: full-page PNGs at 390×844 (mobile — the primary surface) and 1440×900, in every theme. Use Playwright with `reduced_motion='reduce'` so scroll-reveal content renders visible (otherwise `animation-timeline: view()` sections screenshot at opacity 0 — see the webapp-testing skill).
- **Copy source**: the i18n namespace JSON (or page copy) as a file.
- **Positioning brief**: target competitor, audience, honesty constraints (what may NOT be claimed).
- **Product-reality audit** if claims need grounding.

## 2. Run the workflow

Use the Workflow tool: phase 1 = 3 experts in `parallel`, phase 2 = personas in `parallel`. Schemas force structure:

- Expert: `{verdict: accept|accept-with-changes|reject, score: 1-10, one_liner, strengths[], required_changes[{what, why, where, severity: blocker|major|minor}], nice_to_haves[]}`
- Persona: `{first_5_seconds, signup: yes|no|maybe, why, friction[], best_section, worst_section, converting_change}`

Expert prompts that worked (adapt the domain consultant to the product's industry):
- **Strategist**: accountable for CAC/conversion; judge positioning vs the named competitor, claim believability, pricing vs willingness-to-pay, funnel logic for a cold social click. "Be adversarial about anything that smells like wishful thinking."
- **Designer**: mobile-first execution at 390px, hierarchy, theme system integrity, typography, a11y red flags visible in shots, where the page is too long.
- **Domain consultant** (for job-search: a veteran headhunter): claim credibility to an insider, what could blow up legally/reputationally, would they recommend it to their own clients.

Personas: 5 distinct, high-tension characters (different budgets, devices, themes, languages, prior burns with competitor products). Instruct: "Stay ruthlessly in character. Honest reaction, not politeness."

## 3. Aggregate + act

- Pass = every expert `accept`/`accept-with-changes` AND no un-addressed `blocker`.
- Fix all `blocker` + `major` items; batch `minor` with judgment. Re-screenshot after fixes.
- Persona `signup` split and each `converting_change` go into the report to the founder — they're roadmap signal, not just page feedback.
- Report votes + scores + what you changed vs deferred (with reasons).
