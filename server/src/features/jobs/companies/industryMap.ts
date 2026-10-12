// server/src/features/jobs/companies/industryMap.ts
//
// One industry vocabulary for companies (SM-10): the closed list the
// industries filter and onboarding already use (ONBOARDING_INDUSTRIES). A
// provider or bank string becomes one of those ids only when it IS one of
// them, compared exactly and without regard to case (the id as written,
// "AI / ML", or its slug, "ai_ml"). Nothing is guessed from a near match: an
// unmapped value is kept as the source wrote it (D3), so "Banking" stays
// "Banking" and never turns into "Fintech".

import { ONBOARDING_INDUSTRIES } from '../../onboarding/contract.js';

/** The industry ids, in list order. */
export const INDUSTRY_IDS: readonly string[] = ONBOARDING_INDUSTRIES.map((i) => i.id);

function key(label: string): string {
  return label.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
}

const ID_BY_LABEL = new Map<string, string>();
for (const { id, slug } of ONBOARDING_INDUSTRIES) {
  ID_BY_LABEL.set(key(id), id);
  ID_BY_LABEL.set(key(slug), id);
}

/** The industry id a label names exactly (case-insensitive), or null. */
export function industryIdFor(label: unknown): string | null {
  if (typeof label !== 'string') return null;
  return ID_BY_LABEL.get(key(label)) ?? null;
}

/** Provider or bank industry strings with every exact label replaced by its id; the rest unchanged; no value twice. */
export function mapIndustries(values: readonly string[] | null | undefined): string[] {
  const out: string[] = [];
  for (const value of values ?? []) {
    if (typeof value !== 'string' || !value.trim()) continue;
    const mapped = industryIdFor(value) ?? value;
    if (!out.includes(mapped)) out.push(mapped);
  }
  return out;
}
