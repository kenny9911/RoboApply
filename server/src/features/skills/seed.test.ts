// @vitest-environment node
// MKT-2G item 2: the committed seed. It is generated from tables the
// repository already has, read here at test time, so a change to one of them
// fails until the seed is regenerated. The term tables are read through
// features/match/terms.ts, the path every match module imports them by.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { displayTerm, EVERYDAY_WORDS, isEverydayWord, SHOWN_BY } from '../match/terms.js';
import { SKILL_ALIASES } from '../search/skills.js';
import { aliasKey } from './keys.js';
import { evidenceFor } from './related.js';
import {
  ADDITIONS_PATH,
  buildSeed,
  DROPPED_PATH,
  parseAdditions,
  parseDropped,
  parseReviewed,
  REVIEWED_PATH,
  SEED_PATH,
  serializeAdditions,
  serializeDropped,
  serializeReviewed,
  serializeSeed,
  type SeedSkill,
} from './seed/build.js';
import { SEED_DROPPED_KEYS, SEED_SKILL_IDS, SEED_SKILLS, SEED_VERSION } from './seed/index.js';
import { TYPEAHEAD_SKILL_ALIASES } from './seed/sources.js';
import * as skillsTerms from './terms.js';
import { skillIdsInText } from './text.js';
import { SKILL_KINDS } from './types.js';
import { buildVocabulary } from './vocabulary.js';

const committed = readFileSync(SEED_PATH, 'utf8');
const vocabulary = buildVocabulary(SEED_SKILLS);
const byId = new Map(SEED_SKILLS.map((s) => [s.id, s]));

describe('the seed is generated, not written by hand', () => {
  it('builds byte-identically twice', () => {
    expect(serializeSeed(buildSeed())).toBe(serializeSeed(buildSeed()));
  });

  it('the committed file is the generator output (after changing skills/terms.ts or seed/sources.ts run: npx tsx server/src/features/skills/seed/build.ts --write)', () => {
    expect(committed).toBe(serializeSeed(buildSeed()));
    expect(SEED_VERSION).toBe(1);
  });

  it('what a reviewer approved replaces the generated entry and adds new ones', () => {
    const reviewed = parseReviewed([
      { id: 'postgresql', kind: 'hard', labelEn: 'PostgreSQL', labelZh: null, aliases: ['postgres', 'psql', 'pg'], aliasKeys: ['pgsql'], parentId: 'sql', esco: 'esco:test', status: 'reviewed' },
      { id: 'supabase', kind: 'hard', labelEn: 'Supabase', aliases: [], parentId: 'postgresql', status: 'reviewed' },
    ]);
    const file = buildSeed({ reviewed });
    const pg = file.skills.find((s) => s.id === 'postgresql')!;
    expect(pg).toMatchObject({ aliases: ['pg', 'postgres', 'psql'], aliasKeys: ['pgsql'], esco: 'esco:test' });
    expect(file.skills.find((s) => s.id === 'supabase')).toMatchObject({ parentId: 'postgresql', status: 'reviewed', esco: null });
    expect(file.skills).toHaveLength(SEED_SKILLS.length + 1);
    expect(serializeSeed(buildSeed({ reviewed }))).toBe(serializeSeed(file));
    expect(parseReviewed(JSON.parse(serializeReviewed(reviewed)))).toEqual(reviewed);
  });

  it('refuses reviewed data that would make one name lead to two skills, or name a missing parent', () => {
    const base = { kind: 'hard', aliases: [], parentId: null, status: 'reviewed' };
    expect(() => buildSeed({ reviewed: parseReviewed([{ ...base, id: 'pg_tool', labelEn: 'PG tool', aliases: ['postgres'] }]) })).toThrow(/two skills/);
    expect(() => buildSeed({ reviewed: parseReviewed([{ ...base, id: 'pg_tool', labelEn: 'PG tool', parentId: 'nowhere' }]) })).toThrow(/no seed skill/);
    expect(() => parseReviewed([{ ...base, id: 'x', labelEn: 'X', kind: 'tool' }])).toThrow(/unknown kind/);
    expect(() => parseReviewed({})).toThrow(/array/);
  });
});

