// formatDraftField — render one draft field as a human string.
//
// Lifted out of the deleted `components/v3/onboarding/PreferenceTray.tsx`. The
// tray itself is gone (it belonged to the chat, which suppressed unconfirmed
// values because the assistant had not asked about them yet); this function is
// not, because the setup panel still has to say back what it understood.
//
// Its one caller is the `notes_added` echo on step 2: the free-text line is the
// only place in setup where a model reads something, so it is the only place
// that owes the user a receipt. `POST /confirm` returns the draft FIELD NAMES
// the extractor contributed; this turns each of them into the value that
// landed, so the echo reads "Will not take: agencies" rather than the bare
// word "dealbreakers".
//
// It never renders `salary` in setup — nothing in the flow can set it — but the
// case survives because Settings → Hunt shares this formatter and a partial
// range ("USD 150,000+") is exactly where a naive join produces nonsense.

import type {
  OnboardingDraftPreferences,
  RAPreferences,
  RAWorkType,
} from '../../../lib/api/v2/types';

/** Closed-enum draft values that need localization (work modes, employment
 *  types). Free-text values render as-is. */
export const ENUM_VALUE_KEYS = new Set([
  'remote',
  'hybrid',
  'onsite',
  'full_time',
  'contract',
  'part_time',
  'internship',
]);

/**
 * Human-readable value for a draft field, or null when the field has no
 * renderable value (a captured-but-empty field never gets a line).
 * `tValue` localizes closed-enum members; unknown values pass through
 * untouched.
 */
export function formatDraftFieldValue(
  draft: OnboardingDraftPreferences,
  field: string,
  tValue: (value: string) => string,
): string | null {
  const localize = (v: string) => (ENUM_VALUE_KEYS.has(v) ? tValue(v) : v);
  const joinList = (list?: string[]) =>
    list && list.length > 0 ? list.map(localize).join(' · ') : null;

  switch (field) {
    case 'targetRoles':
      return joinList(draft.targetRoles);
    case 'seniority':
      return draft.seniority ?? null;
    case 'workModes':
      return joinList(draft.workModes);
    case 'employmentTypes':
      return joinList(draft.employmentTypes);
    case 'industriesTarget':
      return joinList(draft.industriesTarget);
    case 'industriesAvoid':
      return joinList(draft.industriesAvoid);
    case 'companyStages':
      return joinList(draft.companyStages);
    case 'companySizes':
      return joinList(draft.companySizes);
    case 'targetCompanies':
      return joinList(draft.targetCompanies);
    case 'mustHaves':
      return joinList(draft.mustHaves);
    case 'dealbreakers':
      return joinList(draft.dealbreakers);
    case 'salary': {
      const s = draft.salary;
      if (!s || (s.min == null && s.max == null)) return null;
      const fmt = (n: number) => n.toLocaleString();
      const range =
        s.min != null && s.max != null
          ? `${fmt(s.min)}–${fmt(s.max)}`
          : s.min != null
            ? `${fmt(s.min)}+`
            : `≤${fmt(s.max as number)}`;
      const currency = s.currency ? `${s.currency} ` : '';
      const period = s.period ? ` / ${s.period}` : '';
      return `${currency}${range}${period}`;
    }
    case 'locations': {
      const l = draft.locations;
      if (!l) return null;
      const parts = [...(l.cities ?? []), ...(l.countries ?? [])];
      return parts.length > 0 ? parts.join(' · ') : null;
    }
    default:
      return null;
  }
}

/**
 * The PERSISTED preferences, read back in draft shape.
 *
 * `POST /confirm` returns the stored `RAPreferences`, not the draft it derived
 * them from, and the notes receipt has to be true: the free-text line goes
 * through the extractor and the taxonomy tables, which drop values they do not
 * recognise. Formatting the submitted draft would show the user a word the
 * server discarded. Formatting this shows what actually landed.
 *
 * Salary is mapped for completeness (Settings can set it) and is never
 * reachable from setup.
 */
export function draftFromPreferences(
  prefs: RAPreferences,
): OnboardingDraftPreferences {
  const modes = prefs.workModes ?? { remote: false, hybrid: false, onsite: false };
  const workModes = (['remote', 'hybrid', 'onsite'] as RAWorkType[]).filter(
    (m) => modes[m],
  );
  return {
    targetRoles: prefs.roleTitles ?? [],
    workModes,
    locations: { cities: prefs.cities ?? [], remoteOk: !!modes.remote },
    industriesTarget: prefs.industriesTarget ?? [],
    industriesAvoid: prefs.industriesAvoid ?? [],
    companyStages: Object.entries(prefs.companyStages ?? {})
      .filter(([, on]) => on)
      .map(([stage]) => stage),
    companySizes: prefs.companySizes ?? [],
    targetCompanies: prefs.targetCompanies ?? [],
    mustHaves: prefs.mustHaves ?? [],
    dealbreakers: prefs.dealbreakers ?? [],
  };
}

/**
 * Draft field names that have a `jobs.setup.fields.*` label.
 *
 * next-intl does NOT throw on a missing key — it renders the literal dotted
 * path — so a dynamic `t('fields.' + name)` over a name the server invented
 * would ship the string "jobs.setup.fields.whatever" to nine locales. The echo
 * silently drops anything not on this list instead.
 */
export const LABELLED_DRAFT_FIELDS = new Set([
  'targetRoles',
  'seniority',
  'workModes',
  'salary',
  'employmentTypes',
  'industriesTarget',
  'industriesAvoid',
  'companyStages',
  'companySizes',
  'locations',
  'targetCompanies',
  'mustHaves',
  'dealbreakers',
]);
