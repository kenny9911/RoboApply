// @vitest-environment node
//
// The source and apply rules every job reader shares (GOAPPLY_PARITY_PLAN §5;
// MARKET_STRATEGY §1.4, M-7, JC-1, JC-7). The card, the job page, the visitor
// list and the GoApply card meta are tested in their own files; this file pins
// the pure rules and that the contract module re-exports them.

import { describe, expect, it } from 'vitest';
import * as contract from './contract.js';
import {
  EMPLOYER_BOARD_SOURCES,
  applyLinkOf,
  cnListable,
  cnListableWhere,
  hasApplyLink,
  httpUrl,
  hasPayFigure,
  salaryLineOf,
  sourceFactsOf,
  sourceKindOf,
  viaOf,
} from './sourceLine.js';
import { PUBLIC_ATS } from '../jobs/sources/atsPublic/contract.js';

describe('sourceKindOf / viaOf', () => {
  it('reads how a row reached us from its own columns; an unknown board is never an employer board', () => {
    expect(sourceKindOf({ sourceBoard: 'user_import', visibility: 'private', fromRecruiterBank: false })).toBe('user_import');
    expect(sourceKindOf({ sourceBoard: 'greenhouse', visibility: 'private', fromRecruiterBank: false })).toBe('user_import');
    expect(sourceKindOf({ sourceBoard: 'gohire', visibility: 'public', fromRecruiterBank: true })).toBe('bank');
    expect(sourceKindOf({ sourceBoard: 'robohire', visibility: 'public', fromRecruiterBank: true })).toBe('bank');
    for (const board of PUBLIC_ATS) expect(sourceKindOf({ sourceBoard: board, visibility: 'public', fromRecruiterBank: false }), board).toBe('ats_public');
    for (const board of ['jsearch', 'activejobs', 'seed', 'manual', 'mystery', '']) {
      expect(sourceKindOf({ sourceBoard: board, visibility: 'public', fromRecruiterBank: false }), board).toBe('provider');
    }
    expect([viaOf('bank'), viaOf('ats_public'), viaOf('user_import'), viaOf('provider')]).toEqual(['bank', 'ats', 'import', undefined]);
    // Every connector the board adapter knows counts as an employer board.
    expect(EMPLOYER_BOARD_SOURCES).toEqual(expect.arrayContaining([...PUBLIC_ATS]));
  });
});

describe('apply link', () => {
  it('only an http(s) link, as stored; where it leads is claimed only where it is known', () => {
    expect(httpUrl(' https://careers.example.cn/1 ')).toBe('https://careers.example.cn/1');
    for (const bad of ['', '  ', null, undefined, 42, 'javascript:alert(1)', 'data:text/html,x', 'mailto:a@b.cn', 'tel:13800138000', '/jobs/1', 'careers.example.cn/1']) {
      expect(httpUrl(bad), String(bad)).toBeNull();
      expect(hasApplyLink({ applyUrl: bad })).toBe(false);
    }
    expect(applyLinkOf({ applyUrl: 'https://jobs.gohire.example/p/1', sourceBoard: 'gohire' }, 'bank')).toEqual({ url: 'https://jobs.gohire.example/p/1', target: 'gohire' });
    expect(applyLinkOf({ applyUrl: 'https://jobs.robohire.example/p/1', sourceBoard: 'robohire' }, 'bank')).toEqual({ url: 'https://jobs.robohire.example/p/1', target: null });
    expect(applyLinkOf({ applyUrl: 'https://boards.greenhouse.io/acme/jobs/1', sourceBoard: 'greenhouse' }, 'ats_public')?.target).toBe('employer');
    expect(applyLinkOf({ applyUrl: 'https://x.example/1', sourceBoard: 'user_import' }, 'user_import')?.target).toBeNull();
    expect(applyLinkOf({ applyUrl: 'https://x.example/1', sourceBoard: 'jsearch' }, 'provider')?.target).toBeNull();
    expect(applyLinkOf({ applyUrl: '', sourceBoard: 'greenhouse' }, 'ats_public')).toBeNull();
  });
});

