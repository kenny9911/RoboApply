// server/src/features/skills/cli.ts — owner tooling for the skill vocabulary (SM-6; MATCH 4.6, 8 decision 6).
//
//   npx tsx server/src/features/skills/cli.ts <command> [options] [--apply]
//
// EVERY COMMAND IS A DRY RUN UNLESS --apply IS GIVEN: it prints what it would
// write and writes nothing (no row, no file, no model call, no embedding
// call). These commands are run by the owner or the orchestrator, never by a
// work-package engineer against a database.
//
//   export-strings --market intl|cn|all [--out skills-strings.csv]
//       Read-only count of the distinct strings of RAJob.skills and
//       RAJob.skillsDetail over public, canonical, live postings, with the
//       number of postings that carry each. --apply writes the local file.
//   propose [--in skills-strings.csv] [--out skills-clusters.csv] [--with-model] [--top 200]
//       Deterministic clusters of those strings (cluster.ts). With
//       --with-model and --apply the configured model also names the top N
//       clusters and proposes aliases and Chinese labels; its output goes to
//       columns named "proposed…" and is never written to RASkill by any
//       command without a reviewer's decision.
//   review-export [--top 1000] [--clusters skills-clusters.csv] [--out skills-review.csv]
//       The review sheet: id, kind, labelEn, labelZh, labelZhHant, aliases,
//       parentId, decision (+ mentions, note). From the clusters file when
//       given, else from RASkill ordered by mention count.
//   review-import <csv>
//       Rows with a decision are applied: `keep` (upsert, status reviewed),
//       `merge-into:<id>` (the names move to that skill), `drop` (the string
//       is never a skill again). Refuses the whole file when it would make one
//       alias key point at two ids, or on any invalid row.
//   attach-ids [--esco <file>] [--onet <file>] [--<source>-id-column id] [--<source>-label-column label] [--<source>-alt-column <name>]
//       Sets esco / onet where a label of the local file equals one of our
//       labels or aliases exactly (case-insensitive). The files are supplied
//       by the owner after approving those sources. Nothing is downloaded and
//       no Lightcast data is read. Column names are read from the file's own
//       header and passed with the flags: none is assumed here.
//   embed-labels [--market intl|cn] [--batch 96] [--all] [--replace-model]
//       Writes RASkill.embedding for reviewed skills that lack one for the
//       current embedding model. Needs the embeddings client
//       (platform/embeddings/client.ts); without it the command says so.
//       RASkill holds ONE vector per skill: when skills already carry a vector
//       of another model the command refuses, because writing over them ends
//       the embedding step for the market that uses that model.
//       --replace-model says that is intended.
//   export-seed
//       Carries the review decisions of the table into the committed seed, so
//       a fresh environment starts with them: reviewed rows that differ from
//       the generated seed → seed/reviewed.json; alias keys and identifiers
//       the table added to a seed skill → seed/additions.json; dropped seed
//       skills and dropped strings → seed/dropped.json; then
//       seed/skills.seed.json is regenerated from the three. The command adds
//       to what the three files already hold: a decision made in another
//       database is kept unless a row of this table says otherwise.
//
// A row an automatic step makes for a seed skill (embed-labels, attach-ids,
// the target of a merge) has the status `seed` and decides nothing: the skill
// stays what the committed seed says (canonicalize.ts `missingRowOf`).
//
// Importing this file opens no database connection and no network: every
// command works on the dependencies it is given (`runSkillsCommand`), and the
// real ones are created only by `main`.

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ExtendedPrismaClient } from '../../lib/prisma.js';
import { foldTwToCn } from '../jobs/normalize/index.js';
import { displayTerm } from './terms.js';
import { missingRowOf, rowOfRecord, SKILL_EMBED_DIMENSIONS } from './canonicalize.js';
import { clusterSkillStrings, type SkillCluster, type SkillString } from './cluster.js';
import { delimiterOf, formatCsv, joinList, parseTable, splitList, type Table } from './csv.js';
import { aliasKey, hasHan } from './keys.js';
import { createMemorySkillRepo, type SkillRepo, type SkillRow, type SkillWrite } from './repo.js';
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
  type SeedAddition,
  type SeedDropped,
  type SeedSkill,
} from './seed/build.js';
import { SEED_DROPPED_KEYS, SEED_SKILL_IDS, SEED_SKILLS } from './seed/index.js';
import { SKILL_KINDS, SKILL_STATUS_DROPPED, type AliasConflict, type SkillKind, type SkillRecord, type SkillSnapshot } from './types.js';
import { buildVocabulary, mergeOverSeed } from './vocabulary.js';

export const SKILLS_COMMANDS = ['export-strings', 'propose', 'review-export', 'review-import', 'attach-ids', 'embed-labels', 'export-seed'] as const;
export type SkillsCommand = (typeof SKILLS_COMMANDS)[number];

export const SKILLS_USAGE = `Usage: tsx server/src/features/skills/cli.ts <${SKILLS_COMMANDS.join('|')}> [options] [--apply]
Without --apply nothing is written (dry run). See the header of cli.ts for the options of each command.`;

export const DEFAULT_STRINGS_FILE = 'skills-strings.csv';
export const DEFAULT_CLUSTERS_FILE = 'skills-clusters.csv';
export const DEFAULT_REVIEW_FILE = 'skills-review.csv';
export const DEFAULT_REVIEW_TOP = 1000;
export const DEFAULT_MODEL_TOP = 200;
export const DEFAULT_EMBED_BATCH = 96;
/** Changes printed per command. */
export const SAMPLE_SIZE = 20;

export type SkillsMarket = 'intl' | 'cn';

export interface SkillsArgs {
  command: SkillsCommand;
  apply: boolean;
  flags: Record<string, string | true>;
  positional: string[];
}

const BOOLEAN_FLAGS = new Set(['apply', 'with-model', 'all', 'replace-model']);
const VALUE_FLAGS = new Set([
  'market', 'out', 'in', 'top', 'clusters', 'batch',
  'esco', 'onet', 'esco-id-column', 'esco-label-column', 'esco-alt-column', 'onet-id-column', 'onet-label-column', 'onet-alt-column',
]);

/** Command line → options. Throws with the usage text on bad input. A dry run unless --apply is given. */
export function parseSkillsArgs(argv: readonly string[]): SkillsArgs {
  const fail = (message: string): never => {
    throw new Error(`${message}\n${SKILLS_USAGE}`);
  };
  let command: string | null = null;
  const flags: Record<string, string | true> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const name = a.slice(2);
      if (BOOLEAN_FLAGS.has(name)) flags[name] = true;
      else if (VALUE_FLAGS.has(name)) {
        const value = argv[++i];
        if (value === undefined || value.startsWith('--')) fail(`--${name} needs a value.`);
        flags[name] = value!;
      } else fail(`Unknown option ${a}.`);
    } else if (command === null) command = a;
    else positional.push(a);
  }
  if (!command || !(SKILLS_COMMANDS as readonly string[]).includes(command)) fail(command ? `Unknown command ${command}.` : 'Name a command.');
  return { command: command as SkillsCommand, apply: flags.apply === true, flags, positional };
}

/** Local files, so a test never touches the disk. */
export interface CliIo {
  exists(file: string): boolean;
  readFile(file: string): string;
  writeFile(file: string, text: string): void;
}

/** What the model returns for one cluster. A proposal, never a vocabulary entry. */
export interface ClusterProposal {
  id: string;
  labelEn: string | null;
  labelZh: string | null;
  labelZhHant: string | null;
  aliases: string[];
}

export interface ClusterNamer {
  /** The model's name, written beside each proposal. */
  model: string;
  name(clusters: ReadonlyArray<{ id: string; label: string; members: string[] }>): Promise<ClusterProposal[]>;
}

export interface LabelEmbedder {
  /** The tag stored in RASkill.embeddingModel. */
  model: string;
  /** Null when the client is unavailable: nothing is written, never a made-up vector. */
  embed(texts: string[]): Promise<number[][] | null>;
}

