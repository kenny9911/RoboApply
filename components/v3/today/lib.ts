// components/v3/today/lib.ts
//
// Pure display helpers for the Today match feed — formatting + the mapping
// from real API shapes (RAJobListItem + RAJobMatchScoreView) onto the
// prototype's card vocabulary (tags / facets / status). Kept framework-free
// and i18n-agnostic where possible; the few user-facing strings these produce
// are passed in pre-translated by the card (so all copy stays in `t()`).

import type {
  RAJobListItem,
  RAJobMatchScoreView,
  RATrackerStatus,
  RAWorkType,
} from '../../../lib/api/v2';

/** A logo bubble color index 0..4 (matches `.logo[data-color]` in v3.css). */
export function logoColor(index: number): number {
  return ((index % 5) + 5) % 5;
}

/** First letter of the company name, uppercased, for the logo bubble. */
export function logoLetter(companyName: string): string {
  const c = companyName.trim();
  return c ? c[0]!.toUpperCase() : '?';
}

/** Compact salary band, e.g. "$185–215k". Returns null when unknown. */
export function formatSalary(
  min: number | null,
  max: number | null,
  currency: string | null,
): string | null {
  if (min == null && max == null) return null;
  const sym = currencySymbol(currency);
  const k = (n: number) => {
    if (n >= 1000) {
      const v = n / 1000;
      return Number.isInteger(v) ? `${v}k` : `${v.toFixed(0)}k`;
    }
    return String(n);
  };
  if (min != null && max != null) {
    return min === max ? `${sym}${k(min)}` : `${sym}${k(min)}–${k(max)}`;
  }
  const only = (min ?? max)!;
  return `${sym}${k(only)}`;
}

function currencySymbol(currency: string | null): string {
  switch ((currency ?? 'USD').toUpperCase()) {
    case 'USD':
    case 'AUD':
    case 'CAD':
      return '$';
    case 'EUR':
      return '€';
    case 'GBP':
      return '£';
    case 'JPY':
    case 'CNY':
      return '¥';
    default:
      return '';
  }
}

/** Bucket a posted-at ISO into a coarse age key the card translates. Returns
 *  `{ key, count }` so the caller can `t('posted.hoursAgo', { count })`. */
export function postedAge(
  postedAt: string | null,
  now: number = Date.now(),
): { key: 'justNow' | 'hoursAgo' | 'daysAgo' | 'unknown'; count: number } {
  if (!postedAt) return { key: 'unknown', count: 0 };
  const then = new Date(postedAt).getTime();
  if (Number.isNaN(then)) return { key: 'unknown', count: 0 };
  const diffMs = Math.max(0, now - then);
  const hours = Math.floor(diffMs / 3_600_000);
  if (hours < 1) return { key: 'justNow', count: 0 };
  if (hours < 24) return { key: 'hoursAgo', count: hours };
  return { key: 'daysAgo', count: Math.floor(hours / 24) };
}

/** Match tier from a 0..100 score — drives the headline tag + tone. */
export type MatchTier = 'strong' | 'good' | 'stretch' | 'longShot';
export function scoreTier(score: number): MatchTier {
  if (score >= 80) return 'strong';
  if (score >= 60) return 'good';
  if (score >= 40) return 'stretch';
  return 'longShot';
}

/** Work-type → a translation sub-key the card resolves. */
export function workTypeKey(wt: RAWorkType): 'remote' | 'hybrid' | 'onsite' {
  return wt;
}

/**
 * Map a tracker status → the prototype's 3-state card status. The Today feed
 * only distinguishes applied vs. open; "passed" is a client-local dismiss the
 * card manages itself (not derived here).
 */
export function cardStatusFromTracker(
  status: RATrackerStatus | null | undefined,
): 'applied' | 'queued' {
  if (
    status === 'applied' ||
    status === 'interviewing' ||
    status === 'negotiating' ||
    status === 'accepted'
  ) {
    return 'applied';
  }
  return 'queued';
}

/** One facet row on the expanded card. `tone` maps to `.facet.good/.warn`. */
export interface DerivedFacet {
  /** pre-translated label */
  label: string;
  /** pre-translated value */
  value: string;
  tone?: 'good' | 'warn';
}

/**
 * Derive the three facet rows (Salary fit / Skill overlap / Risk flag) from the
 * match explanation signals. All copy is passed in pre-translated via `labels`
 * so the helper itself emits no hardcoded English.
 */
export function deriveFacets(
  view: RAJobMatchScoreView,
  labels: {
    salaryFit: string;
    salaryWithinBand: string;
    salaryBelowBand: string;
    skillOverlap: string;
    skillValue: (pct: number) => string;
    riskFlag: string;
    riskNone: string;
  },
): DerivedFacet[] {
  const { signals } = view.explanation;
  const salaryGood = signals.salary >= 70;
  const topGap = view.explanation.gaps[0];

  return [
    {
      label: labels.salaryFit,
      value: salaryGood ? labels.salaryWithinBand : labels.salaryBelowBand,
      tone: salaryGood ? 'good' : 'warn',
    },
    {
      label: labels.skillOverlap,
      value: labels.skillValue(signals.skills),
    },
    {
      label: labels.riskFlag,
      value: topGap ?? labels.riskNone,
      tone: topGap ? 'warn' : 'good',
    },
  ];
}

/** A card tag (mono pill). `tone` maps to `.tag.strong/.warn`. */
export interface DerivedTag {
  label: string;
  tone?: 'strong' | 'warn';
}

/**
 * Derive the headline tags for a collapsed card from the list item + score.
 * All labels are pre-translated by the caller. We surface: the match-tier tag
 * (strong), the work mode, and — when the score is a stretch — a warn "stretch"
 * tag so the user reads risk at a glance.
 */
export function deriveTags(
  job: RAJobListItem,
  score: number | null,
  labels: {
    tier: Record<MatchTier, string>;
    workType: Record<'remote' | 'hybrid' | 'onsite', string>;
    stretch: string;
  },
): DerivedTag[] {
  const tags: DerivedTag[] = [];
  if (score != null) {
    const tier = scoreTier(score);
    tags.push({
      label: labels.tier[tier],
      tone: tier === 'strong' || tier === 'good' ? 'strong' : undefined,
    });
  }
  tags.push({ label: labels.workType[job.workType] });
  if (score != null && score < 60) {
    tags.push({ label: labels.stretch, tone: 'warn' });
  }
  return tags;
}
