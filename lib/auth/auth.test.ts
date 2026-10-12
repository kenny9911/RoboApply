import { describe, expect, it } from 'vitest';
import { detectInAppBrowser } from './inAppBrowser';
import { afterEach } from 'vitest';
import { PRIORITY_NEXT_PATHS, attributionFrom, carriedQuery, entryContext, priorityNext, safeNext, signupAttribution } from './entry';
import { signInRoute } from './signInRoute';
import { TWO_FACTOR_PAGE, isTwoFactorRequired, twoFactorHref } from './twoFactor';
import { OAUTH_TOUCH_PARAM_MAX, oauthStartUrl } from '../api/auth';
import { RoboApiError } from '../api/client';
import { __resetAnalyticsForTests, captureAttribution, safePath } from '../analytics';
import { OAUTH_TOUCH_PARAM_MAX as SERVER_OAUTH_TOUCH_PARAM_MAX, PRIORITY_NEXT_PATHS as SERVER_PRIORITY_NEXT_PATHS, isPriorityNext } from '../../server/src/features/auth/contract';

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

  it('carries the stored first and last touch (the provider callback has no body to send them in)', () => {
    const firstTouch = { ref: 'ABCDEFGH', utmSource: 'newsletter', landingPath: '/r/:code', at: '2026-10-01T00:00:00.000Z' };
    const lastTouch = { from: 'job', jobId: 'cm7', at: '2026-10-10T00:00:00.000Z' };
    const p = new URLSearchParams(oauthStartUrl('google', { age: true, attribution: { from: 'job', firstTouch, lastTouch } }).split('?')[1]);
    expect(JSON.parse(p.get('ft')!)).toEqual(firstTouch);
    expect(JSON.parse(p.get('lt')!)).toEqual(lastTouch);
    expect(p.get('from')).toBe('job');
    // Nothing stored: no parameter at all.
    const none = new URLSearchParams(oauthStartUrl('google', { attribution: { from: 'job', lastTouch: null } }).split('?')[1]);
    expect(none.has('ft')).toBe(false);
    expect(none.has('lt')).toBe(false);
  });

  it('a touch too long for the URL loses its landing page, and is left out when still too long', () => {
    expect(OAUTH_TOUCH_PARAM_MAX).toBe(SERVER_OAUTH_TOUCH_PARAM_MAX);
    const long = { ref: 'ABCDEFGH', landingPath: `/${'p'.repeat(OAUTH_TOUCH_PARAM_MAX)}`, at: '2026-10-01T00:00:00.000Z' };
    const p = new URLSearchParams(oauthStartUrl('line', { attribution: { firstTouch: long } }).split('?')[1]);
    expect(JSON.parse(p.get('ft')!)).toEqual({ ref: 'ABCDEFGH', at: '2026-10-01T00:00:00.000Z' });
    const huge = { utmCampaign: 'c'.repeat(OAUTH_TOUCH_PARAM_MAX + 1), at: '2026-10-01T00:00:00.000Z' };
    expect(oauthStartUrl('line', { attribution: { firstTouch: huge } })).toBe('/api/v1/roboapply/auth/oauth/line/start');
  });
});

// ── INT-01 ───────────────────────────────────────────────────────────────

describe('`next` to a free tool page (WP-57 → INT-01)', () => {
  const unfinished = { onboarding: { step: 'account' as const, path: null, completed: false, nextRoute: '/onboarding/situation' } };
  const done = { onboarding: { step: 'done' as const, path: null, completed: true, nextRoute: null } };

  it('the web list equals the server list', () => {
    expect([...PRIORITY_NEXT_PATHS]).toEqual([...SERVER_PRIORITY_NEXT_PATHS]);
    for (const path of PRIORITY_NEXT_PATHS) {
      expect(priorityNext(path)).toBe(path);
      expect(isPriorityNext(path)).toBe(true);
    }
  });

  it('honours next=/tools/resume-check after sign-in and sign-up, even while onboarding is unfinished', () => {
    expect(safeNext('/tools/resume-check')).toBe('/tools/resume-check');
    expect(signInRoute(unfinished, '/tools/resume-check')).toBe('/tools/resume-check');
    expect(signInRoute(done, '/tools/resume-check')).toBe('/tools/resume-check');
    expect(signInRoute(null, '/tools/resume-check')).toBe('/tools/resume-check');
  });

  it('honours next=/tools/resume-job-match the same way (query and hash kept)', () => {
    expect(signInRoute(unfinished, '/tools/resume-job-match')).toBe('/tools/resume-job-match');
    expect(signInRoute(unfinished, '/tools/resume-job-match?kept=1#report')).toBe('/tools/resume-job-match?kept=1#report');
    expect(priorityNext('/tools/resume-job-match/')).toBe('/tools/resume-job-match/');
  });

  it('an unknown next still falls back to the default route', () => {
    // Unfinished onboarding: its screen, not the page asked for.
    expect(signInRoute(unfinished, '/jobs/cm1')).toBe('/onboarding/situation');
    expect(signInRoute(unfinished, '/tools')).toBe('/onboarding/situation');
    expect(signInRoute(unfinished, '/tools/resume-check/extra')).toBe('/onboarding/situation');
    expect(signInRoute(unfinished, '/tools/something-else')).toBe('/onboarding/situation');
    // Never off-site, whatever the path looks like.
    expect(signInRoute(unfinished, '//evil.example/tools/resume-check')).toBe('/onboarding/situation');
    expect(signInRoute(done, 'https://evil.example/tools/resume-check')).toBe('/jobs');
    expect(priorityNext('/\\evil/tools/resume-check')).toBeNull();
    expect(priorityNext(null)).toBeNull();
    // Onboarding done: any same-site next, else /jobs.
    expect(signInRoute(done, '/jobs/cm1')).toBe('/jobs/cm1');
    expect(signInRoute(done, null)).toBe('/jobs');
  });

  it('from=resume-job-match picks its own contextual variant', () => {
    expect(entryContext(q('from=resume-job-match&next=/tools/resume-job-match'))).toEqual({ kind: 'resume_job_match', jobId: null });
    expect(entryContext(q('from=resume-check')).kind).toBe('resume_check');
    // A job in the link still wins (the page is about that job).
    expect(entryContext(q('from=resume-job-match&job=cm1')).kind).toBe('job');
    expect(carriedQuery(q('from=resume-job-match&next=/tools/resume-job-match'))).toBe('?next=%2Ftools%2Fresume-job-match&from=resume-job-match');
  });
});

