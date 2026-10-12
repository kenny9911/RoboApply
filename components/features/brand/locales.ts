// components/features/brand/locales.ts — the language list every switcher
// shows (TASK_PLAN.md WP-12, ARCHITECTURE.md §1.6): the brand's locales in the
// brand's own order (GoApply: 简体中文 first), each with its native label.
// RoboApply's order is lib/localeConfig LOCALES, so its list is unchanged.

import { LOCALE_LABELS, isLocaleIn, LOCALES, type RoboLocale } from '../../../lib/localeConfig';

export interface SwitcherLocale {
  code: RoboLocale;
  label: string;
}

export function brandSwitcherLocales(brandLocales: readonly string[]): SwitcherLocale[] {
  const seen = new Set<RoboLocale>();
  const out: SwitcherLocale[] = [];
  for (const code of brandLocales) {
    if (!isLocaleIn(code, LOCALES) || seen.has(code)) continue;
    seen.add(code);
    out.push({ code, label: LOCALE_LABELS[code] });
  }
  return out;
}
