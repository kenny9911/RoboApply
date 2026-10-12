// @vitest-environment node
//
// Pure parts of the profile area: completeness, the LLM snapshot allowlist,
// resume → profile proposals and the sensitive-answer cipher.

import { describe, expect, it } from 'vitest';

import { ProfileLinksSchema, ProfilePatchSchema, SensitiveAnswersSchema, isLinkedInProfileUrl } from './contract.js';
import { COMPLETENESS_RULES, computeCompleteness } from './completeness.js';
import { emptyCore, readWorkAuth, readYm, toCore, type ProfileCore } from './model.js';
import { diffProfile, parseResumeDate, planAccepted, proposeFromResume, splitName, toE164, StaleDiffError } from './resumeSync.js';
import { openSensitive, sealSensitive, sensitiveCryptoConfigured } from './sensitiveCrypto.js';
import { CN_SNAPSHOT_KEYS, NEVER_IN_PROMPT, buildSnapshotText, snapshotCacheKey } from './snapshot.js';

const U = 'user_1';

function full(over: Partial<ProfileCore> = {}): ProfileCore {
  return {
    ...emptyCore(U),
    firstName: 'Ada',
    lastName: 'Lovelace',
    contactEmail: 'ada@example.test',
    phoneE164: '+14155550100',
    city: 'Austin',
    region: 'TX',
    country: 'US',
    headline: 'Data analyst',
    summary: 'Five years of analytics.',
    skills: [{ name: 'SQL', confirmed: true }],
    languages: [{ language: 'English', level: 'native' }],
    links: { linkedin: 'https://www.linkedin.com/in/ada' },
    workAuth: [{ country: 'US', authorized: true, sponsorship: 'no' }],
    education: [{ id: 'e1', school: 'UT Austin', degree: 'BS', major: 'Statistics', gpa: '3.8', startDate: '2014-09', endDate: '2018-05', current: false, location: null }],
    experience: [
      { id: 'x1', company: 'Acme', title: 'Analyst', location: 'Austin', startDate: '2018-06', endDate: null, current: true, description: 'Dashboards', bullets: ['Cut report time 40%'], kind: 'work', employmentType: null },
    ],
    updatedAt: '2026-10-10T00:00:00.000Z',
    ...over,
  };
}

// ── completeness ──────────────────────────────────────────────────────────

describe('computeCompleteness', () => {
  it('an empty RoboApply profile is 0 and lists every required field', () => {
    const r = computeCompleteness(emptyCore(U), 'intl');
    expect(r.completeness).toBe(0);
    expect(r.missing.map((m) => m.key)).toEqual(['firstName', 'lastName', 'contactEmail', 'phone', 'location', 'education', 'experience', 'skills', 'workAuth']);
    expect(r.missing[0]).toEqual({ key: 'firstName', label: 'profile.missing.firstName', section: 'personal' });
  });

  it('a full RoboApply profile is 100 with nothing missing', () => {
    expect(computeCompleteness(full(), 'intl')).toEqual({ completeness: 100, missing: [] });
  });

  it('weights required fields twice as much as helpful ones', () => {
    const noHelpful = full({ headline: null, summary: null, languages: [], links: {} });
    const r = computeCompleteness(noHelpful, 'intl');
    expect(r.missing).toEqual([]);
    // 9 required ×2 = 18; 4 helpful ×1 = 4 → 18/22
    expect(r.completeness).toBe(Math.floor((100 * 18) / 22));
  });

  it('a work-authorization row left unanswered still counts as missing', () => {
    const r = computeCompleteness(full({ workAuth: [{ country: 'US', authorized: null, sponsorship: null }] }), 'intl');
    expect(r.missing.map((m) => m.key)).toEqual(['workAuth']);
  });

  it('GoApply: no LinkedIn or work authorization; identity and graduation class required for students; work optional for students', () => {
    const student = full({ links: {}, workAuth: [], experience: [], cnFields: { identity: 'yingjie' } });
    const r = computeCompleteness(student, 'cn');
    expect(r.missing.map((m) => m.key)).toEqual(['graduationClass']);
    const r2 = computeCompleteness({ ...student, cnFields: { identity: 'yingjie', graduationClass: 2026 } }, 'cn');
    expect(r2.missing).toEqual([]);
    const pro = computeCompleteness(full({ experience: [], cnFields: { identity: 'shezhao' } }), 'cn');
    expect(pro.missing.map((m) => m.key)).toEqual(['experience']);
    const none = computeCompleteness(full({ cnFields: null }), 'cn');
    expect(none.missing.map((m) => m.key)).toEqual(['cnIdentity']);
  });

  it('every rule names a section and a market', () => {
    for (const r of COMPLETENESS_RULES) {
      expect(r.markets.length).toBeGreaterThan(0);
      expect(r.section).toBeTruthy();
    }
  });
});

