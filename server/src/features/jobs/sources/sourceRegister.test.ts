// @vitest-environment node
//
// The source register (MKT-5D; JI-12): docs/job-search/SOURCE_REGISTER.md has
// one row per provider id the code knows, with plan, quota, permitted
// surfaces, attribution, retention and the date read. This test reads the
// Markdown file from disk (no network) and fails when a provider id of
// PROVIDER_META has no row, when a row lacks a date read or another required
// cell, and when a site the strategy forbids (§1.6) appears among the
// providers. The checks are one pure function, so the test also proves that it
// DOES fail for each of those mistakes. The switch table (section 3) is held
// to the code as well: every variable it names is one the server's source
// reads.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { BRANDS } from '../../../platform/brand/index.js';
import { isDeniedHost } from '../import/index.js';
import { dailyCallLimit, publicDisplayProviders } from '../ingest/config.js';
import { ensureBuiltinAdapters } from '../ingest/providers.js';
import { NEVER_PUBLIC_DISPLAY_PROVIDERS, PROVIDER_META } from '../normalize/index.js';
import { sourceProvidersForBrand } from './index.js';
import './register.js';
import { TW_OPEN_DATA_ATTRIBUTIONS } from './twHooks.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REGISTER_PATH = join(HERE, '..', '..', '..', '..', '..', 'docs', 'job-search', 'SOURCE_REGISTER.md');
const REGISTER = readFileSync(REGISTER_PATH, 'utf8');
const PROVIDER_IDS = Object.keys(PROVIDER_META);

// ── Reading the Markdown ────────────────────────────────────────────────────

/** The text of a `## N. …` section, up to the next `## `. */
function section(markdown: string, number: number): string {
  const start = markdown.search(new RegExp(`^## ${number}\\. `, 'm'));
  if (start < 0) return '';
  const rest = markdown.slice(start + 3);
  const end = rest.search(/^## /m);
  return end < 0 ? rest : rest.slice(0, end);
}

/** The cells of one table line (`| a | b |`). A cell never holds a pipe in this document. */
const cells = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());

interface Table {
  header: string[];
  rows: Array<Record<string, string>>;
}

/** The first table of a section, each row keyed by the header's column names. */
function firstTable(text: string): Table {
  const lines = text.split('\n');
  const at = lines.findIndex((l, i) => l.trim().startsWith('|') && /^\|\s*:?-{3,}/.test(lines[i + 1]?.trim() ?? ''));
  if (at < 0) return { header: [], rows: [] };
  const header = cells(lines[at]!);
  const rows: Array<Record<string, string>> = [];
  for (const line of lines.slice(at + 2)) {
    if (!line.trim().startsWith('|')) break;
    const values = cells(line);
    rows.push(Object.fromEntries(header.map((name, i) => [name, values[i] ?? ''])));
  }
  return { header, rows };
}

/** The provider id of a row: the first `code` token of its first cell. */
const providerOf = (row: Record<string, string>, column: string): string | null => /`([a-z_]+)`/.exec(row[column] ?? '')?.[1] ?? null;

const COLUMNS = {
  id: 'Provider id',
  what: 'What it is and who publishes it',
  status: 'Status',
  plan: 'Plan and quota on the date read',
  surfaces: 'Permitted surfaces and their basis',
  attribution: 'Required attribution',
  retention: 'Retention on termination',
  terms: 'Terms (primary URL)',
  date: 'Date read',
  pending: 'Owner decision pending',
} as const;

/** Sites of MARKET_STRATEGY §1.6 that the import denylist (features/jobs/import) does not already name. */
const OTHER_FORBIDDEN_HOSTS = /(?:^|\.)(?:remotive\.(?:com|io)|myworkdayjobs\.com|serpapi\.com|apify\.com|brightdata\.com|mantiks\.io|qcc\.com|qichacha\.com)$/;
const isForbiddenHost = (host: string): boolean => isDeniedHost(host, {}) || OTHER_FORBIDDEN_HOSTS.test(host.toLowerCase());

