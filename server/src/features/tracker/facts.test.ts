// @vitest-environment node
//
// WP-38 pure rules: follow-up facts (ruling C11), weekly counts (C40), the
// stage ladders per market and the CSV writer.

import { describe, expect, it } from 'vitest';

import { CN_TRACKER_LADDER } from '../cn/tracker/index.js';
import type { TrackerEntryView } from './contract.js';
import { csvCell, trackerCsv } from './csv.js';
import {
  computeFollowUps,
  computeWeeklyFacts,
  daysBetween,
  isCalendarDay,
  userDayKey,
  weekRange,
  weekStartFor,
  zoneOffsetLabel,
  zoneOffsetMinutes,
  zonedDayKey,
  zonedDayStart,
  zonedMinute,
  type FactEntry,
} from './facts.js';
import { INTL_TRACKER_LADDER, isStageDetailAllowed, isStatusAllowed, ladderFor, outcomeForStatus } from './stages.js';

const NOW = new Date('2026-10-10T12:00:00.000Z');
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

function entry(over: Partial<FactEntry> = {}): FactEntry {
  return {
    id: 'e1',
    status: 'applied',
    dateApplied: null,
    followUpAt: null,
    interviewAt: null,
    deadline: null,
    companyName: 'Acme',
    title: 'Analyst',
    ...over,
  };
}

describe('computeFollowUps', () => {
  it('no reply: applied 10+ days ago and still at Applied', () => {
    const out = computeFollowUps(
      [entry({ id: 'a', dateApplied: ago(10) }), entry({ id: 'b', dateApplied: ago(9.9) }), entry({ id: 'c', status: 'applying', dateApplied: ago(30) })],
      NOW,
      'intl',
    );
    expect(out.map((f) => [f.entryId, f.reason, f.days])).toEqual([
      ['c', 'no_reply_10d', 30],
      ['a', 'no_reply_10d', 10],
    ]);
  });

  it('a reply (any move out of Applied) or an ending removes the fact', () => {
    expect(computeFollowUps([entry({ status: 'first_call', dateApplied: ago(20) })], NOW, 'intl')).toEqual([]);
    expect(computeFollowUps([entry({ status: 'rejected', dateApplied: ago(20), interviewAt: new Date(NOW.getTime() + 3600_000) })], NOW, 'intl')).toEqual([]);
  });

  it('a follow-up date the user set replaces the 10-day rule', () => {
    expect(computeFollowUps([entry({ dateApplied: ago(20), followUpAt: new Date(NOW.getTime() + DAY) })], NOW, 'intl')).toEqual([]);
    const due = computeFollowUps([entry({ dateApplied: ago(20), followUpAt: ago(0.5) })], NOW, 'intl');
    expect(due.map((f) => f.reason)).toEqual(['follow_up_due']);
  });

  it('interview within 24 hours, not one in 25 hours or in the past', () => {
    const at = (h: number) => new Date(NOW.getTime() + h * 3600_000);
    const out = computeFollowUps(
      [entry({ id: 'x', status: 'interviewing', interviewAt: at(23) }), entry({ id: 'y', status: 'interviewing', interviewAt: at(25) }), entry({ id: 'z', status: 'interviewing', interviewAt: at(-1) })],
      NOW,
      'intl',
    );
    expect(out.map((f) => f.entryId)).toEqual(['x']);
  });

  it('saved-job deadlines: 2 days on RoboApply, 3 days on GoApply', () => {
    const inDays = (d: number) => new Date(Date.UTC(2026, 9, 10 + d));
    const rows = [0, 2, 3, 4].map((d) => entry({ id: `d${d}`, status: 'bookmarked', deadline: inDays(d) }));
    expect(computeFollowUps(rows, NOW, 'intl').map((f) => [f.entryId, f.days])).toEqual([
      ['d2', 2],
      ['d0', 0],
    ]);
    expect(computeFollowUps(rows, NOW, 'cn').map((f) => f.entryId)).toEqual(['d3', 'd2', 'd0']);
    // An applied job's deadline no longer matters.
    expect(computeFollowUps([entry({ status: 'applied', deadline: inDays(1) })], NOW, 'cn')).toEqual([]);
  });

  it('orders interviews, then deadlines, then follow-ups', () => {
    const out = computeFollowUps(
      [
        entry({ id: 'n', dateApplied: ago(11) }),
        entry({ id: 'i', status: 'interviewing', interviewAt: new Date(NOW.getTime() + 3600_000) }),
        entry({ id: 'd', status: 'bookmarked', deadline: new Date(Date.UTC(2026, 9, 11)) }),
      ],
      NOW,
      'intl',
    );
    expect(out.map((f) => f.reason)).toEqual(['interview_tomorrow', 'deadline_soon', 'no_reply_10d']);
  });
});