// ── model ────────────────────────────────────────────────────────────────

describe('model normalizers', () => {
  it('drops malformed JSON parts and duplicate countries', () => {
    expect(
      readWorkAuth([
        { country: 'US', authorized: true, sponsorship: null },
        { country: 'US', authorized: false, sponsorship: null },
        { country: 'zz', authorized: true, sponsorship: null },
        'junk',
      ]),
    ).toEqual([{ country: 'US', authorized: true, sponsorship: null }]);
    expect(readYm('2020-03-01')).toBe('2020-03');
    expect(readYm('2020')).toBe('2020');
    expect(readYm('soon')).toBeNull();
  });

  it('orders rows current first, then most recent', () => {
    const base = { degree: null, major: null, gpa: null, location: null };
    const core = toCore(U, null, [
      { id: 'a', school: 'Old', startYm: '2010-01', endYm: '2014-01', current: false, sortOrder: 0, ...base },
      { id: 'b', school: 'New', startYm: '2016-01', endYm: '2018-01', current: false, sortOrder: 1, ...base },
      { id: 'c', school: 'Now', startYm: '2024-01', endYm: '2026-01', current: true, sortOrder: 2, ...base },
    ], [], null);
    expect(core.education.map((e) => e.school)).toEqual(['Now', 'New', 'Old']);
    expect(core.education[0]!.endDate).toBeNull();
  });
});

// ── contract ─────────────────────────────────────────────────────────────

describe('contract rules', () => {
  it.each([
    ['https://www.linkedin.com/in/ada-lovelace', true],
    ['https://tw.linkedin.com/in/ada/', true],
    ['https://linkedin.com/pub/ada/1/2/3', true],
    ['https://www.linkedin.com/company/acme', false],
    ['https://evil.example/linkedin.com/in/ada', false],
    ['https://notlinkedin.com/in/ada', false],
    ['ftp://www.linkedin.com/in/ada', false],
  ])('LinkedIn link %s → %s', (url, ok) => {
    expect(isLinkedInProfileUrl(url)).toBe(ok);
    expect(ProfileLinksSchema.safeParse({ linkedin: url }).success).toBe(ok);
  });

  it('work authorization is one row per country; the permit answer is a Taiwan value', () => {
    expect(ProfilePatchSchema.safeParse({ workAuth: [{ country: 'TW', authorized: false, sponsorship: 'now', permit: 'gold_card' }] }).success).toBe(true);
    expect(ProfilePatchSchema.safeParse({ workAuth: [{ country: 'US', authorized: true, sponsorship: null }, { country: 'US', authorized: false, sponsorship: null }] }).success).toBe(false);
    expect(ProfilePatchSchema.safeParse({ workAuth: [{ country: 'TW', authorized: true, sponsorship: null, permit: 'visa' }] }).success).toBe(false);
  });

  it('sensitive answers are a closed set of fields', () => {
    expect(SensitiveAnswersSchema.safeParse({ eeo: { gender: 'decline' } }).success).toBe(true);
    expect(SensitiveAnswersSchema.safeParse({ cn: { nativePlace: '湖南长沙', familyMembers: [{ relation: '父亲', name: '王某' }] } }).success).toBe(true);
    expect(SensitiveAnswersSchema.safeParse({ eeo: { birthDate: '1990-01-01' } }).success).toBe(false);
  });
});

// ── snapshot (H32) ───────────────────────────────────────────────────────

