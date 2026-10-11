// server/src/features/tw/payRule.ts — Taiwan's pay-disclosure rule, from config
// (MKT-5F; MARKET_STRATEGY §1.3, §1.5 "Pay", §9.5 JT-6; modelled on
// platform/billing/fxReference.ts).
//
// The note "Why is pay not listed?" names the statutory amount below which an
// employer must state pay (就業服務法第5條第2項第6款). The Ministry of Labor has
// announced a change from NT$40,000 to about NT$50,000 (not passed, no date),
// so the amount, the provision, the link and the day they were read live in
// AppConfig `tw.payRule.v1`:
//
//   { thresholdTwd, lawLabel, sourceUrl, asOf, updatedAt, updatedBy }
//
// and one admin edit follows the law without a deploy.
//
//   - No row: the law in force as read on 2026-10-11 (`TW_PAY_RULE_DEFAULT`).
//   - A row that does not pass the rules below (hand-edited): no rule at all.
//     The note then shows no amount: a number we cannot vouch for is worse
//     than none (D3). It never falls back to the default, which may be the
//     old law by then.
//
// What the amount is NOT: a job's pay. It is never shown on a job as its pay,
// never a filter value, and never written to a job row (the pay parser is
// threshold-agnostic since MKT-1C). This module only serves the note.
//
// Pure apart from the two functions that take a `db` and the hold below.
//
// The public route is open to everyone, so it does not read the database on
// every request: `createTwPayRuleHold` keeps one read in the process for a
// minute (`TW_PAY_RULE_HOLD_MS`), and a save through the admin route clears
// it on the instance that saved. The 5 minutes an edit may take to reach the
// note (`TW_PAY_RULE_MAX_STALE_MS`) are split: one minute here, four at the
// caller (the route's Cache-Control and the web client's stale time).

import type { ExtendedPrismaClient } from '../../lib/prisma.js';
import { TW_PAY_RULE_CONFIG_KEY, TW_PAY_RULE_LIMITS, type TwPayRuleAdminView, type TwPayRuleView } from './contract.js';

export { TW_PAY_RULE_CONFIG_KEY, TW_PAY_RULE_LIMITS } from './contract.js';

/** The rule as stored. */
export interface TwPayRule {
  thresholdTwd: number;
  lawLabel: string;
  sourceUrl: string;
  /** YYYY-MM-DD */
  asOf: string;
  updatedAt: string | null;
  updatedBy: string | null;
}

export type TwPayRuleInput = Pick<TwPayRule, 'thresholdTwd' | 'lawLabel' | 'sourceUrl' | 'asOf'>;

/**
 * The law in force as read on 2026-10-11: Employment Services Act, Article 5,
 * paragraph 2, subparagraph 6, in the Ministry of Justice's law database
 * (docs/jobright-clone/market/JOB_SOURCES_TW.md §4).
 */
export const TW_PAY_RULE_DEFAULT: Readonly<TwPayRuleInput> = Object.freeze({
  thresholdTwd: 40_000,
  lawLabel: '就業服務法第5條第2項第6款',
  sourceUrl: 'https://law.moj.gov.tw/LawClass/LawSingle.aspx?pcode=N0090001&flno=5',
  asOf: '2026-10-11',
});

export type TwPayRuleDb = Pick<ExtendedPrismaClient, 'appConfig'>;

export interface TwPayRuleIssue {
  path: 'thresholdTwd' | 'lawLabel' | 'sourceUrl' | 'asOf';
  message: string;
}

/** Thrown by `saveTwPayRule` for an entry that breaks a rule; the route answers 422 with the issues. */
export class TwPayRuleValidationError extends Error {
  readonly issues: TwPayRuleIssue[];
  constructor(issues: TwPayRuleIssue[]) {
    super('The pay rule is not valid.');
    this.name = 'TwPayRuleValidationError';
    this.issues = issues;
  }
}

/** Taipei time is UTC+8 all year: the rule is Taiwan's, so "today" is Taipei's day. */
const TAIPEI_OFFSET_MS = 8 * 3_600_000;

/** The calendar day in Taipei of an instant, as YYYY-MM-DD. */
export function taipeiToday(now: Date): string {
  return new Date(now.getTime() + TAIPEI_OFFSET_MS).toISOString().slice(0, 10);
}

