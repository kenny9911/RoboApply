#!/usr/bin/env node
// scripts/board-seeds/build-seeds.mjs: the three seed files of the employer
// boards, written from a validation report and from nothing else
// (MARKET_STRATEGY.md 1.2, 1.3, 1.4; requirements JI-3, JC-4, JT-5; ruling D3).
//
//   node scripts/board-seeds/build-seeds.mjs --report scripts/board-seeds/report-<date>.json [--write]
//
// Asks nothing and reads no clock. Input: the report ./validate.mjs wrote (what
// each candidate board answered on the report's date) and the seed files as
// they are. Output: server/src/features/jobs/sources/atsPublic/seeds.cn.json,
// seeds.tw.json and seeds.intl.json. Without --write it only prints what it
// would write (the counts per market and job-board system, and every board it
// leaves out with the reason).
//
// Which board goes where. Only a board the report calls valid (it answered on
// that date with at least one posting and the right company name):
//
//   seeds.cn.json    at least one posting located in mainland China
//   seeds.tw.json    at least one posting located in Taiwan
//   seeds.intl.json  at least one posting located anywhere else, or not placed
//
// One board can be in two or three files; the server merges them into ONE
// source per (job-board system, board id) (seeds.ts). `postings` in a file is
// the board's count for THAT file's place on the report's date, so the three
// counts of a board add up to its postings (a posting located in two of the
// three places counts in both).
//
// `countries` is what the board is READ for, as the server understands it
// (empty = the whole board; each posting then lands in the market of its own
// location). Greenhouse, Lever and Ashby list a whole board in one listing:
// always empty. SmartRecruiters is asked per country when codes are named:
//   - in the mainland and the Taiwan file it names CN / TW, so a long board is
//     read for that country alone. Its count there is that of the listing
//     asked with the API's country filter (the listing the server reads for
//     that file) where the report has one, else the whole listing's;
//   - in the international file it is read whole (empty), and only when its
//     listing was read to its end and is at most --sr-max postings long
//     (default 1000, ten listing requests per read). A longer board is left
//     out of the international file and reported: reading it whole is a
//     decision for the owner, not for a list.
//
// A board the server's connector could not read, or is close to not reading,
// is not seeded at all. A Greenhouse or an Ashby board sends every posting
// text in ONE answer, the connector refuses an answer over 15 MB (shared.ts
// MAX_RESPONSE_BYTES), and the third refusal in a row switches the source off
// and archives its open postings two days later. The caps are posting counts,
// because a count is what the report holds; a count is only a stand-in for a
// size (one posting took from about 7,700 characters of an answer to 17,447
// on the boards measured), so they leave more than a quarter of the limit
// free at the density of the ONE answer measured for each system when the
// caps were set (MEASURED_CHARS_PER_POSTING): --greenhouse-max 1000 (11.4
// million characters at SpaceX's 11,433 a posting, 73% of the limit) and
// --ashby-max 650 (11.3 million at OpenAI's 17,447, 72%). A board above its
// cap is reported, not written. `lever_eu` boards are reported only: no
// connector reads that host yet.
//
// KNOWN GAP (M4 cross-review; docs/jobright-clone/market/BOARD_SEEDS.md 3.1):
// a count cap does not bound a size. A SEEDED Greenhouse board is denser than
// the calibration: `coupang` answered 11,048,005 characters for 673 postings
// (16,416 a posting, 70% of the limit; it reaches the limit at about 958
// postings, under the cap). The fix is to record each large board's answer
// size in the report and to leave a board out above 75% of the limit
// (requests/waveM4-carryover.md, MKT-5B.1), not to lower the count cap.
//
// The name of an entry is what the board's answer stated. Where the system
// states none (Lever, Ashby) it is the employer the board id spells, or the
// employer a document confirms for that board id (`nameSource` in the report).
// A board whose employer nothing confirms (`board_id_only`) is written under
// its board id: the placeholder the server already knows and replaces when a
// later list or an admin names the board. A name is never taken from a guess.
//
// Existing entries are kept: one the report calls valid gets today's facts and
// keeps where and when it was first confirmed; one the report does not call
// valid is left exactly as it is and named in the output, never dropped. One
// exception, also named in the output: an entry of a board that has grown past
// a size cap above is taken out of every file, because the cap is there to
// keep a deployment from seeding a board it cannot read.
//
// Plain Node (24 or newer), no dependency. scripts/board-seeds/build-seeds.test.ts
// covers the rules.

