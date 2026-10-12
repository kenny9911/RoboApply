// @vitest-environment node
// MKT-1D — the committed evaluation fixtures: shape, counts, subsets, hard
// negatives, referential integrity of the labels and determinism of the
// generator. Everything is synthetic; nothing here reads a database or the network.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { payPlausible } from '../../jobs/normalize/index.js';
import { TAXONOMY_NODES, getTaxonomyNode, taxonomyAncestors, taxonomyChildren } from '../../jobs/taxonomy/index.js';
import { SENIORITY_LEVELS } from '../../search/index.js';
import { POOL_MIN, POOL_MIN_GOOD, POOL_MIN_ZERO, buildFixtures, constructedGrade, fixturesHash, indefiniteArticle } from './fixtures/build.js';
import { FIXTURES_DIR, fixtureFilesHash, loadBaselines, loadLabels, loadMarketFixtures, loadPersonas, loadPostings } from './fixtures/load.js';
import { BaselinesFileSchema, FIXTURE_FILES, FIXTURE_LEVELS, FIXTURE_MARKETS, LabelsFileSchema, PersonasFileSchema, PostingsFileSchema, type Persona, type Posting } from './fixtures/schema.js';
import { postingRecord, personaResume, personaUser } from './world.js';

const SEED_DIR = path.join(FIXTURES_DIR, 'seed');
const read = (name: string) => readFileSync(path.join(FIXTURES_DIR, name), 'utf8');
const seed = <T>(name: string) => JSON.parse(readFileSync(path.join(SEED_DIR, name), 'utf8')) as T;

const fx = Object.fromEntries(FIXTURE_MARKETS.map((m) => [m, loadMarketFixtures(m)!])) as Record<'intl' | 'cn', NonNullable<ReturnType<typeof loadMarketFixtures>>>;
const level = (l: string) => FIXTURE_LEVELS.indexOf(l as (typeof FIXTURE_LEVELS)[number]);

