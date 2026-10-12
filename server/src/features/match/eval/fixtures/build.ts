// server/src/features/match/eval/fixtures/build.ts
//
// Deterministic generator of the evaluation fixtures (MKT-1D; strategy 2.6).
//
//   npx tsx server/src/features/match/eval/fixtures/build.ts          write the six files
//   npx tsx server/src/features/match/eval/fixtures/build.ts --check  exit 1 when a file on disk differs
//
// Input: the hand-written tables in fixtures/seed/ (role groups, skill sets in
// four languages, sentence banks, invented employer names, hard negatives).
// Every role has its own skill list and its own work sentences: a posting
// requires the first skills of ITS role and describes that role's work, so the
// two roles of a group are never the same posting under two titles.
// Output, per market: personas.<market>.json (40 personas with a resume each),
// postings.<market>.json (at least 240 postings) and
// labels.constructed.<market>.json (one grade 0-3 per pooled persona-posting
// pair). The same seed gives byte-identical files.
//
// Everything is SYNTHETIC (D3): no posting text, employer, resume or contact
// field comes from a job board, a provider response or a database row. The
// generator reads nothing but seed/ and imports none of the code under test,
// so a change in matching can never change a label. After a change here, write
// the ranking baseline again (README "The ranking baseline"): a baseline is for
// one set of fixtures.
//
// How a label is constructed (`constructedGrade`): from how the posting was
// written relative to the persona, never from a score.
//   same role 3 · same role group 2 · same category 1 · otherwise 0
//   career changer: the target role 2 (1 when the resume shows under a third
//     of its required skills) · the target's group 1 · the role being left 1.
//     These grades follow what the person says they want, which the fit must
//     not read (invariant 2), so career changers are reported on their own
//     rows and are outside every gated value (gates.ts CAREER_CHANGER_SUBSET).
//   a posting marked otherDiscipline is 0 outside its own role group
//   level two steps away −1, three or more −2 (not applied to a career changer)
//   internship: at most 1 for mid level and above, at most 2 for entry level
//   a posting with no skills and no stated level: at most 2
//   under a third of the required skills shown (same role or group): −1
//   needs sponsorship and the posting says none: at most 1
//   a stated 届别 the persona is not in: at most 1
//   a master's degree required and not held: −1

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashFiles } from './load.js';
import {
  FIXTURE_FILES,
  FIXTURE_LEVELS,
  type FixtureLang,
  type FixtureLevel,
  type FixtureMarket,
  type FixtureSubset,
  type Persona,
  type PersonaKind,
  type Posting,
} from './schema.js';

export const FIXTURE_SEED = 20261011;
export const GENERATED_BY = 'server/src/features/match/eval/fixtures/build.ts';
export const LABEL_RULE =
  'Constructed by the generator from how each posting was written: same role 3, same role group 2, same category 1, else 0; then level distance, internship, thin posting, required skills shown, sponsorship, class year and degree adjust it (see the header of fixtures/build.ts). Not a judge label and not a human label.';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SEED_DIR = path.join(HERE, 'seed');

// ── Seed tables ───────────────────────────────────────────────────────────

type ByLang<T> = Partial<Record<FixtureLang, T>>;

interface SeedRole {
  roleId: string;
  title: ByLang<string>;
  /** Eight positions of the group's skill vocabulary, the most characteristic of the role first. */
  skills: number[];
  /** The two things a person in this role is responsible for. */
  work: ByLang<[string, string]>;
}
interface SeedGroup {
  groupId: string;
  categoryId: string;
  country: string;
  industry: string;
  field: ByLang<string>;
  /** The group's skill vocabulary: position i names the same skill in every language. */
  skills: ByLang<string[]>;
  roles: [SeedRole, SeedRole];
}
interface SeedCountry {
  name: string;
  city: string;
  cityText: string;
  currency: string;
  payFactor: number;
}
interface SeedGeo {
  referenceDate: string;
  countries: Record<string, SeedCountry>;
  cn: { name: string; currency: string; cities: string[] };
  annualPayUsd: Record<FixtureLevel, number>;
  cnMonthlyPayCny: Record<FixtureLevel, number>;
}
interface ResumeText {
  heading: string;
  sections: { summary: string; experience: string; education: string; skills: string };
  present: string;
  summary: Record<PersonaKind, string>;
  jobLine: string;
  bullets: [string, string, string];
  changerBullet: string;
  internBullet: string;
  educationLine: string;
}
interface PostingText {
  intro: string;
  duties: string;
  thin: string;
  required: string;
  preferred: string;
  soft: string;
  years: string;
  internship: string;
  campus: string;
  sponsorOffered: string;
  sponsorNot: string;
  pay: string;
  master: string;
  remote: string;
}
interface SeedText {
  levels: Record<FixtureLang, Record<FixtureLevel, string>>;
  listJoin: Record<FixtureLang, string>;
  softSkills: Record<FixtureLang, [string, string]>;
  degrees: Record<FixtureLang, { bachelor: string; master: string }>;
  resume: Record<FixtureLang, ResumeText>;
  posting: Record<FixtureLang, PostingText>;
}
interface SeedSpecial {
  key: string;
  lang: FixtureLang;
  roleId: string;
  groupId: string;
  categoryId: string;
  title: string;
  level: FixtureLevel;
  country?: string;
  otherDiscipline: boolean;
  skills?: string[];
  work?: [string, string];
  skillsFromGroup?: string;
  pay?: { min: number; max: number; currency: string; period: 'hour' | 'year' | 'month'; text: string };
}

function seed<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(SEED_DIR, name), 'utf8')) as T;
}

interface Tables {
  groups: SeedGroup[];
  geo: SeedGeo;
  text: SeedText;
  companies: Record<FixtureLang, string[]>;
  specials: Record<FixtureMarket, SeedSpecial[]>;
}