/** Every host a text names: in a URL, or bare (`boards-api.greenhouse.io/v1/…`, `<tenant>.zhiye.com`). */
function hostsIn(text: string): string[] {
  const hosts = new Set<string>();
  for (const hit of text.matchAll(/(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?=[/\s`),;:]|$)/gi)) hosts.add(hit[1]!.toLowerCase());
  return [...hosts];
}

const realDate = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);

/**
 * What is wrong with a register text for the given provider ids. Empty when
 * nothing is. Pure: the tests below run it on the committed file and on
 * deliberately broken copies.
 */
function registerProblems(markdown: string, providerIds: readonly string[]): string[] {
  const problems: string[] = [];
  const table = firstTable(section(markdown, 1));
  if (table.rows.length === 0) return ['section 1 has no provider table'];
  for (const column of Object.values(COLUMNS)) if (!table.header.includes(column)) problems.push(`the provider table has no column "${column}"`);

  const seen = new Set<string>();
  for (const row of table.rows) {
    const id = providerOf(row, COLUMNS.id);
    const label = row[COLUMNS.id] || '(empty)';
    if (!id) {
      problems.push(`row ${label}: no provider id`);
      continue;
    }
    seen.add(id);
    if (!providerIds.includes(id)) problems.push(`row ${label}: "${id}" is not a provider id of the code`);
    for (const column of [COLUMNS.what, COLUMNS.status, COLUMNS.plan, COLUMNS.surfaces, COLUMNS.attribution, COLUMNS.retention, COLUMNS.terms, COLUMNS.pending]) {
      if (!row[column]?.trim()) problems.push(`row ${label}: "${column}" is empty`);
    }
    if (!realDate(row[COLUMNS.date] ?? '')) problems.push(`row ${label}: no date read`);
    if (!/^(?:on\b|off until |not a source$)/.test(row[COLUMNS.status] ?? '')) problems.push(`row ${label}: the status is not "on", "off until …" or "not a source"`);
    for (const host of hostsIn(Object.values(row).join(' '))) {
      if (isForbiddenHost(host)) problems.push(`row ${label}: names the forbidden site ${host}`);
    }
  }
  for (const id of providerIds) if (!seen.has(id)) problems.push(`provider "${id}" has no row`);
  return problems;
}

/** The committed register with one provider's rows taken out of section 1. */
function withoutRowsOf(markdown: string, id: string): string {
  const start = markdown.search(/^## 1\. /m);
  const end = markdown.search(/^## 2\. /m);
  const kept = markdown
    .slice(start, end)
    .split('\n')
    .filter((line) => !line.startsWith(`| \`${id}\``));
  return `${markdown.slice(0, start)}${kept.join('\n')}${markdown.slice(end)}`;
}

/** The committed register with one more row at the end of the provider table. */
function withRow(markdown: string, row: string): string {
  const marker = '\nNotes on the table:';
  return markdown.replace(marker, `${row}\n${marker}`);
}

// ── The switch table against the code ───────────────────────────────────────

const SERVER_SRC = join(HERE, '..', '..', '..');
let serverSource: string | null = null;

/** The text of every source file of the server: no test, no fixture, no generated client. Read once. */
function serverSourceText(): string {
  if (serverSource !== null) return serverSource;
  const parts: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === 'generated' || name === '__tests__' || name === '__fixtures__' || name === 'node_modules') continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')) parts.push(readFileSync(full, 'utf8'));
    }
  };
  walk(SERVER_SRC);
  serverSource = parts.join('\n');
  return serverSource;
}

/** Every environment variable a text names in code type: `NAME`, `NAME=value`. */
function envNamesIn(text: string): string[] {
  return [...new Set([...text.matchAll(/`([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)(?:=[^`]*)?`/g)].map((hit) => hit[1]!))];
}

/** `INGEST_<PROVIDER>_DAILY_CALLS` and `INGEST_<PROVIDER>_CN_DAILY_CALLS` are built from the provider id (ingest/config.ts). */
const DAILY_CALLS_NAME = /^INGEST_[A-Z]+(_CN)?_DAILY_CALLS$/;

function readByCode(name: string): boolean {
  const source = serverSourceText();
  if (new RegExp(`(?<![A-Z0-9_])${name}(?![A-Z0-9_])`).test(source)) return true;
  const family = DAILY_CALLS_NAME.exec(name);
  return !!family && source.includes(`}${family[1] ?? ''}_DAILY_CALLS\``);
}