import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const USAGE = `usage: node scripts/board-seeds/build-seeds.mjs --report <report.json> [--write] [options]

Writes the three employer-board seed files from a validation report. Asks nothing.

  --report <file>        the report of scripts/board-seeds/validate.mjs
  --write                write the files (without it: print what would be written)
  --seeds-dir <dir>      where the seed files are (default server/src/features/jobs/sources/atsPublic)
  --sr-max <n>           longest SmartRecruiters board read whole for the international file (default 1000 postings)
  --greenhouse-max <n>   largest Greenhouse board seeded (default 1000 postings; one answer must stay well under 15 MB)
  --ashby-max <n>        largest Ashby board seeded (default 650 postings; same limit)
  --help                 this text`;

/** The systems the server's connectors read (sources/atsPublic/contract.ts PUBLIC_ATS), in the order the files list them. */
export const SEEDABLE_ATS = ['greenhouse', 'lever', 'ashby', 'smartrecruiters'];
export const SEED_FILES = ['cn', 'tw', 'intl'];
export const DEFAULT_LIMITS = { srMax: 1000, greenhouseMax: 1000, ashbyMax: 650 };
/**
 * The answer the caps were calibrated on for each one-answer system, in
 * characters a posting, with the connector's own URL on 2026-10-11: Greenhouse
 * `spacex` 31,155,380 characters for 2,725 postings; Ashby `openai` 14,219,219
 * for 815. seeds.test.ts holds the caps above to the connector's limit with
 * these. NOT the densest board there is: seeded `greenhouse/coupang` measures
 * 16,416 a posting (see the header's KNOWN GAP). Do not simply raise the
 * Greenhouse value to that: the 75% rule would then cap at 718 postings and
 * drop Databricks (62% measured) for no reason.
 */
export const MEASURED_CHARS_PER_POSTING = { greenhouse: 11_433, ashby: 17_447 };
export const DEFAULT_SEEDS_DIR = 'server/src/features/jobs/sources/atsPublic';
/** Where the method is written down; every entry's note names it. */
export const METHOD_DOC = 'docs/jobright-clone/market/BOARD_SEEDS.md';
const REREAD_MARK = '; re-read ';

export class UsageError extends Error {}

export function parseArgs(argv) {
  const out = { help: false, report: null, write: false, seedsDir: DEFAULT_SEEDS_DIR, ...DEFAULT_LIMITS };
  const int = (name, raw) => {
    if (!/^\d+$/.test(String(raw ?? ''))) throw new UsageError(`${name} needs a whole number`);
    return Number.parseInt(raw, 10);
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new UsageError(`${arg} needs a value`);
      i += 1;
      return v;
    };
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--report') out.report = value();
    else if (arg === '--write') out.write = true;
    else if (arg === '--seeds-dir') out.seedsDir = value();
    else if (arg === '--sr-max') out.srMax = int(arg, value());
    else if (arg === '--greenhouse-max') out.greenhouseMax = int(arg, value());
    else if (arg === '--ashby-max') out.ashbyMax = int(arg, value());
    else throw new UsageError(`unknown argument ${arg}`);
  }
  if (!out.help && !out.report) throw new UsageError('--report is required');
  return out;
}

const keyOf = (b) => `${b.ats}:${b.boardToken ?? b.token}`;
const sortedCodes = (byCountry, drop = []) =>
  Object.keys(byCountry ?? {})
    .filter((c) => /^[A-Z]{2}$/.test(c) && !drop.includes(c))
    .sort();