/** True for a YYYY-MM-DD string that is a day of the calendar (2026-02-30 is not). */
function isRealDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** An https URL with a host and no credentials, as written; null for anything else. */
function httpsUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password ? value : null;
  } catch {
    return null;
  }
}

/**
 * The rules of an entry (empty when valid):
 *   thresholdTwd  a whole number of thousands from 10,000 to 200,000;
 *   lawLabel      1 to 120 characters on one line;
 *   sourceUrl     an https link, at most 500 characters;
 *   asOf          a real YYYY-MM-DD day that is not after today in Taipei.
 * `value` is anything (a request body, a stored JSON value). Pure given `now`.
 */
export function validateTwPayRule(value: unknown, now: Date): TwPayRuleIssue[] {
  const v = (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
  const issues: TwPayRuleIssue[] = [];
  const L = TW_PAY_RULE_LIMITS;

  const amount = v.thresholdTwd;
  if (typeof amount !== 'number' || !Number.isInteger(amount)) issues.push({ path: 'thresholdTwd', message: 'A whole number of New Taiwan dollars is needed.' });
  else if (amount < L.minTwd || amount > L.maxTwd) issues.push({ path: 'thresholdTwd', message: `Between ${L.minTwd} and ${L.maxTwd}.` });
  else if (amount % L.stepTwd !== 0) issues.push({ path: 'thresholdTwd', message: `A whole number of thousands (a multiple of ${L.stepTwd}).` });

  const label = typeof v.lawLabel === 'string' ? v.lawLabel.trim() : '';
  if (!label) issues.push({ path: 'lawLabel', message: 'Name the provision.' });
  else if ([...label].length > L.lawLabelMax || /[\r\n]/.test(label)) issues.push({ path: 'lawLabel', message: `One line of at most ${L.lawLabelMax} characters.` });

  const link = typeof v.sourceUrl === 'string' ? v.sourceUrl.trim() : '';
  if (!link || link.length > L.sourceUrlMax || !httpsUrl(link)) issues.push({ path: 'sourceUrl', message: 'An https link to where the rule can be read.' });

  const asOf = typeof v.asOf === 'string' ? v.asOf.trim() : '';
  if (!isRealDate(asOf)) issues.push({ path: 'asOf', message: 'A date as YYYY-MM-DD.' });
  else if (asOf > taipeiToday(now)) issues.push({ path: 'asOf', message: 'The date cannot be in the future.' });

  return issues;
}

/** What a read of the config gives. */
export type TwPayRuleRead =
  | { stored: 'config'; rule: TwPayRule }
  | { stored: 'default'; rule: TwPayRule }
  | { stored: 'invalid'; rule: null; updatedAt: string | null; updatedBy: string | null };

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** The stored JSON as a rule, or null when it is not one (not JSON, a missing field, a broken rule). */
export function parseStoredTwPayRule(raw: string | null | undefined, now: Date): TwPayRule | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (validateTwPayRule(parsed, now).length) return null;
  const v = parsed as Record<string, unknown>;
  return {
    thresholdTwd: v.thresholdTwd as number,
    lawLabel: (v.lawLabel as string).trim(),
    sourceUrl: (v.sourceUrl as string).trim(),
    asOf: (v.asOf as string).trim(),
    updatedAt: str(v.updatedAt),
    updatedBy: str(v.updatedBy),
  };
}

/**
 * The rule in force for the note: an admin's stored rule, else the default.
 * A stored value that is not a valid rule gives no rule (`stored: 'invalid'`).
 */
export async function readTwPayRule(db: TwPayRuleDb, now: Date = new Date()): Promise<TwPayRuleRead> {
  const row = await db.appConfig.findUnique({ where: { key: TW_PAY_RULE_CONFIG_KEY }, select: { value: true, updatedBy: true } });
  if (!row) return { stored: 'default', rule: { ...TW_PAY_RULE_DEFAULT, updatedAt: null, updatedBy: null } };
  const rule = parseStoredTwPayRule(row.value, now);
  if (rule) return { stored: 'config', rule };
  return { stored: 'invalid', rule: null, updatedAt: null, updatedBy: str(row.updatedBy) };
}

