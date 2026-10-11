// @vitest-environment node
//
// MKT-3C: host rules that read a posting's links.
//   - JI-8: links to Recruitee, Personio, Teamtailor and BambooHR boards are ATS links;
//   - JI-5 (MARKET_STRATEGY §1.5 K2): the exact posting key `<ats>:<tenant>:<postingId>` from a
//     posting URL, one positive and one negative case per pattern, and never a guessed tenant;
//   - JI-6: which link a candidate opens (`pickEmployerLink`), and the LinkedIn / Indeed tests.
// Every URL here is SYNTHETIC: the tenant "acme" and the ids are made up. The SHAPES are the
// public ones of JOB_SOURCES_INTL.md §7.1; four of them were re-read on 2026-10-11 from the
// boards' documented public listing APIs (structure only, no posting text kept):
//   Lever hostedUrl      https://jobs.lever.co/{site}/{uuid}            (applyUrl adds /apply)
//   Ashby jobUrl         https://jobs.ashbyhq.com/{org}/{uuid}          (applyUrl adds /application)
//   SmartRecruiters      https://jobs.smartrecruiters.com/{Company}/{15 digits}-{slug}
//   Greenhouse           a board may send its postings to the employer's own page
//                        (https://{employer}/…?gh_jid={id}), which names no tenant.
import { describe, expect, it } from 'vitest';
import { PUBLIC_ATS } from '../sources/atsPublic/contract.js';
import { externalIdFor } from '../sources/atsPublic/shared.js';
import {
  applyLinkKind,
  atsPostingKeyFromBoardRow,
  atsPostingKeyFromUrl,
  atsPostingKeyFromUrls,
  atsPostingKeyOf,
  atsPostingRefFromUrl,
  atsTypeFromUrl,
  isIndeedHost,
  isJobBoardHost,
  isLinkedInHost,
  pickEmployerLink,
} from './ats.js';
import * as normalize from './index.js';

const UUID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

describe('JI-8: four more job-board systems are classified as an ATS', () => {
  it.each([
    ['https://acme.recruitee.com/o/backend-engineer', 'recruitee'],
    ['https://acme.jobs.personio.de/job/123456', 'personio'],
    ['https://acme.jobs.personio.com/job/123456?language=en', 'personio'],
    ['https://acme.teamtailor.com/jobs/123456-backend-engineer', 'teamtailor'],
    ['https://career.acme.teamtailor.com/jobs/1', 'teamtailor'],
    ['https://acme.bamboohr.com/careers/42', 'bamboohr'],
  ])('%s → %s', (url, expected) => {
    expect(atsTypeFromUrl(url)).toBe(expected);
    // An ATS link is where a candidate applies: never a job board, and employer-direct for the link rule.
    expect(isJobBoardHost(new URL(url).hostname)).toBe(false);
    expect(applyLinkKind(url)).toBe('employer');
  });

  it.each([
    // The vendor's own marketing site is an ordinary employer host, not a board of theirs.
    ['https://www.personio.de/karriere/', 'other'],
    ['https://www.personio.com/about-personio/careers/', 'other'],
    // A look-alike domain is not the ATS.
    ['https://recruitee.com.example.org/o/x', 'other'],
    ['https://notbamboohr.com/careers/1', 'other'],
    ['https://teamtailor.com.evil.example/jobs/1', 'other'],
  ])('%s is not that ATS (%s)', (url, expected) => {
    expect(atsTypeFromUrl(url)).toBe(expected);
  });
});

