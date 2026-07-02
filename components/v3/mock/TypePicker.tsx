'use client';

// TypePicker — Step 03. The researched interview FORMATS (behavioral, live
// coding, system design, case, clinical scenario, mock sales call, portfolio
// review, take-home defense, …) each with a minute estimate. When a role is
// chosen we surface the formats that actually fit it: recommended ones sort to
// the front and carry a "Recommended" badge — so a Nurse sees Clinical Scenario,
// a salesperson a Mock Sales Call, a designer a Portfolio Review. Selecting
// lifts the type id. Labels/subs are localized via mock.setup.types.<id>.*.

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { RAMockType } from '../../../lib/api/v2/types';
import { useMockRoleLabels } from '../../../lib/mockRoleLabels';

/** Collapsed default: show only the N most role-relevant formats. */
const COLLAPSE_LIMIT = 6;

interface Props {
  types: RAMockType[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Ordered type ids recommended for the chosen role (badge + sort-to-front). */
  recommendedTypeIds?: string[];
  /** The chosen role title, for the "recommended for {role}" sub-line. */
  roleLabel?: string | null;
}

export function TypePicker({ types, selectedId, onSelect, recommendedTypeIds, roleLabel }: Props) {
  const t = useTranslations('mock');
  const { localizeRole } = useMockRoleLabels();
  const [expanded, setExpanded] = useState(false);
  // Localized type label/sub with the catalog English as a safe fallback.
  const tr = (tp: RAMockType, field: 'label' | 'sub'): string => {
    const key = `setup.types.${tp.id}.${field}`;
    return t.has(key) ? t(key) : tp[field];
  };

  const recIds = recommendedTypeIds ?? [];
  const recSet = useMemo(() => new Set(recIds), [recommendedTypeIds]);

  // Recommended formats first (in recommendation order), then the rest in
  // catalog order. V8's Array.sort is stable, so non-recommended order holds.
  const ordered = useMemo(() => {
    if (!recSet.size) return types;
    const rank = new Map(recIds.map((id, i) => [id, i]));
    return [...types].sort(
      (a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity),
    );
  }, [types, recommendedTypeIds]);

  const showRec = recSet.size > 0;

  // Collapsed: show the top COLLAPSE_LIMIT (recommended-first) + always the
  // selected card even if it sorts beyond the cut. Expand reveals all.
  const collapsible = ordered.length > COLLAPSE_LIMIT;
  const visible = expanded
    ? ordered
    : ordered.filter((tp, i) => i < COLLAPSE_LIMIT || tp.id === selectedId);

  return (
    <section className="iv-step">
      <div className="iv-step-head">
        <span className="iv-step-num">03</span>
        <div>
          <div className="iv-step-title">{t('setup.type.title')}</div>
          <div className="iv-step-sub">
            {showRec && roleLabel
              ? t('setup.type.recommendedFor', { role: localizeRole(roleLabel) })
              : t('setup.type.sub')}
          </div>
        </div>
      </div>
      <div className="iv-type-grid">
        {visible.map((tp) => {
          const recommended = recSet.has(tp.id);
          return (
            <button
              key={tp.id}
              type="button"
              className={`iv-type-card ${tp.id === selectedId ? 'active' : ''} ${recommended ? 'recommended' : ''}`}
              onClick={() => onSelect(tp.id)}
            >
              <div className="iv-type-min-row">
                <div className="iv-type-min">{t('setup.type.minutes', { minutes: tp.minutes })}</div>
                {recommended ? (
                  <span className="iv-type-rec">{t('setup.type.recommendedBadge')}</span>
                ) : null}
              </div>
              <div className="iv-type-label">{tr(tp, 'label')}</div>
              <div className="iv-type-sub">{tr(tp, 'sub')}</div>
            </button>
          );
        })}
      </div>
      {collapsible ? (
        <button type="button" className="iv-show-all" onClick={() => setExpanded((v) => !v)}>
          {expanded ? t('setup.showFewer') : t('setup.showAll', { count: ordered.length })}
        </button>
      ) : null}
    </section>
  );
}
