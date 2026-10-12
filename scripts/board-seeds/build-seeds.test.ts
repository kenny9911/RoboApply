// @vitest-environment node
//
// scripts/board-seeds/build-seeds.mjs (MKT-4S; MARKET_STRATEGY.md 1.2, 1.3,
// 1.4; JI-3, JC-4, JT-5; D3). The builder writes the three seed files from a
// validation report and from nothing else: these tests hold which board goes
// into which file, what an entry carries, and that nothing is dropped
// silently. Reports, boards and companies are SYNTHETIC. No network, no clock.

import { describe, expect, it } from 'vitest';

// @ts-expect-error: a plain .mjs script, no type declarations
import * as b from './build-seeds.mjs';

type Row = Record<string, unknown>;

const valid = (over: Row): Row => ({ employer: 'Acme', valid: true, nameCheck: 'stated_name', companyName: 'Acme', postings: 10, read: 10, complete: true, byCountry: { US: 10 }, unplaced: 0, mainland: 0, taiwan: 0, elsewhere: 10, requests: 1, ...over });
const report = (...results: Row[]): Row => ({ date: '2026-10-11', verifiedBy: 'live board API', requests: 42, summary: { all: { open: 0 } }, results });
const old = (over: Row): Row => ({ ats: 'greenhouse', boardToken: 'acme', companyName: 'Acme', countries: [], note: 'docs/jobright-clone/market/JOB_SOURCES_TW.md 3.5: SYNTHETIC first confirmation', confirmedOn: '2026-09-01', ...over });
const keys = (file: { boards: Array<{ ats: string; boardToken: string }> }) => file.boards.map((e) => `${e.ats}:${e.boardToken}`);

