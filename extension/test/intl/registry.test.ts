// The international adapter list after WP-70: what the RoboApply build fills,
// the host permissions that follow from it, and the D1 shape of every adapter.

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { formPageKey, formStepKey, INTL_ADAPTERS, INTL_FILLABLE_ATS_TYPES, INTL_FORM_SITES, intlFormSiteForUrl, isMultiPage, matchesHostPattern } from '../../src/adapters/intl/index';
import { boardDomains } from '../../src/content/boards/index';
import { adapterHostPatterns, plannedSiteForUrl, plannedSitesFor } from '../../src/adapters/registry';
import { detectAdapter } from '../../src/content/detect';
import { buildManifest, manifestViolations } from '../../src/manifest';
import { loadIntlFixture } from './harness';

describe('international adapters', () => {
  it('cover every planned international form host', () => {
    expect(INTL_FILLABLE_ATS_TYPES).toEqual(['greenhouse', 'lever', 'ashby', 'workday', 'smartrecruiters', 'icims', 'workable', 'taleo', 'successfactors']);
    expect(plannedSitesFor('intl')).toEqual([]);
    expect(plannedSiteForUrl(new URL('https://acme.wd5.myworkdayjobs.com/en-US/careers/job/1'), 'intl')).toBeNull();
  });

  it('have no submit() or next() (D1)', () => {
    for (const a of INTL_ADAPTERS) {
      expect(a).not.toHaveProperty('submit');
      expect(a).not.toHaveProperty('next');
      expect(Object.keys(a).sort()).toEqual(['attachFile', 'fill', 'hostPatterns', 'id', 'listFields', 'matches', 'probe', 'readJob', 'siteName']);
    }
  });

  it('adapter sources never press, submit or listen for submits', () => {
    const dir = resolve(__dirname, '../../src/adapters/intl');
    for (const f of readdirSync(dir)) {
      const src = readFileSync(join(dir, f), 'utf8').replace(/\/\/[^\n]*/g, '');
      expect(src, f).not.toMatch(/\.(click|submit|requestSubmit)\s*\(|dispatchEvent|addEventListener|KeyboardEvent|MouseEvent|\bfetch\s*\(/);
    }
  });

  it('only the multi-page forms are filled page by page', () => {
    expect(INTL_ADAPTERS.filter(isMultiPage).map((a) => a.id)).toEqual(['workday', 'taleo', 'successfactors']);
    const doc = loadIntlFixture('workday', 'my-information');
    expect(formStepKey({ id: 'greenhouse' }, doc)).toBeNull();
  });

  it('each saved form is claimed by its own adapter only', () => {
    const cases: Array<[string, string, string]> = [
      ['workday', 'my-information', 'https://exampleco.wd5.myworkdayjobs.com/en-US/External/apply'],
      ['smartrecruiters', 'classic', 'https://jobs.smartrecruiters.com/SampleLabs/1-x'],
      ['icims', 'profile', 'https://careers-exampleco.icims.com/jobs/1/x/candidate'],
      ['workable', 'standard', 'https://apply.workable.com/exampleco/j/AB12/apply/'],
      ['taleo', 'personal-info', 'https://exampleco.taleo.net/careersection/ex/jobapply.ftl?job=1'],
      ['successfactors', 'apply', 'https://career5.successfactors.com/careers?company=X'],
    ];
    for (const [dir, name, url] of cases) {
      const doc = loadIntlFixture(dir, name);
      expect(detectAdapter(new URL(url), doc, { set: 'intl', dev: false })?.id, name).toBe(dir);
      // On another host the same markup is not filled (except local fixtures in dev builds).
      expect(detectAdapter(new URL('https://www.example.test/apply'), doc, { set: 'intl', dev: false }), name).toBeNull();
      expect(detectAdapter(new URL('http://localhost:3000/fixture.html'), doc, { set: 'intl', dev: true })?.id, name).toBe(dir);
    }
  });
});

describe('RoboApply manifest after WP-70', () => {
  const m = buildManifest({ brand: 'roboapply', target: 'chrome', dev: false, version: '1.0.0' }) as {
    host_permissions: string[];
    content_scripts: Array<{ matches: string[] }>;
    permissions: string[];
  };

  it('holds the new form hosts, https only, and stays policy-clean', () => {
    expect(m.permissions).toEqual(['activeTab', 'scripting', 'storage']);
    expect(m.host_permissions).toEqual(
      expect.arrayContaining([
        'https://*.myworkdayjobs.com/*',
        'https://*.myworkdaysite.com/*',
        'https://jobs.smartrecruiters.com/*',
        'https://*.icims.com/*',
        'https://apply.workable.com/*',
        'https://*.taleo.net/careersection/*',
        'https://*.successfactors.com/career*',
        'https://*.successfactors.eu/career*',
        'https://jobs.jobvite.com/*',
        'https://*.bamboohr.com/careers/*',
      ]),
    );
    expect(m.host_permissions.every((h) => h.startsWith('https://'))).toBe(true);
    expect(m.content_scripts[0].matches).toEqual(adapterHostPatterns('intl'));
    expect(manifestViolations(m)).toEqual([]);
  });

  it('GoApply builds get the international form hosts too (D5); RoboApply gets no mainland portal host', () => {
    const cn = buildManifest({ brand: 'goapply', target: 'edge', dev: false, version: '1.0.0' }) as { host_permissions: string[] };
    expect(cn.host_permissions).toEqual(expect.arrayContaining(adapterHostPatterns('intl')));
    expect(manifestViolations(cn)).toEqual([]);
    const intl = buildManifest({ brand: 'roboapply', target: 'chrome', dev: false, version: '1.0.0' }) as { host_permissions: string[] };
    expect(intl.host_permissions.join(' ')).not.toMatch(/mokahr|zhiye|beisen|feishu|dayee|hotjob/);
  });

  it('a supported site is recognised from the URL alone, before its form is open', () => {
    expect(INTL_FORM_SITES.map((x) => x.siteName)).toEqual(['Greenhouse', 'Lever', 'Ashby', 'Workday', 'SmartRecruiters', 'iCIMS', 'Workable', 'Taleo', 'SuccessFactors', 'Jobvite', 'BambooHR', 'Recruitee']);
    const supported: Array<[string, string]> = [
      ['https://acme.wd5.myworkdayjobs.com/en-US/careers/job/123', 'Workday'],
      ['https://jobs.smartrecruiters.com/ExampleCo/743999999999999-field-technician', 'SmartRecruiters'],
      ['https://careers-acme.icims.com/jobs/1234/backend-engineer/job', 'iCIMS'],
      ['https://apply.workable.com/example-co/j/ABC123DEF/', 'Workable'],
      ['https://acme.taleo.net/careersection/2/jobdetail.ftl?job=123', 'Taleo'],
      ['https://career5.successfactors.eu/career?company=acme', 'SuccessFactors'],
      ['https://acme.bamboohr.com/careers/42', 'BambooHR'],
      ['https://acme.recruitee.com/o/backend-engineer', 'Recruitee'],
      ['https://boards.greenhouse.io/exampleco/jobs/123', 'Greenhouse'],
    ];
    for (const [u, site] of supported) expect(intlFormSiteForUrl(new URL(u))?.siteName, u).toBe(site);
    // Hosts and paths the extension has no access to.
    for (const u of [
      'https://acme.taleo.net/other/page',
      'https://acme.bamboohr.com/hiring/jobs',
      'https://acme.recruitee.com/',
      'https://myworkdayjobs.com.evil.test/x',
      'http://acme.wd5.myworkdayjobs.com/x',
      'https://careers.example.test/apply',
      'https://www.linkedin.com/jobs/view/3901234567/',
    ]) {
      expect(intlFormSiteForUrl(new URL(u)), u).toBeNull();
    }
  });

  it('no form site is a job board', () => {
    const hosts = INTL_FORM_SITES.flatMap((x) => x.domains);
    for (const d of boardDomains()) for (const h of hosts) expect(h === d || h.endsWith(`.${d}`), `${h} vs ${d}`).toBe(false);
  });

  it('host match patterns follow Chrome semantics', () => {
    expect(matchesHostPattern(new URL('https://a.b.taleo.net/careersection/x'), 'https://*.taleo.net/careersection/*')).toBe(true);
    expect(matchesHostPattern(new URL('https://taleo.net/careersection/x'), 'https://*.taleo.net/careersection/*')).toBe(true);
    expect(matchesHostPattern(new URL('https://x.successfactors.com/careers?x=1'), 'https://*.successfactors.com/career*')).toBe(true);
    expect(matchesHostPattern(new URL('https://jobs.jobvite.com/x'), 'https://jobs.jobvite.com/*')).toBe(true);
    expect(matchesHostPattern(new URL('https://x.jobs.jobvite.com/x'), 'https://jobs.jobvite.com/*')).toBe(false);
    expect(matchesHostPattern(new URL('https://x.test/'), 'not a pattern')).toBe(false);
  });

  it('a multi-page form gets a new page key when its step changes at the same URL', () => {
    const base = 'https://exampleco.wd5.myworkdayjobs.com/en-US/External/job/x/apply/applyManually';
    const workday = INTL_ADAPTERS.find((a) => a.id === 'workday')!;
    const page1 = formPageKey(workday, loadIntlFixture('workday', 'my-information'), base);
    const page2 = formPageKey(workday, loadIntlFixture('workday', 'my-experience'), base);
    expect(page1).toBe(`${base}#step=My%20Information`);
    expect(page2).not.toBe(page1);
    expect(formPageKey(INTL_ADAPTERS[0], loadIntlFixture('workday', 'my-information'), base)).toBe(base);
    expect(formPageKey(null, document, base)).toBe(base);
  });
});