/** How the report confirmed the board's name, in the words of an entry's note. */
function nameClause(board) {
  switch (board.nameCheck) {
    case 'stated_name_alias':
      return 'company name as the board states it (a spelling scripts/board-seeds/candidates.jsonl lists for this employer)';
    case 'board_id_is_name':
      return "the system states no company name; the board id is the employer's name";
    case 'board_id_alias':
      return `the system states no company name; ${board.nameSource} confirms this board id for this employer`;
    case 'board_id_only':
      return 'the system states no company name and no document confirms whose board this is: the entry carries its board id as the name until someone names it';
    default:
      return 'company name as the board states it';
  }
}

/** A board id listed for an employer counts as the employer's only with the document that confirms it. */
const nameCheckOf = (r) => (r.nameCheck === 'board_id_alias' && !(typeof r.nameSource === 'string' && r.nameSource.trim()) ? 'board_id_only' : r.nameCheck);

/**
 * What the report measured for each valid board, one record per (system, board
 * id): its name, how the name was confirmed, and its postings in mainland
 * China, in Taiwan and elsewhere. A SmartRecruiters board can have several
 * results (the whole listing, and one per country asked with the API's
 * filter); they are put together here.
 */
export function boardsOf(results) {
  const boards = new Map();
  for (const r of results) {
    if (r.valid !== true) continue;
    const key = keyOf(r);
    let b = boards.get(key);
    if (!b) boards.set(key, (b = { ats: r.ats, token: r.token, companyName: null, nameCheck: null, nameSource: null, whole: null, filtered: {} }));
    // The name: what the board stated; else the employer its board id spells or a document confirms for it;
    // else, where nothing confirms whose board it is, the board id itself.
    const check = nameCheckOf(r);
    const name = typeof r.companyName === 'string' && r.companyName.trim() ? r.companyName.trim() : check === 'board_id_only' ? r.token : r.employer;
    if (!b.companyName || !(r.countries?.length > 0)) {
      b.companyName = name;
      b.nameCheck = check;
      b.nameSource = check === 'board_id_alias' ? r.nameSource.trim() : null;
    }
    if (r.countries?.length > 0) for (const c of r.countries) b.filtered[c] = (r.byCountry ?? {})[c] ?? 0;
    else b.whole = r;
  }
  // A listing asked with the API's country filter that came back empty is that country's count as well: none.
  for (const r of results) {
    if (r.valid === true || r.reason !== 'no_postings' || !(r.countries?.length > 0)) continue;
    const b = boards.get(keyOf(r));
    if (b) for (const c of r.countries) b.filtered[c] ??= 0;
  }
  return [...boards.values()].map((b) => {
    const whole = b.whole;
    const wholeKnown = !!whole && whole.complete !== false;
    // The listing asked with the API's country filter is the listing the server reads for the mainland and the
    // Taiwan file: its count is the measure where the report has one. Else the whole listing's count.
    const place = (code, field) => b.filtered[code] ?? (whole ? whole[field] : 0);
    return {
      ats: b.ats,
      token: b.token,
      companyName: b.companyName,
      nameCheck: b.nameCheck,
      nameSource: b.nameSource,
      postings: whole ? whole.postings : Object.values(b.filtered).reduce((n, v) => n + v, 0),
      complete: wholeKnown,
      readWhole: !!whole,
      mainland: place('CN', 'mainland'),
      taiwan: place('TW', 'taiwan'),
      elsewhere: whole ? whole.elsewhere : 0,
      otherCountries: whole ? sortedCodes(whole.byCountry, ['CN', 'TW']) : [],
    };
  });
}

/**
 * Where an entry was confirmed. A new board: this report. A board that was
 * there keeps where it was first confirmed, and the re-read is written behind
 * it (once: an earlier re-read is replaced, and writing the same report twice
 * changes nothing).
 */
