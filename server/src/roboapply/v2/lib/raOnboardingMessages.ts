// backend/src/roboapply/v2/lib/raOnboardingMessages.ts
//
// Server-side message catalog for first-run setup
// (/api/v1/roboapply/v2/onboarding/*).
//
// Some user-visible strings in this flow are derived on the BACKEND — the
// "what your resume says" ingest rows, and the RACareerGoal title fallback.
// They ship to the client pre-rendered inside JSON responses, so the frontend
// bundles cannot localize them; they must be localized here, keyed by the
// request locale that `getRequestLocale(req)` (lib/raLocale.ts) resolves.
//
// RULE for future onboarding backend work: any NEW user-visible string
// produced server-side for this flow goes through this catalog (add a key to
// OnboardingMessages + all four ready-locale blocks below).
//
// WHAT THIS CATALOG NO LONGER CARRIES. It used to hold the conversational
// flow's whole vocabulary: greetings, generic opening prompts and chips, the
// apology turn, zero-result relaxation chips, the turn-cap wrap and its recap,
// per-topic next-question chips, quick-reply pill labels, the salary
// non-filterable disclosure, the whyMatched fallback, and `chatLanguageDirective`
// (a LanguageService fork for the streaming chat agent, which bypassed
// BaseAgent). Setup is two steps now — add a resume, then confirm what we read
// from it — so none of those strings had a reader in any of the four locales.
//
// Locale coverage mirrors the frontend: en / zh / zh-TW / ja are fully
// translated (READY_LOCALES in roboapply/lib/localeConfig.ts); es / fr / pt /
// de fall back to English, matching what the UI chrome shows for those
// locales. To add a language: add a block here AND the frontend bundle — see
// memory/project_roboapply_i18n.md.

import type { RaLocale } from './raLocale.js';
import type { IngestRowKind } from '../types/onboarding.js';

export interface OnboardingMessages {
  /** RACareerGoal.targetTitle fallback when no role was captured. */
  defaultTargetTitle: string;
  /** Ingest-row labels. */
  ingestLabel: Record<IngestRowKind, string>;
  /** Experience-row value templates. `{count}` roles, `{years}`, `{role}`. */
  ingestExperienceValue: string;
  ingestExperienceValueNoYears: string;
  /** Single-role variant. `{role}`. */
  ingestExperienceValueSingle: string;
  /** Terminal ingest fallback. `{name}` = variant display name. */
  importedRow: string;
}

const en: OnboardingMessages = {
  defaultTargetTitle: 'My next role',
  ingestLabel: {
    identity: 'Identity',
    experience: 'Experience',
    skills: 'Skills',
    education: 'Education',
    links: 'Links',
    summary: 'Summary',
  },
  ingestExperienceValue: '{count} roles · ~{years} yrs · most recently {role}',
  ingestExperienceValueNoYears: '{count} roles · most recently {role}',
  ingestExperienceValueSingle: 'Most recently {role}',
  importedRow: 'Imported {name}',
};

const zh: OnboardingMessages = {
  defaultTargetTitle: '我的下一份工作',
  ingestLabel: {
    identity: '基本信息',
    experience: '工作经历',
    skills: '技能',
    education: '教育背景',
    links: '链接',
    summary: '亮点',
  },
  ingestExperienceValue: '{count} 段工作经历 · 约 {years} 年 · 最近任职 {role}',
  ingestExperienceValueNoYears: '{count} 段工作经历 · 最近任职 {role}',
  ingestExperienceValueSingle: '最近任职 {role}',
  importedRow: '已导入 {name}',
};

const zhTW: OnboardingMessages = {
  defaultTargetTitle: '我的下一份工作',
  ingestLabel: {
    identity: '基本資料',
    experience: '工作經歷',
    skills: '技能',
    education: '學歷',
    links: '連結',
    summary: '亮點',
  },
  ingestExperienceValue: '{count} 段工作經歷 · 約 {years} 年 · 最近任職 {role}',
  ingestExperienceValueNoYears: '{count} 段工作經歷 · 最近任職 {role}',
  ingestExperienceValueSingle: '最近任職 {role}',
  importedRow: '已匯入 {name}',
};

const ja: OnboardingMessages = {
  defaultTargetTitle: '次の仕事',
  ingestLabel: {
    identity: '基本情報',
    experience: '職歴',
    skills: 'スキル',
    education: '学歴',
    links: 'リンク',
    summary: 'ハイライト',
  },
  ingestExperienceValue: '職歴 {count} 件 · 約 {years} 年 · 直近は {role}',
  ingestExperienceValueNoYears: '職歴 {count} 件 · 直近は {role}',
  ingestExperienceValueSingle: '直近は {role}',
  importedRow: '{name} を取り込みました',
};

const CATALOG: Partial<Record<RaLocale, OnboardingMessages>> = {
  en,
  zh,
  'zh-TW': zhTW,
  ja,
  // es / fr / pt / de intentionally absent → English fallback, consistent
  // with the UI chrome for those locales.
};

/** Resolve the message block for a locale, falling back to English. */
export function getMessages(locale: RaLocale): OnboardingMessages {
  return CATALOG[locale] ?? en;
}

/** Tiny `{name}` substitution — same helper shape as raQueueMessages.ts;
 *  re-declared here so the two catalogs stay independently deletable. */
export function format(
  template: string,
  params: Record<string, string | number>,
): string {
  return template.replace(/\{(\w+)\}/g, (m, key) =>
    key in params ? String(params[key]) : m,
  );
}