describe('weeks', () => {
  it('Sunday-anchored UTC weeks', () => {
    expect(weekStartFor(NOW)).toBe('2026-10-04');
    expect(weekRange('2026-10-04')).toMatchObject({ startUtc: '2026-10-04', endUtc: '2026-10-10' });
    expect(daysBetween(NOW, new Date('2026-10-12T00:00:00Z'))).toBe(2);
  });

  it('counts applications, not events, inside the week only', () => {
    const entries = [entry({ id: 'a', dateApplied: ago(1) }), entry({ id: 'b', dateApplied: ago(8) }), entry({ id: 'c', status: 'interviewing', interviewAt: ago(2) })];
    const events = [
      { entryId: 'a', kind: 'status', toValue: 'first_call', createdAt: ago(1) },
      { entryId: 'a', kind: 'status', toValue: 'interviewing', createdAt: ago(0.5) },
      { entryId: 'b', kind: 'status', toValue: 'offer', createdAt: ago(8) },
      { entryId: 'b', kind: 'outcome', toValue: 'they_said_no', createdAt: ago(1) },
    ];
    expect(computeWeeklyFacts(entries, events, '2026-10-04', NOW, 'intl')).toEqual({
      weekStart: '2026-10-04',
      weekEnd: '2026-10-10',
      applied: 1,
      interviews: 2,
      offers: 0,
      ended: 1,
      noReply10d: 0,
    });
  });
});

