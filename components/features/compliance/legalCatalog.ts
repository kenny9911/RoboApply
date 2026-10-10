// components/features/compliance/legalCatalog.ts — the web's copy of the legal
// document catalog (client-safe; no fs, no env).
//
// Mirrors LEGAL_DOC_FILES / LEGAL_DOC_ALIASES / LEGAL_DOC_MARKET_ALIASES /
// LEGAL_FOOTER_DOCS in server/src/features/compliance/contract.ts (runtime
// values cannot cross the type-only contract mirror). A parity test keeps the
// two identical.

export type LegalMarket = 'intl' | 'cn';

export const LEGAL_DOCS = [
  'terms',
  'privacy',
  'cookies',
  'refunds',
  'subscription-terms',
  'ai-disclosure',
  'tw-pdpa-notice',
  'pi-collection-list',
  'third-party-sharing',
  'ai-content-labels',
  'complaints',
  'referral-terms',
  'coaching',
] as const;
export type LegalDocSlug = (typeof LEGAL_DOCS)[number];

export const LEGAL_DOC_FILES: Record<LegalMarket, Partial<Record<LegalDocSlug, string>>> = {
  intl: {
    terms: 'terms',
    privacy: 'privacy',
    cookies: 'cookies',
    refunds: 'refunds',
    'subscription-terms': 'subscription-terms',
    'ai-disclosure': 'ai-disclosure',
    'tw-pdpa-notice': 'tw-pdpa-notice',
    'referral-terms': 'referral-terms',
    coaching: 'coaching',
  },
  cn: {
    terms: 'user-agreement',
    privacy: 'privacy',
    'pi-collection-list': 'pi-collection-list',
    'third-party-sharing': 'third-party-sharing',
    'ai-content-labels': 'ai-content-labels',
    complaints: 'complaints',
    'referral-terms': 'referral-terms',
    coaching: 'coaching',
  },
};

export const LEGAL_DOC_ALIASES: Readonly<Record<string, LegalDocSlug>> = {
  agreement: 'terms',
  'user-agreement': 'terms',
  'personal-info-list': 'pi-collection-list',
  'ai-content-labelling': 'ai-content-labels',
};

export const LEGAL_DOC_MARKET_ALIASES: Record<LegalMarket, Partial<Record<LegalDocSlug, LegalDocSlug>>> = {
  intl: {},
  cn: { 'ai-disclosure': 'ai-content-labels' },
};

export const LEGAL_FOOTER_DOCS: Record<LegalMarket, LegalDocSlug[]> = {
  intl: ['terms', 'privacy', 'cookies', 'ai-disclosure', 'subscription-terms', 'refunds'],
  cn: ['terms', 'privacy', 'pi-collection-list', 'third-party-sharing', 'ai-content-labels', 'complaints'],
};

export function resolveLegalDocSlug(market: LegalMarket, slug: string): { doc: LegalDocSlug; file: string } | { redirect: LegalDocSlug } | null {
  const alias = LEGAL_DOC_ALIASES[slug] ?? (LEGAL_DOC_MARKET_ALIASES[market] as Record<string, LegalDocSlug | undefined>)[slug];
  if (alias) return LEGAL_DOC_FILES[market][alias] ? { redirect: alias } : null;
  if (!(LEGAL_DOCS as readonly string[]).includes(slug)) return null;
  const doc = slug as LegalDocSlug;
  const file = LEGAL_DOC_FILES[market][doc];
  return file ? { doc, file } : null;
}

/** Documents of a market that WP-13 ships (for the "Other documents" list). */
export function legalDocsFor(market: LegalMarket, locale?: string | null): LegalDocSlug[] {
  const base = [...LEGAL_FOOTER_DOCS[market]];
  if (market === 'intl' && locale === 'zh-TW') base.push('tw-pdpa-notice');
  return base;
}

/**
 * Block placeholders rendered as live components on the page. The last four
 * come from the code that enforces them (residency summary, the AI routing
 * policy lists, the job data sources, the cross-border rule): never typed
 * into a document.
 */
export const LEGAL_BLOCKS = ['retention_schedule', 'ai_models', 'processors', 'processing_facts', 'llm_endpoints', 'data_attributions', 'offshore_notice'] as const;
export type LegalBlock = (typeof LEGAL_BLOCKS)[number];

export type LegalSegment = { kind: 'markdown'; text: string } | { kind: 'block'; block: LegalBlock };

/** Split a document body at block placeholders (on their own line). */
export function splitLegalBlocks(body: string): LegalSegment[] {
  const out: LegalSegment[] = [];
  const re = new RegExp(`^[ \\t]*\\{\\{\\s*(${LEGAL_BLOCKS.join('|')})\\s*\\}\\}[ \\t]*$`, 'gm');
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const text = body.slice(last, m.index);
    if (text.trim()) out.push({ kind: 'markdown', text });
    out.push({ kind: 'block', block: m[1] as LegalBlock });
    last = m.index + m[0].length;
  }
  const rest = body.slice(last);
  if (rest.trim()) out.push({ kind: 'markdown', text: rest });
  return out;
}