describe('JI-5: the exact posting key K2 from a posting URL', () => {
  // [url, key]
  const POSITIVE: Array<[string, string]> = [
    // Greenhouse: both board hosts.
    ['https://boards.greenhouse.io/stripe/jobs/123', 'greenhouse:stripe:123'],
    ['https://boards.greenhouse.io/acme/jobs/4012345?gh_src=abc#app', 'greenhouse:acme:4012345'],
    ['https://job-boards.greenhouse.io/acme/jobs/4012345', 'greenhouse:acme:4012345'],
    ['http://www.boards.greenhouse.io/Acme/jobs/4012345/', 'greenhouse:acme:4012345'],
    // Lever: the US and the EU data centre are two namespaces.
    [`https://jobs.lever.co/acme/${UUID}`, `lever:acme:${UUID}`],
    [`https://jobs.lever.co/acme/${UUID}/apply`, `lever:acme:${UUID}`],
    [`https://jobs.lever.co/Acme/${UUID.toUpperCase()}?lever-source=x`, `lever:acme:${UUID}`],
    [`https://jobs.eu.lever.co/acme/${UUID}`, `lever_eu:acme:${UUID}`],
    // Ashby.
    [`https://jobs.ashbyhq.com/acme/${UUID}`, `ashby:acme:${UUID}`],
    [`https://jobs.ashbyhq.com/acme/${UUID}/application`, `ashby:acme:${UUID}`],
    [`https://jobs.ashbyhq.com/Acme.Labs/${UUID}`, `ashby:acme.labs:${UUID}`],
    // SmartRecruiters: the id is the leading digits of the last segment.
    ['https://jobs.smartrecruiters.com/AcmeGroup/744000012345678-backend-engineer', 'smartrecruiters:acmegroup:744000012345678'],
    ['https://jobs.smartrecruiters.com/AcmeGroup/744000012345678', 'smartrecruiters:acmegroup:744000012345678'],
    ['https://jobs.smartrecruiters.com/AcmeGroup/744000012345678-backend-engineer?oga=true', 'smartrecruiters:acmegroup:744000012345678'],
    // Workable: the shortcode is lower-cased in the key.
    ['https://apply.workable.com/acme/j/1A2B3C4D5E', 'workable:acme:1a2b3c4d5e'],
    ['https://apply.workable.com/acme/j/1A2B3C4D5E/apply/', 'workable:acme:1a2b3c4d5e'],
    // Workday: the tenant is the sub-domain, the id what follows the last underscore.
    ['https://acme.wd5.myworkdayjobs.com/en-US/External/job/Austin-TX/Senior-Backend-Engineer_R-12345', 'workday:acme:r-12345'],
    ['https://acme.wd103.myworkdayjobs.com/External/job/Remote/Data_Analyst_II_JR100234', 'workday:acme:jr100234'],
    ['https://acme.wd1.myworkdayjobs.com/en-US/External/job/Taipei/Engineer_JR100234-1/apply', 'workday:acme:jr100234-1'],
    ['https://acme.wd1.myworkdayjobs.com/en-US/External/job/Taipei/Engineer_JR100234/apply/autofillWithResume', 'workday:acme:jr100234'],
    // iCIMS.
    ['https://careers-acme.icims.com/jobs/1234/senior-engineer/job', 'icims:careers-acme:1234'],
    ['https://uscareers-acme.icims.com/jobs/1234/job?mobile=false', 'icims:uscareers-acme:1234'],
  ];

  it.each(POSITIVE)('%s → %s', (url, key) => {
    expect(atsPostingKeyFromUrl(url)).toBe(key);
    expect(key).toBe(key.toLowerCase());
    expect(key.split(':')).toHaveLength(3);
  });

  it.each([
    // Greenhouse: an employer's own page carries the posting id but no tenant. Never guessed.
    ['https://stripe.com/jobs/search?gh_jid=123', 'employer page with ?gh_jid='],
    ['https://careers.acme.example/openings/backend?gh_jid=4012345', 'employer page with ?gh_jid='],
    ['https://boards.greenhouse.io/acme', 'the board itself, no posting'],
    ['https://boards.greenhouse.io/acme/jobs', 'no posting id'],
    ['https://boards.greenhouse.io/acme/jobs/abc', 'a posting id that is not a number'],
    ['https://boards.greenhouse.io/embed/job_app?for=acme&token=4012345', 'the embedded form, not a posting path'],
    ['https://api.greenhouse.io/acme/jobs/123', 'another Greenhouse host'],
    // Lever.
    ['https://jobs.lever.co/acme', 'the board itself'],
    ['https://jobs.lever.co/acme/not-a-uuid', 'no uuid'],
    [`https://hire.lever.co/acme/${UUID}`, "the recruiter's side, not the public board"],
    // Ashby.
    ['https://jobs.ashbyhq.com/acme', 'the board itself'],
    ['https://jobs.ashbyhq.com/acme/backend-engineer', 'no uuid'],
    [`https://app.ashbyhq.com/acme/${UUID}`, 'another Ashby host'],
    // SmartRecruiters.
    ['https://jobs.smartrecruiters.com/AcmeGroup', 'the board itself'],
    ['https://jobs.smartrecruiters.com/AcmeGroup/backend-engineer', 'no leading digits'],
    [`https://jobs.smartrecruiters.com/external-referrals/company/AcmeGroup/publication/${UUID}`, 'the referral flow names no posting id'],
    ['https://careers.smartrecruiters.com/AcmeGroup', 'the careers page'],
    // Workable.
    ['https://apply.workable.com/acme', 'the board itself'],
    ['https://apply.workable.com/acme/j', 'no shortcode'],
    ['https://acme.workable.com/jobs/123456', 'the legacy host, another id space'],
    // Workday.
    ['https://acme.wd5.myworkdayjobs.com/en-US/External', 'the board itself'],
    ['https://acme.wd5.myworkdayjobs.com/en-US/External/job/Austin-TX/Senior-Backend-Engineer', 'no requisition id'],
    ['https://acme.wd5.myworkdayjobs.com/en-US/External/job/Austin-TX/Senior_Backend_Engineer', 'a title with underscores and no id'],
    ['https://acme.myworkdayjobs.com/External/job/Austin/Engineer_R-1', 'no data-centre label, so no tenant shape'],
    ['https://wd5.myworkdayjobs.com/External/job/Austin/Engineer_R-1', 'no tenant'],
    // iCIMS.
    ['https://careers-acme.icims.com/jobs/search?ss=1', 'the search page'],
    ['https://careers-acme.icims.com/jobs/intro', 'no posting id'],
    ['https://icims.com/jobs/1234/job', 'no tenant sub-domain'],
    // Not a posting URL at all.
    ['https://www.linkedin.com/jobs/view/123', 'a job board'],
    ['https://careers.acme.example/jobs/123', 'an employer site'],
    ['ftp://boards.greenhouse.io/acme/jobs/123', 'not http(s)'],
    ['boards.greenhouse.io/acme/jobs/123', 'no scheme'],
    ['', 'empty'],
    [null, 'null'],
    [undefined, 'undefined'],
  ])('%s gives no key (%s)', (url) => {
    expect(atsPostingKeyFromUrl(url as string | null | undefined)).toBeNull();
    expect(atsPostingRefFromUrl(url as string | null | undefined)).toBeNull();
  });

  it('keeps the tenant and the id as the URL writes them in the ref; only the key is lower-cased', () => {
    const ref = atsPostingRefFromUrl('https://jobs.smartrecruiters.com/AcmeGroup/744000012345678-backend-engineer');
    expect(ref).toEqual({ ats: 'smartrecruiters', tenant: 'AcmeGroup', postingId: '744000012345678' });
    expect(atsPostingKeyOf(ref!)).toBe('smartrecruiters:acmegroup:744000012345678');
    expect(atsPostingRefFromUrl('https://apply.workable.com/acme/j/1A2B3C4D5E')).toEqual({ ats: 'workable', tenant: 'acme', postingId: '1A2B3C4D5E' });
  });

  it('a tenant that is not a board token gives no key (nothing is cleaned up into one)', () => {
    expect(atsPostingKeyFromUrl('https://boards.greenhouse.io/ac%20me/jobs/123')).toBeNull();
    expect(atsPostingKeyFromUrl('https://boards.greenhouse.io/ac:me/jobs/123')).toBeNull();
    expect(atsPostingKeyFromUrl('https://boards.greenhouse.io/%E0%A4%A/jobs/123')).toBeNull();
    expect(atsPostingKeyFromUrl(`https://jobs.lever.co/${'a'.repeat(121)}/${UUID}`)).toBeNull();
  });

  it('a posting is keyed by its apply link first, then by its posting page', () => {
    expect(atsPostingKeyFromUrls('https://boards.greenhouse.io/stripe/jobs/123', 'https://www.linkedin.com/jobs/view/9')).toBe('greenhouse:stripe:123');
    expect(atsPostingKeyFromUrls('https://www.totaljobs.com/job/9', `https://jobs.lever.co/acme/${UUID}`)).toBe(`lever:acme:${UUID}`);
    expect(atsPostingKeyFromUrls(`https://jobs.ashbyhq.com/acme/${UUID}`, 'https://boards.greenhouse.io/acme/jobs/1')).toBe(`ashby:acme:${UUID}`);
    expect(atsPostingKeyFromUrls('https://stripe.com/jobs/search?gh_jid=123', 'https://stripe.com/jobs/search?gh_jid=123')).toBeNull();
    expect(atsPostingKeyFromUrls(null, undefined)).toBeNull();
    expect(atsPostingKeyFromUrls(null)).toBeNull();
  });
});