describe('FIX-3: weeks and days are the user\'s own (the click at 02:25 on Sunday Oct 11 in Taipei)', () => {
  // 02:25 local on Sunday Oct 11 in UTC+8 = 18:25 UTC on Saturday Oct 10.
  const CLICK = new Date('2026-10-10T18:25:07.412Z');
  const TPE = 'Asia/Taipei';
  const LA = 'America/Los_Angeles';

  it('zone helpers: offsets, the start of a day and the day of a moment', () => {
    expect(zoneOffsetMinutes(CLICK, TPE)).toBe(480);
    expect(zoneOffsetMinutes(CLICK, LA)).toBe(-420); // daylight time in October
    expect(zoneOffsetMinutes(new Date('2026-12-10T18:25:00Z'), LA)).toBe(-480);
    expect(zoneOffsetLabel(CLICK, TPE)).toBe('UTC+08:00');
    expect(zoneOffsetLabel(CLICK, LA)).toBe('UTC-07:00');
    expect(zoneOffsetLabel(CLICK, 'UTC')).toBe('UTC');
    expect(zoneOffsetLabel(CLICK, 'Asia/Kolkata')).toBe('UTC+05:30');
    expect(zonedDayStart('2026-10-11', TPE).toISOString()).toBe('2026-10-10T16:00:00.000Z');
    expect(zonedDayStart('2026-10-11', LA).toISOString()).toBe('2026-10-11T07:00:00.000Z');
    // The day clocks go back in Los Angeles (Nov 1, 2026) still starts at its own midnight.
    expect(zonedDayStart('2026-11-01', LA).toISOString()).toBe('2026-11-01T07:00:00.000Z');
    expect(zonedDayStart('2026-11-02', LA).toISOString()).toBe('2026-11-02T08:00:00.000Z');
    expect(zonedDayKey(CLICK, TPE)).toBe('2026-10-11');
    expect(zonedDayKey(CLICK, LA)).toBe('2026-10-10');
    expect(zonedMinute(CLICK, TPE)).toBe('2026-10-11 02:25');
    // An unknown zone is UTC, never an exception.
    expect(zonedDayKey(CLICK, 'Not/AZone')).toBe('2026-10-10');
    expect(zonedDayKey(CLICK, null)).toBe('2026-10-10');
  });

  it('a picked calendar day keeps its day; a moment takes the day it happened on for the user', () => {
    const picked = new Date('2026-10-02T00:00:00.000Z');
    expect(isCalendarDay(picked)).toBe(true);
    expect(isCalendarDay(CLICK)).toBe(false);
    expect(userDayKey(picked, LA)).toBe('2026-10-02'); // not Oct 1
    expect(userDayKey(CLICK, TPE)).toBe('2026-10-11');
  });

  it('the week of that click is the one starting Sunday Oct 11, and it is counted there', () => {
    expect(weekStartFor(CLICK)).toBe('2026-10-04'); // the UTC week, which the card used to show
    expect(weekStartFor(CLICK, TPE)).toBe('2026-10-11');
    expect(weekRange('2026-10-11', TPE)).toEqual({
      start: new Date('2026-10-10T16:00:00.000Z'),
      end: new Date('2026-10-17T16:00:00.000Z'),
      startUtc: '2026-10-11',
      endUtc: '2026-10-17',
    });
    const entries = [entry({ id: 'sun', dateApplied: CLICK }), entry({ id: 'picked', dateApplied: new Date('2026-10-17T00:00:00.000Z') }), entry({ id: 'next', dateApplied: new Date('2026-10-18T00:00:00.000Z') })];
    const events = [{ entryId: 'sun', kind: 'status', toValue: 'first_call', createdAt: new Date('2026-10-10T17:00:00.000Z') }];
    const thisWeek = computeWeeklyFacts(entries, events, '2026-10-11', CLICK, 'intl', TPE);
    expect(thisWeek).toMatchObject({ weekStart: '2026-10-11', weekEnd: '2026-10-17', applied: 2, interviews: 1 });
    // In the user's last week it is not counted (the UTC week would have counted it there).
    expect(computeWeeklyFacts(entries, events, '2026-10-04', CLICK, 'intl', TPE)).toMatchObject({ applied: 0, interviews: 0 });
    expect(computeWeeklyFacts(entries, events, '2026-10-04', CLICK, 'intl')).toMatchObject({ applied: 1, interviews: 1 });
  });

  it('CSV: days and the interview time are the user\'s, and the interview says its zone', () => {
    const row: TrackerEntryView = {
      id: 'e1', userId: 'u1', jobId: null, status: 'interviewing', excitementStars: 0, maxSalary: null, maxSalaryCurrency: 'USD', notesMarkdown: null,
      dateSaved: '2026-10-10T18:20:00.000Z', dateApplied: CLICK.toISOString(), deadline: '2026-10-30', followUpAt: '2026-10-25T00:00:00.000Z', appliedVia: 'manual', linkedRunId: null, job: null,
      externalSnapshot: { title: 'Analyst', companyName: 'Acme', applyUrl: null }, createdAt: '2026-10-10T18:20:00.000Z', updatedAt: CLICK.toISOString(), source: 'manual', stageDetail: null, outcome: null,
      interviewAt: '2026-10-20T02:30:00.000Z', offer: null, tailoredVariantId: null, coverLetterId: null,
    };
    const line = (tz?: string) => trackerCsv([row], 'en', 'intl', tz ? { timeZone: tz } : {}).split('\r\n')[1]!.split(',');
    // Saved, applied, interview, follow-up, deadline (columns 5–9).
    expect(line(TPE).slice(4, 9)).toEqual(['2026-10-11', '2026-10-11', '2026-10-20 10:30 UTC+08:00', '2026-10-25', '2026-10-30']);
    expect(line(LA).slice(4, 9)).toEqual(['2026-10-10', '2026-10-10', '2026-10-19 19:30 UTC-07:00', '2026-10-25', '2026-10-30']);
    // No zone known: UTC, and it says so.
    expect(line().slice(4, 9)).toEqual(['2026-10-10', '2026-10-10', '2026-10-20 02:30 UTC', '2026-10-25', '2026-10-30']);
    // A salary with no amount writes no currency.
    expect(line(TPE).slice(9, 11)).toEqual(['', '']);
  });
});