describe('source facts', () => {
  it('the employer is the original publisher of a board row only; the link is never LinkedIn; the date is lastSeenAt', () => {
    const seen = new Date('2026-10-09T00:00:00.000Z');
    expect(sourceFactsOf({ sourceBoard: 'lever', companyName: '示例', sourceUrl: 'https://jobs.lever.co/x/1', lastSeenAt: seen }, 'ats_public')).toEqual({
      original: '示例',
      url: 'https://jobs.lever.co/x/1',
      lastVerifiedAt: seen.toISOString(),
      via: 'ats',
    });
    expect(sourceFactsOf({ sourceBoard: 'gohire', companyName: '示例' }, 'bank')).toEqual({ original: null, url: null, lastVerifiedAt: null, via: 'bank' });
    expect(sourceFactsOf({ sourceBoard: 'jsearch', companyName: 'Acme', originalSourceName: 'Acme careers', sourceUrl: 'https://uk.linkedin.com/jobs/view/1', lastSeenAt: seen.toISOString() }, 'provider')).toEqual({
      original: 'Acme careers',
      url: null,
      lastVerifiedAt: seen.toISOString(),
    });
    expect(sourceFactsOf({ sourceBoard: 'user_import', companyName: 'x', sourceUrl: 'ftp://x', applyUrl: 'https://x.example/1', lastSeenAt: 'not a date' }, 'user_import')).toEqual({
      original: null,
      url: 'https://x.example/1',
      lastVerifiedAt: null,
      via: 'import',
    });
  });
});

describe('salary line', () => {
  it('null when neither figures nor a line exist; never 0 or an empty line', () => {
    expect(salaryLineOf(null, null)).toBeNull();
    expect(salaryLineOf(null, '  ')).toBeNull();
    expect(salaryLineOf(null, '18-28K·15薪', 15)).toEqual({ text: '18-28K·15薪', min: null, max: null, currency: null, period: null, months: 15 });
    expect(salaryLineOf({ min: 40, max: 55, currency: 'USD', period: 'hour', text: null }, null)).toEqual({ text: null, min: 40, max: 55, currency: 'USD', period: 'hour', months: null });
    expect(salaryLineOf({ min: 1, max: 2, currency: 'CNY', period: 'fortnight' }, 'x', 0)).toMatchObject({ period: null, months: null });
    // A figure is above zero: a stored 0 is a source's "nothing here".
    expect(hasPayFigure({ min: 8_000, max: null })).toBe(true);
    expect(hasPayFigure({ min: null, max: 12_000 })).toBe(true);
    expect(hasPayFigure({ min: 0, max: 0 })).toBe(false);
    expect(hasPayFigure({ min: null, max: null })).toBe(false);
    expect(hasPayFigure(null)).toBe(false);
  });
});

describe('mainland listing rule', () => {
  it('a public mainland row needs a usable apply link; private rows and other markets are not this rule’s concern', () => {
    expect(cnListable({ market: 'cn', visibility: 'public', applyUrl: 'https://careers.example.cn/1' })).toBe(true);
    for (const applyUrl of ['', '   ', null, undefined, 'javascript:alert(1)']) {
      expect(cnListable({ market: 'cn', visibility: 'public', applyUrl }), String(applyUrl)).toBe(false);
      expect(cnListable({ market: 'cn', visibility: 'private', applyUrl })).toBe(true);
      expect(cnListable({ market: 'intl', visibility: 'public', applyUrl })).toBe(true);
    }
    expect(cnListableWhere()).toEqual({
      OR: [
        { visibility: { not: 'public' } },
        { applyUrl: { startsWith: 'http://', mode: 'insensitive' } },
        { applyUrl: { startsWith: 'https://', mode: 'insensitive' } },
      ],
    });
  });
});

describe('feed/contract.ts is the door other areas use', () => {
  it('re-exports the rules (the area boundary allows contract.ts and index.ts only)', () => {
    expect(contract.applyLinkOf).toBe(applyLinkOf);
    expect(contract.sourceFactsOf).toBe(sourceFactsOf);
    expect(contract.sourceKindOf).toBe(sourceKindOf);
    expect(contract.cnListable).toBe(cnListable);
    expect(contract.cnListableWhere).toBe(cnListableWhere);
    expect(contract.salaryLineOf).toBe(salaryLineOf);
    expect(contract.FEED_THIN_BELOW).toBe(contract.FEED_LIMITS.widenBelowRows);
  });
});