describe('fixture files', () => {
  it('every file parses against its schema and says it is synthetic', () => {
    for (const market of FIXTURE_MARKETS) {
      expect(PersonasFileSchema.safeParse(JSON.parse(read(FIXTURE_FILES.personas(market)))).success, `personas ${market}`).toBe(true);
      expect(PostingsFileSchema.safeParse(JSON.parse(read(FIXTURE_FILES.postings(market)))).success, `postings ${market}`).toBe(true);
      const labels = LabelsFileSchema.safeParse(JSON.parse(read(FIXTURE_FILES.labels(market))));
      expect(labels.success, `labels ${market}`).toBe(true);
      expect(labels.data?._kind).toBe('constructed');
    }
    // "_synthetic": true is the first key of every fixture and every seed file.
    const files = [...readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.json') && f !== FIXTURE_FILES.baselines).map((f) => path.join(FIXTURES_DIR, f)), ...readdirSync(SEED_DIR).map((f) => path.join(SEED_DIR, f))];
    expect(files.length).toBeGreaterThanOrEqual(11);
    for (const f of files) expect(readFileSync(f, 'utf8').replace(/\s+/g, '').startsWith('{"_synthetic":true'), path.basename(f)).toBe(true);
  });

  it('the labels file name and key say the labels are constructed, not judged or human', () => {
    for (const market of FIXTURE_MARKETS) {
      expect(FIXTURE_FILES.labels(market)).toBe(`labels.constructed.${market}.json`);
      expect(loadLabels(market)!._kind).toBe('constructed');
    }
  });

  it('the stored ranking baseline has the baseline shape and was measured on these fixtures', () => {
    const file = path.join(FIXTURES_DIR, FIXTURE_FILES.baselines);
    expect(existsSync(file), 'fixtures/baselines.json is committed with the fixtures').toBe(true);
    expect(BaselinesFileSchema.safeParse(JSON.parse(readFileSync(file, 'utf8'))).success).toBe(true);
    const baseline = loadBaselines()!;
    expect(baseline.source, 'a baseline says what it was measured on').toBeTruthy();
    // Regenerating the fixtures changes the labels: the baseline must be written again with them.
    expect(baseline.fixturesHash, 'baselines.json is for other fixtures: write it again (see eval/README.md, "The ranking baseline")').toBe(fixtureFilesHash());
    expect(fixtureFilesHash()).toBe(fixturesHash(buildFixtures()));
  });

  it('a missing file loads as null and a malformed one throws', () => {
    expect(loadPersonas('intl', path.join(FIXTURES_DIR, 'no-such-folder'))).toBeNull();
    expect(() => loadPostings('intl', SEED_DIR)).not.toThrow();
    expect(loadPostings('intl', SEED_DIR)).toBeNull();
  });

  it('levels are the six seniority levels of the search contract', () => {
    expect([...FIXTURE_LEVELS]).toEqual([...SENIORITY_LEVELS]);
  });
});

describe('personas', () => {
  it('40 per market with unique ids, each with a resume', () => {
    for (const market of FIXTURE_MARKETS) {
      const personas = fx[market].personas;
      expect(personas).toHaveLength(40);
      expect(new Set(personas.map((p) => p.id)).size).toBe(40);
      for (const p of personas) {
        expect(p.market).toBe(market);
        expect(p.resumeMarkdown).toContain(`persona-${p.id}@example.test`);
        expect(p.resumeMarkdown).toContain(p.recentTitles[0]);
        expect(p.skills.length).toBe(p.skillKeys.length);
      }
    }
  });

  it('cover the 15 largest role groups, three levels, career changers and new graduates', () => {
    const groups = TAXONOMY_NODES.filter((n) => n.level === 2).map((g, i) => ({ id: g.id, i, roles: taxonomyChildren(g.id).length }));
    const largest = [...groups].sort((a, b) => b.roles - a.roles || a.i - b.i).slice(0, 15).map((g) => g.id);
    const seeded = seed<{ groups: Array<{ groupId: string }> }>('groups.json').groups.map((g) => g.groupId);
    expect(new Set(seeded)).toEqual(new Set(largest));
    for (const market of FIXTURE_MARKETS) {
      const personas = fx[market].personas;
      const covered = new Set(personas.map((p) => getTaxonomyNode(p.roleId)!.parent));
      expect(covered, market).toEqual(new Set(largest));
      for (const l of ['entry', 'mid', 'senior']) expect(personas.filter((p) => p.level === l).length, `${market} ${l}`).toBeGreaterThanOrEqual(5);
      expect(personas.filter((p) => p.kind === 'career_changer').length, market).toBeGreaterThanOrEqual(3);
      expect(personas.filter((p) => p.kind === 'new_graduate').length, market).toBeGreaterThanOrEqual(3);
      for (const p of personas.filter((x) => x.kind === 'career_changer')) expect(p.targetRoleId).not.toBe(p.roleId);
      for (const p of personas.filter((x) => x.kind !== 'career_changer')) expect(p.targetRoleId).toBe(p.roleId);
    }
  });

  it('intl: at least 8 Traditional Chinese personas and 4 cross-language cases in both directions', () => {
    const personas = fx.intl.personas;
    expect(personas.filter((p) => p.subset === 'zh-TW' && p.resumeLang === 'zh-TW').length).toBeGreaterThanOrEqual(8);
    const cross = personas.filter((p) => p.subset === 'cross');
    expect(cross.length).toBeGreaterThanOrEqual(4);
    for (const p of cross) expect(p.poolLangs).not.toContain(p.resumeLang);
    // An English resume against Chinese and against Japanese postings, and the reverse.
    expect(cross.some((p) => p.resumeLang === 'en' && p.poolLangs.includes('zh-TW'))).toBe(true);
    expect(cross.some((p) => p.resumeLang === 'en' && p.poolLangs.includes('ja'))).toBe(true);
    expect(cross.some((p) => p.resumeLang !== 'en' && p.poolLangs.includes('en'))).toBe(true);
    expect(personas.filter((p) => p.subset === 'en').every((p) => p.resumeLang === 'en' && p.poolLangs.join() === 'en')).toBe(true);
    for (const p of personas) expect(typeof p.needsSponsorship).toBe('boolean');
    expect(personas.some((p) => p.needsSponsorship)).toBe(true);
  });

  it('cn: Simplified Chinese personas plus at least 4 English-resume cases, with class year and degree', () => {
    const personas = fx.cn.personas;
    const english = personas.filter((p) => p.resumeLang === 'en');
    expect(english.length).toBeGreaterThanOrEqual(4);
    expect(english.every((p) => p.subset === 'cross')).toBe(true);
    expect(personas.filter((p) => p.resumeLang === 'zh-CN').length).toBe(40 - english.length);
    expect(personas.every((p) => p.poolLangs.join() === 'zh-CN')).toBe(true);
    for (const p of personas) {
      expect(p.classYear === null || Number.isInteger(p.classYear)).toBe(true);
      expect(['bachelor', 'master']).toContain(p.degree);
      expect(p.needsSponsorship).toBeUndefined();
    }
    expect(personas.filter((p) => p.kind === 'new_graduate').every((p) => typeof p.classYear === 'number')).toBe(true);
  });

  it('turn into matcher inputs with no missing piece', () => {
    for (const market of FIXTURE_MARKETS) {
      for (const p of fx[market].personas) {
        const user = personaUser(p);
        expect(user.experience.length).toBeGreaterThan(0);
        expect(user.searchProfile?.filters).toMatchObject({ taxonomyIds: [p.targetRoleId] });
        expect(personaResume(p).resumeContentHash).toMatch(/^[0-9a-f]{40}$/);
      }
    }
  });
});

describe('postings', () => {
  it('at least 240 per market, unique ids, roles that exist in the taxonomy with the right parents', () => {
    for (const market of FIXTURE_MARKETS) {
      const postings = fx[market].postings;
      expect(postings.length).toBeGreaterThanOrEqual(240);
      expect(new Set(postings.map((p) => p.id)).size).toBe(postings.length);
      for (const p of postings) {
        expect(p.market).toBe(market);
        const chain = taxonomyAncestors(p.roleId).map((n) => n.id);
        expect(chain, p.id).toEqual([p.roleId, p.groupId, p.categoryId]);
      }
    }
  });

  it('employers are the invented names of seed/companies.json and nothing else', () => {
    const companies = seed<Record<string, string[] | string | boolean>>('companies.json');
    const names = new Set(Object.values(companies).flatMap((v) => (Array.isArray(v) ? v : [])));
    for (const n of names) expect(n).toMatch(/synthetic|虚构|虛構|架空/);
    for (const market of FIXTURE_MARKETS) {
      for (const p of fx[market].postings) expect(names.has(p.companyName), p.companyName).toBe(true);
      for (const p of fx[market].personas) for (const e of p.experience) expect(names.has(e.company), e.company).toBe(true);
    }
  });

  it('carry the hard negatives the invariants need', () => {
    for (const market of FIXTURE_MARKETS) {
      const postings = fx[market].postings;
      const tagged = (t: string) => postings.filter((p) => p.tags.includes(t));
      // An internship.
      expect(tagged('internship').length).toBeGreaterThan(0);
      expect(tagged('internship').every((p) => p.employmentType === 'internship' && p.level === 'intern_newgrad')).toBe(true);
      // A posting that lists no skills and states no level.
      expect(tagged('no_skills_no_level').length).toBeGreaterThan(0);
      expect(tagged('no_skills_no_level').every((p) => p.skills.length === 0 && p.level === null && p.qualifications === null)).toBe(true);
      // A posting located by country only.
      expect(tagged('country_only').length).toBeGreaterThan(0);
      expect(tagged('country_only').every((p) => p.location.city === null && p.workModel === 'onsite')).toBe(true);
      // The same head noun in another discipline.
      expect(tagged('other_discipline').length).toBeGreaterThanOrEqual(2);
      expect(tagged('other_discipline').every((p) => p.otherDiscipline)).toBe(true);
      // An implausible pay line: the product's own rule says it cannot be pay; every other pay line can.
      const absurd = tagged('implausible_pay');
      expect(absurd).toHaveLength(1);
      for (const p of postings.filter((x) => x.pay)) {
        const plausible = payPlausible({ min: p.pay!.min, max: p.pay!.max, currency: p.pay!.currency, period: p.pay!.period, months: p.pay!.months });
        expect(plausible, `${p.id} ${p.pay!.text}`).toBe(p.pay!.plausible);
        expect(p.pay!.plausible).toBe(!p.tags.includes('implausible_pay'));
      }
      expect(postingRecord(absurd[0]!).salaryAnnualMax).toBeNull();
      expect(postingRecord(absurd[0]!).salaryText).toBe(absurd[0]!.pay!.text);
    }
    const titles = fx.intl.postings.map((p) => p.title);
    expect(titles).toContain('Java Backend Architect');
    expect(titles).toContain('Landscape Architect');
    expect(fx.intl.postings.some((p) => p.pay?.text === '$60,000,000 an hour')).toBe(true);
  });

  it('a posting reads as its own role: that role\'s skills first and that role\'s work, never its sibling\'s', () => {
    const groups = seed<{ groups: Array<{ groupId: string; skills: Record<string, string[]>; roles: Array<{ roleId: string; skills: number[]; work: Record<string, [string, string]> }> }> }>('groups.json').groups;
    for (const g of groups) {
      const [a, b] = g.roles as [(typeof g.roles)[number], (typeof g.roles)[number]];
      for (const r of g.roles) {
        expect(r.skills, r.roleId).toHaveLength(8);
        expect(new Set(r.skills).size, r.roleId).toBe(8);
      }
      // The two roles lead with different skills and do different work, in every language of the group.
      expect(a.skills.slice(0, 2).some((k) => b.skills.slice(0, 2).includes(k)), g.groupId).toBe(false);
      expect(a.skills.join() === b.skills.join(), g.groupId).toBe(false);
      for (const lang of Object.keys(g.skills)) expect(a.work[lang]!.some((w) => b.work[lang]!.includes(w)), `${g.groupId} ${lang}`).toBe(false);
    }
    for (const market of FIXTURE_MARKETS) {
      const postings = fx[market].postings.filter((p) => !p.tags.includes('special') && !p.tags.includes('no_skills_no_level'));
      for (const g of groups) {
        for (const r of g.roles) {
          const sibling = g.roles.find((x) => x.roleId !== r.roleId)!;
          for (const p of postings.filter((x) => x.roleId === r.roleId)) {
            const vocabulary = g.skills[p.lang]!;
            const required = p.skills.filter((s) => s.kind === 'hard' && s.required).map((s) => s.name);
            // Every required skill is one of the role's own eight, and the first is the role's leading skill or the next.
            for (const name of required) expect(r.skills.map((k) => vocabulary[k]), `${p.id} requires ${name}`).toContain(name);
            expect(r.skills.slice(0, 2).map((k) => vocabulary[k]), p.id).toContain(required[0]);
            // The duties are the role's, not the sibling role's.
            expect(p.description, p.id).toContain(r.work[p.lang]![0]);
            expect(p.description.includes(sibling.work[p.lang]![0]), p.id).toBe(false);
          }
        }
      }
    }
    // The cases a title swap used to get wrong.
    const byId = new Map(fx.intl.postings.map((p) => [p.id, p]));
    const ios = byId.get('intl-en-ios_engineer-s0')!;
    expect(ios.skills.filter((s) => s.required).map((s) => s.name)).toEqual(['Swift', 'SwiftUI', 'UIKit', 'Xcode']);
    expect(ios.description).toContain('is hiring an iOS Engineer. You will be responsible for the customer iOS app.');
    const pharmacist = byId.get('intl-en-pharmacist-s0')!;
    expect(pharmacist.skills.filter((s) => s.required).map((s) => s.name)).toEqual(['Medication dispensing', 'Drug interaction review', 'Prescription verification', 'Compounding']);
    expect(pharmacist.description).toContain('prescription checks in the hospital pharmacy');
    expect(pharmacist.description).not.toContain('28-bed ward');
    const frontend = byId.get('intl-en-frontend_engineer-s0')!;
    expect(frontend.skills.filter((s) => s.required).map((s) => s.name)).toEqual(['React', 'TypeScript', 'CSS', 'Next.js']);
  });

  it('English postings and resumes use the right article before a title', () => {
    expect(['iOS Engineer', 'HR Generalist', 'SEO Specialist', 'IT Support Specialist', 'NLP Engineer', 'Account Executive', 'Illustrator Intern', 'Interior Designer'].map(indefiniteArticle)).toEqual(Array(8).fill('an'));
    expect(['UX Designer', 'UI Designer', 'User Operations Specialist', 'Backend Engineer', 'Senior iOS Engineer', 'Full-Stack Engineer', 'Junior HR Generalist', 'Data Analyst'].map(indefiniteArticle)).toEqual(Array(8).fill('a'));
    for (const p of fx.intl.postings.filter((x) => x.lang === 'en')) {
      expect(p.description, p.id).toContain(`is hiring ${indefiniteArticle(p.title)} ${p.title}.`);
    }
    const english = [...fx.intl.personas, ...fx.cn.personas].filter((p) => p.resumeLang === 'en').map((p) => p.resumeMarkdown).join('\n');
    expect(english).not.toMatch(/\b(as|hiring) a (iOS|HR|SEO|IT|NLP|Account|Illustrator)\b/);
    expect(english).toMatch(/moving into work as a (Data Analyst|Marketing Manager|UX Designer)\./);
  });

  it('GoApply campus postings state a class year with its quote; RoboApply postings state none', () => {
    const campus = fx.cn.postings.filter((p) => p.classYears.length);
    expect(campus.length).toBeGreaterThan(0);
    for (const p of campus) expect(p.qualifications).toContain(p.classYearQuote!);
    expect(fx.intl.postings.every((p) => p.classYears.length === 0)).toBe(true);
    expect(fx.cn.postings.every((p) => p.sponsorship === null)).toBe(true);
    for (const p of fx.intl.postings.filter((x) => x.sponsorship)) expect(p.qualifications).toContain(p.sponsorshipQuote!);
  });
});

describe('constructed labels', () => {
  it('reference existing personas and postings of the persona\'s pooled languages, one label per pair', () => {
    for (const market of FIXTURE_MARKETS) {
      const { personas, postings, labels } = fx[market];
      const byId = new Map(postings.map((p) => [p.id, p]));
      expect(Object.keys(labels.labels).sort()).toEqual(personas.map((p) => p.id).sort());
      for (const persona of personas) {
        for (const [postingId, grade] of Object.entries(labels.labels[persona.id]!)) {
          const posting = byId.get(postingId);
          expect(posting, `${persona.id} → ${postingId}`).toBeDefined();
          expect(persona.poolLangs).toContain(posting!.lang);
          expect([0, 1, 2, 3]).toContain(grade);
        }
      }
    }
  });

  it('every persona has a pool of at least 30 with at least 5 graded 2 or 3 and at least 10 graded 0', () => {
    expect([POOL_MIN, POOL_MIN_GOOD, POOL_MIN_ZERO]).toEqual([30, 5, 10]);
    for (const market of FIXTURE_MARKETS) {
      for (const persona of fx[market].personas) {
        const grades = Object.values(fx[market].labels.labels[persona.id]!);
        expect(grades.length, persona.id).toBeGreaterThanOrEqual(30);
        expect(grades.filter((g) => g >= 2).length, persona.id).toBeGreaterThanOrEqual(5);
        expect(grades.filter((g) => g === 0).length, persona.id).toBeGreaterThanOrEqual(10);
      }
    }
  });

  it('pools hold the same role two levels away, and the grades follow the stated rule', () => {
    for (const market of FIXTURE_MARKETS) {
      const { personas, postings, labels } = fx[market];
      const byId = new Map(postings.map((p) => [p.id, p]));
      const parents = (roleId: string) => {
        const [, group, category] = taxonomyAncestors(roleId).map((n) => n.id);
        return { groupId: group!, categoryId: category! };
      };
      let twoAway = 0;
      for (const persona of personas) {
        for (const [postingId, grade] of Object.entries(labels.labels[persona.id]!)) {
          const posting = byId.get(postingId)!;
          expect(constructedGrade(persona, posting, parents), `${persona.id} → ${postingId}`).toBe(grade);
          if (posting.roleId === persona.roleId && posting.level && Math.abs(level(posting.level) - level(persona.level)) === 2) twoAway += 1;
        }
      }
      expect(twoAway, market).toBeGreaterThan(0);
    }
  });

  it('grades what the invariants say: internships, other disciplines, thin postings', () => {
    const { personas, postings, labels } = fx.intl;
    const byId = new Map(postings.map((p) => [p.id, p]));
    const grade = (persona: Persona, pick: (p: Posting) => boolean) => {
      const hit = Object.keys(labels.labels[persona.id]!).map((id) => byId.get(id)!).find(pick);
      return hit ? labels.labels[persona.id]![hit.id] : undefined;
    };
    const backend = personas.find((p) => p.subset === 'en' && p.roleId === 'backend_engineer' && p.kind === 'standard')!;
    const sameRole = (p: Posting) => p.roleId === backend.roleId && p.lang === 'en';
    // A full posting at the persona's own level is an excellent match.
    expect(grade(backend, (p) => sameRole(p) && p.level === backend.level && !p.tags.length)).toBe(3);
    // An internship is at most "related" for someone at mid level or above.
    expect(grade(backend, (p) => sameRole(p) && p.employmentType === 'internship')).toBeLessThanOrEqual(1);
    // A posting that says too little is never excellent.
    expect(grade(backend, (p) => sameRole(p) && p.tags.includes('no_skills_no_level'))).toBeLessThanOrEqual(2);
    // "Landscape Architect" is not relevant for a software person. "Java Backend Architect" is the same
    // category: related for a lead-level person, and two levels away from a mid-level one.
    expect(grade(backend, (p) => p.title === 'Landscape Architect')).toBe(0);
    expect(backend.level).toBe('mid');
    expect(grade(backend, (p) => p.title === 'Java Backend Architect')).toBe(0);
    const lead = fx.cn.personas.find((p) => p.roleId === 'backend_engineer' && p.level === 'lead_staff')!;
    const cnTitle = fx.cn.postings.find((p) => p.title === 'Java后端架构师')!;
    expect(fx.cn.labels.labels[lead.id]![cnTitle.id]).toBe(1);
    const ux = personas.find((p) => p.roleId === 'ux_designer' && p.kind === 'standard')!;
    expect(grade(ux, (p) => p.title === 'Interior Designer')).toBe(0);
  });
});

describe('the generator', () => {
  it('is deterministic: the same seed gives the same hash, twice', () => {
    const first = buildFixtures();
    const second = buildFixtures();
    expect(fixturesHash(second)).toBe(fixturesHash(first));
    expect(Object.keys(first).sort()).toEqual(FIXTURE_MARKETS.flatMap((m) => [FIXTURE_FILES.labels(m), FIXTURE_FILES.personas(m), FIXTURE_FILES.postings(m)]).sort());
  });

  it('gives byte-identical files to the ones committed', () => {
    for (const [name, text] of Object.entries(buildFixtures())) expect(read(name) === text, `${name} is stale: run fixtures/build.ts`).toBe(true);
  });
});