function loadTables(): Tables {
  return {
    groups: seed<{ groups: SeedGroup[] }>('groups.json').groups,
    geo: seed<SeedGeo>('geo.json'),
    text: seed<SeedText>('text.json'),
    companies: seed<Record<FixtureLang, string[]>>('companies.json'),
    specials: seed<Record<FixtureMarket, SeedSpecial[]>>('specials.json'),
  };
}

// ── Small deterministic helpers ───────────────────────────────────────────

function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: a small seeded generator (never Math.random, never the clock). */
function rng(seedValue: number): () => number {
  let a = seedValue >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: readonly T[], seedValue: number): T[] {
  const out = [...items];
  const next = rng(seedValue);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => (k in values ? String(values[k]) : `{${k}}`));
}

/**
 * "a" or "an" before an English title, by how its first word is said: an
 * initialism is read letter by letter ("an HR Generalist", "an SEO Specialist",
 * "a UX Designer"), a word by its first sound ("an iOS Engineer", "a User
 * Operations Specialist").
 */
export function indefiniteArticle(phrase: string): 'a' | 'an' {
  const word = phrase.trim().split(/[\s-]/)[0] ?? '';
  if (/^[A-Z]{2,}$/.test(word)) return 'AEFHILMNORSX'.includes(word[0]!) ? 'an' : 'a';
  const lower = word.toLowerCase();
  if (/^(uni|use|usa|usu|uti|eu|one|once)/.test(lower)) return 'a';
  return /^[aeiou]/.test(lower) ? 'an' : 'a';
}