describe('what the review tooling carries into the seed', () => {
  it('the three committed input files are in the form export-seed writes, and are empty until a review round trip', () => {
    expect(readFileSync(REVIEWED_PATH, 'utf8')).toBe(serializeReviewed(parseReviewed(JSON.parse(readFileSync(REVIEWED_PATH, 'utf8')))));
    expect(readFileSync(ADDITIONS_PATH, 'utf8')).toBe(serializeAdditions(parseAdditions(JSON.parse(readFileSync(ADDITIONS_PATH, 'utf8')))));
    expect(readFileSync(DROPPED_PATH, 'utf8')).toBe(serializeDropped(parseDropped(JSON.parse(readFileSync(DROPPED_PATH, 'utf8')))));
    expect(SEED_DROPPED_KEYS).toEqual(buildSeed().dropped);
    expect(SEED_DROPPED_KEYS).toEqual([]);
    expect(SEED_SKILL_IDS.size).toBe(SEED_SKILLS.length);
  });

  it('additions put alias keys and identifiers on top of a generated entry and change nothing else', () => {
    const base = buildSeed({ reviewed: [], additions: [], dropped: { ids: [], keys: [] } });
    const additions = parseAdditions([{ id: 'postgresql', aliasKeys: ['pgsql', 'pgsql', ''], esco: 'esco:test' }, { id: 'docker', onet: 'onet:test' }]);
    expect(additions).toEqual([{ id: 'postgresql', aliasKeys: ['pgsql', 'pgsql'], esco: 'esco:test', onet: null }, { id: 'docker', aliasKeys: [], esco: null, onet: 'onet:test' }]);
    const file = buildSeed({ reviewed: [], additions, dropped: { ids: [], keys: [] } });
    expect(file.skills.find((s) => s.id === 'postgresql')).toEqual({ ...base.skills.find((s) => s.id === 'postgresql')!, aliasKeys: ['pgsql'], esco: 'esco:test' });
    expect(file.skills.find((s) => s.id === 'docker')).toEqual({ ...base.skills.find((s) => s.id === 'docker')!, onet: 'onet:test' });
    expect(file.skills.filter((s) => !['postgresql', 'docker'].includes(s.id))).toEqual(base.skills.filter((s) => !['postgresql', 'docker'].includes(s.id)));
    expect(parseAdditions(JSON.parse(serializeAdditions(additions)))).toEqual([{ id: 'docker', aliasKeys: [], esco: null, onet: 'onet:test' }, { id: 'postgresql', aliasKeys: ['pgsql'], esco: 'esco:test', onet: null }]);
    // A key another skill holds, or an id the seed does not have, stops the build.
    expect(() => buildSeed({ reviewed: [], additions: parseAdditions([{ id: 'postgresql', aliasKeys: ['mysql'] }]), dropped: { ids: [], keys: [] } })).toThrow(/two skills/);
    expect(() => buildSeed({ reviewed: [], additions: parseAdditions([{ id: 'nowhere', aliasKeys: ['x'] }]), dropped: { ids: [], keys: [] } })).toThrow(/no seed skill/);
    expect(() => parseAdditions({})).toThrow(/array/);
    expect(() => parseAdditions([{ aliasKeys: ['x'] }])).toThrow(/needs an id/);
  });

  it('dropped ids leave the seed, their names and the dropped keys are never a skill, and a key a live skill holds is not dropped', () => {
    const dropped = parseDropped({ ids: ['spring', 'spring', 'not_a_seed_skill'], keys: ['fastpacedenvironment', 'postgresql', ''] });
    expect(dropped).toEqual({ ids: ['spring', 'spring', 'not_a_seed_skill'], keys: ['fastpacedenvironment', 'postgresql'] });
    const file = buildSeed({ reviewed: [], additions: [], dropped });
    expect(file.skills).toHaveLength(SEED_SKILLS.length - 1);
    expect(file.skills.some((s) => s.id === 'spring')).toBe(false);
    // Spring Boot was under Spring: it stays, without a parent.
    expect(file.skills.find((s) => s.id === 'spring_boot')!.parentId).toBeNull();
    // "postgresql" is the name of a live skill, so it is not dropped.
    expect(file.dropped).toEqual(['fastpacedenvironment', 'spring', aliasKey('spring framework')].sort());
    const v = buildVocabulary(file.skills, { droppedKeys: file.dropped });
    expect(v.isDropped('Spring')).toBe(true);
    expect(v.isDropped('Fast-paced environment')).toBe(true);
    expect(v.isDropped('PostgreSQL')).toBe(false);
    expect(serializeSeed(buildSeed({ reviewed: [], additions: [], dropped }))).toBe(serializeSeed(file));
    expect(serializeDropped(dropped)).toBe(`${JSON.stringify({ ids: ['not_a_seed_skill', 'spring'], keys: ['fastpacedenvironment', 'postgresql'] }, null, 2)}\n`);
    expect(() => parseDropped([])).toThrow(/object/);
  });
});