describe('which board goes into which file', () => {
  it('a board is in the file of every place it has a posting in, with that place\'s count; only valid boards are written', () => {
    const plan = b.planSeeds({
      report: report(
        valid({ ats: 'greenhouse', token: 'acme', postings: 10, byCountry: { CN: 3, TW: 2, US: 4, DE: 1 }, mainland: 3, taiwan: 2, elsewhere: 5 }),
        valid({ ats: 'lever', token: 'pinecloud', employer: 'Pine Cloud', companyName: null, nameCheck: 'board_id_is_name', postings: 4, byCountry: { TW: 4 }, mainland: 0, taiwan: 4, elsewhere: 0 }),
        valid({ ats: 'ashby', token: 'harbor', employer: 'Harbor', companyName: null, nameCheck: 'board_id_is_name', postings: 6, byCountry: { CN: 6 }, mainland: 6, taiwan: 0, elsewhere: 0 }),
        { ats: 'greenhouse', token: 'gone', employer: 'Gone', valid: false, reason: 'not_found' },
        { ats: 'greenhouse', token: 'other', employer: 'Other', valid: false, reason: 'name_mismatch', companyName: 'Somebody Else', postings: 9, mainland: 9, taiwan: 0, elsewhere: 0, byCountry: { CN: 9 } },
      ),
    });
    expect(keys(plan.files.cn)).toEqual(['greenhouse:acme', 'ashby:harbor']);
    expect(keys(plan.files.tw)).toEqual(['greenhouse:acme', 'lever:pinecloud']);
    expect(keys(plan.files.intl)).toEqual(['greenhouse:acme']);
    expect(plan.files.cn.boards[0]).toEqual({
      ats: 'greenhouse',
      boardToken: 'acme',
      companyName: 'Acme',
      countries: [],
      postings: 3,
      postingCountries: ['CN'],
      verifiedOn: '2026-10-11',
      verifiedBy: 'live board API',
      note: 'docs/jobright-clone/market/BOARD_SEEDS.md: the live board answered on 2026-10-11 (scripts/board-seeds/report-2026-10-11.json); company name as the board states it',
      confirmedOn: '2026-10-11',
    });
    expect(plan.files.tw.boards[0]).toMatchObject({ postings: 2, postingCountries: ['TW'], countries: [] });
    expect(plan.files.intl.boards[0]).toMatchObject({ postings: 5, postingCountries: ['DE', 'US'], countries: [] });
    // Where the system states no company name, the name is the employer the board id spells, and the note says so.
    expect(plan.files.tw.boards[1]).toMatchObject({ companyName: 'Pine Cloud', postings: 4 });
    expect(plan.files.tw.boards[1].note).toContain("the system states no company name; the board id is the employer's name");
    expect(plan.leftOut).toEqual([]);
    expect(plan.takenOut).toEqual([]);
    expect(plan.summary).toMatchObject({ sources: 3, candidatesTried: { greenhouse: 3, lever: 1, ashby: 1 }, validBoards: { greenhouse: 1, lever: 1, ashby: 1 }, requests: 42 });
    expect(plan.summary.perFile.cn).toEqual({ all: { boards: 2, postings: 9 }, greenhouse: { boards: 1, postings: 3 }, ashby: { boards: 1, postings: 6 } });
  });

  it('a name the candidates file spelled out, and a board id a document confirms for an employer, are said in the note with the document', () => {
    const plan = b.planSeeds({
      report: report(
        valid({ ats: 'greenhouse', token: 'acme', companyName: 'Acme Robotics', nameCheck: 'stated_name_alias' }),
        valid({ ats: 'lever', token: 'pine-2', employer: 'Pine Cloud', companyName: null, nameCheck: 'board_id_alias', nameSource: 'docs/jobright-clone/market/JOB_SOURCES_TW.md 3.5' }),
      ),
    });
    expect(plan.files.intl.boards[0]).toMatchObject({ companyName: 'Acme Robotics' });
    expect(plan.files.intl.boards[0].note).toContain('a spelling scripts/board-seeds/candidates.jsonl lists for this employer');
    expect(plan.files.intl.boards[1]).toMatchObject({ companyName: 'Pine Cloud' });
    expect(plan.files.intl.boards[1].note).toContain('the system states no company name; docs/jobright-clone/market/JOB_SOURCES_TW.md 3.5 confirms this board id for this employer');
  });

  it('a board whose employer nothing confirms is written under its board id, never under the guessed name; so is a board-id alias that names no document', () => {
    const plan = b.planSeeds({
      report: report(
        valid({ ats: 'lever', token: 'pine-2', employer: 'Pine Cloud', companyName: null, nameCheck: 'board_id_only', byCountry: { CN: 2, US: 8 }, mainland: 2, elsewhere: 8 }),
        // A report of before the rule (or one edited by hand): an alias without its source is no confirmation.
        valid({ ats: 'ashby', token: 'quiet.io', employer: 'Quiet Mill', companyName: null, nameCheck: 'board_id_alias' }),
        valid({ ats: 'ashby', token: 'harbor.io', employer: 'Harbor Line', companyName: null, nameCheck: 'board_id_alias', nameSource: '  ' }),
      ),
    });
    for (const file of ['cn', 'intl'] as const) {
      const entry = plan.files[file].boards.find((e: Row) => e.boardToken === 'pine-2');
      expect(entry).toMatchObject({ companyName: 'pine-2' });
      expect(entry.note).toContain('no document confirms whose board this is: the entry carries its board id as the name');
    }
    expect(plan.files.intl.boards.map((e: Row) => [e.boardToken, e.companyName])).toEqual([['pine-2', 'pine-2'], ['harbor.io', 'harbor.io'], ['quiet.io', 'quiet.io']]);
    expect(JSON.stringify(plan.files)).not.toMatch(/Pine Cloud|Quiet Mill|Harbor Line/);
  });

  it('SmartRecruiters: CN and TW are named in their files; the international file reads the board whole, and only a listing read to its end of at most --sr-max postings', () => {
    const sr = (over: Row) => valid({ ats: 'smartrecruiters', employer: 'Harbor Foods', companyName: 'Harbor Foods', ...over });
    const plan = b.planSeeds({
      report: report(
        sr({ token: 'Small', postings: 300, byCountry: { CN: 20, TW: 5, DE: 200, FR: 75 }, mainland: 20, taiwan: 5, elsewhere: 275 }),
        sr({ token: 'Long', postings: 1888, byCountry: { CN: 149, TW: 18, US: 1721 }, mainland: 149, taiwan: 18, elsewhere: 1721 }),
        sr({ token: 'Cut', postings: 6434, read: 100, complete: false, byCountry: { FR: 100 }, mainland: 0, taiwan: 0, elsewhere: 100 }),
        // A board asked only with the API's country filter (never whole): the two country files and nothing else.
        sr({ token: 'Group', countries: ['CN'], postings: 1321, read: 100, byCountry: { CN: 1321 }, mainland: 1321, elsewhere: 0 }),
        sr({ token: 'Group', countries: ['TW'], postings: 4, read: 4, byCountry: { TW: 4 }, taiwan: 4, elsewhere: 0 }),
      ),
    });
    expect(plan.files.cn.boards.map((e: Row) => [e.boardToken, e.countries, e.postings])).toEqual([['Group', ['CN'], 1321], ['Long', ['CN'], 149], ['Small', ['CN'], 20]]);
    expect(plan.files.tw.boards.map((e: Row) => [e.boardToken, e.countries, e.postings])).toEqual([['Group', ['TW'], 4], ['Long', ['TW'], 18], ['Small', ['TW'], 5]]);
    expect(plan.files.intl.boards.map((e: Row) => [e.boardToken, e.countries, e.postings, e.postingCountries])).toEqual([['Small', [], 275, ['DE', 'FR']]]);
    expect(plan.leftOut).toEqual([
      { ats: 'smartrecruiters', token: 'Long', companyName: 'Harbor Foods', postings: 1888, reason: 'long_listing_not_read_whole', file: 'intl', seededFor: ['CN', 'TW'] },
      { ats: 'smartrecruiters', token: 'Cut', companyName: 'Harbor Foods', postings: 6434, reason: 'long_listing_not_read_whole', file: 'intl' },
    ]);
    // The limit is an argument.
    const wider = b.planSeeds({ report: report(sr({ token: 'Long', postings: 1888, byCountry: { US: 1888 }, elsewhere: 1888 })), limits: { ...b.DEFAULT_LIMITS, srMax: 2000 } });
    expect(keys(wider.files.intl)).toEqual(['smartrecruiters:Long']);
    expect(wider.files.intl.about).toContain('more than 2000 postings');
  });

  it('SmartRecruiters: where the report holds the listing asked with the API\'s country filter, that answer is the count of the mainland and the Taiwan file, not the whole listing\'s', () => {
    const sr = (over: Row) => valid({ ats: 'smartrecruiters', employer: 'Harbor Foods', companyName: 'Harbor Foods', ...over });
    const plan = b.planSeeds({
      report: report(
        // The whole listing counted 20 mainland and 5 Taiwan postings by the country code each row states.
        sr({ token: 'Small', postings: 300, byCountry: { CN: 20, TW: 5, DE: 275 }, mainland: 20, taiwan: 5, elsewhere: 275 }),
        // Asked again as the server asks it: 9 of the 20 rows are placed in mainland China by their own location line.
        sr({ token: 'Small', countries: ['CN'], postings: 20, read: 20, byCountry: { CN: 9 }, mainland: 9, elsewhere: 11, unplaced: 11 }),
        // One row stated CN in the whole listing; the filtered listing places none there. No Taiwan answer: the whole listing's count stands.
        sr({ token: 'Edge', postings: 40, byCountry: { CN: 1, TW: 2, FR: 37 }, mainland: 1, taiwan: 2, elsewhere: 37 }),
        sr({ token: 'Edge', countries: ['CN'], postings: 1, read: 1, byCountry: { HK: 1 }, mainland: 0, elsewhere: 1 }),
        // The filter answered with nothing at all (not a valid result): that is a count too.
        sr({ token: 'Empty', postings: 60, byCountry: { CN: 3, US: 57 }, mainland: 3, elsewhere: 57 }),
        { ats: 'smartrecruiters', token: 'Empty', employer: 'Harbor Foods', countries: ['CN'], valid: false, reason: 'no_postings', requests: 1 },
        // An empty answer for a board that is not valid at all changes nothing.
        { ats: 'smartrecruiters', token: 'Nobody', employer: 'Nobody', countries: ['CN'], valid: false, reason: 'no_postings', requests: 1 },
      ),
    });
    expect(plan.files.cn.boards.map((e: Row) => [e.boardToken, e.countries, e.postings])).toEqual([['Small', ['CN'], 9]]);
    expect(plan.files.tw.boards.map((e: Row) => [e.boardToken, e.countries, e.postings])).toEqual([['Edge', ['TW'], 2], ['Small', ['TW'], 5]]);
    // The international file is the whole listing's, read to its end.
    expect(plan.files.intl.boards.map((e: Row) => [e.boardToken, e.postings])).toEqual([['Edge', 37], ['Empty', 57], ['Small', 275]]);
    expect(plan.summary.validBoards).toEqual({ smartrecruiters: 3 });
    expect(plan.summary.candidatesTried).toEqual({ smartrecruiters: 4 });
  });

  it('a board the connector could not read in one answer is not seeded anywhere; a Lever EU board is reported only', () => {
    const plan = b.planSeeds({
      report: report(
        valid({ ats: 'greenhouse', token: 'huge', postings: 2725, byCountry: { US: 2700, TW: 25 }, taiwan: 25, elsewhere: 2700 }),
        // 815 postings answered with 90% of the connector's limit on the validation date: too close to seed.
        valid({ ats: 'ashby', token: 'big', employer: 'Big', companyName: null, nameCheck: 'board_id_is_name', postings: 815, elsewhere: 815 }),
        valid({ ats: 'ashby', token: 'fits', employer: 'Fits', companyName: null, nameCheck: 'board_id_is_name', postings: 650, elsewhere: 650 }),
        valid({ ats: 'greenhouse', token: 'edge', postings: 1001, byCountry: { US: 1001 }, elsewhere: 1001 }),
        valid({ ats: 'greenhouse', token: 'room', postings: 1000, byCountry: { US: 1000 }, elsewhere: 1000 }),
        valid({ ats: 'lever', token: 'paged', employer: 'Paged', companyName: null, nameCheck: 'board_id_is_name', postings: 5000, elsewhere: 5000 }),
        valid({ ats: 'lever_eu', token: 'pinecloud', employer: 'Pine Cloud', companyName: null, nameCheck: 'board_id_is_name', postings: 12, elsewhere: 12 }),
      ),
    });
    expect(keys(plan.files.intl)).toEqual(['greenhouse:room', 'lever:paged', 'ashby:fits']);
    expect(plan.files.tw.boards).toEqual([]);
    expect(plan.leftOut.map((x: Row) => [x.ats, x.token, x.reason])).toEqual([
      ['greenhouse', 'huge', 'one_answer_over_the_connector_limit'],
      ['ashby', 'big', 'one_answer_over_the_connector_limit'],
      ['greenhouse', 'edge', 'one_answer_over_the_connector_limit'],
      ['lever_eu', 'pinecloud', 'no_connector_for_this_host'],
    ]);
    expect(b.DEFAULT_LIMITS).toEqual({ srMax: 1000, greenhouseMax: 1000, ashbyMax: 650 });
    // The caps are arguments: a deployment whose connector reads larger answers can seed larger boards.
    const wider = b.planSeeds({ report: report(valid({ ats: 'ashby', token: 'big', employer: 'Big', companyName: null, nameCheck: 'board_id_is_name', postings: 815, elsewhere: 815 })), limits: { ...b.DEFAULT_LIMITS, ashbyMax: 850 } });
    expect(keys(wider.files.intl)).toEqual(['ashby:big']);
  });

  it('a board that has grown past a size cap is taken out of every file that listed it, and named: a deployment must not seed a board it cannot read', () => {
    const existing = {
      cn: { about: 'x', boards: [] },
      tw: { about: 'x', boards: [old({ ats: 'ashby', boardToken: 'big', companyName: 'Big' })] },
      intl: { about: 'x', boards: [old({ ats: 'ashby', boardToken: 'big', companyName: 'Big' }), old({ boardToken: 'gone' })] },
    };
    const plan = b.planSeeds({
      report: report(
        valid({ ats: 'ashby', token: 'big', employer: 'Big', companyName: null, nameCheck: 'board_id_is_name', postings: 815, byCountry: { TW: 5, US: 810 }, taiwan: 5, elsewhere: 810 }),
        { ats: 'greenhouse', token: 'gone', employer: 'Gone', valid: false, reason: 'not_found' },
      ),
      existing,
    });
    expect(keys(plan.files.tw)).toEqual([]);
    // An entry the report merely does not confirm is still kept and named, as before.
    expect(keys(plan.files.intl)).toEqual(['greenhouse:gone']);
    expect(plan.takenOut).toEqual([
      { file: 'tw', ats: 'ashby', boardToken: 'big', why: 'one_answer_over_the_connector_limit' },
      { file: 'intl', ats: 'ashby', boardToken: 'big', why: 'one_answer_over_the_connector_limit' },
    ]);
    expect(plan.keptAsTheyWere).toEqual([{ file: 'intl', ats: 'greenhouse', boardToken: 'gone', why: 'not_valid_in_this_report' }]);
    expect(plan.leftOut).toEqual([{ ats: 'ashby', token: 'big', companyName: 'Big', postings: 815, reason: 'one_answer_over_the_connector_limit' }]);
  });
});