/**
 * Variables that three bundles of the same phase add: the licensed feed
 * (MKT-5A), the board connectors (MKT-5B) and the syndication transport
 * (MKT-5E). The M5 bundles merge together and the register describes the
 * merged tree, so a tree that does not hold one of those bundles yet reads
 * none of its names. A bundle arrives whole: its names are read all together
 * or not at all. A group read in part means a variable was renamed or dropped
 * and the register has to follow. Once every group is read this list only
 * repeats the first check and can go.
 */
const ARRIVING_WITH: Readonly<Record<string, readonly string[]>> = {
  'MKT-5A': [
    'CN_ACTIVEJOBS_ENABLED',
    'FANTASTIC_API_KEY',
    'FANTASTIC_API_KEY_HEADER',
    'FANTASTIC_EXPIRED_PATH',
    'FANTASTIC_FEED_DISABLED',
    'FANTASTIC_FEED_PATH',
    'FANTASTIC_MONTHLY_JOBS',
    'FANTASTIC_TRANSPORT',
    'INGEST_FEED_CN_DAILY_JOBS',
    'INGEST_FEED_COUNTRIES',
    'INGEST_FEED_DAILY_JOBS',
    'INGEST_FEED_TAXONOMIES',
  ],
  'MKT-5B': ['ATS_WORKABLE_DISABLED', 'CN_ATS_BEISEN_ENABLED', 'CN_ATS_BEISEN_MAX_POSTINGS_PER_RUN', 'CN_ATS_TENANT_DENYLIST'],
  'MKT-5E': ['GOHIRE_SYNDICATION_KEY', 'INGEST_BANK_RESYNC_DAYS'],
};

/**
 * What is wrong with the variable names of a switch table, given which names
 * the code reads. Empty when nothing is. Pure, so the test below also runs it
 * on names it knows to be wrong.
 */
function switchProblems(names: readonly string[], isRead: (name: string) => boolean): string[] {
  const problems: string[] = [];
  const arriving = new Set(Object.values(ARRIVING_WITH).flat());
  for (const name of names) if (!isRead(name) && !arriving.has(name)) problems.push(`${name} is not read by the code`);
  for (const [bundle, group] of Object.entries(ARRIVING_WITH)) {
    const unread = group.filter((name) => !isRead(name));
    if (unread.length > 0 && unread.length < group.length) problems.push(`${bundle} is in the tree but the code does not read ${unread.join(', ')}`);
    for (const name of group) if (!names.includes(name)) problems.push(`${name} (${bundle}) is not in the switch table`);
  }
  return problems;
}

const providerRows = firstTable(section(REGISTER, 1)).rows;
const rowsOf = (id: string) => providerRows.filter((r) => providerOf(r, COLUMNS.id) === id);

// ── The committed register ──────────────────────────────────────────────────