function noteFor(old, date, reportFile, clause) {
  const fresh = `${METHOD_DOC}: the live board answered on ${date} (${reportFile}); ${clause}`;
  if (!old) return fresh;
  const first = String(old.note).split(REREAD_MARK)[0];
  if (first.startsWith(`${METHOD_DOC}: the live board answered on ${date} `)) return fresh;
  return `${first}${REREAD_MARK}${date}: ${reportFile} (${METHOD_DOC}); ${clause}`;
}

/**
 * The three files as they should be, and everything left out with its reason.
 * Pure: `existing` is the seed files as parsed JSON ({ cn, tw, intl }, each
 * { about, boards }), `report` the validation report.
 */
export function planSeeds({ report, existing = {}, limits = DEFAULT_LIMITS }) {
  const date = report.date;
  const reportFile = `scripts/board-seeds/report-${date}.json`;
  const boards = boardsOf(report.results ?? []);
  const byKey = new Map(boards.map((b) => [keyOf(b), b]));
  const files = { cn: [], tw: [], intl: [] };
  const leftOut = [];
  // Boards no file may hold, whatever the files held before: the server could not read them.
  const unreadable = new Map();

  for (const b of boards) {
    if (!SEEDABLE_ATS.includes(b.ats)) {
      leftOut.push({ ats: b.ats, token: b.token, companyName: b.companyName, postings: b.postings, reason: 'no_connector_for_this_host' });
      unreadable.set(keyOf(b), 'no_connector_for_this_host');
      continue;
    }
    const cap = b.ats === 'greenhouse' ? limits.greenhouseMax : b.ats === 'ashby' ? limits.ashbyMax : null;
    if (cap !== null && b.postings > cap) {
      leftOut.push({ ats: b.ats, token: b.token, companyName: b.companyName, postings: b.postings, reason: 'one_answer_over_the_connector_limit' });
      unreadable.set(keyOf(b), 'one_answer_over_the_connector_limit');
      continue;
    }
    const sr = b.ats === 'smartrecruiters';
    if (b.mainland > 0) files.cn.push({ board: b, countries: sr ? ['CN'] : [], postings: b.mainland, postingCountries: ['CN'] });
    if (b.taiwan > 0) files.tw.push({ board: b, countries: sr ? ['TW'] : [], postings: b.taiwan, postingCountries: ['TW'] });
    if (sr && !(b.readWhole && b.complete && b.postings <= limits.srMax)) {
      // Too long to read whole from a seed list (or its whole listing was never asked for): the two country files only.
      if (b.readWhole) leftOut.push({ ats: b.ats, token: b.token, companyName: b.companyName, postings: b.postings, reason: 'long_listing_not_read_whole', file: 'intl', ...(b.mainland > 0 || b.taiwan > 0 ? { seededFor: [b.mainland > 0 ? 'CN' : null, b.taiwan > 0 ? 'TW' : null].filter(Boolean) } : {}) });
      continue;
    }
    if (b.elsewhere > 0) files.intl.push({ board: b, countries: [], postings: b.elsewhere, postingCountries: b.otherCountries });
  }

  const order = (a, b) => SEEDABLE_ATS.indexOf(a.ats) - SEEDABLE_ATS.indexOf(b.ats) || a.boardToken.toLowerCase().localeCompare(b.boardToken.toLowerCase()) || a.boardToken.localeCompare(b.boardToken);
  const kept = [];
  const takenOut = [];
  const out = {};
  for (const name of SEED_FILES) {
    const before = new Map((existing[name]?.boards ?? []).map((e) => [keyOf(e), e]));
    const entries = files[name].map(({ board, countries, postings, postingCountries }) => {
      const old = before.get(keyOf(board));
      const clause = nameClause(board);
      before.delete(keyOf(board));
      return {
        ats: board.ats,
        boardToken: board.token,
        companyName: board.companyName,
        countries,
        postings,
        postingCountries,
        verifiedOn: date,
        verifiedBy: report.verifiedBy ?? 'live board API',
        note: noteFor(old, date, reportFile, clause),
        confirmedOn: old?.confirmedOn ?? date,
      };
    });
    // An existing entry this report does not put into this file: kept as it is, and said. Not one of a board the
    // server could not read: that entry is taken out, and said.
    for (const old of before.values()) {
      const why = unreadable.get(keyOf(old));
      if (why) {
        takenOut.push({ file: name, ats: old.ats, boardToken: old.boardToken, why });
        continue;
      }
      const measured = byKey.get(keyOf(old));
      kept.push({ file: name, ats: old.ats, boardToken: old.boardToken, why: measured ? 'valid_but_no_posting_for_this_file' : 'not_valid_in_this_report' });
      entries.push(old);
    }
    out[name] = { about: ABOUT[name](date, reportFile, limits), boards: entries.sort(order) };
  }
  return { date, files: out, leftOut, keptAsTheyWere: kept, takenOut, summary: summarize(out, report) };
}