function thousands(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

const levelIndex = (l: FixtureLevel): number => FIXTURE_LEVELS.indexOf(l);

function must<T>(v: T | undefined | null, what: string): T {
  if (v === undefined || v === null) throw new Error(`fixtures/build.ts: missing ${what}`);
  return v;
}

// ── Roles ─────────────────────────────────────────────────────────────────

interface Role {
  roleId: string;
  /** 0 or 1 inside its group. */
  slotInGroup: 0 | 1;
  /** Position in the flat list of the 30 roles. */
  index: number;
  groupIndex: number;
  group: SeedGroup;
  title: ByLang<string>;
  /** The 8 positions of the group's skill vocabulary this role uses, its own first (seed `skills`). */
  skillIdx: number[];
  work: ByLang<[string, string]>;
  /** A skill of the other role of the group that this role does not list (what a person picks up beside a sibling team). */
  siblingOnlyIdx: number;
}

/** How many skills a role lists. Posting slots and persona levels pick positions 0 to 7 of that list. */
const ROLE_SKILLS = 8;

function rolesOf(groups: SeedGroup[]): Role[] {
  const out: Role[] = [];
  groups.forEach((group, groupIndex) => {
    const size = must(group.skills.en, `English skills of ${group.groupId}`).length;
    for (const [lang, list] of Object.entries(group.skills)) {
      if (list.length !== size || new Set(list).size !== size) throw new Error(`fixtures/build.ts: skills of ${group.groupId} in ${lang} are not ${size} distinct names`);
    }
    group.roles.forEach((r, i) => {
      const slotInGroup = i as 0 | 1;
      const sibling = group.roles[slotInGroup === 0 ? 1 : 0];
      if (r.skills.length !== ROLE_SKILLS || new Set(r.skills).size !== ROLE_SKILLS || r.skills.some((k) => !Number.isInteger(k) || k < 0 || k >= size)) {
        throw new Error(`fixtures/build.ts: role ${r.roleId} needs ${ROLE_SKILLS} distinct positions of its group's ${size} skills`);
      }
      for (const lang of Object.keys(group.skills) as FixtureLang[]) must(r.work[lang], `work phrases of ${r.roleId} in ${lang}`);
      out.push({
        roleId: r.roleId,
        slotInGroup,
        index: groupIndex * 2 + i,
        groupIndex,
        group,
        title: r.title,
        skillIdx: [...r.skills],
        work: r.work,
        siblingOnlyIdx: must(sibling.skills.find((k) => !r.skills.includes(k)), `a skill of ${sibling.roleId} that ${r.roleId} does not list`),
      });
    });
    const [a, b] = group.roles;
    // The two roles of a group are different work: a posting of one must not read as a posting of the other.
    if (a.skills.slice(0, 2).some((k) => b.skills.slice(0, 2).includes(k))) {
      throw new Error(`fixtures/build.ts: the roles of ${group.groupId} lead with the same skills`);
    }
    for (const lang of Object.keys(group.skills) as FixtureLang[]) {
      if (a.work[lang]!.some((w) => b.work[lang]!.includes(w))) throw new Error(`fixtures/build.ts: the roles of ${group.groupId} share a work phrase in ${lang}`);
    }
  });
  return out;
}

const skillKey = (group: SeedGroup, groupIdx: number): string => `${group.groupId}:${groupIdx}`;

function skillName(group: SeedGroup, lang: FixtureLang, groupIdx: number): string {
  return must(must(group.skills[lang], `skills of ${group.groupId} in ${lang}`)[groupIdx], `skill ${groupIdx} of ${group.groupId} in ${lang}`);
}

function levelTitle(t: SeedText, lang: FixtureLang, level: FixtureLevel, base: string): string {
  return fill(t.levels[lang][level], { t: base });
}

// ── Postings ──────────────────────────────────────────────────────────────

interface Slot {
  n: number;
  level: FixtureLevel | null;
  /** Positions inside the role's 8 skills. */
  required: number[];
  preferred: number[];
  minYears: number | null;
  pay: boolean;
  internship?: boolean;
  thin?: boolean;
  countryOnly?: boolean;
  remote?: boolean;
}

const SLOTS: Slot[] = [
  { n: 0, level: 'mid', required: [0, 1, 2, 3], preferred: [4, 5], minYears: 3, pay: true },
  { n: 1, level: 'senior', required: [0, 1, 2, 4], preferred: [3, 6], minYears: 6, pay: true },
  { n: 2, level: 'entry', required: [0, 1, 3], preferred: [2, 5], minYears: 1, pay: false },
  { n: 3, level: 'lead_staff', required: [0, 2, 4, 6], preferred: [7], minYears: 10, pay: true },
  { n: 4, level: 'intern_newgrad', required: [0, 1], preferred: [], minYears: null, pay: false, internship: true },
  { n: 5, level: null, required: [], preferred: [], minYears: null, pay: false, thin: true },
  { n: 6, level: 'mid', required: [1, 2, 5], preferred: [0, 7], minYears: 2, pay: true, countryOnly: true },
  { n: 7, level: 'senior', required: [0, 3, 5, 7], preferred: [1, 2], minYears: 5, pay: true, remote: true },
];

/** Which slots each language of each market gets. */
const SLOTS_BY_LANG: Record<FixtureMarket, ByLang<number[]>> = {
  intl: { en: [0, 1, 2, 3, 4, 5, 6], 'zh-TW': [0, 1, 2, 3, 4, 5], ja: [0, 1, 2, 3, 4, 5] },
  cn: { 'zh-CN': [0, 1, 2, 3, 4, 5, 6, 7] },
};

/** The class year a GoApply campus posting states. */
const CAMPUS_CLASS_YEAR = 2027;

function payFor(tables: Tables, market: FixtureMarket, lang: FixtureLang, country: string, level: FixtureLevel): NonNullable<Posting['pay']> {
  const p = tables.text.posting[lang];
  if (market === 'cn') {
    const base = tables.geo.cnMonthlyPayCny[level];
    const min = Math.floor((base * 0.9) / 1000) * 1000;
    const max = Math.ceil((base * 1.1) / 1000) * 1000;
    return { min, max, currency: tables.geo.cn.currency, period: 'month', months: 12, text: fill(p.pay, { min, max, cur: tables.geo.cn.currency }), plausible: true };
  }
  const c = must(tables.geo.countries[country], `country ${country}`);
  const base = tables.geo.annualPayUsd[level] * c.payFactor;
  const min = Math.round((base * 0.9) / 1000) * 1000;
  const max = Math.round((base * 1.1) / 1000) * 1000;
  return { min, max, currency: c.currency, period: 'year', months: null, text: fill(p.pay, { min: thousands(min), max: thousands(max), cur: c.currency }), plausible: true };
}

function placeFor(tables: Tables, market: FixtureMarket, lang: FixtureLang, group: SeedGroup, groupIndex: number): { country: string; countryName: string; city: string; cityText: string } {
  if (market === 'cn') {
    const city = tables.geo.cn.cities[groupIndex % tables.geo.cn.cities.length]!;
    return { country: 'CN', countryName: tables.geo.cn.name, city, cityText: city };
  }
  const country = lang === 'zh-TW' ? 'TW' : lang === 'ja' ? 'JP' : group.country;
  const c = must(tables.geo.countries[country], `country ${country}`);
  return { country, countryName: c.name, city: c.city, cityText: c.cityText };
}

function slotPosting(tables: Tables, market: FixtureMarket, lang: FixtureLang, role: Role, slot: Slot): Posting {
  const t = tables.text.posting[lang];
  const join = tables.text.listJoin[lang];
  const group = role.group;
  const place = placeFor(tables, market, lang, group, role.groupIndex);
  const baseTitle = must(role.title[lang], `title of ${role.roleId} in ${lang}`);
  const title = slot.level && !slot.thin ? levelTitle(tables.text, lang, slot.level, baseTitle) : baseTitle;
  const companies = must(tables.companies[lang], `companies in ${lang}`);
  const companyName = companies[(role.index * 3 + slot.n * 5) % companies.length]!;
  const work = must(role.work[lang], `work phrases of ${role.roleId} in ${lang}`);
  const hard = (positions: number[], required: boolean): Posting['skills'] =>
    positions.map((pos) => {
      const gi = role.skillIdx[pos]!;
      return { name: skillName(group, lang, gi), key: skillKey(group, gi), kind: 'hard' as const, required };
    });
  const skills: Posting['skills'] = slot.thin
    ? []
    : [...hard(slot.required, true), ...hard(slot.preferred, false), { name: tables.text.softSkills[lang][(role.index + slot.n) % 2]!, key: null, kind: 'soft' as const, required: false }];

  const sponsorship: Posting['sponsorship'] =
    market === 'intl' && slot.n === 1 && role.index % 3 === 0 ? 'not_offered' : market === 'intl' && slot.n === 2 && role.index % 4 === 0 ? 'offered' : null;
  const sponsorshipQuote = sponsorship === 'offered' ? t.sponsorOffered : sponsorship === 'not_offered' ? t.sponsorNot : null;
  const campus = market === 'cn' && slot.internship === true;
  const classYearQuote = campus ? fill(t.campus, { year: CAMPUS_CLASS_YEAR }) : null;
  const educationLevel: Posting['educationLevel'] = market === 'cn' && slot.n === 7 && role.index % 5 === 0 ? 'master' : null;

  const description = [
    fill(t.intro, { company: companyName, title, article: indefiniteArticle(title) }),
    slot.thin ? t.thin : fill(t.duties, { work0: work[0], work1: work[1] }),
    slot.internship ? t.internship : '',
    slot.remote ? fill(t.remote, { country: place.countryName }) : '',
  ]
    .filter(Boolean)
    .join(' ');
  const qualifications = slot.thin
    ? null
    : [
        fill(t.required, { list: hard(slot.required, true).map((s) => s.name).join(join) }),
        slot.preferred.length ? fill(t.preferred, { list: hard(slot.preferred, false).map((s) => s.name).join(join) }) : '',
        t.soft,
        slot.minYears !== null ? fill(t.years, { n: slot.minYears }) : '',
        educationLevel === 'master' ? t.master : '',
        sponsorshipQuote ?? '',
        classYearQuote ?? '',
      ]
        .filter(Boolean)
        .join(' ');

  const tags: string[] = [];
  if (slot.internship) tags.push('internship');
  if (slot.thin) tags.push('no_skills_no_level');
  if (slot.countryOnly) tags.push('country_only');
  if (slot.remote) tags.push('remote');

  return {
    id: `${market}-${lang}-${role.roleId}-s${slot.n}`,
    market,
    lang,
    roleId: role.roleId,
    groupId: group.groupId,
    categoryId: group.categoryId,
    title,
    companyName,
    companyIndustries: (role.index + slot.n) % 3 === 0 ? [group.industry] : [],
    level: slot.level,
    employmentType: slot.internship ? 'internship' : 'full_time',
    skills,
    minYears: slot.minYears,
    educationLevel,
    location: slot.remote
      ? { text: place.countryName, city: null, country: place.country }
      : slot.countryOnly
        ? { text: place.countryName, city: null, country: place.country }
        : { text: place.cityText, city: place.city, country: place.country },
    workModel: slot.remote ? 'remote' : 'onsite',
    remoteScope: slot.remote ? place.country : null,
    pay: slot.pay && slot.level ? payFor(tables, market, lang, place.country, slot.level) : null,
    sponsorship,
    sponsorshipQuote,
    classYears: campus ? [CAMPUS_CLASS_YEAR] : [],
    classYearQuote,
    description,
    qualifications,
    postedDaysAgo: 1 + ((role.index * 7 + slot.n * 3) % 28),
    tags,
    otherDiscipline: false,
  };
}

function specialPosting(tables: Tables, market: FixtureMarket, sp: SeedSpecial, n: number, roles: Role[]): Posting {
  const lang = sp.lang;
  const t = tables.text.posting[lang];
  const join = tables.text.listJoin[lang];
  const fromGroup = sp.skillsFromGroup ? must(roles.find((r) => r.roleId === sp.roleId), `role ${sp.roleId} of special ${sp.key}`) : null;
  const companies = must(tables.companies[lang], `companies in ${lang}`);
  const companyName = companies[(n * 7 + 2) % companies.length]!;
  let country: string;
  let city: string;
  let cityText: string;
  if (market === 'cn') {
    city = tables.geo.cn.cities[n % tables.geo.cn.cities.length]!;
    cityText = city;
    country = 'CN';
  } else {
    country = must(sp.country, `country of special ${sp.key}`);
    const c = must(tables.geo.countries[country], `country ${country}`);
    city = c.city;
    cityText = c.cityText;
  }
  const skills: Posting['skills'] = fromGroup
    ? [0, 1, 2, 3].map((pos) => {
        const gi = fromGroup.skillIdx[pos]!;
        return { name: skillName(fromGroup.group, lang, gi), key: skillKey(fromGroup.group, gi), kind: 'hard' as const, required: true };
      })
    : must(sp.skills, `skills of special ${sp.key}`).map((name) => ({ name, key: null, kind: 'hard' as const, required: true }));
  const work = fromGroup ? must(fromGroup.work[lang], `work phrases for special ${sp.key}`) : must(sp.work, `work phrases of special ${sp.key}`);
  const tags = ['special'];
  if (sp.otherDiscipline) tags.push('other_discipline');
  if (/architect|designer|engineer|架构师|架構師|建筑师|建築師|设计师|工程师/i.test(sp.title) && sp.key !== 'implausible_pay') tags.push('head_noun');
  if (sp.pay) tags.push('implausible_pay');
  return {
    id: `${market}-${lang}-x-${sp.key}`,
    market,
    lang,
    roleId: sp.roleId,
    groupId: sp.groupId,
    categoryId: sp.categoryId,
    title: sp.title,
    companyName,
    companyIndustries: [],
    level: sp.level,
    employmentType: 'full_time',
    skills,
    minYears: null,
    educationLevel: null,
    location: { text: cityText, city, country },
    workModel: 'onsite',
    remoteScope: null,
    pay: sp.pay ? { min: sp.pay.min, max: sp.pay.max, currency: sp.pay.currency, period: sp.pay.period, months: null, text: sp.pay.text, plausible: false } : null,
    sponsorship: null,
    sponsorshipQuote: null,
    classYears: [],
    classYearQuote: null,
    description: [fill(t.intro, { company: companyName, title: sp.title, article: indefiniteArticle(sp.title) }), fill(t.duties, { work0: work[0], work1: work[1] })].join(' '),
    qualifications: fill(t.required, { list: skills.map((s) => s.name).join(join) }),
    postedDaysAgo: 2 + ((n * 5) % 20),
    tags,
    otherDiscipline: sp.otherDiscipline,
  };
}

function buildPostings(tables: Tables, market: FixtureMarket, roles: Role[]): Posting[] {
  const out: Posting[] = [];
  for (const [lang, slotNumbers] of Object.entries(SLOTS_BY_LANG[market]) as Array<[FixtureLang, number[]]>) {
    for (const role of roles) {
      // A language covers the role groups that have a title and skills in it.
      if (!role.title[lang] || !role.group.skills[lang] || !role.work[lang]) continue;
      for (const n of slotNumbers) out.push(slotPosting(tables, market, lang, role, SLOTS[n]!));
    }
  }
  tables.specials[market].forEach((sp, n) => out.push(specialPosting(tables, market, sp, n, roles)));
  const ids = new Set(out.map((p) => p.id));
  if (ids.size !== out.length) throw new Error(`fixtures/build.ts: duplicate posting id in ${market}`);
  return out;
}

// ── Personas ──────────────────────────────────────────────────────────────

interface PersonaPlan {
  subset: FixtureSubset;
  kind: PersonaKind;
  roleId: string;
  targetRoleId?: string;
  level: FixtureLevel;
  resumeLang: FixtureLang;
  poolLangs: FixtureLang[];
  /** Where the persona lives (default: the country of the pooled postings of its role). */
  country?: string;
  classYear?: number;
}

const CYCLE_A: FixtureLevel[] = ['mid', 'senior', 'entry'];
const CYCLE_B: FixtureLevel[] = ['senior', 'entry', 'mid'];
const CYCLE_TW: FixtureLevel[] = ['senior', 'mid', 'entry'];

function plansFor(market: FixtureMarket, groups: SeedGroup[]): PersonaPlan[] {
  const first = (g: number) => groups[g]!.roles[0].roleId;
  const second = (g: number) => groups[g]!.roles[1].roleId;
  const plans: PersonaPlan[] = [];
  if (market === 'intl') {
    const en = { subset: 'en' as const, resumeLang: 'en' as const, poolLangs: ['en' as const] };
    groups.forEach((_, g) => plans.push({ ...en, kind: 'standard', roleId: first(g), level: CYCLE_A[g % 3]! }));
    [0, 3, 6, 9, 12].forEach((g, i) => plans.push({ ...en, kind: 'standard', roleId: second(g), level: CYCLE_B[i % 3]! }));
    [1, 5, 11].forEach((g) => plans.push({ ...en, kind: 'new_graduate', roleId: first(g), level: 'intern_newgrad' }));
    plans.push({ ...en, kind: 'career_changer', roleId: 'school_teacher', targetRoleId: 'data_analyst', level: 'senior' });
    plans.push({ ...en, kind: 'career_changer', roleId: 'account_executive', targetRoleId: 'marketing_manager', level: 'mid' });
    plans.push({ ...en, kind: 'career_changer', roleId: 'graphic_designer', targetRoleId: 'ux_designer', level: 'mid' });
    const tw = { subset: 'zh-TW' as const, resumeLang: 'zh-TW' as const, poolLangs: ['zh-TW' as const], country: 'TW' };
    const twGroups = groups.map((grp, g) => ({ grp, g })).filter((x) => !!x.grp.skills['zh-TW']);
    twGroups.forEach((x, i) => plans.push({ ...tw, kind: 'standard', roleId: first(x.g), level: CYCLE_TW[i % 3]! }));
    plans.push({ ...tw, kind: 'new_graduate', roleId: 'data_analyst', level: 'intern_newgrad' });
    // Cross-language cases: the resume and the pooled postings are in different languages.
    plans.push({ subset: 'cross', kind: 'standard', roleId: 'data_analyst', level: 'mid', resumeLang: 'en', poolLangs: ['zh-TW'], country: 'TW' });
    plans.push({ subset: 'cross', kind: 'standard', roleId: 'marketing_manager', level: 'senior', resumeLang: 'en', poolLangs: ['zh-TW'], country: 'TW' });
    plans.push({ subset: 'cross', kind: 'standard', roleId: 'backend_engineer', level: 'mid', resumeLang: 'en', poolLangs: ['ja', 'zh-TW'], country: 'JP' });
    plans.push({ subset: 'cross', kind: 'standard', roleId: 'frontend_engineer', level: 'senior', resumeLang: 'zh-TW', poolLangs: ['en'] });
    plans.push({ subset: 'cross', kind: 'standard', roleId: 'fullstack_engineer', level: 'mid', resumeLang: 'ja', poolLangs: ['en'] });
    return plans;
  }
  const zh = { subset: 'zh-CN' as const, resumeLang: 'zh-CN' as const, poolLangs: ['zh-CN' as const] };
  groups.forEach((_, g) => plans.push({ ...zh, kind: 'standard', roleId: first(g), level: CYCLE_A[g % 3]! }));
  [0, 2, 4, 6, 8, 10, 12, 14].forEach((g, i) => plans.push({ ...zh, kind: 'standard', roleId: second(g), level: CYCLE_B[i % 3]! }));
  [1, 3, 5, 7, 9].forEach((g, i) => plans.push({ ...zh, kind: 'new_graduate', roleId: first(g), level: 'intern_newgrad', classYear: i < 3 ? CAMPUS_CLASS_YEAR : CAMPUS_CLASS_YEAR - 1 }));
  plans.push({ ...zh, kind: 'career_changer', roleId: 'school_teacher', targetRoleId: 'data_analyst', level: 'senior' });
  plans.push({ ...zh, kind: 'career_changer', roleId: 'account_executive', targetRoleId: 'user_operations', level: 'mid' });
  plans.push({ ...zh, kind: 'career_changer', roleId: 'graphic_designer', targetRoleId: 'ui_designer', level: 'mid' });
  plans.push({ ...zh, kind: 'career_changer', roleId: 'registered_nurse', targetRoleId: 'hr_generalist', level: 'senior' });
  [0, 4, 8].forEach((g) => plans.push({ ...zh, kind: 'standard', roleId: first(g), level: 'lead_staff' }));
  // English resume against Simplified Chinese postings.
  const cross = { subset: 'cross' as const, kind: 'standard' as const, resumeLang: 'en' as const, poolLangs: ['zh-CN' as const] };
  plans.push({ ...cross, roleId: 'backend_engineer', level: 'mid' });
  plans.push({ ...cross, roleId: 'data_analyst', level: 'senior' });
  plans.push({ ...cross, roleId: 'marketing_manager', level: 'mid' });
  plans.push({ ...cross, roleId: 'financial_analyst', level: 'entry' });
  plans.push({ ...cross, roleId: 'ux_designer', level: 'mid' });
  return plans;
}

const YEARS: Record<FixtureLevel, number> = { intern_newgrad: 0, entry: 2, mid: 4, senior: 8, lead_staff: 12, director_exec: 16 };

/** Which of the role's 8 skills a persona of this level shows (positions), by persona number. */
function shownPositions(level: FixtureLevel, n: number): number[] {
  if (level === 'intern_newgrad') return [0, 1, 2, 5];
  if (level === 'entry') return [0, 1, 2, 3, 5];
  return [0, 1, 2, 3, n % 2 === 0 ? 4 : 5, 6];
}

interface Job {
  level: FixtureLevel;
  start: string;
  end: string | null;
  kind: 'work' | 'internship';
}

/** Dated jobs for a level, newest first, relative to the fixed reference date 2026-10. */
function jobsFor(level: FixtureLevel): Job[] {
  switch (level) {
    case 'intern_newgrad':
      return [{ level: 'intern_newgrad', start: '2026-01', end: '2026-06', kind: 'internship' }];
    case 'entry':
      return [{ level: 'entry', start: '2024-10', end: null, kind: 'work' }];
    case 'mid':
      return [
        { level: 'mid', start: '2024-01', end: null, kind: 'work' },
        { level: 'entry', start: '2022-10', end: '2023-12', kind: 'work' },
      ];
    case 'senior':
      return [
        { level: 'senior', start: '2022-01', end: null, kind: 'work' },
        { level: 'mid', start: '2018-10', end: '2021-12', kind: 'work' },
      ];
    case 'lead_staff':
      return [
        { level: 'lead_staff', start: '2021-01', end: null, kind: 'work' },
        { level: 'senior', start: '2014-10', end: '2020-12', kind: 'work' },
      ];
    case 'director_exec':
      return [
        { level: 'director_exec', start: '2020-01', end: null, kind: 'work' },
        { level: 'lead_staff', start: '2010-10', end: '2019-12', kind: 'work' },
      ];
  }
}

function buildPersona(tables: Tables, market: FixtureMarket, plan: PersonaPlan, n: number, roles: Role[]): Persona {
  const role = must(roles.find((r) => r.roleId === plan.roleId), `role ${plan.roleId}`);
  const target = must(roles.find((r) => r.roleId === (plan.targetRoleId ?? plan.roleId)), `role ${plan.targetRoleId}`);
  const lang = plan.resumeLang;
  const rt = tables.text.resume[lang];
  const group = role.group;
  const code = `${market === 'intl' ? 'INTL' : 'CN'}-${String(n).padStart(2, '0')}`;
  const id = `${market}-p${String(n).padStart(2, '0')}`;
  const baseTitle = must(role.title[lang], `title of ${role.roleId} in ${lang}`);
  const targetTitle = must(target.title[lang], `title of ${target.roleId} in ${lang}`);

  // Skills: the role's own, one of the sibling role's, and for a career changer three of the target role's.
  const positions = shownPositions(plan.level, n);
  const own = positions.map((pos) => role.skillIdx[pos]!);
  const groupIdxs = plan.kind === 'new_graduate' ? own : [...own, role.siblingOnlyIdx];
  const skillPairs: Array<{ name: string; key: string }> = groupIdxs.map((gi) => ({ name: skillName(group, lang, gi), key: skillKey(group, gi) }));
  const targetPairs =
    plan.kind === 'career_changer' ? [0, 1, 2].map((pos) => target.skillIdx[pos]!).map((gi) => ({ name: skillName(target.group, lang, gi), key: skillKey(target.group, gi) })) : [];
  const seen = new Set<string>();
  const allPairs = [...skillPairs, ...targetPairs].filter((s) => (seen.has(s.key) ? false : (seen.add(s.key), true)));

  // Where the persona lives: the country of the postings pooled for it.
  const poolLang = plan.poolLangs[0]!;
  let country: string;
  let city: string;
  let currency: string;
  let payAmount: number;
  let payPeriod: 'year' | 'month';
  // A career changer accepts entry-level pay in the new field.
  const payLevel: FixtureLevel = plan.kind === 'career_changer' ? 'entry' : plan.level;
  if (market === 'cn') {
    country = 'CN';
    city = tables.geo.cn.cities[target.groupIndex % tables.geo.cn.cities.length]!;
    currency = tables.geo.cn.currency;
    payAmount = Math.max(500, Math.round((tables.geo.cnMonthlyPayCny[payLevel] * 0.85) / 500) * 500);
    payPeriod = 'month';
  } else {
    country = plan.country ?? (poolLang === 'zh-TW' ? 'TW' : poolLang === 'ja' ? 'JP' : target.group.country);
    const c = must(tables.geo.countries[country], `country ${country}`);
    city = c.city;
    currency = c.currency;
    payAmount = Math.round((tables.geo.annualPayUsd[payLevel] * c.payFactor * 0.85) / 1000) * 1000;
    payPeriod = 'year';
  }
  const location: Persona['location'] = n % 2 === 0 ? { label: country, country, radiusKm: 0 } : { label: city, city, country, radiusKm: 40 };

  // Experience and the resume.
  const companies = must(tables.companies[lang], `companies in ${lang}`);
  const jobs = jobsFor(plan.level);
  const experience: Persona['experience'] = jobs.map((j, i) => ({
    title: levelTitle(tables.text, lang, j.level, baseTitle),
    company: companies[(n * 2 + i) % companies.length]!,
    start: j.start,
    end: j.end,
    current: j.end === null,
    kind: j.kind,
  }));
  const work = must(role.work[lang], `work phrases of ${role.roleId} in ${lang}`);
  const s = (i: number) => skillPairs[i % skillPairs.length]!.name;
  const degree: Persona['degree'] = n % 4 === 0 ? 'master' : 'bachelor';
  const years = YEARS[plan.level];
  const classYear = market === 'cn' ? (plan.classYear ?? null) : undefined;
  const endYear = plan.kind === 'new_graduate' ? (plan.classYear ?? 2026) : 2026 - years;
  const field = group.field[lang] ?? must(group.field.en, `field of ${group.groupId}`);
  const degreeLabel = tables.text.degrees[lang][degree];

  const lines: string[] = [fill(rt.heading, { code }), `persona-${id}@example.test`, '', `## ${rt.sections.summary}`];
  lines.push(
    fill(rt.summary[plan.kind], { title: experience[0]!.title, years, roleTitle: baseTitle, targetTitle, roleArticle: indefiniteArticle(baseTitle), targetArticle: indefiniteArticle(targetTitle) }),
  );
  lines.push('', `## ${rt.sections.experience}`);
  experience.forEach((e, i) => {
    lines.push(fill(rt.jobLine, { title: e.title, company: e.company, start: e.start, end: e.end ?? rt.present }));
    if (e.kind === 'internship') lines.push(`- ${fill(rt.internBullet, { work0: work[0], s0: s(0) })}`);
    else if (i === 0) {
      lines.push(`- ${fill(rt.bullets[0], { work0: work[0], s0: s(0), s1: s(1) })}`);
      lines.push(`- ${fill(rt.bullets[1], { work1: work[1], s2: s(2) })}`);
      if (plan.kind === 'career_changer') lines.push(`- ${fill(rt.changerBullet, { t0: targetPairs[0]!.name, t1: targetPairs[1]!.name, t2: targetPairs[2]!.name })}`);
    } else lines.push(`- ${fill(rt.bullets[2], { work0: work[0], s3: s(3) })}`);
  });
  lines.push('', `## ${rt.sections.education}`, fill(rt.educationLine, { degree: degreeLabel, field, year: endYear }));
  lines.push('', `## ${rt.sections.skills}`, allPairs.map((x) => x.name).join(tables.text.listJoin[lang]));

  const persona: Persona = {
    id,
    market,
    locale: lang === 'zh-CN' ? 'zh' : lang,
    subset: plan.subset,
    kind: plan.kind,
    roleId: role.roleId,
    targetRoleId: target.roleId,
    level: plan.level,
    yearsExperience: years,
    skills: allPairs.map((x) => x.name),
    skillKeys: allPairs.map((x) => x.key),
    location,
    payFloor: { amount: payAmount, currency, period: payPeriod },
    ...(market === 'intl' ? { needsSponsorship: plan.subset === 'en' && n % 4 === 1 } : {}),
    ...(market === 'cn' ? { classYear: classYear ?? null } : {}),
    degree,
    resumeLang: lang,
    poolLangs: plan.poolLangs,
    resumeMarkdown: lines.join('\n'),
    recentTitles: experience.slice(0, 2).map((e) => e.title),
    experience,
    education: [{ degree, label: degreeLabel, field, endYear }],
    employerIndustries: n % 3 === 0 ? [group.industry] : [],
  };
  return persona;
}

function buildPersonas(tables: Tables, market: FixtureMarket, roles: Role[]): Persona[] {
  return plansFor(market, tables.groups).map((plan, i) => buildPersona(tables, market, plan, i + 1, roles));
}

// ── Constructed labels ────────────────────────────────────────────────────

export type ConstructedGrade = 0 | 1 | 2 | 3;

interface RoleParents {
  groupId: string;
  categoryId: string;
}

/** The grade the generator records for (persona, posting). See the header for the rule. */
export function constructedGrade(persona: Persona, posting: Posting, parents: (roleId: string) => RoleParents): ConstructedGrade {
  const own = parents(persona.roleId);
  const target = parents(persona.targetRoleId);
  const changer = persona.kind === 'career_changer';
  const sameRole = posting.roleId === persona.roleId;
  const sameGroup = posting.groupId === own.groupId;
  const sameCategory = posting.categoryId === own.categoryId;
  const hardRequired = posting.skills.filter((s) => s.kind === 'hard' && s.required);
  const keys = new Set(persona.skillKeys);
  const share = hardRequired.length ? hardRequired.filter((s) => s.key !== null && keys.has(s.key)).length / hardRequired.length : null;

  let g: number;
  if (changer) {
    if (posting.roleId === persona.targetRoleId) g = share === null || share >= 1 / 3 ? 2 : 1;
    else if (posting.groupId === target.groupId) g = 1;
    else if (sameRole) g = 1;
    else g = 0;
  } else {
    g = sameRole ? 3 : sameGroup ? 2 : sameCategory ? 1 : 0;
  }
  if (posting.otherDiscipline && !(sameGroup || posting.groupId === target.groupId)) g = 0;
  if (g <= 0) return 0;

  if (!changer && posting.level) {
    const d = Math.abs(levelIndex(persona.level) - levelIndex(posting.level));
    if (d === 2) g -= 1;
    else if (d >= 3) g -= 2;
  }
  if (posting.employmentType === 'internship') {
    if (levelIndex(persona.level) >= levelIndex('mid')) g = Math.min(g, 1);
    else if (persona.level === 'entry') g = Math.min(g, 2);
  }
  if (!posting.level && !posting.skills.some((s) => s.kind === 'hard')) g = Math.min(g, 2);
  if (!changer && (sameRole || sameGroup) && share !== null && share < 1 / 3) g -= 1;
  if (persona.needsSponsorship === true && posting.sponsorship === 'not_offered') g = Math.min(g, 1);
  if (typeof persona.classYear === 'number' && posting.classYears.length && !posting.classYears.includes(persona.classYear)) g = Math.min(g, 1);
  if (posting.educationLevel === 'master' && persona.degree !== 'master') g -= 1;
  return Math.max(0, Math.min(3, g)) as ConstructedGrade;
}

export const POOL_MIN = 30;
/** The pool is filled with unrelated postings up to this size. */
export const POOL_TARGET = 36;

/** Postings pooled for one persona: its role, the role group, the category, every hard negative, and unrelated postings. */
function poolFor(persona: Persona, postings: Posting[], parents: (roleId: string) => RoleParents): Posting[] {
  const own = parents(persona.roleId);
  const target = parents(persona.targetRoleId);
  const candidates = postings.filter((p) => persona.poolLangs.includes(p.lang));
  const isSpecial = (p: Posting) => p.tags.includes('special');
  const inRole = candidates.filter((p) => !isSpecial(p) && (p.roleId === persona.roleId || p.roleId === persona.targetRoleId));
  const inGroup = candidates.filter((p) => !isSpecial(p) && !inRole.includes(p) && (p.groupId === own.groupId || p.groupId === target.groupId));
  const inCategory = candidates
    .filter((p) => !isSpecial(p) && !inRole.includes(p) && !inGroup.includes(p) && (p.categoryId === own.categoryId || p.categoryId === target.categoryId))
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, 6);
  const specials = candidates.filter(isSpecial);
  // At least 14 unrelated postings, and enough of them to bring the pool to POOL_TARGET.
  const related = inRole.length + inGroup.length + inCategory.length + specials.length;
  const unrelated = shuffled(
    candidates.filter((p) => !isSpecial(p) && p.categoryId !== own.categoryId && p.categoryId !== target.categoryId).sort((a, b) => a.id.localeCompare(b.id)),
    FIXTURE_SEED ^ fnv1a(persona.id),
  ).slice(0, Math.max(14, POOL_TARGET - related));
  const seen = new Set<string>();
  return [...inRole, ...inGroup, ...inCategory, ...specials, ...unrelated].filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)));
}

