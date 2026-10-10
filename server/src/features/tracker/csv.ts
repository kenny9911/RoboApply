// server/src/features/tracker/csv.ts — CSV export of the user's applications
// (WP-38; ARCH §3.7 `GET /v2/tracker/export.csv`, 5/day).
//
// Columns are the user's own data. Header and stage words follow the brand
// and the request locale: GoApply (mainland market) in Simplified Chinese uses
// the GoApply ladder words (网申 / 三方 / 未通过); every other case, RoboApply
// zh-TW / zh-CN included, is English until INT moves these strings into the
// server i18n loader with Traditional labels (the web bundles are not loaded
// on the server).
// Cells that a spreadsheet would run as a formula (= + - @, tab, CR) are
// prefixed with an apostrophe (CSV injection).

import type { TrackerEntryView } from './contract.js';
import type { TrackerMarket } from './stages.js';

type Lang = 'en' | 'zh';

const HEADERS: Record<Lang, string[]> = {
  en: [
    'Company',
    'Job title',
    'Stage',
    'How it ended',
    'Saved on',
    'Applied on',
    'Interview',
    'Follow up on',
    'Deadline',
    'Salary',
    'Currency',
    'Added from',
    'Link',
    'Notes',
  ],
  zh: ['公司', '职位', '阶段', '结果', '收藏日期', '投递日期', '面试时间', '跟进日期', '截止日期', '薪资', '币种', '来源', '链接', '备注'],
};

const STAGES: Record<Lang, Record<string, string>> = {
  en: {
    bookmarked: 'Saved',
    applying: 'Applied',
    applied: 'Applied',
    first_call: 'First call',
    assessment: 'Assessment',
    written_test: 'Written test',
    ai_interview: 'AI interview',
    interviewing: 'Interviewing',
    final_round: 'Final round',
    offer: 'Offer',
    negotiating: 'Offer',
    accepted: 'Offer',
    signed: 'Signed',
    rejected: 'Rejected',
    withdrawn: 'Withdrawn',
    closed: 'Job was pulled',
  },
  zh: {
    bookmarked: '收藏',
    applying: '网申',
    applied: '网申',
    first_call: '初次沟通',
    assessment: '测评',
    written_test: '笔试',
    ai_interview: 'AI面试',
    interviewing: '面试',
    final_round: '终面',
    offer: 'Offer',
    negotiating: 'Offer',
    accepted: 'Offer',
    signed: '三方',
    rejected: '未通过',
    withdrawn: '放弃',
    closed: '职位关闭',
  },
};

const OUTCOMES: Record<Lang, Record<string, string>> = {
  en: { they_said_no: 'They said no', i_withdrew: 'I withdrew', job_pulled: 'Job was pulled' },
  zh: { they_said_no: '未通过', i_withdrew: '我放弃了', job_pulled: '职位关闭' },
};

const TRADITIONAL_ZH = /^zh[-_](tw|hk|mo|hant)/i;

/** Simplified Chinese only on the GoApply (mainland) market; English otherwise. */
export function csvLangFor(locale: string | null | undefined, market: TrackerMarket): Lang {
  if (market !== 'cn' || !locale) return 'en';
  return /^zh/i.test(locale) && !TRADITIONAL_ZH.test(locale) ? 'zh' : 'en';
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

/** The whole file: UTF-8 BOM (so spreadsheet apps read Chinese), CRLF line ends. */
export function trackerCsv(entries: readonly TrackerEntryView[], locale: string | null | undefined, market: TrackerMarket): string {
  const lang = csvLangFor(locale, market);
  const rows: unknown[][] = [HEADERS[lang]];
  for (const e of entries) {
    const company = e.job?.companyName ?? e.externalSnapshot?.companyName ?? '';
    const title = e.job?.title ?? e.externalSnapshot?.title ?? '';
    const link = e.job?.applyUrl ?? e.externalSnapshot?.applyUrl ?? '';
    rows.push([
      company,
      title,
      STAGES[lang][e.status] ?? e.status,
      e.outcome ? OUTCOMES[lang][e.outcome] : '',
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
