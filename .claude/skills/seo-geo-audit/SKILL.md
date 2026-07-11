---
name: seo-geo-audit
description: Audit a page or site for technical SEO + GEO (generative engine optimization) against 2026 best practice — retrievability, multilingual hreflang cluster integrity, extractable answer-shaped content, schema hygiene, AI-crawler policy. Use when asked to check/improve SEO, GEO, hreflang, structured data, or "why aren't we showing up in ChatGPT/Google".
---

# SEO + GEO Audit

Grounded in 2026 evidence (Ahrefs controlled studies, Princeton GEO paper, Google docs). Key reality checks: **schema markup does NOT drive AI citations** (do it as cheap entity hygiene only); **97% of llms.txt files get zero bot requests** (ship it, expect nothing); **no major AI crawler executes JavaScript** — SSR HTML text is the entire GEO surface; **GEO is mostly won off-page** (third-party mentions correlate ~3× stronger than backlinks).

## Checklist

### Retrievability (binary — fails here kill everything)
- [ ] `robots.txt` exists; marketing paths allowed for `*` AND named AI bots (GPTBot, OAI-SearchBot, ClaudeBot, PerplexityBot, Google-Extended, CCBot); app/api paths disallowed.
- [ ] `sitemap.xml` exists, referenced from robots, submitted to Google Search Console + Bing (+ Naver for ko).
- [ ] All marketing copy present in server-rendered HTML: `curl -s $URL | grep "<h1\|key claim text"` — never JS-injected.

### Multilingual (skip if single-locale)
- [ ] One URL per language (subpath) — cookie-based language switching is invisible to crawlers (Google crawls without Accept-Language or cookies).
- [ ] Full self-inclusive hreflang cluster on every locale page (missing return links ⇒ ignored) + `x-default`; ship via BOTH Metadata API `alternates.languages` and sitemap `xhtml:link`.
- [ ] Chinese: `zh-Hans`→simplified URL, `zh-Hant`→traditional URL, plus Bing-compat aliases `zh-CN`/`zh-HK`.
- [ ] Each locale page self-canonical; NEVER canonicalize across languages. Untranslated locale URLs: `noindex,follow` and OUT of the cluster/sitemap until translated (foreign hreflang serving duplicate English poisons the cluster).
- [ ] `<html lang>` matches page content; localized title/description lead with NATIVE keywords (KI not AI in de; 海投/投履歷/自소서-class native pain terms), not translated English.
- [ ] Default-language negotiation on `/` (Accept-Language) is fine as x-default; verify `curl -H 'Accept-Language: ja' $URL | grep '<html lang'`.

### Extractable content (the actual GEO lever)
- [ ] Question-shaped H2/H3s with self-contained, answer-first 40–75-word passages (cited ~3.1×).
- [ ] Visible FAQ in server HTML (FAQ *rich results* died May 2026; the visible text is what LLMs extract — worth ~2.8× citation rate).
- [ ] Concrete citable statistics with sources on-page (Princeton GEO: +30–40% visibility).
- [ ] Freshness: update cadence; Perplexity favors <30-day content.

### Schema (hygiene only — no rich-result fantasies)
- [ ] JSON-LD `@graph`: Organization + WebSite + WebPage + SoftwareApplication-with-offers (real prices synced to checkout). `inLanguage` per locale. Escape `<` as `<`.
- [ ] NEVER: fake `aggregateRating`/`review` (manual-action trigger), FAQPage/SearchAction (dead), prices that don't match the visible page.

### Verification commands
```bash
curl -s $URL | grep -oE '<title>[^<]*|<html[^>]*lang="[^"]*"'
curl -s -H 'Accept-Language: de' $URL | grep -oE '<html[^>]*lang="[^"]*"'
curl -s -o /dev/null -w '%{http_code} -> %{redirect_url}' $URL/en   # expect 308 -> /
curl -s $URL/robots.txt | head; curl -s $URL/sitemap.xml | head -c 800
curl -s $URL | python3 -c "import sys,json,re; m=re.findall(r'<script type=\"application/ld\+json\">(.*?)</script>', sys.stdin.read(), re.S); [print(json.dumps(json.loads(x), indent=1)[:500]) for x in m]"
```

### Off-page (report as roadmap, not page changes)
Review-platform presence (G2/Trustpilot — hard inclusion gates for "best X" AI answers), comparison/alternatives pages (listicles take ~40% of commercial-intent citations, but your own listicle citing you excludes you from the recommendation 69% of the time — earn third-party ones), Reddit presence (#1 Perplexity domain, volatile on ChatGPT), non-English content (dramatically weaker competition in AI answers).