describe('two-step sign-in redirect', () => {
  const required = (details?: Record<string, unknown>) =>
    new RoboApiError('Enter the code', { status: 401, code: 'two_factor_required', payload: { success: false, code: 'two_factor_required', ...(details ? { details } : {}) } });

  it('recognises the 401 two_factor_required answer only', () => {
    expect(isTwoFactorRequired(required())).toBe(true);
    expect(isTwoFactorRequired(new RoboApiError('no', { status: 401, payload: { success: false, code: 'invalid_credentials' } }))).toBe(false);
    expect(isTwoFactorRequired(new Error('x'))).toBe(false);
    expect(isTwoFactorRequired(null)).toBe(false);
  });

  it('goes to /login/2fa carrying where the person was going', () => {
    expect(TWO_FACTOR_PAGE).toBe('/login/2fa');
    // The password form: the server names the page; `next` comes from the form.
    expect(twoFactorHref(required({ next: '/login/2fa' }), '/jobs/cm1')).toBe('/login/2fa?next=%2Fjobs%2Fcm1');
    expect(twoFactorHref(required({ next: '/login/2fa' }), null)).toBe('/login/2fa');
    // Provider, reset and phone routes: the server already knows where to continue.
    expect(twoFactorHref(required({ next: '/login/2fa?next=%2Fonboarding%2Fsituation' }), '/jobs')).toBe('/login/2fa?next=%2Fonboarding%2Fsituation');
    expect(twoFactorHref(required())).toBe('/login/2fa');
  });

  it('never leaves the site, whatever the answer or the page says', () => {
    expect(twoFactorHref(required({ next: 'https://evil.example/login/2fa' }), '/jobs')).toBe('/login/2fa?next=%2Fjobs');
    expect(twoFactorHref(required({ next: '/login/2fa?next=https%3A%2F%2Fevil.example' }), null)).toBe('/login/2fa');
    expect(twoFactorHref(required({ next: '/login/2fa?next=%2F%2Fevil.example' }), '/jobs')).toBe('/login/2fa?next=%2Fjobs');
    expect(twoFactorHref(required({ next: '/login/2fa' }), '//evil.example')).toBe('/login/2fa');
    expect(twoFactorHref(required({ next: '/somewhere-else?next=/jobs' }), null)).toBe('/login/2fa');
  });
});

describe('what signup sends as attribution', () => {
  afterEach(() => __resetAnalyticsForTests());

  it('this page’s entry parameters, plus the stored first and last touch', () => {
    __resetAnalyticsForTests();
    expect(signupAttribution(q('from=job&job=cm1'), '/signup')).toEqual({ from: 'job', jobId: 'cm1', landingPath: '/signup' });
    captureAttribution({ search: '?utm_source=newsletter', pathname: '/' });
    captureAttribution({ search: '?ref=ABCD2345&from=invite', pathname: '/signup' });
    const sent = signupAttribution(q('ref=ABCD2345&from=invite'), '/signup')!;
    expect(sent).toMatchObject({ ref: 'ABCD2345', from: 'invite', landingPath: '/signup' });
    // The stored touches travel in Touch field names (`firstTouch` / `lastTouch`);
    // the referral is functional, so it is there whatever the analytics choice.
    expect(sent.firstTouch).toBeTruthy();
    expect([sent.firstTouch, sent.lastTouch].some((touch) => touch?.ref === 'ABCD2345')).toBe(true);
  });

  it('with no stored touch and no entry parameters there is nothing to send', () => {
    __resetAnalyticsForTests();
    expect(signupAttribution(q(''))).toBeUndefined();
  });
});

describe('invite codes never reach product events (WP-60 #43)', () => {
  it("safePath('/r/abc123') → '/r/:code'", () => {
    expect(safePath('/r/abc123')).toBe('/r/:code');
    expect(safePath('/r/ABCD2345?utm_source=x#top')).toBe('/r/:code');
    expect(safePath('/r/ABCD2345/anything')).toBe('/r/:code');
  });

  it('leaves other paths alone and still hides one-time tokens', () => {
    expect(safePath('/resume')).toBe('/resume');
    expect(safePath('/r')).toBe('/r');
    expect(safePath('/review/123')).toBe('/review/123');
    expect(safePath('/jobs/r/abc')).toBe('/jobs/r/abc');
    expect(safePath('/reset-password/secret-token')).toBe('/reset-password/:token');
    expect(safePath('/jobs?x=1')).toBe('/jobs');
  });

  it('a landing path noted for attribution is scrubbed the same way', () => {
    __resetAnalyticsForTests();
    captureAttribution({ search: '?ref=ABCD2345', pathname: '/r/ABCD2345' });
    const sent = signupAttribution(q(''));
    expect(JSON.stringify(sent)).not.toContain('/r/ABCD2345');
    __resetAnalyticsForTests();
  });
});