describe('existing entries', () => {
  it('one the report confirms gets today\'s facts and keeps where and when it was first confirmed; a second refresh does not pile up notes', () => {
    const existing = { tw: { about: 'x', boards: [old({ companyName: 'acme' })] }, cn: { about: 'x', boards: [] }, intl: { about: 'x', boards: [] } };
    const first = b.planSeeds({ report: report(valid({ ats: 'greenhouse', token: 'acme', byCountry: { TW: 10 }, taiwan: 10, elsewhere: 0 })), existing });
    const entry = first.files.tw.boards[0];
    expect(entry).toMatchObject({ companyName: 'Acme', postings: 10, verifiedOn: '2026-10-11', verifiedBy: 'live board API', confirmedOn: '2026-09-01' });
    expect(entry.note).toBe(
      'docs/jobright-clone/market/JOB_SOURCES_TW.md 3.5: SYNTHETIC first confirmation; re-read 2026-10-11: scripts/board-seeds/report-2026-10-11.json (docs/jobright-clone/market/BOARD_SEEDS.md); company name as the board states it',
    );
    const later = { ...report(valid({ ats: 'greenhouse', token: 'acme', byCountry: { TW: 7 }, taiwan: 7, elsewhere: 0 })), date: '2026-11-20' };
    const second = b.planSeeds({ report: later, existing: { ...existing, tw: first.files.tw } });
    expect(second.files.tw.boards[0]).toMatchObject({ postings: 7, verifiedOn: '2026-11-20', confirmedOn: '2026-09-01' });
    expect(second.files.tw.boards[0].note).toBe(
      'docs/jobright-clone/market/JOB_SOURCES_TW.md 3.5: SYNTHETIC first confirmation; re-read 2026-11-20: scripts/board-seeds/report-2026-11-20.json (docs/jobright-clone/market/BOARD_SEEDS.md); company name as the board states it',
    );
    expect(second.keptAsTheyWere).toEqual([]);
  });

  it('writing the same report twice changes nothing; a board this builder added is re-read with one note behind the first', () => {
    const empty = { cn: { about: 'x', boards: [] }, tw: { about: 'x', boards: [] }, intl: { about: 'x', boards: [] } };
    const r = report(valid({ ats: 'greenhouse', token: 'acme', byCountry: { CN: 2, US: 8 }, mainland: 2, elsewhere: 8 }));
    const first = b.planSeeds({ report: r, existing: empty });
    const again = b.planSeeds({ report: r, existing: first.files });
    for (const name of ['cn', 'tw', 'intl']) expect(b.renderSeedFile(again.files[name])).toBe(b.renderSeedFile(first.files[name]));
    const later = b.planSeeds({ report: { ...r, date: '2026-11-20' }, existing: first.files });
    expect(later.files.cn.boards[0]).toMatchObject({ confirmedOn: '2026-10-11', verifiedOn: '2026-11-20' });
    expect(later.files.cn.boards[0].note).toBe(
      'docs/jobright-clone/market/BOARD_SEEDS.md: the live board answered on 2026-10-11 (scripts/board-seeds/report-2026-10-11.json); company name as the board states it; re-read 2026-11-20: scripts/board-seeds/report-2026-11-20.json (docs/jobright-clone/market/BOARD_SEEDS.md); company name as the board states it',
    );
  });

  it('one the report does not confirm is kept exactly as it was and named; never dropped', () => {
    const gone = old({ boardToken: 'gone' });
    const moved = old({ boardToken: 'moved' });
    const existing = { cn: { about: 'x', boards: [gone, moved] }, tw: { about: 'x', boards: [] }, intl: { about: 'x', boards: [] } };
    const plan = b.planSeeds({
      report: report({ ats: 'greenhouse', token: 'gone', employer: 'Gone', valid: false, reason: 'not_found' }, valid({ ats: 'greenhouse', token: 'moved', byCountry: { US: 10 }, mainland: 0, elsewhere: 10 })),
      existing,
    });
    expect(plan.files.cn.boards).toEqual([gone, moved]);
    expect(plan.keptAsTheyWere).toEqual([
      { file: 'cn', ats: 'greenhouse', boardToken: 'gone', why: 'not_valid_in_this_report' },
      { file: 'cn', ats: 'greenhouse', boardToken: 'moved', why: 'valid_but_no_posting_for_this_file' },
    ]);
    // The board that has postings elsewhere is also where they are.
    expect(keys(plan.files.intl)).toEqual(['greenhouse:moved']);
  });
});