/**
 * Store an admin's entry. Throws `TwPayRuleValidationError` when it breaks a
 * rule (nothing is written then). Returns the rule as stored.
 */
export async function saveTwPayRule(db: TwPayRuleDb, input: unknown, adminId: string | null, now: Date = new Date()): Promise<TwPayRule> {
  const issues = validateTwPayRule(input, now);
  if (issues.length) throw new TwPayRuleValidationError(issues);
  const v = input as TwPayRuleInput;
  const rule: TwPayRule = {
    thresholdTwd: v.thresholdTwd,
    lawLabel: v.lawLabel.trim(),
    sourceUrl: v.sourceUrl.trim(),
    asOf: v.asOf.trim(),
    updatedAt: now.toISOString(),
    updatedBy: adminId,
  };
  const value = JSON.stringify(rule);
  await db.appConfig.upsert({
    where: { key: TW_PAY_RULE_CONFIG_KEY },
    update: { value, updatedBy: adminId },
    create: { key: TW_PAY_RULE_CONFIG_KEY, value, updatedBy: adminId },
  });
  return rule;
}

/** The longest the note may be behind an admin's edit: 5 minutes (the item's "cache 5 minutes"). */
export const TW_PAY_RULE_MAX_STALE_MS = 5 * 60_000;
/** How long one read of the rule is kept in the process. */
export const TW_PAY_RULE_HOLD_MS = 60_000;
/** What is left of the 5 minutes for whoever asked (a browser, a shared cache, the web client). */
export const TW_PAY_RULE_CALLER_MAX_AGE_S = (TW_PAY_RULE_MAX_STALE_MS - TW_PAY_RULE_HOLD_MS) / 1000;

/**
 * One read of the rule, kept in the process for `ttlMs`, so that a request to
 * the open route is not a database round trip each time. Requests that arrive
 * while a read is under way wait for that one read. A read that fails is not
 * kept: the next request reads again. `clear()` forgets the value (a save
 * calls it, so the instance that saved answers the new rule at once).
 */
export interface TwPayRuleHold {
  read(load: () => Promise<TwPayRuleRead>, now: Date): Promise<TwPayRuleRead>;
  clear(): void;
}

export function createTwPayRuleHold(ttlMs: number = TW_PAY_RULE_HOLD_MS): TwPayRuleHold {
  let held: { value: TwPayRuleRead; at: number } | null = null;
  let loading: Promise<TwPayRuleRead> | null = null;
  // A read that began before a `clear()` must not put its answer back afterwards.
  let generation = 0;
  return {
    async read(load, now) {
      const t = now.getTime();
      // A clock that went backwards is not trusted either.
      if (held && t >= held.at && t - held.at < ttlMs) return held.value;
      if (loading) return loading;
      const mine = generation;
      const run = load().then((value) => {
        if (generation === mine) held = { value, at: t };
        return value;
      });
      loading = run;
      const done = () => {
        if (loading === run) loading = null;
      };
      run.then(done, done);
      return run;
    },
    clear() {
      generation += 1;
      held = null;
      loading = null;
    },
  };
}

/** The process's own hold: the public route reads through it and the admin route clears it after a save. */
export const twPayRuleHold: TwPayRuleHold = createTwPayRuleHold();

/** The rule as the note reads it; null when a stored value could not be read as a rule. */
export function publicTwPayRule(read: TwPayRuleRead): TwPayRuleView | null {
  if (!read.rule) return null;
  const { thresholdTwd, lawLabel, sourceUrl, asOf } = read.rule;
  return { thresholdTwd, lawLabel, sourceUrl, asOf, isDefault: read.stored === 'default' };
}

/** The admin view: what the public route answers, where it comes from, and who stored it. */
export function adminTwPayRule(read: TwPayRuleRead): TwPayRuleAdminView {
  return {
    rule: publicTwPayRule(read),
    stored: read.stored,
    updatedAt: read.rule ? read.rule.updatedAt : read.updatedAt,
    updatedBy: read.rule ? read.rule.updatedBy : read.updatedBy,
    default: { ...TW_PAY_RULE_DEFAULT },
    limits: TW_PAY_RULE_LIMITS,
  };
}
