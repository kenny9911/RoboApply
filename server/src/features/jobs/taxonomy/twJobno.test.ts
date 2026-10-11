// @vitest-environment node
//
// 通俗職業分類 → role map (MKT-3E, JT-4). Pure: a committed file, no network.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// The script that lists the code / name pairs of saved responses (the only way a pair enters the map).
import { asciiHeader, catalog, compareWithMap, readRows } from '../../../../../scripts/tw-jobno-catalog.mjs';
import { TW_JOBNO_MAJORS, TW_JOBNO_MINORS, TW_JOBNO_SOURCE, twCategoryForMajor, twRoleForJobno, validateTwJobno, type TwJobnoData } from './twJobno.js';
import { getTaxonomyNode } from './taxonomy.js';
import * as taxonomy from './index.js';

/** The 22 大類 exactly as observed in live data (JOB_SOURCES_TW.md 5.2). */
const MAJORS: ReadonlyArray<[string, string]> = [
  ['01', '經營／行政／總務'], ['02', '業務／貿易／銷售'], ['03', '人資／法務／智財'], ['04', '財務／金融／保險'], ['05', '廣告／公關／設計'], ['06', '客服／門市'],
  ['07', '工程／研發／生技'], ['08', '資訊／軟體／系統'], ['09', '品管／製造／環衛'], ['10', '技術／維修／操作'], ['11', '營建／製圖／施作'], ['12', '新聞／出版／印刷'],
  ['13', '傳播／娛樂／藝術'], ['14', '教育／學術／研究'], ['15', '物流／運輸／資材'], ['16', '旅遊／餐飲／休閒'], ['17', '醫療／美容／保健'], ['18', '保全／軍警消'],
  ['19', '清潔／家事／托育(保母)'], ['20', '農林漁牧相關'], ['21', '行銷／企劃／專案'], ['22', '其他職類'],
];

const table = (over: Partial<TwJobnoData> = {}): TwJobnoData => ({
  version: 1,
  asOf: '2026-10-11',
  source: { ...TW_JOBNO_SOURCE },
  major: TW_JOBNO_MAJORS.map((m) => ({ ...m })),
  minor: TW_JOBNO_MINORS.map((m) => ({ ...m })),
  ...over,
});

describe('twJobno: the shipped map', () => {
  it('is valid: unique codes, every 小類 under a listed 大類 and mapped to a role of the tree', () => {
    expect(validateTwJobno()).toEqual([]);
    expect(TW_JOBNO_SOURCE.url).toBe('https://jobooks.taiwanjobs.gov.tw/cl.aspx?n=3');
  });

  it('pins the 22 大類 to the codes and names of the live data, in order', () => {
    expect(TW_JOBNO_MAJORS.map((m) => [m.code, m.name])).toEqual(MAJORS);
    for (const m of TW_JOBNO_MAJORS) if (m.categoryId !== null) expect(getTaxonomyNode(m.categoryId)?.level, m.code).toBe(1);
  });

  it('holds the four 小類 the research note names, with their titles', () => {
    const byCode = new Map(TW_JOBNO_MINORS.map((m) => [m.code, m]));
    expect(byCode.get('080202')).toMatchObject({ name: '軟(韌)體設計工程師', taxonomyId: 'software_engineer' });
    expect(byCode.get('080104')).toMatchObject({ name: '網路安全工程師', taxonomyId: 'security_engineer' });
    expect(byCode.get('050313')).toMatchObject({ name: '網頁設計師', taxonomyId: 'ui_designer' });
    expect(byCode.get('010206')).toMatchObject({ name: '行政助理', taxonomyId: 'administrative_assistant' });
  });

  it('every mapped 小類 names a level-3 id', () => {
    for (const m of TW_JOBNO_MINORS) expect(getTaxonomyNode(m.taxonomyId)?.level, `${m.code} ${m.name}`).toBe(3);
  });

  it('is part of the public surface of the taxonomy', () => {
    expect(taxonomy.twRoleForJobno).toBe(twRoleForJobno);
    expect(taxonomy.twCategoryForMajor).toBe(twCategoryForMajor);
    expect(taxonomy.TW_JOBNO_MAJORS).toBe(TW_JOBNO_MAJORS);
  });
});

describe('twRoleForJobno / twCategoryForMajor', () => {
  it('a mapped 6-digit 小類 gives its role; anything else gives null', () => {
    expect(twRoleForJobno('080202')).toBe('software_engineer');
    expect(twRoleForJobno(' 080202 ')).toBe('software_engineer');
    expect(twRoleForJobno('０８０２０２')).toBe('software_engineer');
    for (const code of ['999999', '0802', '08', '', '08020a', '0802020', null, undefined]) expect(twRoleForJobno(code), String(code)).toBeNull();
    // A number loses its leading zero: it is not a code.
    expect(twRoleForJobno(80202)).toBeNull();
  });

  it('a 大類 gives its Explore category by its own code or by a longer code that starts with it', () => {
    expect(twCategoryForMajor('08')).toBe('software_engineering');
    expect(twCategoryForMajor('0802')).toBe('software_engineering');
    expect(twCategoryForMajor('080202')).toBe('software_engineering');
    expect(twCategoryForMajor('17')).toBe('healthcare');
    // A 大類 that spans several categories is not forced into one.
    expect(twCategoryForMajor('22')).toBeNull();
    expect(twCategoryForMajor('03')).toBeNull();
    for (const code of ['99', '8', 'ab', '', null, undefined]) expect(twCategoryForMajor(code), String(code)).toBeNull();
  });
});