describe('buildSnapshotText — the only profile text a prompt may contain', () => {
  const planted = {
    ...full(),
    cnFields: {
      identity: 'yingjie',
      graduationClass: 2026,
      major: 'CS',
      schoolTags: ['985', '211'],
      nativePlace: 'SECRET-NATIVE',
      politicalStatus: 'SECRET-POLITICAL',
      gender: 'SECRET-GENDER',
      birthDate: '1999-09-09',
      familyMembers: [{ name: 'SECRET-FAMILY' }],
      photoAssetId: 'SECRET-PHOTO',
      eeo: { raceEthnicity: 'SECRET-RACE' },
    },
    addressLine1: 'SECRET-STREET 1',
    postalCode: '78701',
    middleName: 'Q',
  } satisfies ProfileCore;

  it.each(['intl', 'cn'] as const)('%s: carries the useful profile and none of the excluded fields', (market) => {
    const text = buildSnapshotText(planted, market);
    expect(text).toContain('Data analyst');
    expect(text).toContain('SQL');
    expect(text).toContain('Analyst, Acme');
    expect(text).toContain('UT Austin');
    for (const banned of [
      'SECRET-NATIVE',
      'SECRET-POLITICAL',
      'SECRET-GENDER',
      '1999-09-09',
      'SECRET-FAMILY',
      'SECRET-PHOTO',
      'SECRET-RACE',
      'SECRET-STREET',
      '78701',
      'Ada',
      'Lovelace',
      'ada@example.test',
      '+14155550100',
      'linkedin.com',
      '985',
      'schoolTags',
    ]) {
      expect(text, banned).not.toContain(banned);
    }
    for (const key of NEVER_IN_PROMPT) expect(text).not.toContain(`${key}:`);
  });

  it('GoApply reads only the allowlisted background keys; RoboApply never shows them', () => {
    expect(buildSnapshotText(planted, 'cn')).toContain('identity: yingjie; graduationClass: 2026; major: CS');
    expect(buildSnapshotText(planted, 'intl')).not.toContain('identity:');
    for (const k of CN_SNAPSHOT_KEYS) expect(NEVER_IN_PROMPT as readonly string[]).not.toContain(k);
  });

  it('work authorization is the person’s own answers (RoboApply); Taiwan permit and preferences included', () => {
    const text = buildSnapshotText(
      full({
        workAuth: [
          { country: 'US', authorized: null, sponsorship: null },
          { country: 'TW', authorized: false, sponsorship: 'now', permit: 'gold_card' },
        ],
        twFields: { desiredTitles: ['PM'], desiredPay: { kind: 'negotiable' } },
      }),
      'intl',
    );
    expect(text).toContain('- US: allowed to work: not answered; sponsorship: not answered');
    expect(text).toContain('- TW: allowed to work: no; needs sponsorship now; holds an Employment Gold Card');
    expect(text).toContain('Taiwan job preferences: titles: PM; expected pay: negotiable (面議)');
    expect(buildSnapshotText(full({ workAuth: [{ country: 'US', authorized: true, sponsorship: 'no' }] }), 'cn')).not.toContain('Work authorization');
  });

  it('cache key changes with the profile and the primary resume', () => {
    const a = snapshotCacheKey('2026-10-10T00:00:00.000Z', 'h1');
    expect(a).toHaveLength(32);
    expect(snapshotCacheKey('2026-10-10T00:00:00.000Z', 'h2')).not.toBe(a);
    expect(snapshotCacheKey('2026-10-11T00:00:00.000Z', 'h1')).not.toBe(a);
    expect(snapshotCacheKey(null, null)).toBe(snapshotCacheKey(null, null));
  });
});

// ── resume sync ─────────────────────────────────────────────────────────