describe('JI-5: the key of an employer-board row comes from its own board and externalId', () => {
  it.each([
    ['greenhouse', 'stripe', '123', 'greenhouse:stripe:123', 'https://boards.greenhouse.io/stripe/jobs/123'],
    ['lever', 'acme', UUID, `lever:acme:${UUID}`, `https://jobs.lever.co/acme/${UUID}`],
    ['ashby', 'acme', UUID, `ashby:acme:${UUID}`, `https://jobs.ashbyhq.com/acme/${UUID}`],
    ['smartrecruiters', 'AcmeGroup', '744000012345678', 'smartrecruiters:acmegroup:744000012345678', 'https://jobs.smartrecruiters.com/AcmeGroup/744000012345678-backend-engineer'],
  ])('%s %s:%s → %s, the same key its posting URL gives', (board, token, postingId, key, url) => {
    const externalId = externalIdFor(token, postingId);
    expect(atsPostingKeyFromBoardRow(board, externalId)).toBe(key);
    expect(atsPostingKeyFromUrl(url)).toBe(key);
    // The mainland copy of a posting located in both markets (JC-4) is the same posting.
    expect(atsPostingKeyFromBoardRow(board, `${externalId}#cn`)).toBe(key);
    expect(atsPostingKeyFromBoardRow(board.toUpperCase(), ` ${externalId} `)).toBe(key);
  });

  it('covers every public job-board system the connectors read', () => {
    for (const ats of PUBLIC_ATS) expect(atsPostingKeyFromBoardRow(ats, externalIdFor('acme', '1'))).toBe(`${ats}:acme:1`);
  });

  it.each([
    ['jsearch', 'jsearch:abc'],
    ['activejobs', 'activejobs:123'],
    ['gohire', 'job_1'],
    ['workday', 'acme:R-1'],
    ['greenhouse', 'no-colon'],
    ['greenhouse', ':123'],
    ['greenhouse', 'acme:'],
    ['greenhouse', 'acme:1:2'],
    ['greenhouse', 'ac me:1'],
    ['greenhouse', 'acme:1 2'],
    ['greenhouse', ''],
    ['greenhouse', null],
    [null, 'acme:1'],
    ['', 'acme:1'],
  ])('board %s with externalId %s gives no key', (board, externalId) => {
    expect(atsPostingKeyFromBoardRow(board, externalId)).toBeNull();
  });
});

