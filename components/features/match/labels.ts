'use client';

// Label helpers shared by the match components: evidence lines, degree and
// level names. Deterministic evidence carries a `ref` (what the fact is) and
// the raw value from the posting or resume; AI evidence is a verbatim quote.

import { useTranslations } from 'next-intl';

import type { MatchEvidence } from '../../../lib/api/contracts/match';

const EVIDENCE_REFS = new Set([
  'title',
  'seniority',
  'skill_have',
  'skill_missing',
  'education_required',
  'class_year',
  'industry',
  'location_met',
  'location_not_met',
  'pay_met',
  'pay_not_met',
  'visa_offered',
  'visa_not_offered',
]);
const DEGREES = new Set(['none', 'associate', 'bachelor', 'master', 'phd']);
const LEVELS = new Set(['intern_newgrad', 'entry', 'mid', 'senior', 'lead_staff', 'director_exec']);

/** "Master's degree" for a degree key; the raw text otherwise. */
export function useDegreeLabel(): (value: string | number | null | undefined) => string | null {
  const t = useTranslations('fit.degree');
  return (value) => {
    if (value === null || value === undefined || value === '') return null;
    const v = String(value);
    return DEGREES.has(v) ? t(v) : v;
  };
}

export function useEvidenceText(): (e: MatchEvidence) => string {
  const t = useTranslations('fit');
  const degree = useDegreeLabel();
  return (e) => {
    if (!e.ref || !EVIDENCE_REFS.has(e.ref)) return t('compared.evidence.quote', { text: e.text });
    let text = e.text;
    if (e.ref === 'education_required') text = degree(e.text) ?? e.text;
    if (e.ref === 'seniority' && LEVELS.has(e.text)) text = t(`seniority.${e.text}`);
    // Visa lines quote the post's own words; with none there is nothing to quote.
    if ((e.ref === 'visa_offered' || e.ref === 'visa_not_offered') && !text.trim()) return t(`compared.evidence.${e.ref}_plain`);
    return t(`compared.evidence.${e.ref}`, { text });
  };
}