export const POOL_MIN_GOOD = 5;
export const POOL_MIN_ZERO = 10;

function buildLabels(personas: Persona[], postings: Posting[], parents: (roleId: string) => RoleParents): Record<string, Record<string, ConstructedGrade>> {
  const out: Record<string, Record<string, ConstructedGrade>> = {};
  for (const persona of personas) {
    const row: Record<string, ConstructedGrade> = {};
    for (const p of poolFor(persona, postings, parents).sort((a, b) => a.id.localeCompare(b.id))) row[p.id] = constructedGrade(persona, p, parents);
    const grades = Object.values(row);
    const good = grades.filter((g) => g >= 2).length;
    const zero = grades.filter((g) => g === 0).length;
    if (grades.length < POOL_MIN || good < POOL_MIN_GOOD || zero < POOL_MIN_ZERO) {
      throw new Error(`fixtures/build.ts: pool of ${persona.id} is too thin (${grades.length} postings, ${good} graded 2 or 3, ${zero} graded 0)`);
    }
    out[persona.id] = row;
  }
  return out;
}

// ── Files ─────────────────────────────────────────────────────────────────

function listFile(header: Record<string, unknown>, key: string, items: unknown[]): string {
  const head = Object.entries(header).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`);
  return `{\n${head.join(',\n')},\n${JSON.stringify(key)}: [\n${items.map((i) => JSON.stringify(i)).join(',\n')}\n]\n}\n`;
}

function recordFile(header: Record<string, unknown>, key: string, record: Record<string, unknown>): string {
  const head = Object.entries(header).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`);
  const rows = Object.entries(record).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`);
  return `{\n${head.join(',\n')},\n${JSON.stringify(key)}: {\n${rows.join(',\n')}\n}\n}\n`;
}

/** Every generated file: name → exact contents. Pure given the seed tables. */
export function buildFixtures(): Record<string, string> {
  const tables = loadTables();
  const roles = rolesOf(tables.groups);
  const parentMap = new Map<string, RoleParents>();
  for (const r of roles) parentMap.set(r.roleId, { groupId: r.group.groupId, categoryId: r.group.categoryId });
  for (const market of ['intl', 'cn'] as const) for (const sp of tables.specials[market]) if (!parentMap.has(sp.roleId)) parentMap.set(sp.roleId, { groupId: sp.groupId, categoryId: sp.categoryId });
  const parents = (roleId: string) => must(parentMap.get(roleId), `parents of role ${roleId}`);

  const files: Record<string, string> = {};
  for (const market of ['intl', 'cn'] as const) {
    const header = { _synthetic: true, _generatedBy: GENERATED_BY, _seed: FIXTURE_SEED, market };
    const postings = buildPostings(tables, market, roles);
    const personas = buildPersonas(tables, market, roles);
    const labels = buildLabels(personas, postings, parents);
    files[FIXTURE_FILES.personas(market)] = listFile(header, 'personas', personas);
    files[FIXTURE_FILES.postings(market)] = listFile(header, 'postings', postings);
    files[FIXTURE_FILES.labels(market)] = recordFile({ ...header, _kind: 'constructed', _rule: LABEL_RULE }, 'labels', labels);
  }
  return files;
}

/** One hash over every generated file (determinism check). */
export function fixturesHash(files: Record<string, string> = buildFixtures()): string {
  return hashFiles(files);
}

function isMain(): boolean {
  const entry = process.argv[1];
  return !!entry && path.resolve(entry) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  const files = buildFixtures();
  const check = process.argv.includes('--check');
  let stale = 0;
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(HERE, name);
    if (check) {
      let onDisk = '';
      try {
        onDisk = readFileSync(file, 'utf8');
      } catch {
        // Missing: reported as stale below.
      }
      if (onDisk !== text) {
        stale += 1;
        console.error(`stale: ${name}`);
      }
    } else {
      writeFileSync(file, text);
      console.log(`wrote ${name} (${text.length} characters)`);
    }
  }
  console.log(`fixtures hash ${fixturesHash(files)}`);
  if (check && stale) process.exit(1);
}