describe('stage ladders', () => {
  it('RoboApply follows ruling C1; GoApply follows 收藏 → … → 三方 / 未通过', () => {
    expect(INTL_TRACKER_LADDER).toEqual(['bookmarked', 'applied', 'first_call', 'interviewing', 'final_round', 'offer', 'rejected']);
    expect(ladderFor('cn')).toEqual(CN_TRACKER_LADDER);
    expect(CN_TRACKER_LADDER).toEqual(['bookmarked', 'applied', 'assessment', 'written_test', 'ai_interview', 'interviewing', 'offer', 'signed', 'rejected']);
  });

  it('allows each market its own stages plus terminal and legacy statuses', () => {
    expect(isStatusAllowed('intl', 'final_round')).toBe(true);
    expect(isStatusAllowed('intl', 'written_test')).toBe(false);
    expect(isStatusAllowed('cn', 'written_test')).toBe(true);
    expect(isStatusAllowed('cn', 'first_call')).toBe(false);
    for (const m of ['intl', 'cn'] as const) {
      for (const s of ['withdrawn', 'closed', 'negotiating', 'applying']) expect(isStatusAllowed(m, s)).toBe(true);
      expect(isStatusAllowed(m, 'submitted')).toBe(false);
    }
  });

  it('stage details: GoApply interview rounds only; RoboApply short labels on open stages', () => {
    expect(isStageDetailAllowed('cn', 'interviewing', 'hr_mianshi')).toBe(true);
    expect(isStageDetailAllowed('cn', 'offer', 'hr_mianshi')).toBe(false);
    expect(isStageDetailAllowed('cn', 'interviewing', 'panel')).toBe(false);
    expect(isStageDetailAllowed('intl', 'interviewing', 'Panel')).toBe(true);
    expect(isStageDetailAllowed('intl', 'rejected', 'Panel')).toBe(false);
    expect(isStageDetailAllowed('intl', 'rejected', null)).toBe(true);
  });

  it('maps terminal statuses back to who ended it', () => {
    expect([outcomeForStatus('rejected'), outcomeForStatus('withdrawn'), outcomeForStatus('closed'), outcomeForStatus('offer')]).toEqual([
      'they_said_no',
      'i_withdrew',
      'job_pulled',
      null,
    ]);
  });
});

describe('CSV', () => {
  const base: TrackerEntryView = {
    id: 'e1',
    userId: 'u1',
    jobId: null,
    status: 'applied',
    excitementStars: 0,
    maxSalary: 90000,
    maxSalaryCurrency: 'USD',
    notesMarkdown: '=HYPERLINK("http://x")',
    dateSaved: '2026-10-01T00:00:00.000Z',
    dateApplied: '2026-10-02T09:00:00.000Z',
    deadline: null,
    followUpAt: null,
    appliedVia: 'manual',
    linkedRunId: null,
    job: null,
    externalSnapshot: { title: 'Analyst, Data', companyName: 'Acme "Labs"', applyUrl: 'https://acme.example/1' },
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-02T00:00:00.000Z',
    source: 'manual',
    stageDetail: null,
    outcome: null,
    interviewAt: null,
    offer: null,
    tailoredVariantId: null,
    coverLetterId: null,
  };

  it('quotes, neutralises formulas and writes a BOM + CRLF', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('-5')).toBe("'-5");
    expect(csvCell(null)).toBe('');
    const csv = trackerCsv([base], 'en', 'intl');
    expect(csv.startsWith('﻿Company,Job title,Stage')).toBe(true);
    const line = csv.split('\r\n')[1]!;
    expect(line).toBe(`"Acme ""Labs""","Analyst, Data",Applied,,2026-10-01,2026-10-02,,,,90000,USD,manual,https://acme.example/1,"'=HYPERLINK(""http://x"")"`);
  });
});