describe('JI-6: which link a candidate opens', () => {
  it('knows LinkedIn and Indeed hosts under their country domains', () => {
    for (const host of ['linkedin.com', 'www.linkedin.com', 'tw.linkedin.com', 'lnkd.in']) expect(isLinkedInHost(host)).toBe(true);
    for (const host of ['notlinkedin.com', 'linkedin.com.example.org', 'licdn.com', '', null, undefined]) expect(isLinkedInHost(host)).toBe(false);
    for (const host of ['indeed.com', 'www.indeed.com', 'uk.indeed.com', 'indeed.co.uk', 'tw.indeed.com', 'indeed.com.au', 'au.indeed.com', 'indeed.de']) expect(isIndeedHost(host)).toBe(true);
    for (const host of ['indeedjobs.example', 'notindeed.com', 'indeed.example.org', 'careers.indeedcorp.example', '', null, undefined]) expect(isIndeedHost(host)).toBe(false);
    // Both are job boards for every other rule.
    expect(isJobBoardHost('uk.indeed.com')).toBe(true);
    expect(isJobBoardHost('tw.linkedin.com')).toBe(true);
  });

  it.each([
    ['https://careers.acme.example/jobs/1', 'employer'],
    ['https://boards.greenhouse.io/acme/jobs/1', 'employer'],
    [`https://jobs.lever.co/acme/${UUID}`, 'employer'],
    ['https://www.totaljobs.com/job/1', 'board'],
    ['https://www.glassdoor.com/job-listing/x', 'board'],
    ['https://www.104.com.tw/job/abc', 'board'],
    ['https://www.google.com/search?q=jobs', 'board'],
    ['https://www.linkedin.com/jobs/view/1', 'linkedin'],
    ['https://lnkd.in/abc', 'linkedin'],
    ['https://uk.indeed.com/viewjob?jk=1', 'indeed'],
    ['https://www.indeed.com/viewjob?jk=1', 'indeed'],
    ['ftp://careers.acme.example/1', null],
    ['not a url', null],
    ['', null],
    [null, null],
  ])('%s is a %s link', (url, kind) => {
    expect(applyLinkKind(url as string | null)).toBe(kind);
  });

  it('picks the employer or ATS page first, then a job board, and never LinkedIn or Indeed', () => {
    const employer = 'https://careers.acme.example/jobs/1';
    const ats = `https://jobs.lever.co/acme/${UUID}`;
    const board = 'https://www.totaljobs.com/job/1';
    const linkedin = 'https://www.linkedin.com/jobs/view/1';
    const indeed = 'https://uk.indeed.com/viewjob?jk=1';

    expect(pickEmployerLink([linkedin, board, employer, ats])).toEqual({ url: employer, direct: true, only: null });
    expect(pickEmployerLink([board, ats])).toEqual({ url: ats, direct: true, only: null });
    expect(pickEmployerLink([linkedin, indeed, board])).toEqual({ url: board, direct: false, only: null });
    expect(pickEmployerLink([board, 'https://www.glassdoor.com/job-listing/x'])).toEqual({ url: board, direct: false, only: null });
    // Only LinkedIn and / or Indeed: no link, and the site of the first of them is named.
    expect(pickEmployerLink([linkedin])).toEqual({ url: null, direct: false, only: 'linkedin' });
    expect(pickEmployerLink([indeed])).toEqual({ url: null, direct: false, only: 'indeed' });
    expect(pickEmployerLink([linkedin, indeed])).toEqual({ url: null, direct: false, only: 'linkedin' });
    expect(pickEmployerLink([indeed, linkedin, linkedin])).toEqual({ url: null, direct: false, only: 'indeed' });
    // Nothing usable at all is not "LinkedIn only".
    expect(pickEmployerLink([])).toEqual({ url: null, direct: false, only: null });
    expect(pickEmployerLink([null, undefined, '', 'javascript:alert(1)', 'not a url'])).toEqual({ url: null, direct: false, only: null });
    // Values that are not URLs are skipped, not chosen.
    expect(pickEmployerLink([null, 'mailto:jobs@acme.example', employer])).toEqual({ url: employer, direct: true, only: null });
  });

  it('returns the normalized form of the link it picks', () => {
    const picked = pickEmployerLink(['  https://Careers.Acme.Example/jobs/1  ']);
    expect(picked.direct).toBe(true);
    expect(picked.url).toBe(normalize.safeUrl('  https://Careers.Acme.Example/jobs/1  '));
  });

  it('the area index exports the link and key helpers other areas use (MKT-3A, MKT-3D, MKT-5C)', () => {
    expect(normalize.pickEmployerLink).toBe(pickEmployerLink);
    expect(normalize.atsPostingKeyFromUrl).toBe(atsPostingKeyFromUrl);
    expect(normalize.atsPostingKeyFromUrls).toBe(atsPostingKeyFromUrls);
    expect(normalize.atsPostingRefFromUrl).toBe(atsPostingRefFromUrl);
    expect(normalize.isIndeedHost).toBe(isIndeedHost);
    expect(normalize.isLinkedInHost).toBe(isLinkedInHost);
  });
});
