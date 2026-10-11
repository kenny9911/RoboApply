// Detection: URL + DOM probe; dev builds also accept local fixture pages.

import { describe, expect, it } from 'vitest';

import { getExtBrand, isTrustedBrandOrigin } from '../src/brands/index';
import { detectAdapter, isLocalHost } from '../src/content/detect';
import { loadFixture } from './helpers';

describe('detectAdapter', () => {
  it('finds the adapter for a supported host with a form', () => {
    const doc = loadFixture('lever', 'standard');
    expect(detectAdapter(new URL('https://jobs.lever.co/exampleco/abc/apply'), doc, { set: 'intl', dev: false })?.id).toBe('lever');
  });

  it('a supported host without an application form is not detected', () => {
    document.documentElement.innerHTML = '<body><h2>Backend Engineer</h2><a href="apply">Apply for this job</a></body>';
    expect(detectAdapter(new URL('https://jobs.lever.co/exampleco/abc'), document, { set: 'intl', dev: false })).toBeNull();
  });

  it('a lookalike host is not detected', () => {
    const doc = loadFixture('greenhouse', 'classic');
    expect(detectAdapter(new URL('https://boards.greenhouse.io.evil.example/x'), doc, { set: 'intl', dev: false })).toBeNull();
  });

  it('local fixture pages are detected only in dev builds', () => {
    const doc = loadFixture('ashby', 'standard');
    const local = new URL('http://127.0.0.1:8080/ashby.html');
    expect(isLocalHost(local)).toBe(true);
    expect(detectAdapter(local, doc, { set: 'intl', dev: false })).toBeNull();
    expect(detectAdapter(local, doc, { set: 'intl', dev: true })?.id).toBe('ashby');
  });

  it('the GoApply build fills the international form sites too (its adapter set is a superset of RoboApply\'s, D5)', () => {
    const doc = loadFixture('greenhouse', 'classic');
    expect(detectAdapter(new URL('https://boards.greenhouse.io/x/jobs/1'), doc, { set: 'cn', dev: false })?.id).toBe('greenhouse');
  });
});

describe('isTrustedBrandOrigin', () => {
  const robo = getExtBrand('roboapply');
  it.each([
    ['https://www.roboapply.io', false, true],
    ['https://roboapply.io', false, true],
    ['https://www.roboapply.io/', false, true],
    ['https://www.roboapply.io/extension', false, false],
    ['http://www.roboapply.io', false, false],
    ['https://evil.roboapply.io.example', false, false],
    ['https://www.goapply.top', false, false],
    ['http://localhost:3611', false, false],
    ['http://localhost:3611', true, true],
    ['http://127.0.0.1:4799', true, true],
    ['not a url', true, false],
  ])('%s (dev=%s) → %s', (origin, dev, want) => {
    expect(isTrustedBrandOrigin(robo, origin as string, dev as boolean)).toBe(want);
  });
});