describe('source register: one row per provider id', () => {
  it('JI-12: every provider id of PROVIDER_META has a row with plan, quota, permitted surfaces, attribution, retention and a date read', () => {
    expect(PROVIDER_IDS.length).toBeGreaterThanOrEqual(11);
    expect(registerProblems(REGISTER, PROVIDER_IDS)).toEqual([]);
    for (const id of PROVIDER_IDS) expect(rowsOf(id).length, id).toBeGreaterThanOrEqual(1);
    // Every other provider is one row; the employer boards have one per board system.
    for (const id of PROVIDER_IDS.filter((p) => p !== 'ats_public')) expect(rowsOf(id).length, id).toBe(1);
    for (const system of ['Greenhouse', 'Lever', 'Ashby', 'SmartRecruiters', 'Workable', 'Recruitee', 'Personio', '北森']) {
      expect(rowsOf('ats_public').some((r) => r[COLUMNS.id]!.includes(system)), system).toBe(true);
    }
  });

  it('JI-12: the check fails when a provider id is added without a row', () => {
    expect(registerProblems(REGISTER, [...PROVIDER_IDS, 'brand_new_source'])).toEqual(['provider "brand_new_source" has no row']);
    expect(registerProblems(withoutRowsOf(REGISTER, 'usajobs'), PROVIDER_IDS)).toEqual(['provider "usajobs" has no row']);
    expect(registerProblems(withoutRowsOf(REGISTER, 'tw_gov_jobs'), PROVIDER_IDS)).toEqual(['provider "tw_gov_jobs" has no row']);
  });

  it('JI-12: the check fails when a row lacks its date read or another required cell', () => {
    const usajobs = REGISTER.split('\n').find((line) => line.startsWith('| `usajobs`'))!;
    const parts = usajobs.split('|');
    // The table has ten columns: cell 9 is the date read, cell 7 the retention.
    expect(parts.length).toBe(12);
    const undated = [...parts];
    undated[9] = ' ';
    expect(registerProblems(REGISTER.replace(usajobs, undated.join('|')), PROVIDER_IDS)).toEqual(['row `usajobs`: no date read']);
    const wrongDate = [...parts];
    wrongDate[9] = ' last week ';
    expect(registerProblems(REGISTER.replace(usajobs, wrongDate.join('|')), PROVIDER_IDS)).toEqual(['row `usajobs`: no date read']);
    const noRetention = [...parts];
    noRetention[7] = '  ';
    expect(registerProblems(REGISTER.replace(usajobs, noRetention.join('|')), PROVIDER_IDS)).toEqual(['row `usajobs`: "Retention on termination" is empty']);
  });

  it('JI-12: the check fails when a forbidden site of strategy 1.6 appears as a provider', () => {
    const cellsFor = (first: string, what: string, terms: string) => `| ${first} | ${what} | on | Free. | Signed-in: yes. | None. | not stated | ${terms} | 2026-10-12 | None. |`;
    // A forbidden board added under an existing provider id.
    const asBoard = withRow(REGISTER, cellsFor('`ats_public` · 104', 'Job pages of www.104.com.tw read as HTML.', 'https://www.104.com.tw/terms'));
    expect(registerProblems(asBoard, PROVIDER_IDS)).toEqual(['row `ats_public` · 104: names the forbidden site www.104.com.tw']);
    // A forbidden site added as a provider of its own.
    const asProvider = withRow(REGISTER, cellsFor('`indeed`', 'Indeed search results.', 'https://www.indeed.com/legal'));
    expect(registerProblems(asProvider, PROVIDER_IDS)).toEqual(['row `indeed`: "indeed" is not a provider id of the code', 'row `indeed`: names the forbidden site www.indeed.com']);
    for (const host of ['www.linkedin.com', 'uk.indeed.com', 'www.glassdoor.com', 'www.zhipin.com', 'sou.zhaopin.com', 'www.liepin.com', 'we.51job.com', 'www.lagou.com', 'acme.jobs.feishu.cn', 'app.mokahr.com', 'www.1111.com.tw', 'www.cake.me', 'www.yourator.co', 'www.518.com.tw', 'www.yes123.com.tw', 'meet.jobs', 'remotive.com', 'acme.wd5.myworkdayjobs.com', 'serpapi.com', 'openapi.qcc.com']) {
      const broken = withRow(REGISTER, cellsFor('`jsearch`', `Reads ${host} directly.`, 'none'));
      expect(registerProblems(broken, PROVIDER_IDS), host).toContain(`row \`jsearch\`: names the forbidden site ${host}`);
    }
    // A status outside the three words is a problem too.
    const vague = REGISTER.replace(/(\| `user_import` \|[^|]*\| )on \(both brands\)/, '$1maybe');
    expect(vague).not.toBe(REGISTER);
    expect(registerProblems(vague, PROVIDER_IDS)).toEqual(['row `user_import`: the status is not "on", "off until …" or "not a source"']);
  });
});