describe('reading a sentence against the seed', () => {
  it('ordinary sentences name no skill: units, marketing metrics, a postscript, a sports team, two words that only spell a tool', () => {
    const bank = [
      'I am a product designer with 6 years of experience in design and research.',
      '8-hour work day; open shift schedule; air flow testing; post man; super set; hub spot',
      'power point of contact; word press; red shift; sales force of 20; data bricks; snow flake',
      'The colour red is used on every label',
      'Administered 500 ml IV fluids and mixed 30 mL of reagent',
      'Reduced CPA by 30% and CPC by 12% across paid social campaigns',
      'P.S. I am available from March. PS: references on request.',
      'Lifelong fan of the Red Sox and the White Sox',
      'Used a rag to clean the press after every run',
      'Worked with Ai Weiwei studio on the exhibition build',
      'Revenue up 12% vs PY; managed AR and AP; 40 hr week; available from 2 pm',
      'ICH-GCP trained; delivered CBT and DBT groups; LL.M. in tax law; NLP practitioner',
      'Processed CPP and EI deductions for 300 staff',
      'IFR rated commercial pilot with 2,000 hours',
      'Handed over the rest of the migration and will go far with swift decisions',
      'She excels at spring cleaning, rails against waste and is less of a sketch artist',
      'A 5-node cluster, net revenue impact and TS/SCI clearance',
      'Iam a hard working person who is a fast learner',
    ];
    for (const sentence of bank) expect(skillIdsInText(sentence, { vocabulary }), sentence).toEqual([]);
  });

  it('every name of the seed is found where a sentence writes it', () => {
    // Names with a bracket in them are never written that way in a sentence; their plain alias is found instead.
    const notWritten = new Set(['Teacher qualification certificate (China)', 'First-class constructor (China)']);
    for (const s of SEED_SKILLS) {
      for (const name of [s.labelEn, s.labelZh, s.labelZhHant, ...s.aliases]) {
        if (!name || notWritten.has(name)) continue;
        for (const sentence of [`Worked with ${name} every day`, `${name}, among others`, `熟悉 ${name} 的使用`]) {
          expect(skillIdsInText(sentence, { vocabulary, listOnlyWords: true }), `${s.id}: ${sentence}`).toContain(s.id);
        }
      }
    }
    for (const name of notWritten) expect(skillIdsInText(`Holds the ${name}`, { vocabulary })).toEqual([vocabulary.idOf(name)]);
  });
});