describe('resume → profile proposals', () => {
  it.each([
    ['2020-03', '2020-03'],
    ['2020/3', '2020-03'],
    ['2020.03', '2020-03'],
    ['2020年3月', '2020-03'],
    ['03/2020', '2020-03'],
    ['Mar 2020', '2020-03'],
    ['September 2021', '2021-09'],
    ['Sept 2021', '2021-09'],
    ['2019', '2019'],
    ['someday', null],
    ['2020-13', null],
  ])('date %s → %s', (raw, ym) => {
    expect(parseResumeDate(raw).ym).toBe(ym);
  });

  it('reads "present" as a current role', () => {
    expect(parseResumeDate('Present')).toEqual({ ym: null, present: true });
    expect(parseResumeDate('至今')).toEqual({ ym: null, present: true });
  });

  it.each([
    ['Jane Doe', { first: 'Jane', middle: null, last: 'Doe' }],
    ['Jane Q. Public Doe', { first: 'Jane', middle: 'Q. Public', last: 'Doe' }],
    ['王小明', { first: '小明', middle: null, last: '王' }],
    ['欧阳娜娜', { first: '娜娜', middle: null, last: '欧阳' }],
    ['Cher', { first: 'Cher', middle: null, last: null }],
  ])('name %s', (raw, out) => {
    expect(splitName(raw)).toEqual(out);
  });

  it('writes phones in international form only when the country is clear', () => {
    expect(toE164('+1 (415) 555-0100', { market: 'intl', country: null })).toBe('+14155550100');
    expect(toE164('0044 20 7946 0000', { market: 'intl', country: null })).toBe('+442079460000');
    expect(toE164('138 1234 5678', { market: 'cn', country: null })).toBe('+8613812345678');
    expect(toE164('0912-345-678', { market: 'intl', country: 'TW' })).toBe('+886912345678');
    expect(toE164('415-555-0100', { market: 'intl', country: 'US' })).toBe('+14155550100');
    expect(toE164('415-555-0100', { market: 'intl', country: null })).toBeNull();
    expect(toE164('call me', { market: 'intl', country: 'US' })).toBeNull();
  });

  const parsed = {
    name: 'Ada Lovelace',
    email: 'ada@new.example',
    phone: '+1 415 555 0199',
    linkedin: 'linkedin.com/in/ada-l',
    github: 'github.com/ada',
    summary: 'Analytics lead.',
    skills: { technical: ['SQL', 'Python'], tools: ['Tableau', 'python'] },
    languages: [
      { language: 'French', proficiency: 'Professional working' },
      { language: 'Klingon' }, // no stated level → not proposed
    ],
    education: [
      { institution: 'UT Austin', degree: 'BS', field: 'Statistics', year: '2018' },
      { institution: 'Rice University', degree: 'MS', field: 'Data Science', startDate: '2018-08', endDate: '2020-05' },
    ],
    experience: [
      { company: 'Acme', role: 'Analyst', duration: '2018 - Present' },
      { company: 'Initech', role: 'Intern', duration: 'Jun 2017 – Aug 2017', employmentType: 'internship', achievements: ['Built a model'] },
    ],
  };

  it('proposes field-by-field changes, new rows, and never a removal', () => {
    const profile = full({ links: {}, skills: [{ name: 'sql', confirmed: true }] });
    const proposal = proposeFromResume(parsed, { market: 'intl', country: 'US' })!;
    const diff = diffProfile(profile, proposal, 'intl');
    const byPath = Object.fromEntries(diff.map((d) => [d.path, d]));

    expect(byPath.firstName).toBeUndefined(); // same name
    expect(byPath.contactEmail).toMatchObject({ kind: 'change', current: 'ada@example.test', proposed: 'ada@new.example' });
    expect(byPath.phoneE164).toMatchObject({ kind: 'change', proposed: '+14155550199' });
    expect(byPath['links.linkedin']).toMatchObject({ kind: 'add', proposed: 'https://linkedin.com/in/ada-l' });
    expect(byPath['links.github']).toMatchObject({ kind: 'add', proposed: 'https://github.com/ada' });
    expect(byPath.skills).toMatchObject({ kind: 'add', proposed: ['Python', 'Tableau'] });
    expect(byPath.languages).toMatchObject({ kind: 'add', proposed: [{ language: 'French', level: 'professional' }] });

    const rows = diff.filter((d) => d.path.startsWith('education[') || d.path.startsWith('experience['));
    expect(rows).toHaveLength(2); // UT Austin and Acme/Analyst already exist
    expect(rows.map((r) => (r.proposed as { school?: string; company?: string }).school ?? (r.proposed as { company: string }).company)).toEqual(['Rice University', 'Initech']);
    const intern = rows.find((r) => r.path.startsWith('experience['))!.proposed as { kind: string; startDate: string; endDate: string; bullets: string[] };
    expect(intern).toMatchObject({ kind: 'internship', startDate: '2017-06', endDate: '2017-08', bullets: ['Built a model'] });
    expect(diff.every((d) => d.kind !== 'remove')).toBe(true);
  });

  it('GoApply never proposes a LinkedIn link', () => {
    const proposal = proposeFromResume(parsed, { market: 'cn', country: null })!;
    expect(diffProfile(emptyCore(U), proposal, 'cn').some((d) => d.path === 'links.linkedin')).toBe(false);
  });

  it('row keys stay stable when other parts of the profile change', () => {
    const p1 = proposeFromResume(parsed, { market: 'intl', country: 'US' })!;
    const d1 = diffProfile(full(), p1, 'intl').filter((d) => d.path.includes('['));
    const d2 = diffProfile(full({ headline: 'Changed', skills: [] }), p1, 'intl').filter((d) => d.path.includes('['));
    expect(d2.map((d) => d.path)).toEqual(d1.map((d) => d.path));
  });

  it('applies only accepted paths and rejects a path that is no longer offered', () => {
    const profile = full({ links: {} });
    const diff = diffProfile(profile, proposeFromResume(parsed, { market: 'intl', country: 'US' })!, 'intl');
    const eduPath = diff.find((d) => d.path.startsWith('education['))!.path;
    const plan = planAccepted(profile, diff, ['skills', 'links.github', eduPath]);
    expect(plan.fields).toEqual({});
    expect(plan.links).toEqual({ github: 'https://github.com/ada' });
    expect(plan.skills!.map((s) => s.name)).toEqual(['SQL', 'Python', 'Tableau']);
    expect(plan.skills!.every((s) => s.confirmed)).toBe(true);
    expect(plan.education).toHaveLength(1);
    expect(plan.experience).toHaveLength(0);
    expect(() => planAccepted(profile, diff, ['education[deadbeef]'])).toThrow(StaleDiffError);
  });

  it('spoken languages listed with the skills are not proposed as skills', () => {
    const proposal = proposeFromResume({ skills: { technical: ['SQL'], soft: ['Mentoring'], languages: ['English', 'Mandarin'] } }, { market: 'intl', country: 'US' })!;
    expect(proposal.skills).toEqual(['SQL', 'Mentoring']);
    const diff = diffProfile(emptyCore(U), proposal, 'intl');
    expect(diff.find((d) => d.path === 'skills')?.proposed).toEqual(['SQL', 'Mentoring']);
  });

  it('returns null for a resume that was never read into structured data', () => {
    expect(proposeFromResume(null, { market: 'intl', country: null })).toBeNull();
    expect(proposeFromResume('text', { market: 'intl', country: null })).toBeNull();
  });
});