export interface LabelVectorStore {
  embeddedIds(model: string): Promise<string[]>;
  /** Rows that carry a vector made by a model other than `model`, with that model. */
  otherModels(model: string): Promise<Array<{ id: string; model: string }>>;
  write(id: string, vector: number[], model: string): Promise<boolean>;
}

export interface SkillsCliDeps {
  io: CliIo;
  repo: SkillRepo;
  /** Default: the committed seed. */
  seed?: readonly SkillRecord[];
  /** Keys the seed lists as dropped. Default: those of the committed seed when `seed` is not given, else none. */
  seedDroppedKeys?: readonly string[];
  /** export-strings: the read-only count for one market. */
  queryStrings?: (market: SkillsMarket) => Promise<SkillString[]>;
  /** propose --with-model. */
  namer?: ClusterNamer | null;
  /** embed-labels. */
  embedder?: LabelEmbedder | null;
  vectors?: LabelVectorStore | null;
  /** export-seed: where the four seed files are. */
  seedPath?: string;
  reviewedPath?: string;
  additionsPath?: string;
  droppedPath?: string;
}

export interface SkillsReport {
  command: SkillsCommand;
  apply: boolean;
  lines: string[];
  /** Files written (empty in a dry run). */
  files: string[];
  /** Rows of RASkill created or changed (0 in a dry run). */
  rows: number;
  /** False when the command refused (bad file, collision, missing dependency). */
  ok: boolean;
}

function flag(args: SkillsArgs, name: string): string | undefined {
  const v = args.flags[name];
  return typeof v === 'string' ? v : undefined;
}

function positiveInt(args: SkillsArgs, name: string, fallback: number): number {
  const raw = flag(args, name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`--${name} needs a whole number above 0.\n${SKILLS_USAGE}`);
  return n;
}

function head(report: SkillsReport, title: string): void {
  report.lines.push(`${report.command} · ${report.apply ? 'APPLIED' : 'DRY RUN: nothing was written'}${title ? ` · ${title}` : ''}`);
}

function tail(report: SkillsReport): void {
  if (!report.apply && report.ok) report.lines.push('Run again with --apply to write this.');
}

function sample<T>(report: SkillsReport, what: string, items: readonly T[], line: (item: T) => string): void {
  if (!items.length) return;
  report.lines.push(`${what} (${Math.min(items.length, SAMPLE_SIZE)} of ${items.length}):`);
  for (const item of items.slice(0, SAMPLE_SIZE)) report.lines.push(`  ${line(item)}`);
}

/** The seed a command works over: the committed one, or the one a test gives. */
export interface SeedBase {
  seed: readonly SkillRecord[];
  seedIds: ReadonlySet<string>;
  seedDroppedKeys: readonly string[];
}

function seedBaseOf(given: { seed?: readonly SkillRecord[]; seedDroppedKeys?: readonly string[] }): SeedBase {
  if (!given.seed) return { seed: SEED_SKILLS, seedIds: SEED_SKILL_IDS, seedDroppedKeys: given.seedDroppedKeys ?? SEED_DROPPED_KEYS };
  return { seed: given.seed, seedIds: new Set(given.seed.map((r) => r.id)), seedDroppedKeys: given.seedDroppedKeys ?? [] };
}

interface Loaded extends SeedBase {
  rows: SkillRow[];
  records: SkillRecord[];
  droppedKeys: string[];
  vocabulary: SkillSnapshot;
}

/** The vocabulary as the application would load it: RASkill over the seed. One read. */
async function loadAll(deps: SkillsCliDeps): Promise<Loaded> {
  const base = seedBaseOf(deps);
  const rows = await deps.repo.list();
  const merged = mergeOverSeed(base.seed, rows, { seedDroppedKeys: base.seedDroppedKeys });
  return { ...base, rows, ...merged, vocabulary: buildVocabulary(merged.records, { droppedKeys: merged.droppedKeys, source: 'database' }) };
}

// ── export-strings ────────────────────────────────────────────────────────

const STRINGS_HEADER = ['market', 'term', 'mentions', 'kind'];

async function exportStrings(args: SkillsArgs, deps: SkillsCliDeps, report: SkillsReport): Promise<void> {
  const market = flag(args, 'market');
  if (market !== 'intl' && market !== 'cn' && market !== 'all') throw new Error(`--market must be intl, cn or all.\n${SKILLS_USAGE}`);
  const out = flag(args, 'out') ?? DEFAULT_STRINGS_FILE;
  head(report, `market ${market}`);
  if (!deps.queryStrings) {
    report.ok = false;
    report.lines.push('No database reader was given: nothing was counted.');
    return;
  }
  const table: Array<Array<string | number>> = [STRINGS_HEADER];
  for (const m of (market === 'all' ? ['intl', 'cn'] : [market]) as SkillsMarket[]) {
    const strings = await deps.queryStrings(m);
    const total = strings.reduce((n, s) => n + s.mentions, 0);
    report.lines.push(`Market ${m}: ${strings.length} distinct strings, ${total} mentions (read only).`);
    for (const s of strings) table.push([m, s.term, s.mentions, s.kind ?? '']);
  }
  report.lines.push(`${report.apply ? 'Wrote' : 'Would write'} ${table.length - 1} rows to ${out}.`);
  if (report.apply) {
    deps.io.writeFile(out, formatCsv(table));
    report.files.push(out);
  }
}

/** The strings of a strings file, both markets added up (the vocabulary is one for both brands). */
export function readStringsFile(text: string): SkillString[] {
  const table = parseTable(text);
  for (const column of ['term', 'mentions']) if (!table.header.includes(column)) throw new Error(`The strings file has no "${column}" column.`);
  return table.rows.map((r) => ({ term: r.term ?? '', mentions: Number(r.mentions) || 0, kind: r.kind || null }));
}

// ── propose ───────────────────────────────────────────────────────────────

const CLUSTERS_HEADER = ['clusterId', 'label', 'members', 'mentions', 'kind', 'knownId', 'proposedLabelEn', 'proposedLabelZh', 'proposedLabelZhHant', 'proposedAliases', 'proposedBy'];
const MEMBER_MARK = { key: '', near: '~', phrase: '+' } as const;

function memberCell(cluster: SkillCluster): string {
  return joinList(cluster.members.map((m) => `${MEMBER_MARK[m.via]}${m.term}×${m.mentions}`));
}

/** One member cell back into its parts ("~Postgressql×2" → near, "Postgressql", 2). */
export function parseMember(cell: string): { term: string; mentions: number; via: 'key' | 'near' | 'phrase' } {
  const m = cell.match(/^([~+]?)(.*?)×(\d+)$/s);
  if (!m) return { term: cell.replace(/^[~+]/, ''), mentions: 0, via: 'key' };
  return { term: m[2]!, mentions: Number(m[3]), via: m[1] === '~' ? 'near' : m[1] === '+' ? 'phrase' : 'key' };
}