describe('shape and uniqueness', () => {
  it('every entry is reviewed, has a plain id, a label and a known kind, and no invented identifier', () => {
    expect(SEED_SKILLS.length).toBeGreaterThan(200);
    for (const s of SEED_SKILLS) {
      expect(s.id, s.id).toMatch(/^[a-z0-9_]+$/);
      expect(s.labelEn.trim(), s.id).not.toBe('');
      expect(SKILL_KINDS, s.id).toContain(s.kind);
      expect(s.status, s.id).toBe('reviewed');
      expect(s.esco, s.id).toBeNull();
      expect(s.onet, s.id).toBeNull();
      expect(Array.isArray(s.aliases), s.id).toBe(true);
      if (s.parentId) expect(byId.has(s.parentId), `${s.id} → ${s.parentId}`).toBe(true);
      expect(s.parentId, s.id).not.toBe(s.id);
    }
  });

  it('has no duplicate id and is sorted by id', () => {
    const ids = SEED_SKILLS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([...ids].sort());
  });

  it('no alias key points at two ids', () => {
    const owner = new Map<string, string>();
    for (const s of SEED_SKILLS) {
      for (const name of [s.labelEn, s.labelZh, s.labelZhHant, ...s.aliases]) {
        if (!name) continue;
        const key = aliasKey(name);
        expect(key, `${s.id}: ${name}`).not.toBe('');
        expect(owner.get(key) ?? s.id, `"${name}" (${key})`).toBe(s.id);
        owner.set(key, s.id);
      }
    }
    expect(vocabulary.conflicts).toEqual([]);
    expect(vocabulary.size).toBe(SEED_SKILLS.length);
  });

  it('the parent edges have no loop', () => {
    for (const s of SEED_SKILLS) {
      const seen = new Set<string>();
      for (let at: string | null = s.id; at; at = byId.get(at)?.parentId ?? null) {
        expect(seen.has(at), `${s.id} loops at ${at}`).toBe(false);
        seen.add(at);
      }
      expect(vocabulary.parentOf(s.id)).toBe(s.parentId);
    }
  });
});

describe('coverage of features/match/terms.ts', () => {
  it('features/match/terms.ts exports the two tables, and they are the ones the generator reads', () => {
    expect(SHOWN_BY).toBe(skillsTerms.SHOWN_BY);
    expect(EVERYDAY_WORDS).toBe(skillsTerms.EVERYDAY_WORDS);
    expect(displayTerm).toBe(skillsTerms.displayTerm);
    expect(SHOWN_BY.length).toBeGreaterThanOrEqual(20);
    expect(EVERYDAY_WORDS.has('rest')).toBe(true);
  });

  it('every term of SHOWN_BY is a seed skill', () => {
    for (const [general, specific] of SHOWN_BY) for (const term of [...general, ...specific]) expect(vocabulary.idOf(term), term).not.toBeNull();
  });

  it('every pair of SHOWN_BY is represented: the named tool is the broader skill or is under it', () => {
    const missing = new Set<string>();
    let pairs = 0;
    for (const [general, specific] of SHOWN_BY) {
      for (const g of general) {
        for (const s of specific) {
          pairs++;
          const broader = vocabulary.idOf(g)!;
          const tool = vocabulary.idOf(s)!;
          const state = evidenceFor(broader, new Set([tool]), vocabulary).state;
          if (state === 'not_shown') missing.add(`${broader} <- ${tool}`);
        }
      }
    }
    expect(pairs).toBeGreaterThan(500);
    // The two places where one key, one id and one parent per skill cannot hold what the table says:
    //   · "rest apis" / "restful apis" are names of the tool REST, so GraphQL, gRPC, OpenAPI and Swagger do not show them
    //     (they still show "API design");
    //   · CloudFormation is listed under cloud infrastructure and under infrastructure as code; it has one parent.
    expect([...missing].sort()).toEqual(['cloud_infrastructure <- cloudformation', 'rest <- graphql', 'rest <- grpc', 'rest <- openapi', 'rest <- swagger']);
  });

  it('the examples of the item hold', () => {
    expect(vocabulary.parentOf('postgresql')).toBe('sql');
    expect(vocabulary.parentOf('sql')).toBe('relational_databases');
    expect(vocabulary.parentOf('aws')).toBe('cloud_infrastructure');
    expect(vocabulary.parentOf(vocabulary.idOf('rest api')!)).toBe('api_design');
    expect(evidenceFor('relational_databases', new Set(['postgresql']), vocabulary)).toEqual({ state: 'related', via: 'postgresql' });
    expect(evidenceFor('postgresql', new Set(['relational_databases']), vocabulary)).toEqual({ state: 'not_shown', via: null });
  });

  it('labels use the usual spelling of displayTerm', () => {
    for (const [term, label] of [['go', 'Go'], ['mysql', 'MySQL'], ['grpc', 'gRPC'], ['node.js', 'Node.js'], ['postgresql', 'PostgreSQL']] as const) {
      expect(displayTerm(term)).toBe(label);
      expect(vocabulary.label(vocabulary.idOf(term)!, 'en')).toBe(label);
    }
  });

  it('a label that is also an ordinary word carries the flag, and no such word is ever taken from a sentence', () => {
    for (const s of SEED_SKILLS) expect(s.everydayWord === true, s.id).toBe(isEverydayWord(s.labelEn));
    expect(byId.get('rest')?.everydayWord).toBe(true);
    expect(byId.get('excel')?.everydayWord).toBe(true);
    expect(byId.get('postgresql')?.everydayWord).toBeUndefined();
    expect(vocabulary.everydayWord('swift')).toBe(true);
    for (const word of EVERYDAY_WORDS) {
      expect(skillIdsInText(`we used ${word} for the rest of it`, { vocabulary }), word).toEqual([]);
      const id = vocabulary.idOf(word);
      if (id) expect(skillIdsInText(word, { vocabulary, listOnlyWords: true }), word).toEqual([id]);
    }
  });
});

