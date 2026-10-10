// @vitest-environment node
//
// WP-52: the pure rules of Ready to apply — the R-19 state machine (D1: no
// "submitted" anywhere), fit-tier gate, user-local weeks, setup steps, the
// cover-letter phrase match, file names and the answer-bank keys.

import { describe, expect, it } from 'vitest';
import { QUEUE_STATES, QUEUE_TRANSITIONS, type QueueState } from './contract.js';
import {
  assertTransition,
  canTransition,
  effectiveSetupStep,
  inWeeklyWindow,
  fileNamePart,
  kitFileName,
  letterNeeded,
  meetsMinTier,
  nextSetupStep,
  postAsksForCoverLetter,
  resumeHeadingName,
  setupMove,
  tabOf,
  weekKeyFor,
  weeklyWindowOpenAnywhere,
} from './stateMachine.js';
import {
  customQuestionKey,
  isSensitiveQuestionKey,
  isValidQuestionKey,
  protectedTypeFor,
  questionKeysFor,
} from './questionKeys.js';
import { PROTECTED_QUESTION_TYPES } from '../extension/contract.js';

describe('queue state machine (R-19, D1)', () => {
  it('has no "submitted" state and no transition into one', () => {
    expect(QUEUE_STATES as readonly string[]).not.toContain('submitted');
    for (const tos of Object.values(QUEUE_TRANSITIONS)) expect(tos as readonly string[]).not.toContain('submitted');
    expect(() => assertTransition('opened', 'submitted' as QueueState)).toThrow();
  });

  it('follows the supervised order picked → preparing → ready_for_review → approved → opened → applied', () => {
    const path: QueueState[] = ['picked', 'preparing', 'ready_for_review', 'approved', 'opened', 'applied'];
    for (let i = 0; i < path.length - 1; i += 1) expect(canTransition(path[i]!, path[i + 1]!)).toBe(true);
  });

  it('rejects illegal transitions with 409 queue_invalid_transition', () => {
    const illegal: Array<[QueueState, QueueState]> = [
      ['picked', 'opened'],
      ['picked', 'approved'],
      ['preparing', 'opened'],
      ['ready_for_review', 'opened'],
      ['ready_for_review', 'applied'],
      ['expired', 'picked'],
      ['skipped', 'opened'],
      ['applied', 'opened'],
    ];
    for (const [from, to] of illegal) {
      expect(canTransition(from, to), `${from} → ${to}`).toBe(false);
      try {
        assertTransition(from, to);
        expect.unreachable(`${from} → ${to} must throw`);
      } catch (err) {
        expect(err).toMatchObject({ code: 'conflict', status: 409, details: { reason: 'queue_invalid_transition', from, to } });
      }
    }
    expect(() => assertTransition('nonsense', 'picked')).toThrow();
  });

  it('only a reviewed kit is approved (opened/applied return there only through Undo)', () => {
    const into = QUEUE_STATES.filter((from) => canTransition(from, 'approved'));
    expect(into.sort()).toEqual(['applied', 'opened', 'ready_for_review']);
  });

  it('Undo · I didn\'t apply returns opened/applied to approved; expired is terminal', () => {
    expect(canTransition('opened', 'approved')).toBe(true);
    expect(canTransition('applied', 'approved')).toBe(true);
    expect(QUEUE_TRANSITIONS.expired).toEqual([]);
  });

  it('groups states into the three tabs', () => {
    expect(tabOf('picked')).toBe('to_prepare');
    expect(tabOf('failed')).toBe('to_prepare');
    expect(tabOf('preparing')).toBe('ready');
    expect(tabOf('approved')).toBe('ready');
    expect(tabOf('opened')).toBe('done');
    expect(tabOf('expired')).toBe('done');
  });
});

describe('fit tier gate (R-09 words)', () => {
  it('passes jobs at or above the minimum tier and never an unscored one', () => {
    expect(meetsMinTier('great', 'good')).toBe(true);
    expect(meetsMinTier('good', 'good')).toBe(true);
    expect(meetsMinTier('possible', 'good')).toBe(false);
    expect(meetsMinTier('possible', 'possible')).toBe(true);
    expect(meetsMinTier('unlikely', 'possible')).toBe(false);
    expect(meetsMinTier('good', 'great')).toBe(false);
    expect(meetsMinTier(null, 'possible')).toBe(false);
    expect(meetsMinTier(undefined, 'possible')).toBe(false);
  });
});

