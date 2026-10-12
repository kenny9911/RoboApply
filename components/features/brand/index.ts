// components/features/brand — public surface of the brand presentation area (WP-12).
// Other areas import from here only (TASK_PLAN.md §2.1 rule 4).

export { WrongBrandNudge, type WrongBrandNudgeProps } from './WrongBrandNudge';
export { SettingsSection as BrandSettingsSection } from './SettingsSection';
export { BrandWordmark, type BrandWordmarkProps } from './BrandWordmark';
export {
  TRADITIONAL_REGIONS,
  decideWrongBrandNudge,
  normalizeCountry,
  nudgeDismissKey,
  nudgeStorageKey,
  type NudgeDecision,
  type NudgeInput,
  type NudgeReason,
} from './nudge';
export { brandSwitcherLocales, type SwitcherLocale } from './locales';