// ── cipher ───────────────────────────────────────────────────────────────

describe('sensitive answers cipher', () => {
  const env = { SENSITIVE_DATA_KEY: 'a'.repeat(64) };

  it('round-trips per user and refuses another user’s row', () => {
    const sealed = sealSensitive(U, { eeo: { gender: 'decline' } }, env);
    expect(sealed.keyVersion).toBe(1);
    expect(sealed.ciphertext).not.toContain('decline');
    expect(openSensitive(U, sealed, env)).toEqual({ eeo: { gender: 'decline' } });
    expect(() => openSensitive('user_2', sealed, env)).toThrow();
  });

  it('reads the previous key during a rotation', () => {
    const old = sealSensitive(U, { cn: { nativePlace: 'x' } }, { SENSITIVE_DATA_KEY: 'old passphrase' });
    const rotated = { SENSITIVE_DATA_KEY: 'new passphrase', SENSITIVE_DATA_KEY_VERSION: '2', SENSITIVE_DATA_KEY_PREVIOUS: 'old passphrase' };
    expect(openSensitive(U, old, rotated)).toEqual({ cn: { nativePlace: 'x' } });
    expect(sealSensitive(U, {}, rotated).keyVersion).toBe(2);
  });

  it('has no fallback key', () => {
    expect(sensitiveCryptoConfigured({})).toBe(false);
    expect(sensitiveCryptoConfigured({ FIELD_ENCRYPTION_KEY: 'x' })).toBe(false);
    expect(() => sealSensitive(U, {}, { FIELD_ENCRYPTION_KEY: 'x' })).toThrow(/SENSITIVE_DATA_KEY/);
  });
});
