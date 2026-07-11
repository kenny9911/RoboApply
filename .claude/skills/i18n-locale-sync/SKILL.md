---
name: i18n-locale-sync
description: Translate new/changed RoboApply i18n namespaces into all locales with the correct per-market register, machine-voice invariants, and structural validation. Use when en.json namespaces changed (or a new locale is added) and the other locale bundles need to catch up — e.g. "translate the landing changes", "sync locales", "add Korean".
---

# i18n Locale Sync

RoboApply ships 9 locales (`lib/localeConfig.ts` LOCALES): en, zh, zh-TW, ja, ko, es, fr, pt, de. `en.json` is the master; `lib/i18n.ts` deep-merges every other bundle over EN, so **partial bundles are always safe** — missing keys fall back to English key-by-key.

## Bundle tiers

- **Full bundles** (ja, zh, zh-TW): entire file translated. When EN changes, translate the changed namespaces and replace them in the existing file.
- **Partial bundles** (ko, es, fr, pt, de): contain only `common`, `nav`, `landing`, `auth`, `onboarding`, `choosePlan`, `errors` (the marketing + conversion path). Everything else falls back to EN by design.

## Workflow

1. Diff or identify the changed EN namespaces. Dump the EN source objects to scratchpad JSON files.
2. Fan out one translation agent per locale (Workflow tool, `parallel`), each with:
   - the EN source JSON path(s),
   - the register guide for its locale (below),
   - the HARD RULES (below),
   - a structured-output schema: `{landing: object, extras?: object, notes: string}` (adapt field names to the namespaces being synced).
3. Validate + apply with `scripts/apply_translations.py <journal.jsonl|output-file>` — it enforces exact key-tree match vs EN and the machine-voice invariants before writing any file. Adapt its namespace lists if syncing something other than landing.
4. If a locale's landing translation is new: add it to `SEO_READY_LOCALES` (lib/localeConfig.ts) so it joins the hreflang cluster + sitemap and its `/{locale}` page flips from noindex to index; add it to `READY_LOCALES` to appear in the in-app switcher.
5. Run `npx vitest run __tests__/pages/landing.test.tsx`, then verify one locale over HTTP: `curl -s localhost:3611/ja | grep '<html lang'`.

## HARD RULES for translator agents

- Return the SAME JSON key structure as the EN source. Never add/remove/rename keys.
- MACHINE-VOICE strings stay ASCII/English exactly: log `time`/`tag` values (SCOUT/MATCH/DRAFT/QUEUE/HOLD/SUBMIT/DIGEST), "LIVE", "OK", tier codes (TIER-0/1/2), file-name strings ("overnight.log", "guarantees.conf", "session-042" — translate only the human suffix), prices/rates/stats (numbers unchanged).
- Preserve ICU placeholders `{like_this}` exactly.
- `landing.meta`: title ≤ 65 chars leading with the locale's native high-intent keyword (never a literal translation of the EN title); description ≤ 165 chars; keywords = 6–9 native search phrases.
- Brand couplet (`hero.headline_machine` / `headline_human` = "We apply. You interview.") gets the punchiest native equivalent, not a gloss.

## Per-locale register guide (from 2026-07 market research)

| Locale | Register | Native hooks / pains | Keyword seeds |
|---|---|---|---|
| es | tú, LatAm-neutral (no voseo/vosotros) | postulaciones infinitas, ghosting, remote-USD jobs | postular a trabajos automáticamente, IA que se postula por ti, práctica de entrevistas con IA |
| pt | você, warm-direct pt-BR | candidaturas infinitas, vagas fantasma | candidatar-se automaticamente, IA que se candidata por você, simulação de entrevista com IA |
| de | du (young product), no Beamtendeutsch; privacy = trust signal | — | KI-Bewerbungsagent, automatisch bewerben, KI Interview-Training (KI, not AI) |
| fr | modern-informal tu, never sloppy | candidatures sans réponse | postuler automatiquement, IA qui postule pour toi, simulation d'entretien IA |
| ja | です/ます polite, dignified — casual EN reads childish | 職務経歴書, 自動応募 | AI 自動応募, AI 模擬面接, 転職 AI エージェント |
| ko | 해요체 polite | 자기소개서(자소서) burden; interview-practice culture strong | AI 자동 지원, AI 모의면접, 자소서 AI |
| zh | direct modern 你 | 海投 fatigue ("告别海投"); mention 支付宝 where EN says Alipay | AI自动投简历, AI模拟面试, AI求职助手 |
| zh-TW | Taiwan register 你 (NOT converted simplified) | 104/1111 人力銀行 mass-apply fatigue; 投履歷 not 投简历 | AI自動投履歷, AI模擬面試, 履歷優化 AI |