const SHARED_ABOUT = (date, reportFile) =>
  `Nothing here is typed from memory: a board is in this file only because its live board answered scripts/board-seeds/validate.mjs on ${date} with at least one posting and passed the name check (${reportFile}; method and counts: ${METHOD_DOC}). ` +
  'companyName is what the answer stated (Greenhouse, SmartRecruiters); Lever and Ashby state none, so it is the employer name the board id spells or a document confirms for it, and the board id itself where nothing confirms whose board it is (the note says which). ' +
  'postingCountries are the ISO codes its counted postings were located in. All counts come from location fields only and are those of that day, never a live number. ' +
  'A deployment loads the files of the markets it serves (seeds.ts): the mainland file and no other where GoApply alone is served, the international and the Taiwan file where RoboApply alone is, all three where both are. ' +
  'A board is ONE source there whatever file names it: countries is what it is READ for, and empty means the whole board, each posting landing in the market of its own location.';

const ABOUT = {
  cn: (date, reportFile) =>
    `Employer boards that listed at least one posting located in mainland China on ${date}. postings is the number of the board's postings located in mainland China that day. ` +
    `Greenhouse, Lever and Ashby boards are read whole (countries is empty); a SmartRecruiters board is asked per country and names CN here. ${SHARED_ABOUT(date, reportFile)}`,
  tw: (date, reportFile) =>
    `Employer boards that listed at least one posting located in Taiwan on ${date}. postings is the number of the board's postings located in Taiwan that day. ` +
    `Greenhouse, Lever and Ashby boards are read whole (countries is empty); a SmartRecruiters board is asked per country and names TW here. ${SHARED_ABOUT(date, reportFile)}`,
  intl: (date, reportFile, limits) =>
    `Employer boards that listed at least one posting located outside mainland China and Taiwan (or with no place the location fields name) on ${date}. postings is the number of those postings that day. ` +
    `Every board in this file is read whole (countries is empty), a SmartRecruiters board included; a SmartRecruiters board with more than ${limits.srMax} postings is not in this file. ${SHARED_ABOUT(date, reportFile)}`,
};

/** Boards and postings per file and job-board system, the merged number of sources, and the candidates tried. */
export function summarize(files, report) {
  const perFile = {};
  const merged = new Set();
  for (const name of SEED_FILES) {
    const rows = { all: { boards: 0, postings: 0 } };
    for (const b of files[name].boards) {
      merged.add(keyOf(b));
      for (const k of [b.ats, 'all']) {
        rows[k] ??= { boards: 0, postings: 0 };
        rows[k].boards += 1;
        rows[k].postings += typeof b.postings === 'number' ? b.postings : 0;
      }
    }
    perFile[name] = rows;
  }
  const tried = {};
  const seenCandidate = new Set();
  for (const r of report.results ?? []) {
    const key = keyOf(r);
    if (seenCandidate.has(key)) continue;
    seenCandidate.add(key);
    tried[r.ats] = (tried[r.ats] ?? 0) + 1;
  }
  const validBoards = {};
  for (const b of boardsOf(report.results ?? [])) validBoards[b.ats] = (validBoards[b.ats] ?? 0) + 1;
  return { perFile, sources: merged.size, candidatesTried: tried, validBoards, requests: report.requests ?? null };
}