describe('coverage of features/search/skills.ts', () => {
  it('the copy the generator reads is the typeahead table, character for character', () => {
    expect(TYPEAHEAD_SKILL_ALIASES).toEqual(SKILL_ALIASES);
    expect(Object.keys(TYPEAHEAD_SKILL_ALIASES)).toEqual(Object.keys(SKILL_ALIASES));
  });

  it('every alias of SKILL_ALIASES leads to the skill it names', () => {
    for (const [alias, target] of Object.entries(SKILL_ALIASES)) {
      const id = vocabulary.idOf(target);
      expect(id, target).not.toBeNull();
      expect(vocabulary.idOf(alias), alias).toBe(id);
    }
    expect(vocabulary.idOf('k8s')).toBe('kubernetes');
    expect(vocabulary.idOf('js')).toBe('javascript');
  });
});

describe('soft skills and certificates', () => {
  it('soft skills are kind soft, in three scripts', () => {
    for (const [id, names] of [
      ['communication', ['communication', 'Communication skills', '沟通能力', '溝通能力']],
      ['attention_to_detail', ['attention to detail', 'detail-oriented', '注重细节']],
      ['teamwork', ['teamwork', '团队合作', '團隊合作']],
      ['leadership', ['leadership', '领导力']],
      ['problem_solving', ['problem solving', 'problem-solving', '解决问题的能力']],
      ['sense_of_responsibility', ['责任心', '責任心']],
    ] as const) {
      expect(vocabulary.kindOf(id), id).toBe('soft');
      for (const name of names) expect(vocabulary.idOf(name), name).toBe(id);
    }
  });

  it('certificates are first-class skills of kind certification', () => {
    for (const [id, names] of [
      ['cpa', ['CPA', '注册会计师', '註冊會計師', 'Certified Public Accountant']],
      ['cfa', ['CFA', '特许金融分析师']],
      ['pmp', ['PMP']],
      ['cet_6', ['CET-6', 'CET6', '大学英语六级', '大學英語六級', '英语六级']],
      ['teacher_qualification_certificate', ['教师资格证', '教師資格證', '教资']],
      ['first_class_constructor', ['一级建造师', '一建', '一級建造師']],
      ['putonghua_certificate', ['普通话等级证书', '普通話等級證書']],
    ] as const) {
      expect(vocabulary.kindOf(id), id).toBe('certification');
      for (const name of names) expect(vocabulary.idOf(name), name).toBe(id);
    }
  });

  it('everything else is a hard skill', () => {
    const kinds = new Map<string, number>();
    for (const s of SEED_SKILLS) kinds.set(s.kind, (kinds.get(s.kind) ?? 0) + 1);
    expect(kinds.get('soft')).toBe(6);
    expect(kinds.get('certification')).toBe(7);
    expect(kinds.get('hard')).toBe(SEED_SKILLS.length - 13);
  });

  it('a seed entry keeps the reviewed type', () => {
    const entry: SeedSkill = buildSeed().skills[0]!;
    expect(entry.status).toBe('reviewed');
  });
});
