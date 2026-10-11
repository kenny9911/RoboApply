// @vitest-environment node
// MKT-1C: the identifying User-Agent of every job-board and open-data request
// (MARKET_STRATEGY §1.2 tier 0, §1.3, §1.4; JI-4). Pure: no network, no database.
import { describe, expect, it } from 'vitest';
import { BRANDS } from '../../../platform/brand/index.js';
import { JOB_SOURCES_CONTACT_ENV, SOURCE_USER_AGENT_MAX, sourceUserAgent } from './userAgent.js';

const PRINTABLE_ASCII = /^[\x20-\x7E]+$/;

describe('sourceUserAgent', () => {
  it('names the brand of the market and its own site when no contact is set', () => {
    expect(sourceUserAgent('intl', {})).toBe('RoboApplyJobs/1.0 (+https://www.roboapply.io)');
    expect(sourceUserAgent('cn', {})).toBe('GoApplyJobs/1.0 (+https://www.goapply.top)');
    // The site is the brand registry's, not a second copy of it.
    expect(sourceUserAgent('intl', {})).toContain(BRANDS.roboapply.canonicalOrigin);
    expect(sourceUserAgent('cn', {})).toContain(BRANDS.goapply.canonicalOrigin);
    expect(sourceUserAgent('intl', {})).toMatch(/roboapply\.io/);
    expect(sourceUserAgent('cn', {})).not.toMatch(/RoboApply|roboapply/);
  });

  it('carries JOB_SOURCES_CONTACT when it is set: a URL or a mailto', () => {
    expect(JOB_SOURCES_CONTACT_ENV).toBe('JOB_SOURCES_CONTACT');
    expect(sourceUserAgent('intl', { JOB_SOURCES_CONTACT: 'https://www.roboapply.io/bots' })).toBe('RoboApplyJobs/1.0 (+https://www.roboapply.io/bots)');
    expect(sourceUserAgent('intl', { JOB_SOURCES_CONTACT: ' mailto:jobs-bot@example.com ' })).toBe('RoboApplyJobs/1.0 (+mailto:jobs-bot@example.com)');
    expect(sourceUserAgent('cn', { CN_JOB_SOURCES_CONTACT: 'mailto:jobs-bot@example.com' })).toBe('GoApplyJobs/1.0 (+mailto:jobs-bot@example.com)');
  });

  // Review finding: one process runs both brands' ingest. RoboApply's contact must never be sent to a mainland
  // board under GoApply's name, and GoApply's never to an international one.
  it('each brand reads its own contact: the other brand\'s value never crosses', () => {
    const roboOnly = { JOB_SOURCES_CONTACT: 'https://www.roboapply.io/bots' };
    expect(sourceUserAgent('intl', roboOnly)).toBe('RoboApplyJobs/1.0 (+https://www.roboapply.io/bots)');
    expect(sourceUserAgent('cn', roboOnly)).toBe('GoApplyJobs/1.0 (+https://www.goapply.top)');
    expect(sourceUserAgent('cn', roboOnly)).not.toMatch(/roboapply/i);

    const both = { JOB_SOURCES_CONTACT: 'https://www.roboapply.io/bots', CN_JOB_SOURCES_CONTACT: 'https://www.goapply.top/bots' };
    expect(sourceUserAgent('intl', both)).toBe('RoboApplyJobs/1.0 (+https://www.roboapply.io/bots)');
    expect(sourceUserAgent('cn', both)).toBe('GoApplyJobs/1.0 (+https://www.goapply.top/bots)');

    const cnOnly = { CN_JOB_SOURCES_CONTACT: 'mailto:bots@goapply.top' };
    expect(sourceUserAgent('cn', cnOnly)).toBe('GoApplyJobs/1.0 (+mailto:bots@goapply.top)');
    expect(sourceUserAgent('intl', cnOnly)).toBe('RoboApplyJobs/1.0 (+https://www.roboapply.io)');
    expect(sourceUserAgent('intl', cnOnly)).not.toMatch(/goapply/i);

    // A blank or unusable GoApply value falls back to GoApply's own site, not to the shared value.
    for (const value of ['', '   ', '\r\n', '联系我们']) {
      expect(sourceUserAgent('cn', { ...roboOnly, CN_JOB_SOURCES_CONTACT: value }), JSON.stringify(value)).toBe('GoApplyJobs/1.0 (+https://www.goapply.top)');
    }
    // The same cleaning applies to GoApply's value.
    expect(sourceUserAgent('cn', { CN_JOB_SOURCES_CONTACT: 'https://www.goapply.top/bots\r\nX-Injected: 1' })).toBe('GoApplyJobs/1.0 (+https://www.goapply.top/bots)');
  });

  it.each([
    ['empty', ''],
    ['blank', '   '],
    ['only a line break', '\r\n'],
    ['only non-ASCII', '聯絡我們'],
    ['only brackets', '()'],
  ])('a %s contact falls back to the brand site', (_label, value) => {
    expect(sourceUserAgent('intl', { JOB_SOURCES_CONTACT: value })).toBe('RoboApplyJobs/1.0 (+https://www.roboapply.io)');
  });

  it('a value with a line break cannot add a header: only its first line is used', () => {
    const ua = sourceUserAgent('intl', { JOB_SOURCES_CONTACT: 'https://www.roboapply.io/bots\r\nX-Injected: 1' });
    expect(ua).toBe('RoboApplyJobs/1.0 (+https://www.roboapply.io/bots)');
    expect(ua).not.toMatch(/[\r\n]/);
    expect(sourceUserAgent('intl', { JOB_SOURCES_CONTACT: 'mailto:jobs-bot@example.com\nBcc: x@example.com' })).toBe('RoboApplyJobs/1.0 (+mailto:jobs-bot@example.com)');
    expect(sourceUserAgent('intl', { JOB_SOURCES_CONTACT: '\nhttps://www.roboapply.io/bots' })).toBe('RoboApplyJobs/1.0 (+https://www.roboapply.io/bots)');
  });

  it('is printable ASCII with one comment: control characters, non-ASCII and brackets are removed', () => {
    const ua = sourceUserAgent('cn', { CN_JOB_SOURCES_CONTACT: 'https://www.goapply.top/机器人\t(bots)\u0000\u007f' });
    expect(ua).toBe('GoApplyJobs/1.0 (+https://www.goapply.top/bots)');
    expect(ua).toMatch(PRINTABLE_ASCII);
    expect(ua.match(/[()]/g)).toEqual(['(', ')']);
  });

  it('is capped at 200 characters and still closes its comment', () => {
    expect(SOURCE_USER_AGENT_MAX).toBe(200);
    const ua = sourceUserAgent('intl', { JOB_SOURCES_CONTACT: `https://www.roboapply.io/${'a'.repeat(500)}` });
    expect(ua).toHaveLength(200);
    expect(ua.startsWith('RoboApplyJobs/1.0 (+https://www.roboapply.io/aaaa')).toBe(true);
    expect(ua.endsWith('a)')).toBe(true);
    expect(ua).toMatch(PRINTABLE_ASCII);
  });

  it('reads process.env by default and never throws', () => {
    const before = process.env.JOB_SOURCES_CONTACT;
    try {
      process.env.JOB_SOURCES_CONTACT = 'mailto:env-default@example.com';
      expect(sourceUserAgent('intl')).toBe('RoboApplyJobs/1.0 (+mailto:env-default@example.com)');
      delete process.env.JOB_SOURCES_CONTACT;
      expect(sourceUserAgent('intl')).toBe('RoboApplyJobs/1.0 (+https://www.roboapply.io)');
    } finally {
      if (before === undefined) delete process.env.JOB_SOURCES_CONTACT;
      else process.env.JOB_SOURCES_CONTACT = before;
    }
  });
});