/** A seed file as text: the note about the list, then one board per line. */
export function renderSeedFile(file) {
  const lines = file.boards.map((b) => `    ${JSON.stringify(b)}`);
  return `{\n  "about": ${JSON.stringify(file.about)},\n  "boards": [\n${lines.join(',\n')}\n  ]\n}\n`;
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const out = deps.stdout ?? ((line) => console.log(line));
  const err = deps.stderr ?? ((line) => console.error(line));
  const readFile = deps.readFile ?? ((path) => readFileSync(path, 'utf8'));
  const writeFile = deps.writeFile ?? ((path, data) => writeFileSync(path, data));
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    err(`${e instanceof UsageError ? e.message : String(e)}\n\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    out(USAGE);
    return 0;
  }
  let report;
  const existing = {};
  try {
    report = JSON.parse(readFile(args.report));
    if (typeof report?.date !== 'string' || !Array.isArray(report.results)) throw new Error('not a validation report');
    for (const name of SEED_FILES) existing[name] = JSON.parse(readFile(`${args.seedsDir}/seeds.${name}.json`));
  } catch (e) {
    err(`cannot read the inputs: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  const open = report.summary?.all?.open ?? 0;
  if (open > 0) {
    err(`${args.report} still has ${open} candidate(s) without a final answer. Finish the validation first.`);
    return 2;
  }
  const plan = planSeeds({ report, existing, limits: { srMax: args.srMax, greenhouseMax: args.greenhouseMax, ashbyMax: args.ashbyMax } });

  out(`Seed files from ${args.report} (validation date ${plan.date}, ${plan.summary.requests ?? '?'} requests):`);
  for (const name of SEED_FILES) {
    const rows = plan.summary.perFile[name];
    out(`  seeds.${name}.json: ${rows.all.boards} boards, ${rows.all.postings} postings  ${SEEDABLE_ATS.filter((a) => rows[a]).map((a) => `${a} ${rows[a].boards} / ${rows[a].postings}`).join(', ')}`);
  }
  out(`  one source per board across the three files: ${plan.summary.sources}`);
  out(`  candidates tried: ${JSON.stringify(plan.summary.candidatesTried)}; valid boards: ${JSON.stringify(plan.summary.validBoards)}`);
  for (const b of plan.leftOut) out(`  left out${b.file ? ` of seeds.${b.file}.json` : ''}: ${b.ats}/${b.token} (${b.companyName}, ${b.postings} postings): ${b.reason}${b.seededFor ? `; seeded for ${b.seededFor.join(', ')}` : ''}`);
  for (const k of plan.takenOut) out(`  taken out of seeds.${k.file}.json, where it was listed: ${k.ats}/${k.boardToken}: ${k.why}`);
  for (const k of plan.keptAsTheyWere) out(`  kept as it was in seeds.${k.file}.json: ${k.ats}/${k.boardToken}: ${k.why}`);
  if (!args.write) {
    out('Nothing written (pass --write).');
    return 0;
  }
  for (const name of SEED_FILES) writeFile(`${args.seedsDir}/seeds.${name}.json`, renderSeedFile(plan.files[name]));
  out(`Written: ${SEED_FILES.map((n) => `${args.seedsDir}/seeds.${n}.json`).join(', ')}`);
  return 0;
}

export function isEntryPoint(argv1 = process.argv[1], moduleUrl = import.meta.url) {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      console.error(e instanceof Error ? e.message : String(e));
      process.exitCode = 1;
    },
  );
}