describe('validateTwJobno', () => {
  it('fails for a duplicate code', () => {
    const minor = TW_JOBNO_MINORS.map((m) => ({ ...m }));
    expect(validateTwJobno(table({ minor: [...minor, { ...minor[0]! }] }))).toContain(`duplicate minor code ${minor[0]!.code}`);
    const major = TW_JOBNO_MAJORS.map((m) => ({ ...m }));
    expect(validateTwJobno(table({ major: [...major, { ...major[0]! }] }))).toContain('duplicate major code 01');
  });

  it('fails for a taxonomyId that is not a level-3 id of the tree', () => {
    const base = TW_JOBNO_MINORS[0]!;
    for (const taxonomyId of ['software_engineering', 'swe_backend', 'no_such_role', '']) {
      expect(validateTwJobno(table({ minor: [{ ...base, taxonomyId }] })), taxonomyId).toContain(`minor ${base.code}: ${taxonomyId} is not a role of the tree`);
    }
  });

  it('fails for a malformed code, a 小類 outside the listed 大類 and a 大類 mapped to a non-category', () => {
    const base = TW_JOBNO_MINORS[0]!;
    expect(validateTwJobno(table({ minor: [{ ...base, code: '0802' }] }))).toContain('minor code 0802 is not six digits');
    expect(validateTwJobno(table({ minor: [{ ...base, code: '990101' }] }))).toContain('minor 990101: its 大類 99 is not listed');
    const major = TW_JOBNO_MAJORS.map((m) => ({ ...m }));
    expect(validateTwJobno(table({ major: major.map((m, i) => (i === 0 ? { ...m, categoryId: 'software_engineer' } : m)) }))).toContain('major 01: software_engineer is not a category of the tree');
  });
});

describe('scripts/tw-jobno-catalog.mjs: the pairs of a saved response', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  // SYNTHETIC rows in the live answer's shape (sources/__fixtures__/tw/README.md).
  const csv = readFileSync(join(here, '..', 'sources', '__fixtures__', 'tw', 'joblist.synthetic.csv'), 'utf8');
  const map = { major: TW_JOBNO_MAJORS.map((m) => ({ ...m })), minor: TW_JOBNO_MINORS.map((m) => ({ ...m })) };

  it('reads a column by the ASCII part of its header', () => {
    expect(asciiHeader('\uFEFFCJOB2_COUNT（職務小類別代碼）')).toBe('CJOB2_COUNT');
    expect(asciiHeader('cjob_name2(職務小類別名稱)')).toBe('CJOB_NAME2');
    const rows = readRows(csv) as Array<Record<string, string>>;
    expect(rows).toHaveLength(8);
    expect(rows[0]).toMatchObject({ CJOB1_COUNT: '08', CJOB_NAME1: '資訊／軟體／系統', CJOB2_COUNT: '080202', CJOB_NAME2: '軟(韌)體設計工程師' });
  });

  it('lists the distinct pairs with counts and says which the map holds', () => {
    const rows = [...(readRows(csv) as Array<Record<string, string>>), ...(readRows(csv) as Array<Record<string, string>>).slice(0, 1)];
    const result = compareWithMap(catalog(rows), map);
    expect(result.disagreements).toEqual([]);
    expect(result.major.map((m: { code: string }) => m.code)).toEqual(['01', '02', '06', '08', '09', '11', '14', '17']);
    const minor = new Map(result.minor.map((m: { code: string; name: string; count: number; taxonomyId: string | null }) => [m.code, m]));
    expect(minor.get('080202')).toEqual({ code: '080202', name: '軟(韌)體設計工程師', count: 2, taxonomyId: 'software_engineer' });
    expect(minor.get('170113')).toEqual({ code: '170113', name: '照顧服務員', count: 1, taxonomyId: null });
    // It prints codes, names and counts only: never a posting field.
    expect(JSON.stringify(result)).not.toMatch(/SYNTHETIC|範例|taiwanjobs/);
  });

  it('flags a code whose name in a response differs from the map, and a 大類 the map does not list', () => {
    const rows = [
      { CJOB1_COUNT: '08', CJOB_NAME1: '資訊／軟體／系統', CJOB2_COUNT: '080202', CJOB_NAME2: '軟體設計工程師' },
      { CJOB1_COUNT: '23', CJOB_NAME1: '新的大類', CJOB2_COUNT: '230101', CJOB_NAME2: '新的小類' },
    ];
    expect(compareWithMap(catalog(rows), map).disagreements).toEqual([
      { level: 'major', code: '23', response: '新的大類', map: null },
      { level: 'minor', code: '080202', response: '軟體設計工程師', map: '軟(韌)體設計工程師' },
    ]);
  });
});