async function propose(args: SkillsArgs, deps: SkillsCliDeps, report: SkillsReport): Promise<void> {
  const input = flag(args, 'in') ?? DEFAULT_STRINGS_FILE;
  const out = flag(args, 'out') ?? DEFAULT_CLUSTERS_FILE;
  const withModel = args.flags['with-model'] === true;
  const top = positiveInt(args, 'top', DEFAULT_MODEL_TOP);
  head(report, `from ${input}`);
  if (!deps.io.exists(input)) {
    report.ok = false;
    report.lines.push(`${input} does not exist. Run export-strings --apply first.`);
    return;
  }
  const strings = readStringsFile(deps.io.readFile(input));
  const { vocabulary } = await loadAll(deps);
  const { clusters, skipped } = clusterSkillStrings(strings, { vocabulary });
  const known = clusters.filter((c) => c.knownId).length;
  report.lines.push(`${strings.length} strings → ${clusters.length} clusters (${known} already in the vocabulary, ${clusters.length - known} new); ${skipped} strings left out (blank or a sentence).`);

  const proposals = new Map<string, ClusterProposal>();
  let proposedBy = '';
  if (withModel) {
    const subjects = clusters.slice(0, top).map((c) => ({ id: c.id, label: c.label, members: c.members.map((m) => m.term) }));
    if (!deps.namer) {
      report.lines.push('--with-model: no model is configured, so no cluster was named.');
    } else if (!report.apply) {
      report.lines.push(`--with-model: would ask ${deps.namer.model} to name the top ${subjects.length} clusters (no call in a dry run).`);
    } else {
      const wanted = new Set(subjects.map((s) => s.id));
      for (const p of await deps.namer.name(subjects)) if (wanted.has(p.id)) proposals.set(p.id, p);
      proposedBy = `proposed by ${deps.namer.model}, not reviewed`;
      report.lines.push(`--with-model: ${deps.namer.model} named ${proposals.size} of ${subjects.length} clusters. Its output is a proposal: only review-import writes to RASkill.`);
    }
  }

  const table: Array<Array<string | number>> = [CLUSTERS_HEADER];
  for (const c of clusters) {
    const p = proposals.get(c.id);
    table.push([c.id, c.label, memberCell(c), c.mentions, c.kind, c.knownId ?? '', p?.labelEn ?? '', p?.labelZh ?? '', p?.labelZhHant ?? '', p ? joinList(p.aliases) : '', p ? proposedBy : '']);
  }
  sample(report, 'Largest clusters', clusters, (c) => `${c.mentions} · ${c.label}${c.knownId ? ` (= ${c.knownId})` : ''} · ${memberCell(c)}`);
  report.lines.push(`${report.apply ? 'Wrote' : 'Would write'} ${clusters.length} clusters to ${out}.`);
  if (report.apply) {
    deps.io.writeFile(out, formatCsv(table));
    report.files.push(out);
  }
}

// ── review-export ─────────────────────────────────────────────────────────

export const REVIEW_HEADER = ['id', 'kind', 'labelEn', 'labelZh', 'labelZhHant', 'aliases', 'parentId', 'decision', 'mentions', 'note'];
/** An alias cell entry that is a stored comparison key, not a spelling. */
export const KEY_PREFIX = 'key:';

/** The alias cell of a skill: its spellings, then every stored key no label or spelling gives, as `key:<key>`. */
function aliasCell(record: SkillRecord, vocabulary: SkillSnapshot): string {
  const given = new Set([record.labelEn, record.labelZh, record.labelZhHant, ...record.aliases, record.id.replace(/_/g, ' ')].filter((n): n is string => !!n).map(aliasKey));
  const keys = vocabulary.keysOf(record.id).filter((k) => !given.has(k));
  return joinList([...record.aliases, ...keys.map((k) => `${KEY_PREFIX}${k}`)]);
}

function reviewRowsFromClusters(table: Table, vocabulary: SkillSnapshot, top: number): Array<Array<string | number>> {
  for (const column of ['clusterId', 'label', 'members', 'mentions']) if (!table.header.includes(column)) throw new Error(`The clusters file has no "${column}" column.`);
  const rows = [...table.rows].sort((a, b) => Number(b.mentions) - Number(a.mentions) || (a.clusterId! < b.clusterId! ? -1 : 1)).slice(0, top);
  return rows.map((r) => {
    const known = r.knownId ? vocabulary.record(r.knownId) : null;
    const label = r.label ?? '';
    const members = splitList(r.members ?? '').map(parseMember);
    const proposed = !!r.proposedBy;
    // A new cluster takes the id the write path would give the string (its key), so the two never become two rows.
    const id = known?.id ?? r.clusterId!;
    const chinese = hasHan(label);
    const simplified = chinese && foldTwToCn(label) === label;
    const labelEn = known?.labelEn ?? (r.proposedLabelEn || (chinese ? '' : displayTerm(label)));
    const labelZh = known?.labelZh ?? (r.proposedLabelZh || (chinese && simplified ? label : ''));
    const labelZhHant = known?.labelZhHant ?? (r.proposedLabelZhHant || (chinese && !simplified ? label : ''));
    const labelKeys = new Set([labelEn, labelZh, labelZhHant, id.replace(/_/g, ' ')].filter(Boolean).map(aliasKey));
    const seen = new Set<string>();
    const aliases: string[] = [];
    for (const name of [...(known?.aliases ?? []), ...members.map((m) => m.term), ...splitList(r.proposedAliases ?? '')]) {
      const key = aliasKey(name);
      if (!key || labelKeys.has(key) || seen.has(key)) continue;
      seen.add(key);
      aliases.push(name);
    }
    const note = [known ? `known: ${known.id}` : 'new', proposed ? r.proposedBy : ''].filter(Boolean).join(' · ');
    return [id, known?.kind ?? (r.kind || 'hard'), labelEn, labelZh ?? '', labelZhHant ?? '', joinList(aliases), known?.parentId ?? '', '', r.mentions ?? '', note];
  });
}

async function reviewExport(args: SkillsArgs, deps: SkillsCliDeps, report: SkillsReport): Promise<void> {
  const top = positiveInt(args, 'top', DEFAULT_REVIEW_TOP);
  const clustersFile = flag(args, 'clusters');
  const out = flag(args, 'out') ?? DEFAULT_REVIEW_FILE;
  const loaded = await loadAll(deps);
  let rows: Array<Array<string | number>>;
  if (clustersFile) {
    head(report, `top ${top} clusters of ${clustersFile}`);
    if (!deps.io.exists(clustersFile)) {
      report.ok = false;
      report.lines.push(`${clustersFile} does not exist. Run propose --apply first.`);
      return;
    }
    rows = reviewRowsFromClusters(parseTable(deps.io.readFile(clustersFile)), loaded.vocabulary, top);
  } else {
    head(report, `top ${top} rows of RASkill by mention count`);
    const byMentions = await deps.repo.listByMentions({ limit: top, notStatus: SKILL_STATUS_DROPPED });
    rows = byMentions.flatMap((r) => {
      // A row that is no skill (the copy of a skill the seed no longer has) is not reviewed.
      const record = loaded.vocabulary.record(r.id);
      if (!record) return [];
      // Only a row a reviewer already kept is pre-set to keep. A `seed` row is not a decision: left blank, it stays
      // what the committed seed says; set to keep, it becomes a reviewed row with what this line holds.
      return [[r.id, record.kind, record.labelEn, record.labelZh ?? '', record.labelZhHant ?? '', aliasCell(record, loaded.vocabulary), record.parentId ?? '', r.status === 'reviewed' ? 'keep' : '', r.mentionCount, r.status]];
    });
  }
  report.lines.push(`${rows.length} rows. Set "decision" to keep, drop or merge-into:<id>; a row with no decision is skipped by review-import.`);
  report.lines.push(`${report.apply ? 'Wrote' : 'Would write'} ${rows.length} rows to ${out}.`);
  if (report.apply) {
    deps.io.writeFile(out, formatCsv([REVIEW_HEADER, ...rows]));
    report.files.push(out);
  }
}

// ── review-import ─────────────────────────────────────────────────────────

export interface ReviewPlan {
  errors: string[];
  /** Rows to create when missing (the seed skill a merge or an alias goes to). */
  ensure: SkillWrite[];
  /** Rows to create or replace. */
  upserts: SkillWrite[];
  /** Keys to add to an existing row. */
  addKeys: Array<{ id: string; keys: string[] }>;
  kept: string[];
  dropped: string[];
  merged: Array<{ from: string; into: string }>;
  undecided: number;
}

const conflictId = (c: AliasConflict) => `${c.key}\u0000${[c.keptId, c.lostId].sort().join('\u0000')}`;

/** Apply a plan to a repo: the one order `review-import --apply` and its rehearsal both use. */
async function applyReviewPlan(repo: SkillRepo, plan: ReviewPlan): Promise<void> {
  await repo.createMissing(plan.ensure);
  await repo.upsert(plan.upserts);
  for (const a of plan.addKeys) await repo.addAliasKeys(a.id, a.keys);
}

