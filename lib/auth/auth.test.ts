import { describe, expect, it } from 'vitest';
import { detectInAppBrowser } from './inAppBrowser';
import { attributionFrom, carriedQuery, entryContext, safeNext } from './entry';
import { signInRoute } from './signInRoute';
import { oauthStartUrl } from '../api/auth';

const q = (s: string) => new URLSearchParams(s);

describe('in-app browser guard (F-ONB-11)', () => {
  it.each([
    ['Mozilla/5.0 (iPhone) AppleWebKit Mobile LinkedInApp', 'linkedin'],
    ['Mozilla/5.0 (iPhone) Instagram 300.0.0', 'instagram'],
    ['Mozilla/5.0 (Linux; Android 13) musical_ly_2022', 'tiktok'],
    ['Mozilla/5.0 (iPhone) [FBAN/FBIOS;FBAV/400.0]', 'facebook'],
    ['Mozilla/5.0 (iPhone) MicroMessenger/8.0.40', 'wechat'],
  ])('%s → %s', (ua, id) => {
    expect(detectInAppBrowser(ua)).toBe(id);
  });
  it('a normal browser is not an in-app browser', () => {
    expect(detectInAppBrowser('Mozilla/5.0 (Macintosh) Chrome/129.0 Safari/537.36')).toBeNull();
    expect(detectInAppBrowser(null)).toBeNull();
  });
});

describe('entry attribution', () => {
  it('keeps the known keys only', () => {
    expect(attributionFrom(q('from=job&job=cm1&action=apply&ref=R1&utm_source=x&evil=1'), '/signup')).toEqual({
      from: 'job',
      jobId: 'cm1',
      action: 'apply',
      ref: 'R1',
      utmSource: 'x',
      landingPath: '/signup',
    });
    expect(attributionFrom(q(''))).toBeUndefined();
  });
  it('carries the query between login and signup', () => {
    expect(carriedQuery(q('next=/jobs&from=job&x=1'))).toBe('?next=%2Fjobs&from=job');
    expect(carriedQuery(q('x=1'))).toBe('');
  });
  it('accepts only same-site next paths', () => {
    expect(safeNext('/jobs/cm1')).toBe('/jobs/cm1');
    expect(safeNext('//evil.example')).toBeNull();
    expect(safeNext('/\\evil')).toBeNull();
    expect(safeNext('https://evil.example')).toBeNull();
  });
  it('picks the contextual variant', () => {
    expect(entryContext(q('action=apply&job=cm1&jobTitle=Analyst'))).toEqual({ kind: 'apply', jobId: 'cm1' });
    expect(entryContext(q('from=job&job=cm1'))).toEqual({ kind: 'job', jobId: 'cm1' });
    expect(entryContext(q('from=resume-check')).kind).toBe('resume_check');
    expect(entryContext(q('action=apply')).kind).toBe('default');
    // Display text never comes from the URL.
    expect(entryContext(q('jobTitle=Analyst'))).toEqual({ kind: 'default', jobId: null });
    expect(carriedQuery(q('job=cm1&jobTitle=Analyst'))).toBe('?job=cm1');
  });
});

describe('sign-in routing', () => {
  it('sends unfinished onboarding to its screen, otherwise next or /jobs', () => {
    const unfinished = { onboarding: { step: 'resume' as const, path: null, completed: false, nextRoute: '/onboarding/resume' } };
    expect(signInRoute(unfinished, '/jobs/cm1')).toBe('/onboarding/resume');
    const done = { onboarding: { step: 'done' as const, path: null, completed: true, nextRoute: null } };
    expect(signInRoute(done, '/jobs/cm1')).toBe('/jobs/cm1');
    expect(signInRoute(done, 'https://evil.example')).toBe('/jobs');
    expect(signInRoute(null, null)).toBe('/jobs');
  });
});

describe('oauthStartUrl', () => {
  it('builds the start path with agreements and attribution', () => {
    const url = oauthStartUrl('line', { next: '/jobs', age: true, pdpa: true, marketing: false, locale: 'zh-TW', attribution: { from: 'job', jobId: 'cm1' } });
    expect(url.startsWith('/api/v1/roboapply/auth/oauth/line/start?')).toBe(true);
    const p = new URLSearchParams(url.split('?')[1]);
    expect(Object.fromEntries(p)).toEqual({ next: '/jobs', age: '1', pdpa: '1', marketing: '0', locale: 'zh-TW', from: 'job', job: 'cm1' });
    expect(oauthStartUrl('google', { next: '//evil' })).toBe('/api/v1/roboapply/auth/oauth/google/start');
  });
});
