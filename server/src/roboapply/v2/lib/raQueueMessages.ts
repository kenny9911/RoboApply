// backend/src/roboapply/v2/lib/raQueueMessages.ts
//
// Server-side message catalog for the Review Queue (/queue) page.
//
// The queue endpoints derive user-visible strings on the BACKEND (the check
// chips "Resume / Cover / Questions / Portfolio" and their values, plus the
// missing-job fallbacks). Those strings ship to the client pre-rendered inside
// `RAQueueItem`, so they cannot be localized by the frontend bundles — they
// must be localized here, keyed by the request locale that
// `getRequestLocale(req)` (lib/raLocale.ts) resolves.
//
// RULE for future /queue backend work: any NEW user-visible string produced
// server-side for this page goes through this catalog (add a key to
// QueueMessages + all four ready-locale blocks below). LLM-generated content
// (cover letters, rewrite output) is localized differently — pass `{ locale }`
// into the agent call so the model responds in the user's language.
//
// Locale coverage mirrors the frontend: en / zh / zh-TW / ja are fully
// translated (READY_LOCALES in roboapply/lib/localeConfig.ts); es / fr / pt /
// de fall back to English, matching what the UI chrome shows for those
// locales. To add a language: add a block here AND the frontend bundle — see
// memory/project_roboapply_i18n.md.

import type { RaLocale } from './raLocale.js';

export interface QueueMessages {
  /** Check-chip keys (the small uppercase labels on the queue card). */
  checkResume: string;
  checkCover: string;
  checkQuestions: string;
  checkPortfolio: string;
  /** Check-chip values. `{x}` placeholders are substituted via format(). */
  tailoredWithReason: string; // {reason}
  tailoredReadyFor: string; // {board}
  coverDraft: string; // {count} — words (latin) or characters (CJK)
  coverNotGenerated: string;
  screeningAnswersOne: string; // {count}
  screeningAnswersMany: string; // {count}
  noScreeningQuestions: string;
  portfolioNotTracked: string;
  /** Fallbacks when the job row is missing/partial. */
  untitledRole: string;
  unknownCompany: string;
  /** Board label when the adapter is a plain external link. */
  directLink: string;
}

const en: QueueMessages = {
  checkResume: 'Resume',
  checkCover: 'Cover',
  checkQuestions: 'Questions',
  checkPortfolio: 'Portfolio',
  tailoredWithReason: 'Tailored — {reason}',
  tailoredReadyFor: 'Tailored snapshot ready for {board}',
  coverDraft: 'Custom draft, ~{count} words',
  coverNotGenerated: 'Draft not yet generated',
  screeningAnswersOne: '{count} screening answer drafted',
  screeningAnswersMany: '{count} screening answers drafted',
  noScreeningQuestions: 'No screening questions',
  portfolioNotTracked: 'Not tracked in auto-apply',
  untitledRole: 'Untitled role',
  unknownCompany: 'Unknown company',
  directLink: 'direct link',
};

const zh: QueueMessages = {
  checkResume: '简历',
  checkCover: '求职信',
  checkQuestions: '筛选问题',
  checkPortfolio: '作品集',
  tailoredWithReason: '已定制 — {reason}',
  tailoredReadyFor: '已生成定制版本，可通过{board}投递',
  coverDraft: '定制草稿，约 {count} 字',
  coverNotGenerated: '草稿尚未生成',
  screeningAnswersOne: '已草拟 {count} 条筛选问题答案',
  screeningAnswersMany: '已草拟 {count} 条筛选问题答案',
  noScreeningQuestions: '没有筛选问题',
  portfolioNotTracked: '自动投递暂不包含此项',
  untitledRole: '未命名职位',
  unknownCompany: '未知公司',
  directLink: '直接链接',
};

const zhTW: QueueMessages = {
  checkResume: '履歷',
  checkCover: '求職信',
  checkQuestions: '篩選問題',
  checkPortfolio: '作品集',
  tailoredWithReason: '已客製 — {reason}',
  tailoredReadyFor: '已產生客製版本，可透過{board}投遞',
  coverDraft: '客製草稿，約 {count} 字',
  coverNotGenerated: '草稿尚未產生',
  screeningAnswersOne: '已草擬 {count} 則篩選問題答案',
  screeningAnswersMany: '已草擬 {count} 則篩選問題答案',
  noScreeningQuestions: '沒有篩選問題',
  portfolioNotTracked: '自動投遞暫不包含此項',
  untitledRole: '未命名職缺',
  unknownCompany: '未知公司',
  directLink: '直接連結',
};

const ja: QueueMessages = {
  checkResume: '履歴書',
  checkCover: 'カバーレター',
  checkQuestions: '質問',
  checkPortfolio: 'ポートフォリオ',
  tailoredWithReason: 'カスタマイズ済み — {reason}',
  tailoredReadyFor: '{board}向けのカスタマイズ版を用意済み',
  coverDraft: 'カスタマイズした下書き、約{count}文字',
  coverNotGenerated: '下書きはまだ生成されていません',
  screeningAnswersOne: 'スクリーニング質問の回答を{count}件下書き済み',
  screeningAnswersMany: 'スクリーニング質問の回答を{count}件下書き済み',
  noScreeningQuestions: 'スクリーニング質問はありません',
  portfolioNotTracked: '自動応募では未対応',
  // 役職 would mean a company rank; the missing thing here is the posting's
  // job title, which the ja bundle consistently calls 職種.
  untitledRole: '職種名なし',
  unknownCompany: '会社名不明',
  // Reads as the destination of the application ({board}向け…), so "direct
  // application" — not a literal "direct link".
  directLink: '直接応募',
};

const CATALOG: Partial<Record<RaLocale, QueueMessages>> = {
  en,
  zh,
  'zh-TW': zhTW,
  ja,
  // es / fr / pt / de intentionally absent → English fallback, consistent
  // with the UI chrome for those locales.
};

/** Resolve the message block for a locale, falling back to English. */
export function getQueueMessages(locale: RaLocale): QueueMessages {
  return CATALOG[locale] ?? en;
}

/** Locales whose natural "length of a text" unit is characters, not
 *  whitespace-separated words (CJK text has no word spaces, so a word count
 *  of a Chinese/Japanese cover letter is meaningless). */
const CHARACTER_COUNT_LOCALES: ReadonlySet<RaLocale> = new Set([
  'zh',
  'zh-TW',
  'ja',
]);

/** Approximate length of a cover letter in the unit native to the locale:
 *  non-whitespace characters for CJK locales, whitespace-split words
 *  otherwise. Returns 0 for blank text. */
export function coverLengthFor(locale: RaLocale, text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  if (CHARACTER_COUNT_LOCALES.has(locale)) {
    return trimmed.replace(/\s+/g, '').length;
  }
  return trimmed.split(/\s+/).length;
}

/** Tiny `{name}` substitution — the catalog has exactly one placeholder per
 *  template, so a full ICU formatter would be overkill. */
export function format(
  template: string,
  params: Record<string, string | number>,
): string {
  return template.replace(/\{(\w+)\}/g, (m, key) =>
    key in params ? String(params[key]) : m,
  );
}