/**
 * What a reviewed sheet changes. Nothing is written here: the plan is
 * rehearsed on a copy of the rows, and the vocabulary the application would
 * load afterwards (the rows over the seed) is checked. Any error refuses the
 * whole sheet (`errors` is then not empty and nothing may be applied).
 */
export async function planReviewImport(table: Table, given: { seed: readonly SkillRecord[]; rows: readonly SkillRow[]; seedDroppedKeys?: readonly string[] }): Promise<ReviewPlan> {
  const base = { ...seedBaseOf(given), rows: given.rows };
  const merge = (rows: readonly SkillRow[]) => mergeOverSeed(base.seed, rows, { seedDroppedKeys: base.seedDroppedKeys });
  const plan: ReviewPlan = { errors: [], ensure: [], upserts: [], addKeys: [], kept: [], dropped: [], merged: [], undecided: 0 };
  for (const column of REVIEW_HEADER.slice(0, 8)) if (!table.header.includes(column)) plan.errors.push(`The sheet has no "${column}" column.`);
  if (plan.errors.length) return plan;

  const mergedBefore = merge(base.rows);
  const before = buildVocabulary(mergedBefore.records, { droppedKeys: mergedBefore.droppedKeys });
  const seen = new Set<string>();
  const keeps = new Map<string, SkillRecord>();
  const merges: Array<{ from: string; into: string; keys: string[]; line: number }> = [];
  const tombstones = new Map<string, SkillWrite>();

  table.rows.forEach((r, i) => {
    const line = i + 2;
    const decision = (r.decision ?? '').trim().toLowerCase();
    if (!decision) {
      plan.undecided++;
      return;
    }
    const id = (r.id ?? '').trim();
    if (!id) return void plan.errors.push(`Line ${line}: a row with a decision needs an id.`);
    if (seen.has(id)) return void plan.errors.push(`Line ${line}: ${id} appears twice.`);
    seen.add(id);
    const existing = before.record(id);
    const cells = splitList(r.aliases ?? '');
    const aliases = cells.filter((c) => !c.startsWith(KEY_PREFIX));
    const aliasKeys = cells.filter((c) => c.startsWith(KEY_PREFIX)).map((c) => c.slice(KEY_PREFIX.length).trim()).filter(Boolean);
    const labelEn = (r.labelEn ?? '').trim();
    const record: SkillRecord = {
      id,
      kind: ((SKILL_KINDS as readonly string[]).includes(r.kind ?? '') ? r.kind : (existing?.kind ?? 'hard')) as SkillKind,
      labelEn: labelEn || existing?.labelEn || id,
      labelZh: (r.labelZh ?? '').trim() || null,
      labelZhHant: (r.labelZhHant ?? '').trim() || null,
      aliases,
      ...(aliasKeys.length ? { aliasKeys } : {}),
      parentId: (r.parentId ?? '').trim() || null,
      esco: existing?.esco ?? null,
      onet: existing?.onet ?? null,
      status: 'reviewed',
    };

    if (decision === 'keep') {
      if (!labelEn) return void plan.errors.push(`Line ${line}: ${id} needs a labelEn to be kept.`);
      if (!(SKILL_KINDS as readonly string[]).includes(r.kind ?? '')) return void plan.errors.push(`Line ${line}: ${id} has the kind "${r.kind}"; use ${SKILL_KINDS.join(', ')}.`);
      keeps.set(id, record);
      plan.kept.push(id);
      return;
    }
    // A dropped or merged row stays as a tombstone that keeps every name it had.
    const ownKeys = [...new Set([...rowOfRecord(record).aliases, ...before.keysOf(id)])].sort();
    const tombstone: SkillWrite = { ...rowOfRecord(record), aliases: ownKeys, parentId: null, status: SKILL_STATUS_DROPPED };
    if (decision === 'drop') {
      tombstones.set(id, tombstone);
      plan.dropped.push(id);
      return;
    }
    // The target id is read as written in the sheet (ids are case-sensitive).
    const target = (r.decision ?? '').trim().match(/^merge-into[:\s]\s*(\S+)$/i)?.[1] ?? null;
    if (!target) return void plan.errors.push(`Line ${line}: the decision "${r.decision}" is not keep, drop or merge-into:<id>.`);
    if (target === id) return void plan.errors.push(`Line ${line}: ${id} cannot be merged into itself.`);
    tombstones.set(id, tombstone);
    merges.push({ from: id, into: target, keys: ownKeys, line });
  });

  for (const m of merges) {
    const kept = keeps.get(m.into);
    const standing = tombstones.has(m.into) ? null : before.record(m.into);
    if (kept) {
      // The names go into the row this sheet writes for the target.
      keeps.set(m.into, { ...kept, aliasKeys: [...new Set([...(kept.aliasKeys ?? []), ...m.keys])] });
    } else if (standing) {
      // A seed skill has no row until something writes one: a `seed` row, which decides nothing about the skill.
      plan.ensure.push(missingRowOf(standing, base.seedIds));
      plan.addKeys.push({ id: m.into, keys: m.keys });
    } else {
      plan.errors.push(`Line ${m.line}: ${m.from} is merged into ${m.into}, which is not a skill after this sheet.`);
      continue;
    }
    plan.merged.push({ from: m.from, into: m.into });
  }
  plan.upserts.push(...[...keeps.values()].map((r) => rowOfRecord(r)), ...tombstones.values());

  // Rehearse: the same writes on a copy, then the vocabulary the application would load.
  const rehearsal = createMemorySkillRepo(base.rows);
  await applyReviewPlan(rehearsal, plan);
  const mergedAfter = merge(await rehearsal.list());
  const after = buildVocabulary(mergedAfter.records, { droppedKeys: mergedAfter.droppedKeys });

  // Parents: each must be a skill after this sheet, with no loop.
  for (const record of keeps.values()) {
    if (!record.parentId) continue;
    if (!after.record(record.parentId)) plan.errors.push(`${record.id}: the parent ${record.parentId} is not a skill after this sheet.`);
    else if (after.parentOf(record.id) !== record.parentId) plan.errors.push(`${record.id}: the parent ${record.parentId} makes a loop.`);
  }

  // One alias key, one id: anything this sheet would newly break refuses it.
  const had = new Set(before.conflicts.map(conflictId));
  for (const c of after.conflicts) {
    if (had.has(conflictId(c))) continue;
    plan.errors.push(`The key "${c.key}" would point at two ids: ${c.keptId} and ${c.lostId}. Merge one into the other, or remove the alias from one of them.`);
  }
  return plan;
}

async function reviewImport(args: SkillsArgs, deps: SkillsCliDeps, report: SkillsReport): Promise<void> {
  const file = args.positional[0];
  if (!file) throw new Error(`review-import needs the path of the reviewed CSV.\n${SKILLS_USAGE}`);
  head(report, file);
  if (!deps.io.exists(file)) {
    report.ok = false;
    report.lines.push(`${file} does not exist.`);
    return;
  }
  const plan = await planReviewImport(parseTable(deps.io.readFile(file)), { ...seedBaseOf(deps), rows: await deps.repo.list() });
  report.lines.push(`Keep: ${plan.kept.length} · merge: ${plan.merged.length} · drop: ${plan.dropped.length} · no decision (skipped): ${plan.undecided}`);
  if (plan.errors.length) {
    report.ok = false;
    report.lines.push(`REFUSED: ${plan.errors.length} problem(s). Nothing was written.`);
    for (const e of plan.errors.slice(0, 50)) report.lines.push(`  ${e}`);
    return;
  }
  sample(report, 'Kept', plan.kept, (id) => id);
  sample(report, 'Merged', plan.merged, (m) => `${m.from} → ${m.into}`);
  sample(report, 'Dropped', plan.dropped, (id) => id);
  const total = plan.upserts.length + plan.addKeys.length;
  report.lines.push(`${report.apply ? 'Wrote' : 'Would write'} ${total} rows of RASkill.`);
  if (!report.apply) return;
  await applyReviewPlan(deps.repo, plan);
  report.rows = total;
}

