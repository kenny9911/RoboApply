// components/features/alice/model.ts — pure helpers for Alice's screens.
//
// Formatting and decisions with no React in them, so they are tested alone:
// the region a stage opens on, the status line under the title, how a profile
// field reads, which rows of two profiles differ, the previous value of a
// changed field. Words come from the `alice` messages; nothing here invents a
// value (D3): an empty field reads as a dash.

import type {
  AliceApplicationsView,
  AliceBrief,
  AliceJobProfile,
  AliceMessageView,
  AlicePay,
  AlicePlace,
  AliceProfileField,
  AliceRevision,
  AliceStage,
  AliceThreadView,
  AliceTopicId,
} from '../../../lib/api/contracts/alice';

/** A translator called with a key built at run time (every key it builds is in the `alice` messages; check:copy proves it). */
export type DynamicTranslate = (key: string, values?: Record<string, string | number>) => string;
export function dynamic(t: unknown): DynamicTranslate {
  return t as DynamicTranslate;
}

export type AliceRegion = 'chat' | 'profile' | 'jobs' | 'applications';
export const REGIONS: readonly AliceRegion[] = ['chat', 'profile', 'jobs', 'applications'];

/** The canvas view a stage opens on (desktop); the phone stays on the chat until the person switches. */
export function canvasFor(stage: AliceStage): Exclude<AliceRegion, 'chat'> {
  return stage === 'saved' ? 'jobs' : 'profile';
}

/** The profile fields the comparison and the version view show, in order (the label and headline lead the card). */
export const SHOWN_FIELDS: readonly AliceProfileField[] = [
  'titles',
  'levels',
  'workModels',
  'places',
  'pay',
  'industries',
  'companyKinds',
  'companies',
  'skills',
  'mustHaves',
  'niceToHaves',
  'dealbreakers',
  'whyItFits',
  'tradeoff',
];

/** Rows of two profiles whose values differ (shown with Alice's blue dot). */
export function differingFields(a: AliceJobProfile, b: AliceJobProfile): Set<AliceProfileField> {
  const out = new Set<AliceProfileField>();
  for (const f of SHOWN_FIELDS) if (JSON.stringify(a[f]) !== JSON.stringify(b[f])) out.add(f);
  return out;
}

/** The current version, or the last one. */
export function currentRevision(thread: Pick<AliceThreadView, 'revisions' | 'currentVersion'>): AliceRevision | null {
  return thread.revisions.find((r) => r.version === thread.currentVersion) ?? thread.revisions.at(-1) ?? null;
}

/** The version a revision was made from (the one before it in the trail). */
export function previousRevision(thread: Pick<AliceThreadView, 'revisions'>, rev: AliceRevision): AliceRevision | null {
  const i = thread.revisions.findIndex((r) => r.version === rev.version);
  return i > 0 ? thread.revisions[i - 1] : null;
}

/** Whether the person has said anything yet (the start actions stay until then). */
export function hasUserTurn(messages: readonly AliceMessageView[]): boolean {
  return messages.some((m) => m.role === 'user');
}

export function formatAmount(pay: AlicePay, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency: pay.currency, maximumFractionDigits: 0 }).format(pay.amount);
  } catch {
    return `${pay.amount} ${pay.currency}`;
  }
}

export function placeText(places: readonly AlicePlace[]): string {
  return places.map((p) => p.label).join(' · ');
}

/** "a, b and c" in the reader's language (Chinese and Japanese use their own separators). */
export function joinList(items: readonly string[], locale: string): string {
  try {
    return new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(items);
  } catch {
    return items.join(', ');
  }
}

/** A YYYY-MM-DD day in the person's language, without shifting it through a time zone. */
export function formatDay(day: string, locale: string): string {
  const [y, m, d] = day.split('-').map(Number);
  if (!y || !m || !d) return day;
  try {
    return new Intl.DateTimeFormat(locale, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d)));
  } catch {
    return day;
  }
}

/** Today as YYYY-MM-DD in the browser's calendar. */
export function todayIso(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** How many intake topics are known (covered or declined) of those that apply. */
export function topicProgress(thread: Pick<AliceThreadView, 'topics'>): { done: number; total: number } {
  const done = new Set<AliceTopicId>([...thread.topics.covered, ...thread.topics.declined]).size;
  return { done: Math.min(done, thread.topics.all.length), total: thread.topics.all.length };
}

/** Topics learned in the last turn (shown as new with Alice's dot). */
export function newlyLearned(messages: readonly AliceMessageView[]): Set<AliceTopicId> {
  const last = [...messages].reverse().find((m) => m.role === 'alice' && m.blocks.some((b) => b.type === 'learned'));
  const block = last?.blocks.find((b) => b.type === 'learned');
  return new Set(block && block.type === 'learned' ? block.topics : []);
}

/** The brief field(s) a topic reads from, for the "What Alice knows" list. */
export function topicValue(brief: AliceBrief, topic: AliceTopicId): unknown[] {
  switch (topic) {
    case 'roles':
      return brief.roles;
    case 'level':
      return brief.levels;
    case 'workSetting':
      return brief.workModels;
    case 'places':
      return brief.places.map((p) => p.label);
    case 'pay':
      return brief.pay ? [brief.pay] : [];
    case 'industries':
      return [...brief.industries, ...brief.avoidIndustries.map((i) => ({ avoid: i }))];
    case 'companyKind':
      return brief.companyKinds;
    case 'companySize':
      return brief.companySizes;
    case 'companies':
      return [...brief.companies, ...brief.avoidCompanies.map((c) => ({ avoid: c }))];
    case 'dreamJob':
      return brief.dreamJob ? [brief.dreamJob] : [];
    case 'values':
      return brief.values;
    case 'dealbreakers':
      return brief.dealbreakers;
    case 'timing':
      return brief.timing ? [brief.timing] : [];
    case 'sponsorship':
      return brief.needsSponsorship === null ? [] : [brief.needsSponsorship];
    default:
      return [];
  }
}

/** The count on the Applications switch: what needs the person (a real count; null until loaded). */
export function needsCount(board: AliceApplicationsView | undefined): number | null {
  return board ? board.needsYou.length : null;
}

/** A saved search with no name is the app's "main search" (filters.unnamed); Alice words it that way. */
export function isUnnamed(name: string | null | undefined): boolean {
  return !name || !name.trim();
}

/** The tracker status → the Applications page's column key (`applications.columns`). */
export function columnKey(status: string): string {
  return status === 'bookmarked' ? 'saved' : status;
}