describe('weeks in the user\'s time zone', () => {
  it('uses ISO weeks per zone (the same instant can be a different week)', () => {
    // Sunday 2026-10-11 20:00 UTC = Monday 04:00 in Shanghai (week 42) but Sunday in Los Angeles (week 41).
    const at = new Date('2026-10-11T20:00:00Z');
    expect(weekKeyFor(at, 'Asia/Shanghai')).toBe('2026-W42');
    expect(weekKeyFor(at, 'America/Los_Angeles')).toBe('2026-W41');
  });

  it('opens the weekly window Monday 06:00–11:59 local only', () => {
    expect(inWeeklyWindow(new Date('2026-10-11T22:00:00Z'), 'Asia/Shanghai')).toBe(true); // Mon 06:00
    expect(inWeeklyWindow(new Date('2026-10-11T21:59:00Z'), 'Asia/Shanghai')).toBe(false); // Mon 05:59
    expect(inWeeklyWindow(new Date('2026-10-12T04:00:00Z'), 'Asia/Shanghai')).toBe(false); // Mon 12:00
    expect(inWeeklyWindow(new Date('2026-10-12T13:00:00Z'), 'America/Los_Angeles')).toBe(true); // Mon 06:00 PDT
    expect(inWeeklyWindow(new Date('2026-10-12T13:00:00Z'), 'Asia/Shanghai')).toBe(false); // Mon 21:00
  });

  it('skips the cron outright outside Sunday 16:00 – Tuesday 00:00 UTC', () => {
    expect(weeklyWindowOpenAnywhere(new Date('2026-10-11T15:59:00Z'))).toBe(false); // Sunday
    expect(weeklyWindowOpenAnywhere(new Date('2026-10-11T16:00:00Z'))).toBe(true);
    expect(weeklyWindowOpenAnywhere(new Date('2026-10-12T23:00:00Z'))).toBe(true); // Monday
    expect(weeklyWindowOpenAnywhere(new Date('2026-10-13T00:00:00Z'))).toBe(false); // Tuesday
    expect(weeklyWindowOpenAnywhere(new Date('2026-10-15T08:00:00Z'))).toBe(false);
  });

  it('every zone\'s Monday 06:00–12:00 lies inside the UTC guard', () => {
    const zones = ['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'Asia/Shanghai', 'Europe/London', 'America/New_York', 'Asia/Kolkata'];
    const start = Date.parse('2026-10-10T00:00:00Z');
    for (let t = start; t < start + 4 * 86_400_000; t += 15 * 60_000) {
      const at = new Date(t);
      for (const z of zones) if (inWeeklyWindow(at, z)) expect(weeklyWindowOpenAnywhere(at), `${z} ${at.toISOString()}`).toBe(true);
    }
  });
});

describe('setup steps (C13: the extension step is skippable)', () => {
  it('moves forward only, and leaves out the extension step when the capability is off', () => {
    expect(nextSetupStep('weekly', true)).toBe('extension');
    expect(nextSetupStep('weekly', false)).toBe('done');
    expect(setupMove('profile', 'profile', true)).toEqual({ kind: 'advance', current: 'profile', next: 'calibrate' });
    expect(setupMove('answers', 'profile', true)).toEqual({ kind: 'noop', current: 'answers' });
    expect(setupMove('extension', 'extension', true)).toEqual({ kind: 'advance', current: 'extension', next: 'done' });
    expect(setupMove('weekly', 'weekly', false)).toEqual({ kind: 'advance', current: 'weekly', next: 'done' });
    expect(effectiveSetupStep('extension', false)).toBe('done');
    expect(effectiveSetupStep('bogus', true)).toBe('profile');
  });

  it('refuses a step after the current one, so no step (skippable or not) can be jumped', () => {
    expect(setupMove('profile', 'extension', true)).toEqual({ kind: 'out_of_order', current: 'profile' });
    expect(setupMove(null, 'weekly', true)).toEqual({ kind: 'out_of_order', current: 'profile' });
    expect(setupMove('calibrate', 'answers', false)).toEqual({ kind: 'out_of_order', current: 'calibrate' });
  });
});

describe('cover letter: only when the post asks for one', () => {
  it('matches the post\'s own words only', () => {
    expect(postAsksForCoverLetter('Please include a cover letter with your application.')).toBe(true);
    expect(postAsksForCoverLetter('Send a covering letter and CV.')).toBe(true);
    expect(postAsksForCoverLetter('A motivation letter is required.')).toBe(true);
    expect(postAsksForCoverLetter('请附上求职信')).toBe(true);
    expect(postAsksForCoverLetter('We build letters for a living (typography).')).toBe(false);
    expect(postAsksForCoverLetter(null, undefined, '')).toBe(false);
  });

  it('applies the settings mode', () => {
    expect(letterNeeded('when_required', true)).toBe(true);
    expect(letterNeeded('when_required', false)).toBe(false);
    expect(letterNeeded('always', false)).toBe(true);
    expect(letterNeeded('never', true)).toBe(false);
  });
});

describe('kit file names', () => {
  const date = new Date('2026-10-12T00:00:00Z');

  it('follows the chosen style and leaves out parts that are not known', () => {
    const input = { name: 'Ana Lima', company: 'Acme, Inc.', role: 'Data Analyst / BI', date };
    expect(kitFileName('name_company_role', input)).toBe('Ana Lima - Acme, Inc. - Data Analyst BI');
    expect(kitFileName('name_role', input)).toBe('Ana Lima - Data Analyst BI');
    expect(kitFileName('company_role_name', input)).toBe('Acme, Inc. - Data Analyst BI - Ana Lima');
    expect(kitFileName('name_date', input)).toBe('Ana Lima - 2026-10-12');
    expect(kitFileName('name_company_role', { company: '某公司', role: '产品经理' })).toBe('某公司 - 产品经理');
  });

  it('falls back to the resume title, then "Resume", when no part is known', () => {
    expect(kitFileName('name_role', { fallback: 'Product resume' })).toBe('Product resume');
    expect(kitFileName('name_role', {})).toBe('Resume');
    expect(kitFileName('unknown_style', { name: 'Ana Lima', fallback: 'Product resume' })).toBe('Product resume');
  });

  it('reads the name from the resume\'s own heading', () => {
    expect(resumeHeadingName('# **Ana Lima**\n\nProduct designer')).toBe('Ana Lima');
    expect(resumeHeadingName('## Experience\n\nNo top heading')).toBeNull();
    expect(resumeHeadingName(null)).toBeNull();
  });

  it('is the name the export gives the file (same rules as buildExportFileName)', async () => {
    // Verification finding: the kit showed "General_Intuition_Medal_Product_Designer_…" for a
    // file the export names with " - " between the parts.
    const { buildExportFileName, cleanFilePart } = await import('../../roboapply/v2/lib/resumeExport.js');
    const cases = [
      { name: 'Ana Lima', company: 'General Intuition & Medal', role: 'Product Designer, Gaming Communities (In Office: New York)' },
      { name: null, company: 'General Intuition & Medal', role: 'Product Designer' },
      { name: 'Ana Lima', company: null, role: null },
      { name: null, company: null, role: null },
      { name: '  A/B  "C"  ', company: 'x'.repeat(80), role: 'Role\twith\ncontrol' },
    ];
    for (const style of ['name_company_role', 'name_role', 'company_role_name', 'name_date'] as const) {
      for (const c of cases) {
        expect(kitFileName(style, { ...c, date, fallback: 'My resume' }), `${style} ${JSON.stringify(c)}`).toBe(buildExportFileName(style, { ...c, date, fallback: 'My resume' }));
      }
    }
    expect(fileNamePart('a/b:c  d')).toBe(cleanFilePart('a/b:c  d'));
  });
});

describe('answer bank keys', () => {
  it('accepts canonical keys per market, currency variants and custom keys', () => {
    expect(isValidQuestionKey('notice_period', 'intl')).toBe(true);
    expect(isValidQuestionKey('notice_period', 'cn')).toBe(false);
    expect(isValidQuestionKey('political_status', 'cn')).toBe(true);
    expect(isValidQuestionKey('political_status', 'intl')).toBe(false);
    expect(isValidQuestionKey('salary_expectation:EUR', 'intl')).toBe(true);
    expect(isValidQuestionKey('salary_expectation:eur', 'intl')).toBe(false);
    expect(isValidQuestionKey('notice_period:EUR', 'intl')).toBe(false);
    expect(isValidQuestionKey(customQuestionKey('Do you have a driving licence?'), 'intl')).toBe(true);
    expect(customQuestionKey('Do you have  a driving licence?')).toBe(customQuestionKey('do you have a driving licence?'));
    expect(isValidQuestionKey('custom:nothex', 'intl')).toBe(false);
    expect(isValidQuestionKey('made_up', 'intl')).toBe(false);
  });

  it('GoApply offers 家庭成员 and 政治面貌 as optional, sensitive keys', () => {
    const cn = questionKeysFor('cn');
    const fam = cn.find((k) => k.key === 'family_members')!;
    const pol = cn.find((k) => k.key === 'political_status')!;
    expect(fam).toMatchObject({ optional: true, sensitive: true, text: { zh: '家庭成员' } });
    expect(pol).toMatchObject({ optional: true, sensitive: true, text: { zh: '政治面貌' } });
    expect(isSensitiveQuestionKey('family_members')).toBe(true);
    expect(questionKeysFor('intl').some((k) => k.sensitive)).toBe(false);
  });

  it('protected types match the extension\'s list (AI never answers them)', () => {
    for (const def of [...questionKeysFor('intl'), ...questionKeysFor('cn')]) {
      if (def.protectedType) expect(PROTECTED_QUESTION_TYPES as readonly string[]).toContain(def.protectedType);
    }
    expect(protectedTypeFor('salary_expectation:USD')).toBe('salary_expectation');
    expect(protectedTypeFor('why_this_company')).toBeNull();
  });
});
