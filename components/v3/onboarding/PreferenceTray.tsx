'use client';

// PreferenceTray — the captured-preference chip strip above the composer.
// Renders ONE chip per CONFIRMED captured field; fields listed in the latest
// `prefs-update` event's `unconfirmed: string[]` are suppressed until the
// assistant confirms them (design-review fix R7 — the tray must never show a
// value the user hasn't confirmed, e.g. an inferred salary currency).
// Tapping a chip pre-fills "Actually, about {field}…" into the composer.

import { useTranslations } from 'next-intl';

import type { OnboardingDraftPreferences } from '../../../lib/api/v2/types';

interface Props {
  draft: OnboardingDraftPreferences;
  /** Every field captured so far (union across turns). */
  captured: string[];
  /** Fields awaiting confirmation — suppressed from the tray. */
  unconfirmed: string[];
  /** Tap → pre-fill a correction into the composer. Receives the localized
   *  field label. */
  onEditField: (fieldLabel: string) => void;
}

/** Closed-enum draft values that need localization (work modes, employment
 *  types, seniority). Free-text values render as-is. */
const ENUM_VALUE_KEYS = new Set([
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
 * renderable value (a captured-but-empty field never gets a chip). Exported
 * for tests. `tValue` localizes closed-enum members; unknown values pass
 * through untouched.
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

export function PreferenceTray({
  draft,
  captured,
  unconfirmed,
  onEditField,
}: Props) {
  const t = useTranslations('onboarding.chat');

  // R7: only confirmed fields reach the tray.
  const visible = captured
    .filter((field) => !unconfirmed.includes(field))
    .map((field) => {
      const value = formatDraftFieldValue(draft, field, (v) =>
        t(`values.${v}`),
      );
      return value ? { field, value } : null;
    })
    .filter((entry): entry is { field: string; value: string } => !!entry);

  if (visible.length === 0) return null;

  return (
    <div style={{ textAlign: 'left' }}>
      <div
        style={{
          fontFamily: 'var(--mono)',
          fontSize: 10.5,
          color: 'var(--muted)',
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          fontWeight: 600,
          marginBottom: 6,
        }}
      >
        {t('tray_title')}
      </div>
      <div className="chips" style={{ marginTop: 0, justifyContent: 'flex-start' }}>
        {visible.map(({ field, value }) => {
          const label = t(`fields.${field}`);
          return (
            <button
              key={field}
              type="button"
              className="chip"
              onClick={() => onEditField(label)}
              title={t('tray_edit_prefix', { field: label })}
            >
              <strong style={{ fontWeight: 600 }}>{label}</strong>
              {': '}
              {value}
            </button>
          );
        })}
      </div>
    </div>
  );
}
