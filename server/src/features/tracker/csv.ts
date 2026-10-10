// server/src/features/tracker/csv.ts — CSV export of the user's applications
// (WP-38; ARCH §3.7 `GET /v2/tracker/export.csv`, 5/day).
//
// Columns are the user's own data. The header and the stage / outcome words
// come from the server i18n loader (platform/email/i18n; English source:
// server/src/i18n/email/staging/tracker.en.json), never from this file:
//
//   tracker.csv.*     the words for any brand and locale. The loader resolves
//                     `en ← staging ← <locale>.json`: every shipped locale
//                     translates the group (WP-92; zh-TW in Traditional
//                     Chinese), and a key a locale lacks reads English;
//   tracker.csvCn.*   GoApply's own ladder words in Simplified Chinese
//                     (网申 / 测评 / 笔试 / AI面试 / 三方 / 未通过). Used only for
//                     GoApply (mainland market) with a Simplified Chinese
//                     request locale, so RoboApply — Taiwan included — never
//                     gets the mainland ladder words.
//
// Cells that a spreadsheet would run as a formula (= + - @, tab, CR) are
// prefixed with an apostrophe (CSV injection).

import { BRANDS, type ProductBrand } from '../../platform/brand/registry.js';
import { createEmailTranslator, type EmailTranslator } from '../../platform/email/i18n.js';
import type { TrackerEntryView } from './contract.js';
import type { TrackerMarket } from './stages.js';

/** Column order of the file; each id is a key under `<group>.header`. */
export const CSV_COLUMNS = [
  'company',
  'title',
  'stage',
  'outcome',
  'savedOn',
  'appliedOn',
  'interview',
  'followUpOn',
  'deadline',
  'salary',
  'currency',
  'source',
  'link',
  'notes',
] as const;
export type CsvColumn = (typeof CSV_COLUMNS)[number];

/** The two key groups in the `tracker` email-i18n namespace. */
export const CSV_GROUP = { shared: 'tracker.csv', goapply: 'tracker.csvCn' } as const;
export type CsvGroup = (typeof CSV_GROUP)[keyof typeof CSV_GROUP];

const TRADITIONAL_ZH = /^zh[-_](tw|hk|mo|hant)/i;

/** True for a Simplified Chinese locale tag (`zh`, `zh-CN`, `zh-Hans`); Traditional variants are not. */
export function isSimplifiedChinese(locale: string | null | undefined): boolean {
  return Boolean(locale) && /^zh/i.test(locale!) && !TRADITIONAL_ZH.test(locale!);
}

/**
 * Which key group the file is written from: GoApply's own ladder words only
 * on the GoApply (mainland) market in Simplified Chinese; `tracker.csv` in
 * every other case (rendered in the request locale, English until translated).
 */
export function csvGroupFor(locale: string | null | undefined, market: TrackerMarket): CsvGroup {
  return market === 'cn' && isSimplifiedChinese(locale) ? CSV_GROUP.goapply : CSV_GROUP.shared;
}

/** The words of one export: header cells and the stage / outcome labels. */
export interface CsvWords {
  group: CsvGroup;
  header: string[];
  stage(status: string): string;
  outcome(outcome: string): string;
}

/** Resolve the words through the i18n loader. A status the bundles do not name is written as its code. */
export function csvWords(locale: string | null | undefined, brand: ProductBrand, t: EmailTranslator = createEmailTranslator(brand, locale)): CsvWords {
  const group = csvGroupFor(locale, brand.market as TrackerMarket);
  const label = (kind: 'stage' | 'outcome', code: string): string => {
    const key = `${group}.${kind}.${code}`;
    return /^[a-z_]+$/.test(code) && t.has(key) ? t(key) : code;
  };
  return {
    group,
    header: CSV_COLUMNS.map((c) => t(`${group}.header.${c}`)),
    stage: (status) => label('stage', status),
    outcome: (outcome) => label('outcome', outcome),
  };
}

/** Quote one cell (RFC 4180) and neutralise spreadsheet formulas. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : '');

const brandOf = (brand: ProductBrand | TrackerMarket): ProductBrand => (typeof brand === 'string' ? (brand === 'cn' ? BRANDS.goapply : BRANDS.roboapply) : brand);

/**
 * The whole file: UTF-8 BOM (so spreadsheet apps read Chinese), CRLF line
 * ends. `brand` is the request's brand (a market is accepted for callers that
 * only know the market).
 */
export function trackerCsv(entries: readonly TrackerEntryView[], locale: string | null | undefined, brand: ProductBrand | TrackerMarket): string {
  const words = csvWords(locale, brandOf(brand));
  const rows: unknown[][] = [words.header];
  for (const e of entries) {
    const company = e.job?.companyName ?? e.externalSnapshot?.companyName ?? '';
    const title = e.job?.title ?? e.externalSnapshot?.title ?? '';
    const link = e.job?.applyUrl ?? e.externalSnapshot?.applyUrl ?? '';
    rows.push([
      company,
      title,
      words.stage(e.status),
      e.outcome ? words.outcome(e.outcome) : '',
      day(e.dateSaved),
      day(e.dateApplied),
      e.interviewAt ? e.interviewAt.slice(0, 16).replace('T', ' ') : '',
      day(e.followUpAt),
      e.deadline ?? '',
      e.maxSalary ?? '',
      e.maxSalary !== null ? (e.maxSalaryCurrency ?? '') : '',
      e.source ?? '',
      link,
      e.notesMarkdown ?? '',
    ]);
  }
  return `﻿${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}