describe('the files and the command', () => {
  it('a file is text with one board per line, sorted by system and board id, and parses back to the same boards', () => {
    const plan = b.planSeeds({ report: report(valid({ ats: 'lever', token: 'b', employer: 'B', companyName: null, nameCheck: 'board_id_is_name' }), valid({ ats: 'greenhouse', token: 'Zed' }), valid({ ats: 'greenhouse', token: 'acme' })) });
    const text = b.renderSeedFile(plan.files.intl);
    expect(JSON.parse(text)).toEqual(plan.files.intl);
    expect(keys(plan.files.intl)).toEqual(['greenhouse:acme', 'greenhouse:Zed', 'lever:b']);
    expect(text.split('\n').filter((l: string) => l.startsWith('    {'))).toHaveLength(3);
    expect(plan.files.intl.about).toMatch(/Nothing here is typed from memory/);
    expect(plan.files.cn.about).toMatch(/mainland China on 2026-10-11/);
    expect(plan.files.tw.about).toMatch(/Taiwan on 2026-10-11/);
  });

  it('without --write nothing is written; with it the three files are; a report with open candidates is refused', async () => {
    const disk = new Map<string, string>([
      ['r.json', JSON.stringify(report(valid({ ats: 'greenhouse', token: 'acme', byCountry: { CN: 1, US: 9 }, mainland: 1, elsewhere: 9 })))],
      ['dir/seeds.cn.json', JSON.stringify({ about: 'x', boards: [] })],
      ['dir/seeds.tw.json', JSON.stringify({ about: 'x', boards: [] })],
      ['dir/seeds.intl.json', JSON.stringify({ about: 'x', boards: [] })],
    ]);
    const said: string[] = [];
    const written: string[] = [];
    const deps = {
      readFile: (p: string) => {
        if (!disk.has(p)) throw new Error(`no such file ${p}`);
        return disk.get(p)!;
      },
      writeFile: (p: string, data: string) => {
        written.push(p);
        disk.set(p, data);
      },
      stdout: (l: string) => said.push(l),
      stderr: (l: string) => said.push(l),
    };
    expect(await b.main(['--report', 'r.json', '--seeds-dir', 'dir'], deps)).toBe(0);
    expect(written).toEqual([]);
    expect(said.join('\n')).toMatch(/seeds\.cn\.json: 1 boards, 1 postings[\s\S]*seeds\.intl\.json: 1 boards, 9 postings[\s\S]*Nothing written/);

    expect(await b.main(['--report', 'r.json', '--seeds-dir', 'dir', '--write'], deps)).toBe(0);
    expect(written).toEqual(['dir/seeds.cn.json', 'dir/seeds.tw.json', 'dir/seeds.intl.json']);
    expect(JSON.parse(disk.get('dir/seeds.cn.json')!).boards).toHaveLength(1);
    expect(JSON.parse(disk.get('dir/seeds.tw.json')!).boards).toEqual([]);

    disk.set('open.json', JSON.stringify({ ...report(), summary: { all: { open: 3 } } }));
    expect(await b.main(['--report', 'open.json', '--seeds-dir', 'dir', '--write'], deps)).toBe(2);
    expect(said.join('\n')).toMatch(/3 candidate\(s\) without a final answer/);
    expect(await b.main([], deps)).toBe(2);
    expect(await b.main(['--help'], deps)).toBe(0);
  });
});