describe('source register: what the rows say agrees with the code', () => {
  it('the dropped LinkedIn feed is registered as not a source, and no brand has it', () => {
    ensureBuiltinAdapters();
    for (const brand of Object.values(BRANDS)) expect(sourceProvidersForBrand(brand, {}), brand.id).not.toContain('linkedin');
    expect(rowsOf('linkedin')[0]![COLUMNS.status]).toBe('not a source');
    // A provider a brand does have is never written off as "not a source".
    const live = new Set(Object.values(BRANDS).flatMap((brand) => sourceProvidersForBrand(brand, {})));
    for (const id of live) for (const row of rowsOf(id)) expect(row[COLUMNS.status], id).not.toBe('not a source');
    // The three sources of this folder are RoboApply's and never GoApply's.
    for (const id of ['tw_open_data', 'tw_gov_jobs', 'usajobs'] as const) {
      expect(sourceProvidersForBrand(BRANDS.roboapply, {}), id).toContain(id);
      expect(sourceProvidersForBrand(BRANDS.goapply, {}), id).not.toContain(id);
    }
  });

  it('prints the two OGDL attribution sentences verbatim, as the code prints them', () => {
    for (const board of ['tw_open_data', 'tw_gov_jobs'] as const) {
      const sentence = TW_OPEN_DATA_ATTRIBUTIONS[board]!(9999).replace('9999', '{year}');
      expect(rowsOf(board)[0]![COLUMNS.attribution], board).toContain(`\`${sentence}\``);
      expect(rowsOf(board)[0]![COLUMNS.attribution]).toContain('https://data.gov.tw/license');
      expect(rowsOf(board)[0]![COLUMNS.terms]).toContain('https://data.gov.tw/license');
    }
  });

  it('never LinkedIn branding for the aggregators, and no made-up answer where the terms are silent', () => {
    for (const id of ['activejobs', 'jsearch'] as const) expect(rowsOf(id)[0]![COLUMNS.attribution], id).toMatch(/never LinkedIn branding|No LinkedIn name, logo or URL/);
    // What the research notes leave open stays open in the register.
    expect(rowsOf('jsearch')[0]![COLUMNS.surfaces]).toContain('unresolved');
    expect(rowsOf('jsearch')[0]![COLUMNS.surfaces]).toContain('Public: never');
    expect(rowsOf('activejobs')[0]![COLUMNS.surfaces]).toContain('Public: unresolved');
    expect(rowsOf('activejobs')[0]![COLUMNS.retention]).toContain('not stated');
    for (const row of rowsOf('ats_public')) expect(row[COLUMNS.retention], row[COLUMNS.id]).toBe('not stated');
    // The plan figures of the date read, each with its place in a research note.
    expect(rowsOf('activejobs')[0]![COLUMNS.plan]).toMatch(/25 requests and 250 jobs a month.*\(STRATEGY 1\.1; INTL 3\.1\)/);
    expect(rowsOf('jsearch')[0]![COLUMNS.plan]).toMatch(/10,000 requests a month.*\(STRATEGY 1\.1; INTL 3\.1\)/);
    // The 北森 connector is off until counsel signs off, behind its flag.
    const beisen = rowsOf('ats_public').find((r) => r[COLUMNS.id]!.includes('北森'))!;
    expect(beisen[COLUMNS.status]).toMatch(/^off until counsel signs off; flag `CN_ATS_BEISEN_ENABLED` \(default off\)/);
  });

  it('every figure and licence statement of a row names where it comes from', () => {
    const cited = /\((?:[^()]*\b(?:INTL|TW|CN|STRATEGY) \d[^()]*|[^()]*read 2026-10-12[^()]*)\)/;
    for (const row of providerRows) {
      const label = row[COLUMNS.id]!;
      // Our own banks and a user's import state no third-party figure, and two rows point at another row
      // (the dropped feed, and the window feed of the same vendor); every other row cites its plan and its surfaces.
      const citesElsewhere = ['bank_robohire', 'bank_gohire', 'user_import', 'linkedin', 'activejobs_feed'].includes(providerOf(row, COLUMNS.id)!);
      if (!citesElsewhere) {
        expect(row[COLUMNS.plan], `${label}: plan`).toMatch(cited);
        expect(row[COLUMNS.surfaces], `${label}: surfaces`).toMatch(cited);
      }
      expect(row[COLUMNS.what], `${label}: what`).toMatch(/\((?:[^()]*\b(?:INTL|TW|CN|STRATEGY) [\dMC][^()]*)\)|Dropped by decision M-4/);
    }
  });

  it('section 2 lists the forbidden sources of strategy 1.6, each with its reason', () => {
    const forbidden = firstTable(section(REGISTER, 2));
    expect(forbidden.header).toEqual(['Source', 'Why not']);
    const text = forbidden.rows.map((r) => r.Source).join(' | ');
    for (const name of ['Indeed', 'LinkedIn', 'Glassdoor', 'Apify', 'Bright Data', 'Mantiks', 'SerpApi', 'Workday', 'career-site HTML', 'Remotive', '104', '1111', '518', 'yes123', 'Cake', 'Yourator', 'Meet.jobs', 'BOSS直聘', '智联', '猎聘', '前程无忧', '拉勾', '飞书招聘', 'Moka', 'MCP servers', 'scraped postings', '企查查', 'country=cn']) {
      expect(text, name).toContain(name);
    }
    expect(forbidden.rows.find((r) => r.Source!.includes('LinkedIn'))!['Why not']).toContain("candidate's own LinkedIn session");
    for (const row of forbidden.rows) expect(row['Why not'], row.Source).toMatch(/\((?:INTL|TW|CN|STRATEGY) \d/);
  });

  it('section 3 names the switch of every provider, and the switches of the two new sources as the code reads them', () => {
    const switches = firstTable(section(REGISTER, 3));
    expect(switches.header).toEqual(['Provider', 'On when', 'Turn it off with', 'Other settings']);
    const named = new Set(switches.rows.map((r) => providerOf(r, 'Provider')).filter(Boolean));
    for (const id of PROVIDER_IDS) expect(named.has(id), id).toBe(true);
    const row = (id: string) => switches.rows.find((r) => providerOf(r, 'Provider') === id)!;
    expect(row('usajobs')['On when']).toContain('`USAJOBS_API_KEY`');
    expect(row('usajobs')['On when']).toContain('`USAJOBS_USER_AGENT_EMAIL`');
    expect(row('usajobs')['Turn it off with']).toContain('`USAJOBS_DISABLED=true`');
    expect(row('tw_gov_jobs')['Turn it off with']).toContain('`TW_GOV_JOBS_ENABLED=false`');
    expect(row('tw_gov_jobs')['Other settings']).toContain('`TW_GOV_JOBS_URL`');
    expect(row('tw_gov_jobs')['Other settings']).toContain('`TW_GOV_JOBS_INCLUDE_TRANSFERS=true`');
    expect(row('tw_open_data')['Turn it off with']).toContain('`TW_OPEN_DATA_JOBS_ENABLED=false`');
    expect(row('ats_public')['Turn it off with']).toContain('`ATS_PUBLIC_SOURCES_DISABLED=true`');
    // No secret value is written anywhere in the file: a key is named, never given.
    expect(REGISTER).not.toMatch(/(?:API_KEY|_KEY|_SECRET)\s*=\s*[A-Za-z0-9]/);
  });

  it('section 3: every variable the switch table names is one the code reads', () => {
    const names = envNamesIn(section(REGISTER, 3));
    expect(names.length).toBeGreaterThanOrEqual(55);
    expect(switchProblems(names, readByCode)).toEqual([]);
    // The variables of this folder's three sources and the common ones are read in any tree.
    for (const name of ['USAJOBS_API_KEY', 'USAJOBS_USER_AGENT_EMAIL', 'USAJOBS_DISABLED', 'TW_GOV_JOBS_ENABLED', 'TW_GOV_JOBS_URL', 'TW_GOV_JOBS_INCLUDE_TRANSFERS', 'TW_OPEN_DATA_JOBS_ENABLED', 'ATS_PUBLIC_SOURCES_DISABLED', 'JOB_PROVIDERS_ROBOAPPLY', 'RAPID_API_KEY']) {
      expect(names, name).toContain(name);
      expect(readByCode(name), name).toBe(true);
    }
    // The two names built from a provider id are read the way the table writes them.
    expect(dailyCallLimit('activejobs', { INGEST_ACTIVEJOBS_DAILY_CALLS: '7' })).toBe(7);
    expect(dailyCallLimit('jsearch', { INGEST_JSEARCH_DAILY_CALLS: '7' })).toBe(7);
    expect(readByCode('INGEST_ACTIVEJOBS_CN_DAILY_CALLS')).toBe(true);

    // The check does fail: a name nothing reads, a name the table lost, and a bundle read in part.
    expect(readByCode('USAJOBS_API_KEYS')).toBe(false);
    expect(readByCode('JOBS_API_KEY')).toBe(false);
    expect(switchProblems([...names, 'TW_GOV_JOBS_NO_SUCH_SWITCH'], readByCode)).toContain('TW_GOV_JOBS_NO_SUCH_SWITCH is not read by the code');
    expect(switchProblems(names.filter((n) => n !== 'ATS_WORKABLE_DISABLED'), readByCode)).toContain('ATS_WORKABLE_DISABLED (MKT-5B) is not in the switch table');
    // A merged tree in which one variable of the feed was renamed: everything is read but that name.
    expect(switchProblems(names, (name) => name !== 'FANTASTIC_FEED_PATH')).toEqual(['MKT-5A is in the tree but the code does not read FANTASTIC_FEED_PATH']);
    // The merged tree as the register describes it: every name is read.
    expect(switchProblems(names, () => true)).toEqual([]);
  });

  it('a status describes what the code does, never a merge that is still to come', () => {
    for (const number of [1, 3] as const) {
      for (const row of firstTable(section(REGISTER, number)).rows) {
        for (const [column, cell] of Object.entries(row)) {
          expect(cell, `section ${number}, ${column}`).not.toMatch(/\bMKT-\d|\bphase M\d|\bis merged\b|\bto be built\b|\bplanned\b/i);
        }
      }
    }
    const status = (system: string) => rowsOf('ats_public').find((r) => r[COLUMNS.id]!.includes(system))![COLUMNS.status]!;
    // The connectors that are on without a flag, and the two sources that wait: for a plan and for counsel.
    for (const system of ['Greenhouse', 'Lever', 'Ashby', 'SmartRecruiters', 'Workable', 'Recruitee', 'Personio']) expect(status(system), system).toMatch(/^on\b/);
    expect(status('Workable')).toContain('`ATS_WORKABLE_DISABLED=true`');
    expect(status('北森')).toMatch(/^off until counsel signs off/);
    expect(rowsOf('activejobs_feed')[0]![COLUMNS.status]).toMatch(/^off until the plan's monthly job quota is at least 20,000/);
    expect(rowsOf('usajobs')[0]![COLUMNS.status]).toMatch(/^off until a key is set/);
    for (const id of ['tw_open_data', 'tw_gov_jobs'] as const) expect(rowsOf(id)[0]![COLUMNS.status], id).toBe('on');
  });

  it('section 4: tw_open_data and usajobs are the recommended first entries of PUBLIC_DISPLAY_PROVIDERS, and the default stays empty', () => {
    const text = section(REGISTER, 4);
    expect(text).toContain('**Its default is empty and stays empty until the owner decides**');
    // The code's default is empty too.
    expect(publicDisplayProviders({})).toEqual([]);
    const candidates = firstTable(text);
    const row = (id: string) => candidates.rows.find((r) => (r.Provider ?? '').includes(`\`${id}\``))!;
    expect(row('tw_open_data')['Candidate?']).toContain('Yes, recommended first entry');
    expect(row('usajobs')['Candidate?']).toContain('Yes, recommended first entry');
    // The providers the code never marks public are "Never" here as well.
    for (const never of NEVER_PUBLIC_DISPLAY_PROVIDERS) expect(row(never)['Candidate?'], never).toBe('Never.');
    expect(row('user_import')['Candidate?']).toBe('Never.');
    for (const waiting of ['ats_public', 'activejobs']) expect(row(waiting)['Candidate?'], waiting).toBe('Not yet.');
    for (const id of PROVIDER_IDS) expect(candidates.rows.some((r) => (r.Provider ?? '').includes(`\`${id}\``)), id).toBe(true);
  });

  it('the register invents no source: every provider table names only provider ids of the code', () => {
    for (const [number, column] of [
      [1, COLUMNS.id],
      [3, 'Provider'],
      [4, 'Provider'],
    ] as const) {
      for (const row of firstTable(section(REGISTER, number)).rows) {
        for (const hit of (row[column] ?? '').matchAll(/`([a-z_]+)`/g)) expect(PROVIDER_IDS, `section ${number}: ${hit[1]}`).toContain(hit[1]);
      }
    }
  });
});