// ── attach-ids ────────────────────────────────────────────────────────────

export type IdSource = 'esco' | 'onet';

export interface AttachPlan {
  set: Array<{ id: string; source: IdSource; value: string; label: string }>;
  /** A skill two identifiers of one file match: never guessed. */
  ambiguous: Array<{ id: string; source: IdSource; values: string[] }>;
  /** A skill that already carries a different identifier: left as it is. */
  different: Array<{ id: string; source: IdSource; has: string; file: string }>;
  rowsRead: Record<IdSource, number>;
}

const exactName = (s: string) => s.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Which identifiers a file gives to which skills. An identifier is attached
 * only where a label of the file equals a label or an alias of ours exactly
 * (case-insensitive, nothing folded). Every value comes from the file.
 */
export function planAttachIds(
  records: readonly SkillRecord[],
  files: Partial<Record<IdSource, { table: Table; idColumn: string; labelColumn: string; altColumn?: string }>>,
): AttachPlan {
  const plan: AttachPlan = { set: [], ambiguous: [], different: [], rowsRead: { esco: 0, onet: 0 } };
  const ours = new Map<string, string[]>();
  for (const r of records) {
    for (const name of [r.labelEn, r.labelZh, r.labelZhHant, ...r.aliases]) {
      if (!name) continue;
      const k = exactName(name);
      const ids = ours.get(k) ?? [];
      if (!ids.includes(r.id)) ids.push(r.id);
      ours.set(k, ids);
    }
  }
  const byId = new Map(records.map((r) => [r.id, r] as const));
  for (const source of ['esco', 'onet'] as const) {
    const file = files[source];
    if (!file) continue;
    for (const column of [file.idColumn, file.labelColumn, ...(file.altColumn ? [file.altColumn] : [])]) {
      if (!file.table.header.includes(column)) throw new Error(`The ${source} file has no "${column}" column (it has: ${file.table.header.join(', ')}). Pass the column names with --${source}-id-column, --${source}-label-column and --${source}-alt-column.`);
    }
    plan.rowsRead[source] = file.table.rows.length;
    const found = new Map<string, Map<string, string>>();
    for (const row of file.table.rows) {
      const value = (row[file.idColumn] ?? '').trim();
      if (!value) continue;
      const labels = [row[file.labelColumn] ?? '', ...(file.altColumn ? splitList(row[file.altColumn] ?? '') : [])];
      for (const label of labels) {
        const ids = label.trim() ? ours.get(exactName(label)) : undefined;
        // A name two of our skills share says nothing about either.
        if (!ids || ids.length !== 1) continue;
        const values = found.get(ids[0]!) ?? new Map<string, string>();
        if (!values.has(value)) values.set(value, label.trim());
        found.set(ids[0]!, values);
      }
    }
    for (const [id, values] of [...found.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      if (values.size > 1) {
        plan.ambiguous.push({ id, source, values: [...values.keys()].sort() });
        continue;
      }
      const [value, label] = [...values.entries()][0]!;
      const has = byId.get(id)?.[source] ?? null;
      if (has === value) continue;
      if (has) plan.different.push({ id, source, has, file: value });
      else plan.set.push({ id, source, value, label });
    }
  }
  return plan;
}

async function attachIds(args: SkillsArgs, deps: SkillsCliDeps, report: SkillsReport): Promise<void> {
  const files: Parameters<typeof planAttachIds>[1] = {};
  for (const source of ['esco', 'onet'] as const) {
    const file = flag(args, source);
    if (!file) continue;
    if (!deps.io.exists(file)) {
      head(report, '');
      report.ok = false;
      report.lines.push(`${file} does not exist. The file is supplied by the owner; nothing is downloaded.`);
      return;
    }
    files[source] = {
      table: parseTable(deps.io.readFile(file), { delimiter: delimiterOf(file) }),
      idColumn: flag(args, `${source}-id-column`) ?? 'id',
      labelColumn: flag(args, `${source}-label-column`) ?? 'label',
      ...(flag(args, `${source}-alt-column`) ? { altColumn: flag(args, `${source}-alt-column`)! } : {}),
    };
  }
  if (!files.esco && !files.onet) throw new Error(`attach-ids needs --esco <file> and/or --onet <file>.\n${SKILLS_USAGE}`);
  head(report, [files.esco ? 'esco' : '', files.onet ? 'onet' : ''].filter(Boolean).join(' + '));
  const loaded = await loadAll(deps);
  const plan = planAttachIds(loaded.records, files);
  for (const source of ['esco', 'onet'] as const) if (files[source]) report.lines.push(`${source}: ${plan.rowsRead[source]} rows read from the supplied file.`);
  report.lines.push(`Identifiers ${report.apply ? 'set' : 'that would be set'}: ${plan.set.length} · skipped, two identifiers match one skill: ${plan.ambiguous.length} · left alone, the skill already has another identifier: ${plan.different.length}`);
  sample(report, 'Set', plan.set, (s) => `${s.id}.${s.source} = ${s.value} (file label "${s.label}")`);
  sample(report, 'Ambiguous', plan.ambiguous, (a) => `${a.id}.${a.source}: ${a.values.join(' / ')}`);
  sample(report, 'Different', plan.different, (d) => `${d.id}.${d.source} is ${d.has}; the file says ${d.file}`);
  if (!report.apply) return;
  const byId = new Map(loaded.records.map((r) => [r.id, r] as const));
  // A seed skill has no row until something writes one: a `seed` row, which holds the identifier and decides nothing else.
  await deps.repo.createMissing([...new Set(plan.set.map((s) => s.id))].map((id) => missingRowOf(byId.get(id)!, loaded.seedIds)));
  for (const s of plan.set) await deps.repo.setExternalIds(s.id, { [s.source]: s.value });
  report.rows = plan.set.length;
}

// ── embed-labels ──────────────────────────────────────────────────────────

async function embedLabels(args: SkillsArgs, deps: SkillsCliDeps, report: SkillsReport): Promise<void> {
  const batch = positiveInt(args, 'batch', DEFAULT_EMBED_BATCH);
  const all = args.flags.all === true;
  head(report, '');
  if (!deps.embedder || !deps.vectors) {
    report.ok = false;
    report.lines.push('The embeddings client (server/src/platform/embeddings/client.ts) is not available in this build or has no key: no label was embedded and no vector was written.');
    return;
  }
  const { model } = deps.embedder;
  const loaded = await loadAll(deps);
  const have = new Set(await deps.vectors.embeddedIds(model));
  const todo = loaded.records.filter((r) => (all || r.status === 'reviewed') && !have.has(r.id)).sort((a, b) => (a.id < b.id ? -1 : 1));
  const batches = Math.ceil(todo.length / batch);
  report.lines.push(`Model ${model}: ${have.size} skills have a label vector, ${todo.length} ${all ? 'skills' : 'reviewed skills'} lack one.`);

  // RASkill holds one vector per skill. A skill on the list that carries a vector of another model would lose it.
  const otherModelOf = new Map((await deps.vectors.otherModels(model)).map((o) => [o.id, o.model || 'an unrecorded model'] as const));
  const replaced = todo.filter((r) => otherModelOf.has(r.id));
  if (replaced.length) {
    const perModel = new Map<string, number>();
    for (const r of replaced) perModel.set(otherModelOf.get(r.id)!, (perModel.get(otherModelOf.get(r.id)!) ?? 0) + 1);
    const models = [...perModel.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([m, n]) => `${m}: ${n}`).join(', ');
    if (args.flags['replace-model'] !== true) {
      report.ok = false;
      report.lines.push(`${replaced.length} of them carry a label vector of another model (${models}). RASkill holds one vector per skill: writing ${model} over them ends the embedding step for the market that uses the other model.`);
      report.lines.push('REFUSED: no label was embedded and no vector was written. Pass --replace-model when that is what you want.');
      return;
    }
    report.lines.push(`${replaced.length} of them carry a label vector of another model (${models}); this run ${report.apply ? 'replaces' : 'would replace'} them (--replace-model).`);
  }

  report.lines.push(`${report.apply ? 'Embedding' : 'Would embed'} ${todo.length} English labels in ${batches} batch(es) of up to ${batch}.`);
  if (!report.apply || !todo.length) return;
  // A seed skill has no row until something writes one (a `seed` row, which only carries the vector); an existing row is left as it is.
  await deps.repo.createMissing(todo.map((r) => missingRowOf(r, loaded.seedIds)));
  for (let i = 0; i < todo.length; i += batch) {
    const slice = todo.slice(i, i + batch);
    const vectors = await deps.embedder.embed(slice.map((r) => r.labelEn));
    if (!vectors || vectors.length !== slice.length || vectors.some((v) => !Array.isArray(v) || v.length !== SKILL_EMBED_DIMENSIONS)) {
      report.ok = false;
      report.lines.push(`Stopped after ${report.rows} vectors: the embeddings client gave no usable answer for the next batch. Nothing was made up; run the command again later.`);
      return;
    }
    for (let j = 0; j < slice.length; j++) if (await deps.vectors.write(slice[j]!.id, vectors[j]!, model)) report.rows++;
  }
  report.lines.push(`Wrote ${report.rows} label vectors.`);
}

// ── export-seed ───────────────────────────────────────────────────────────

function sameSkill(a: SkillRecord, b: SkillRecord): boolean {
  const keys = (r: SkillRecord) => rowOfRecord(r).aliases.join('\u0000');
  return a.kind === b.kind && a.labelEn === b.labelEn && a.labelZh === b.labelZh && a.labelZhHant === b.labelZhHant && a.parentId === b.parentId && a.esco === b.esco && a.onet === b.onet && keys(a) === keys(b);
}

/**
 * The reviewed rows of the table that say something the generated seed does
 * not: a skill it lacks, or one whose labels, kind, parent, identifiers or
 * names differ. A row that only repeats the generated entry is left out, and
 * so is every row that is not `reviewed` (a `seed` row is the copy an
 * automatic step made, never a decision: see `seedAdditions`), so
 * reviewed.json holds review decisions and nothing else.
 */
export function reviewedOverlay(rows: readonly SkillRow[], generated: readonly SkillRecord[]): SeedSkill[] {
  const byId = new Map(generated.map((r) => [r.id, r] as const));
  const out: SeedSkill[] = [];
  for (const row of rows) {
    if (row.status !== 'reviewed') continue;
    const base = byId.get(row.id);
    const rowKeys = new Set(row.aliases);
    // A spelling stays while the table still has its key; a key no label or spelling gives is kept as a key.
    const aliases = (base?.aliases ?? []).filter((a) => rowKeys.has(aliasKey(a)));
    const labelZh = row.labelZh ?? base?.labelZh ?? null;
    const labelZhHant = row.labelZhHant ?? base?.labelZhHant ?? null;
    const given = new Set([row.labelEn, labelZh, labelZhHant, ...aliases, row.id.replace(/_/g, ' ')].filter((n): n is string => !!n).map(aliasKey));
    const aliasKeys = row.aliases.filter((k) => k && !given.has(k)).sort();
    const entry: SeedSkill = {
      id: row.id,
      kind: ((SKILL_KINDS as readonly string[]).includes(row.kind) ? row.kind : (base?.kind ?? 'hard')) as SkillKind,
      labelEn: row.labelEn,
      labelZh,
      labelZhHant,
      aliases,
      ...(aliasKeys.length ? { aliasKeys } : {}),
      parentId: row.parentId,
      esco: row.esco,
      onet: row.onet,
      status: 'reviewed',
      ...(base?.everydayWord ? { everydayWord: true as const } : {}),
    };
    if (base && sameSkill(entry, base)) continue;
    out.push(entry);
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** Every comparison key a record gives: its labels, its spellings, its stored keys and its own id. */
function keysOfRecord(r: SkillRecord): Set<string> {
  const keys = [r.labelEn, r.labelZh, r.labelZhHant, ...r.aliases, r.id.replace(/_/g, ' ')].filter((n): n is string => !!n).map(aliasKey);
  return new Set([...keys, ...(r.aliasKeys ?? [])].filter(Boolean));
}

/**
 * What the table added to a seed skill without a review of the skill itself:
 * alias keys (learned by the embedding step, or moved in by a merge) and
 * ESCO / O*NET identifiers, on a `seed` row or on an unreviewed row that
 * carries a seed id. Nothing else of such a row is read: the skill stays what
 * the generated seed says.
 */
export function seedAdditions(rows: readonly SkillRow[], generated: readonly SkillRecord[]): SeedAddition[] {
  const byId = new Map(generated.map((r) => [r.id, r] as const));
  const out: SeedAddition[] = [];
  for (const row of rows) {
    if (row.status === 'reviewed' || row.status === SKILL_STATUS_DROPPED) continue;
    const base = byId.get(row.id);
    if (!base) continue;
    const given = keysOfRecord(base);
    const aliasKeys = [...new Set(row.aliases)].filter((k) => k && !given.has(k)).sort();
    const esco = row.esco && row.esco !== base.esco ? row.esco : null;
    const onet = row.onet && row.onet !== base.onet ? row.onet : null;
    if (aliasKeys.length || esco || onet) out.push({ id: row.id, aliasKeys, esco, onet });
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}

/**
 * What a reviewer dropped: the seed skills among the dropped rows (dropped, or
 * merged into another skill), and every key those rows hold. The caller leaves
 * out the keys a live skill holds (a merged row's names live on in its target).
 */
export function droppedDecisions(rows: readonly SkillRow[], generated: readonly SkillRecord[]): SeedDropped {
  const seedIds = new Set(generated.map((r) => r.id));
  const ids: string[] = [];
  const keys = new Set<string>();
  for (const row of rows) {
    if (row.status !== SKILL_STATUS_DROPPED) continue;
    if (seedIds.has(row.id)) ids.push(row.id);
    for (const key of [...row.aliases, aliasKey(row.labelEn), aliasKey(row.id.replace(/_/g, ' '))]) if (key) keys.add(key);
  }
  return { ids: ids.sort(), keys: [...keys].sort() };
}

/** The three input files of the seed generator, as records. */
export interface SeedDecisions {
  reviewed: SeedSkill[];
  additions: SeedAddition[];
  dropped: SeedDropped;
}

/**
 * The decisions the committed files already hold, with those of this table
 * over them. The export ADDS to what is committed: a decision made in another
 * database (the other market's, or the one reviewed last month) is kept unless
 * a row of this table says otherwise.
 *
 *   · a reviewed row replaces the committed entry of its id (and removes it
 *     when the row is the generated entry again) and revives a dropped id;
 *   · a dropped row removes the committed entry and addition of its id;
 *   · additions are joined key by key; an identifier of this table wins. A
 *     committed addition stays when this table reviews the skill: the keys
 *     may have been learned in another database, and the generator puts them
 *     on top of the reviewed entry. (A key cannot be taken away from a skill
 *     by a row alone: edit additions.json.)
 *
 * `dropped.keys` is every dropped key; the caller leaves out those a live
 * skill holds.
 */
export function mergeSeedDecisions(committed: SeedDecisions, rows: readonly SkillRow[], generated: readonly SkillRecord[]): SeedDecisions {
  const reviewed = new Map(committed.reviewed.map((e) => [e.id, e] as const));
  const additions = new Map(committed.additions.map((a) => [a.id, a] as const));
  const droppedIds = new Set(committed.dropped.ids);
  for (const row of rows) {
    if (row.status !== 'reviewed' && row.status !== SKILL_STATUS_DROPPED) continue;
    reviewed.delete(row.id);
    if (row.status === 'reviewed') droppedIds.delete(row.id);
    else additions.delete(row.id);
  }
  for (const entry of reviewedOverlay(rows, generated)) reviewed.set(entry.id, entry);

  // What a `seed` row adds is measured against the skill as the seed has it: generated, or reviewed in a committed entry.
  const base = new Map(generated.map((r) => [r.id, r] as const));
  for (const entry of reviewed.values()) base.set(entry.id, entry);
  for (const a of seedAdditions(rows, [...base.values()])) {
    const had = additions.get(a.id);
    additions.set(a.id, { id: a.id, aliasKeys: [...new Set([...(had?.aliasKeys ?? []), ...a.aliasKeys])].sort(), esco: a.esco ?? had?.esco ?? null, onet: a.onet ?? had?.onet ?? null });
  }

  const table = droppedDecisions(rows, generated);
  for (const id of table.ids) droppedIds.add(id);
  const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : 1);
  return {
    reviewed: [...reviewed.values()].sort(byId),
    additions: [...additions.values()].sort(byId),
    dropped: { ids: [...droppedIds].sort(), keys: [...new Set([...committed.dropped.keys, ...table.keys])].sort() },
  };
}

async function exportSeed(deps: SkillsCliDeps, report: SkillsReport): Promise<void> {
  const seedPath = deps.seedPath ?? SEED_PATH;
  const reviewedPath = deps.reviewedPath ?? REVIEWED_PATH;
  const additionsPath = deps.additionsPath ?? ADDITIONS_PATH;
  const droppedPath = deps.droppedPath ?? DROPPED_PATH;
  head(report, '');
  const rows = await deps.repo.list();
  const generated = buildSeed({ reviewed: [], additions: [], dropped: { ids: [], keys: [] } }).skills;
  const committedJson = (file: string, empty: unknown): unknown => (deps.io.exists(file) ? JSON.parse(deps.io.readFile(file)) : empty);
  let committed: SeedDecisions;
  let next: SeedDecisions;
  let seedText: string;
  let lostParent: string[];
  try {
    committed = {
      reviewed: parseReviewed(committedJson(reviewedPath, [])),
      additions: parseAdditions(committedJson(additionsPath, [])),
      dropped: parseDropped(committedJson(droppedPath, { ids: [], keys: [] })),
    };
    const merged = mergeSeedDecisions(committed, rows, generated);
    const reviewed = parseReviewed(JSON.parse(serializeReviewed(merged.reviewed)));
    const additions = parseAdditions(JSON.parse(serializeAdditions(merged.additions)));
    // A dropped key is kept only when no skill of the exported seed holds it.
    const live = buildVocabulary(buildSeed({ reviewed, additions, dropped: { ids: merged.dropped.ids, keys: [] } }).skills);
    const dropped = parseDropped(JSON.parse(serializeDropped({ ids: merged.dropped.ids, keys: merged.dropped.keys.filter((key) => !live.idOfKey(key)) })));
    next = { reviewed, additions, dropped };
    seedText = serializeSeed(buildSeed(next));
    const gone = new Set(dropped.ids);
    lostParent = [...generated, ...reviewed].filter((r) => r.parentId && gone.has(r.parentId) && live.record(r.id)).map((r) => r.id);
  } catch (err) {
    report.ok = false;
    report.lines.push(`REFUSED: the committed files and the rows of RASkill do not make a valid seed (${err instanceof Error ? err.message : String(err)}). Nothing was written.`);
    return;
  }
  const file = JSON.parse(seedText) as { skills: unknown[]; dropped: unknown[] };
  const fromTable = reviewedOverlay(rows, generated);
  report.lines.push(`${rows.filter((r) => r.status === 'reviewed').length} reviewed rows in RASkill; ${fromTable.length} differ from the generated seed.`);
  report.lines.push(`The committed files held ${committed.reviewed.length} reviewed entries, ${committed.additions.length} additions, ${committed.dropped.ids.length} dropped seed skills and ${committed.dropped.keys.length} dropped strings; what this table does not speak about is kept.`);
  sample(report, 'Reviewed entries', next.reviewed, (e) => `${e.id} · ${e.labelEn}`);
  report.lines.push(`${next.additions.length} seed skills carry alias keys or identifiers the table added (the skills themselves stay as generated).`);
  sample(report, 'Additions', next.additions, (a) => `${a.id} · ${[...a.aliasKeys.map((k) => `key ${k}`), a.esco ? `esco ${a.esco}` : '', a.onet ? `onet ${a.onet}` : ''].filter(Boolean).join(', ')}`);
  report.lines.push(`${next.dropped.ids.length} seed skills and ${next.dropped.keys.length} strings are dropped: no skill in any environment that starts from this seed.`);
  sample(report, 'Dropped seed skills', next.dropped.ids, (id) => id);
  sample(report, 'Skills that lose their parent with them', [...new Set(lostParent)].sort(), (id) => id);
  report.lines.push(
    `${report.apply ? 'Wrote' : 'Would write'} ${next.reviewed.length} entries to ${reviewedPath}, ${next.additions.length} to ${additionsPath}, ${next.dropped.ids.length + next.dropped.keys.length} to ${droppedPath} and ${file.skills.length} skills (${file.dropped.length} dropped keys) to ${seedPath}.`,
  );
  if (!report.apply) return;
  deps.io.writeFile(reviewedPath, serializeReviewed(next.reviewed));
  deps.io.writeFile(additionsPath, serializeAdditions(next.additions));
  deps.io.writeFile(droppedPath, serializeDropped(next.dropped));
  deps.io.writeFile(seedPath, seedText);
  report.files.push(reviewedPath, additionsPath, droppedPath, seedPath);
}

// ── Run ───────────────────────────────────────────────────────────────────

/** Run one command on the given dependencies. Without `args.apply` nothing is written anywhere. */
export async function runSkillsCommand(args: SkillsArgs, deps: SkillsCliDeps): Promise<SkillsReport> {
  const report: SkillsReport = { command: args.command, apply: args.apply, lines: [], files: [], rows: 0, ok: true };
  if (args.command === 'export-strings') await exportStrings(args, deps, report);
  else if (args.command === 'propose') await propose(args, deps, report);
  else if (args.command === 'review-export') await reviewExport(args, deps, report);
  else if (args.command === 'review-import') await reviewImport(args, deps, report);
  else if (args.command === 'attach-ids') await attachIds(args, deps, report);
  else if (args.command === 'embed-labels') await embedLabels(args, deps, report);
  else await exportSeed(deps, report);
  tail(report);
  return report;
}

// ── The model prompt of `propose --with-model` ────────────────────────────

export const NAMING_SYSTEM_PROMPT = [
  'You name clusters of skill strings taken from job postings. Each cluster is one skill written in several ways.',
  'For each cluster return: labelEn (the usual English name, with its usual capitals), labelZh (the standard Simplified Chinese term, or null when there is none or you are not certain),',
  'labelZhHant (the standard Traditional Chinese term used in Taiwan, or null when you are not certain; never convert the Simplified term character by character),',
  'and aliases (other common names of the SAME skill, at most 5; no broader or narrower skills).',
  'Do not invent identifiers, counts or sources. When a cluster is not a skill (a sentence, a benefit, a job title), return labelEn null.',
  'Answer with JSON only: {"clusters":[{"id":"…","labelEn":…,"labelZh":…,"labelZhHant":…,"aliases":[…]}]} using the ids you were given.',
].join(' ');

/** The messages of one naming call. Skill strings from public postings only: no user data. */
export function buildNamingMessages(clusters: ReadonlyArray<{ id: string; label: string; members: string[] }>): Array<{ role: 'system' | 'user'; content: string }> {
  const lines = clusters.map((c) => JSON.stringify({ id: c.id, label: c.label, members: c.members.slice(0, 12) }));
  return [
    { role: 'system', content: NAMING_SYSTEM_PROMPT },
    { role: 'user', content: `CLUSTERS (one JSON object per line):\n${lines.join('\n')}` },
  ];
}

/** The model's reply → proposals. Anything that is not the asked shape is dropped; a cluster named null is no proposal. */
export function parseNamingReply(text: string): ClusterProposal[] {
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch {
    return [];
  }
  const list = (data as { clusters?: unknown })?.clusters;
  if (!Array.isArray(list)) return [];
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const out: ClusterProposal[] = [];
  for (const raw of list) {
    const e = raw as Record<string, unknown>;
    const id = str(e?.id);
    const labelEn = str(e?.labelEn);
    if (!id || !labelEn) continue;
    const aliases = Array.isArray(e.aliases) ? e.aliases.map(str).filter((a): a is string => !!a).slice(0, 5) : [];
    out.push({ id, labelEn, labelZh: str(e.labelZh), labelZhHant: str(e.labelZhHant), aliases });
  }
  return out;
}

/** Clusters per model call. */
export const NAMING_BATCH = 40;

// ── The read-only count of export-strings ─────────────────────────────────

type CountDb = Pick<ExtendedPrismaClient, '$queryRaw'>;

/**
 * Distinct skill strings of one market's public, canonical, live postings,
 * with the number of postings that carry each. Read only. Columns are listed
 * by name (never SELECT *; RAJob.searchTsv is not read).
 */
export async function querySkillStrings(db: CountDb, market: SkillsMarket): Promise<SkillString[]> {
  const rows = await db.$queryRaw<Array<{ term: string; mentions: number | bigint; soft: number | bigint; hard: number | bigint }>>`
    WITH jobs AS (
      SELECT j."id", j."skills", j."skillsDetail" FROM "RAJob" j
      WHERE j."market" = ${market} AND j."visibility" = 'public' AND j."isCanonical" = true AND j."archivedAt" IS NULL
    ),
    listed AS (
      SELECT jobs."id" AS job, trim(s) AS term, NULL::text AS kind
      FROM jobs CROSS JOIN LATERAL unnest(jobs."skills") s
      UNION ALL
      SELECT jobs."id" AS job, trim(e->>'skill') AS term, e->>'kind' AS kind
      FROM jobs CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(jobs."skillsDetail") = 'array' THEN jobs."skillsDetail" ELSE '[]'::jsonb END) e
    )
    SELECT mode() WITHIN GROUP (ORDER BY term) AS term,
           count(DISTINCT job)::int AS mentions,
           (count(*) FILTER (WHERE kind = 'soft'))::int AS soft,
           (count(*) FILTER (WHERE kind = 'hard'))::int AS hard
    FROM listed
    WHERE term IS NOT NULL AND length(term) BETWEEN 1 AND 120
    GROUP BY lower(term)
    ORDER BY count(DISTINCT job) DESC, lower(term)
  `;
  return rows.map((r) => ({ term: r.term, mentions: Number(r.mentions), kind: Number(r.soft) > Number(r.hard) ? 'soft' : Number(r.hard) > 0 ? 'hard' : null }));
}

// ── Command line ──────────────────────────────────────────────────────────

/**
 * The embeddings client of platform/embeddings/client.ts, read by its
 * contract (MARKET_TASK_PLAN 3.3) with safe defaults: the module is built in
 * a parallel bundle, so it is loaded by path at run time and its absence, a
 * missing key or a policy refusal all mean "not available", never an error
 * and never a made-up vector.
 */
export async function loadLabelEmbedder(
  brand: string,
  load: () => Promise<unknown> = () => import(/* @vite-ignore */ ['../../platform/embeddings', 'client.js'].join('/')),
  env: Record<string, string | undefined> = process.env,
): Promise<LabelEmbedder | null> {
  let mod: Record<string, unknown>;
  try {
    mod = (await load()) as Record<string, unknown>;
  } catch {
    return null;
  }
  const resolve = mod?.resolveEmbeddingConfig;
  const embedTexts = mod?.embedTexts;
  if (typeof resolve !== 'function' || typeof embedTexts !== 'function') return null;
  let config: { modelTag?: unknown; apiKey?: unknown } | null = null;
  try {
    config = (resolve as (b: string, e: unknown) => { modelTag?: unknown; apiKey?: unknown } | null)(brand, env);
  } catch {
    return null;
  }
  const model = typeof config?.modelTag === 'string' ? config.modelTag : null;
  if (!model || !config?.apiKey) return null;
  return {
    model,
    async embed(texts) {
      const out = (await (embedTexts as (b: string, t: string[], o: unknown) => Promise<{ vectors?: unknown; unavailable?: unknown }>)(brand, texts, { purpose: 'skill', carriesUserData: false })) ?? {};
      return Array.isArray(out.vectors) ? (out.vectors as number[][]) : null;
    },
  };
}

async function main(): Promise<void> {
  const args = parseSkillsArgs(process.argv.slice(2));
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dotenv = (await import('dotenv')).default;
  dotenv.config({ path: path.resolve(here, '../../../../.env'), override: false });
  dotenv.config({ path: path.resolve(here, '../../../../.env.local'), override: false });
  const fs = await import('node:fs');
  const io: CliIo = { exists: (f) => fs.existsSync(f), readFile: (f) => fs.readFileSync(f, 'utf8'), writeFile: (f, t) => fs.writeFileSync(f, t) };
  // Loaded only now: importing this file (tests) never opens a database connection.
  const prisma = (await import('../../lib/prisma.js')).default;
  const { createPrismaSkillRepo } = await import('./repo.js');
  const { embeddedSkillIds, otherModelSkillIds, writeSkillEmbedding } = await import('./canonicalize.js');
  const market: SkillsMarket = flag(args, 'market') === 'cn' ? 'cn' : 'intl';
  const brand = market === 'cn' ? 'goapply' : 'roboapply';

  let namer: ClusterNamer | null = null;
  if (args.command === 'propose' && args.flags['with-model'] === true) {
    // The enrichment task's model and its domestic-only wall (GoApply) decide the route; no user data is sent.
    const { resolveEnrichModel } = await import('../jobs/enrich/index.js');
    const { llmService } = await import('../../services/llm/LLMService.js');
    const { runWithBrand } = await import('../../platform/brand/index.js');
    const route = resolveEnrichModel(brand);
    if (route.available && route.model) {
      namer = {
        model: route.model,
        async name(clusters) {
          const out: ClusterProposal[] = [];
          for (let i = 0; i < clusters.length; i += NAMING_BATCH) {
            const result = await runWithBrand(brand, () =>
              llmService.chatWithUsage(buildNamingMessages(clusters.slice(i, i + NAMING_BATCH)), {
                task: 'enrich',
                temperature: 0,
                maxTokens: 6000,
                responseFormat: 'json_object',
                thinkingMode: 'disabled',
                reasoningEffort: 'minimal',
                carriesUserData: false,
                model: route.model,
                ...(route.provider ? { provider: route.provider } : {}),
              }),
            );
            out.push(...parseNamingReply(result.content));
          }
          return out;
        },
      };
    }
  }

  const report = await runSkillsCommand(args, {
    io,
    repo: createPrismaSkillRepo(async () => prisma),
    queryStrings: (m) => querySkillStrings(prisma, m),
    namer,
    embedder: args.command === 'embed-labels' ? await loadLabelEmbedder(brand) : null,
    vectors: {
      embeddedIds: (model) => embeddedSkillIds(prisma, model),
      otherModels: (model) => otherModelSkillIds(prisma, model),
      write: (id, vector, model) => writeSkillEmbedding(prisma, id, vector, model),
    },
  });
  // eslint-disable-next-line no-console
  console.log(report.lines.join('\n'));
  if (!report.ok) process.exitCode = 1;
}

// Run only as a script (`npx tsx …/cli.ts`), never when imported.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    () => process.exit(process.exitCode ?? 0),
    (err) => {
      // eslint-disable-next-line no-console
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
