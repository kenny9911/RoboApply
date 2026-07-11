// backend/src/roboapply/v2/lib/raCrossBankMatch.ts
//
// The pure, deterministic heart of the cross-bank job-search agent team. NO
// I/O, NO LLM, NO Prisma — every function here is a testable pure transform.
// Formulas are authoritative per docs/CROSSBANK_JOBSEARCH_SPEC.md §5–§6.
//
// Coverage/accuracy thesis (spec §1): coverage is the invariant, accuracy is a
// re-rank-and-label layer on top — the recruiter tag/keyword signals may be
// EMPTY in the actual bank data (their producer agents are not in this repo),
// so they are treated as SOFT boosts, never hard gates. A signal-empty bank
// degrades ranking, never recall.

import { jobFingerprint } from './raOnboardingDraft.js';
import { normalizeForSearch } from './raJobSearch.js';
import type {
  BankId,
  BankJobRow,
  CandidateSignals,
  CrossBankCoverageStats,
  CrossBankExplorerPlan,
  DiscoverJobCard,
  PreMatchInput,
  PreMatchResult,
  PreMatchedCandidate,
  SeniorityBand,
  AcceptanceBand,
} from '../types/crossBank.js';
import type { OnboardingDraftPreferences } from '../types/onboarding.js';

// ─── Constants (spec §5) ──────────────────────────────────────────────────
export const FRESHNESS_DAYS = 45;
export const PER_BANK_QUERY_TAKE = 60;
export const PER_BANK_CANDIDATE_CAP = 120;
export const MATERIALIZE_CAP = 120;
export const PRE_FLOOR = 25;
export const SCORE_FLOOR = 60;
export const DEFAULT_SCORER_BUDGET = 16;
export const SCORER_CONCURRENCY = 8;
export const RECOMMENDED_LIMIT = 12;
export const EXPLORE_CAP = 24;
export const MIN_STRETCH_SCORED = 3;
export const INVITE_CONF_SPREAD = 8;
export const INVITE_BAR_MIN = 55;
export const INVITE_BAR_MAX = 80;
export const INVITE_BAR_DEFAULT = 60;

const SENIORITY_LADDER: readonly Exclude<SeniorityBand, 'unknown'>[] = [
  'entry',
  'mid',
  'senior',
  'lead',
  'exec',
];

const AGGRESSIVENESS_SPLIT: Record<
  PreMatchInput['aggressiveness'],
  { core: number; adjacent: number; stretch: number }
> = {
  balanced: { core: 0.6, adjacent: 0.25, stretch: 0.15 },
  coverage: { core: 0.45, adjacent: 0.35, stretch: 0.2 },
  precision: { core: 0.75, adjacent: 0.18, stretch: 0.07 },
};

// ─── Small numeric helpers ────────────────────────────────────────────────
export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
export function clamp01(n: number): number {
  return clamp(n, 0, 1);
}

// ─── Tokenization ─────────────────────────────────────────────────────────
export function normalizeTokens(text: string | null | undefined): string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .replace(/[^a-z0-9+#.\s-]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
}

// ─── canonicalizeTag (spec §5.1) — reconcile both grammars ─────────────────
const TAG_NAMESPACES = ['lang', 'framework', 'skill', 'category', 'domain', 'tool'];
const SYNONYMS: Record<string, string> = {
  k8s: 'kubernetes',
  golang: 'go',
  js: 'javascript',
  ts: 'typescript',
  postgres: 'postgresql',
  psql: 'postgresql',
  py: 'python',
  reactjs: 'react',
  nodejs: 'node',
  'node.js': 'node',
};

/**
 * Return the set of canonical forms a tag matches on. The recruiter grammar is
 * unverifiable (schema shows `lang:python`; semanticLabels.ts shows title-case
 * `Python`), so we accept BOTH: a namespaced form AND a bare form. Comparison
 * (§5.2) succeeds if ANY form on one side equals any form on the other.
 */
export function canonicalizeTag(raw: string): string[] {
  const base = raw.trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (!base) return [];
  const forms = new Set<string>();
  const colon = base.indexOf(':');
  if (colon > 0 && TAG_NAMESPACES.includes(base.slice(0, colon))) {
    const ns = base.slice(0, colon);
    const bare = base.slice(colon + 1);
    forms.add(base); // namespaced
    forms.add(SYNONYMS[bare] ?? bare); // bare (synonym-normalized)
    forms.add(`${ns}:${SYNONYMS[bare] ?? bare}`);
  } else {
    forms.add(SYNONYMS[base] ?? base);
  }
  return [...forms];
}

/** Flatten a tag list to the union of all canonical forms. */
export function canonicalTagUnion(tags: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const t of tags) for (const f of canonicalizeTag(t)) out.add(f);
  return out;
}

/** Does a single recruiter tag overlap the candidate's canonical form set? */
function tagMatches(recruiterTag: string, candForms: Set<string>): boolean {
  // Seniority predicate: `seniority:senior+` handled by the caller with band idx.
  for (const f of canonicalizeTag(recruiterTag)) if (candForms.has(f)) return true;
  return false;
}

// ─── Seniority (spec §5.2 / [FIX-3]) ───────────────────────────────────────
export function parseSeniorityBand(raw: string | null | undefined): SeniorityBand {
  const s = (raw ?? '').trim().toLowerCase();
  if (!s) return 'unknown';
  if (/(^|[^a-z])(intern|junior|entry|graduate|associate)([^a-z]|$)/.test(s)) return 'entry';
  if (/(^|[^a-z])(intermediate|mid|mid-level|middle)([^a-z]|$)/.test(s)) return 'mid';
  if (/(^|[^a-z])(staff|principal|lead|manager)([^a-z]|$)/.test(s)) return 'lead';
  if (/(^|[^a-z])(executive|exec|vp|vice[- ]president|director|head|chief|c[teofx]o)([^a-z]|$)/.test(s))
    return 'exec';
  if (/(^|[^a-z])(senior|sr|sr\.)([^a-z]|$)/.test(s)) return 'senior';
  return 'unknown';
}

/** 0..4 ladder index; unknown maps to null (caller uses 0.6 neutral fit). */
export function bandIdx(band: SeniorityBand): number | null {
  if (band === 'unknown') return null;
  return SENIORITY_LADDER.indexOf(band);
}

/** Map recruiter Job.experienceLevel (entry|mid|senior|lead|executive). */
export function levelIdx(experienceLevel: string | null | undefined): number | null {
  return bandIdx(parseSeniorityBand(experienceLevel));
}

// ─── resolveMatchInviteScore ([FIX resolver], spec §5.2) ───────────────────
/**
 * NEVER read Job.matchInviteScore raw elsewhere (schema:1231 warns of
 * un-hydrated placeholder rows persisting fake bars). `lib/matchInviteScore.ts`
 * does NOT exist in this repo; this is the single sanctioned resolver.
 */
export function resolveMatchInviteScore(raw: number | null | undefined): {
  inviteBar: number;
  barIsDefault: boolean;
} {
  const barIsDefault = raw == null || raw === INVITE_BAR_DEFAULT;
  const inviteBar = clamp(raw ?? INVITE_BAR_DEFAULT, INVITE_BAR_MIN, INVITE_BAR_MAX);
  return { inviteBar, barIsDefault };
}

// ─── Candidate signals (derived from the resume variant) ───────────────────
export function deriveCandidateSignals(variant: {
  resumeMarkdown: string;
  parsedData?: unknown;
  summary?: string | null;
}): CandidateSignals {
  const parsed =
    variant.parsedData && typeof variant.parsedData === 'object'
      ? (variant.parsedData as Record<string, unknown>)
      : {};
  const strArr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0) : [];

  const skills = strArr(parsed.skills).map((s) => s.trim());
  const titlesFromExp = Array.isArray(parsed.experience)
    ? (parsed.experience as unknown[])
        .map((e) => (e && typeof e === 'object' ? (e as Record<string, unknown>).title : null))
        .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
    : [];
  const headlineTitle = typeof parsed.title === 'string' ? [parsed.title] : [];
  const currentTitles = dedupeStrings([...headlineTitle, ...titlesFromExp]).slice(0, 6);

  const years =
    typeof parsed.yearsExperience === 'number' && Number.isFinite(parsed.yearsExperience)
      ? parsed.yearsExperience
      : null;

  const seniority = parseSeniorityBand(
    typeof parsed.seniority === 'string' ? parsed.seniority : currentTitles[0] ?? null,
  );

  return {
    currentTitles,
    topSkills: skills.slice(0, 30),
    candidateTagSet: skills.slice(0, 40),
    candidateKeywords: dedupeStrings(skills.map((s) => s.toLowerCase())).slice(0, 60),
    seniority,
    years,
  };
}

export function dedupeStrings(arr: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of arr) {
    const k = s.trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(s.trim());
  }
  return out;
}

// ─── Coverage / affinity primitives (spec §5.2) ────────────────────────────
function coverageRatio(required: readonly string[], candForms: Set<string>): {
  ratio: number;
  missing: string[];
} {
  if (required.length === 0) return { ratio: 1, missing: [] };
  const missing: string[] = [];
  let hit = 0;
  for (const r of required) {
    if (tagMatches(r, candForms)) hit++;
    else missing.push(r);
  }
  return { ratio: hit / required.length, missing };
}

function keywordCoverage(
  requiredKw: readonly string[],
  candKw: Set<string>,
  resumeTokens: Set<string>,
): { ratio: number; missing: string[] } {
  if (requiredKw.length === 0) return { ratio: 1, missing: [] };
  const missing: string[] = [];
  let hit = 0;
  for (const kw of requiredKw) {
    const k = kw.trim().toLowerCase();
    // Belt-and-suspenders: satisfied if in the candidate keyword set OR present
    // as a raw resume token — a vocabulary miss never silently zeroes a real fit.
    if (candKw.has(k) || resumeTokens.has(k)) hit++;
    else missing.push(kw);
  }
  return { ratio: hit / requiredKw.length, missing };
}

function preferredOverlapRatio(preferred: readonly string[], candForms: Set<string>): number {
  if (preferred.length === 0) return 0; // a bonus, not a penalty
  let hit = 0;
  for (const p of preferred) if (tagMatches(p, candForms)) hit++;
  return hit / preferred.length;
}

function tokenOverlap(a: string, targets: readonly string[]): number {
  const at = new Set(normalizeTokens(a));
  if (at.size === 0) return 0;
  let best = 0;
  for (const t of targets) {
    const tt = new Set(normalizeTokens(t));
    if (tt.size === 0) continue;
    let inter = 0;
    for (const x of tt) if (at.has(x)) inter++;
    best = Math.max(best, inter / tt.size);
  }
  return best;
}

function titleAffinity(
  title: string,
  primary: readonly string[],
  adjacent: readonly string[],
  stretch: readonly string[],
): number {
  const lc = title.trim().toLowerCase();
  const contains = (arr: readonly string[]) => arr.some((t) => lc.includes(t.trim().toLowerCase()));
  if (contains(primary)) return 1.0;
  if (contains(adjacent)) return 0.75;
  if (contains(stretch)) return 0.45;
  return clamp(tokenOverlap(title, [...primary, ...adjacent]), 0, 0.5);
}

function seniorityFit(jobLevel: string | null, candBand: SeniorityBand): number {
  const j = levelIdx(jobLevel);
  const c = bandIdx(candBand);
  if (j == null || c == null) return 0.6; // unknown → neutral
  return clamp(1 - 0.35 * Math.abs(j - c), 0, 1);
}

function ageDays(publishedAt: Date | null, now: number): number {
  if (!publishedAt) return FRESHNESS_DAYS;
  return (now - publishedAt.getTime()) / 86_400_000;
}

// ─── computePreScore + assignTier (spec §5.2) ──────────────────────────────
export interface PreScoreOutput {
  preScore: number;
  projectedScore: number;
  requiredCoverage: number;
  keywordCoverage: number;
  preferredOverlap: number;
  titleAffinity: number;
  seniorityFit: number;
  recency01: number;
  inviteReadiness: number;
  tier: 'core' | 'adjacent' | 'stretch';
  missingRequiredTags: string[];
  missingRequiredKeywords: string[];
  inviteBar: number;
  barIsDefault: boolean;
}

export function computePreScore(
  row: BankJobRow,
  plan: CrossBankExplorerPlan,
  signals: CandidateSignals,
  resumeTokens: Set<string>,
  now: number,
): PreScoreOutput {
  const candForms = canonicalTagUnion([...signals.candidateTagSet, ...plan.transferableSkillTags]);
  const candKw = new Set(
    [...signals.candidateKeywords, ...plan.mustKeywords].map((k) => k.trim().toLowerCase()),
  );

  const req = coverageRatio(row.job.requiredTagSet, candForms);
  const kw = keywordCoverage(row.job.requiredKeywordSet, candKw, resumeTokens);
  const preferredOverlap = preferredOverlapRatio(row.job.preferredTagSet, candForms);
  const tAff = titleAffinity(row.job.title, plan.primaryTitles, plan.adjacentTitles, plan.stretchTitles);
  const sFit = seniorityFit(row.job.experienceLevel, signals.seniority);
  const projectedScore = 100 * (0.5 * req.ratio + 0.3 * kw.ratio + 0.2 * preferredOverlap);
  const { inviteBar, barIsDefault } = resolveMatchInviteScore(row.job.matchInviteScore);
  const inviteReadiness = clamp01(0.5 + (projectedScore - inviteBar) / 80);
  const recency01 = clamp01(1 - ageDays(row.job.publishedAt, now) / FRESHNESS_DAYS);

  const preScore =
    100 *
    (0.34 * req.ratio +
      0.16 * kw.ratio +
      0.14 * preferredOverlap +
      0.18 * tAff +
      0.08 * sFit +
      0.1 * inviteReadiness) *
    (1 + 0.05 * recency01);

  let tier: 'core' | 'adjacent' | 'stretch';
  if (tAff >= 0.85 && req.ratio >= 0.6) tier = 'core';
  else if (tAff >= 0.55 || req.ratio >= 0.5) tier = 'adjacent';
  else tier = 'stretch';

  return {
    preScore,
    projectedScore,
    requiredCoverage: req.ratio,
    keywordCoverage: kw.ratio,
    preferredOverlap,
    titleAffinity: tAff,
    seniorityFit: sFit,
    recency01,
    inviteReadiness,
    tier,
    missingRequiredTags: req.missing,
    missingRequiredKeywords: kw.missing,
    inviteBar,
    barIsDefault,
  };
}

// ─── Dealbreaker filter (the ONLY content exclusion besides PRE_FLOOR) ──────
function isDealbroken(row: BankJobRow, draft: OnboardingDraftPreferences): boolean {
  const hay = `${row.company.companyName} ${row.job.title}`.toLowerCase();
  for (const db of draft.dealbreakers ?? []) {
    const t = db.trim().toLowerCase();
    if (t && hay.includes(t)) return true;
  }
  for (const ind of draft.industriesAvoid ?? []) {
    const t = ind.trim().toLowerCase();
    if (t && hay.includes(t)) return true;
  }
  return false;
}

// ─── Cross-bank dedup (spec §5.5) ──────────────────────────────────────────
function fingerprintOf(row: BankJobRow): string {
  return jobFingerprint({
    title: row.job.title,
    companyName: row.company.companyName,
    locationCity: row.job.locationCity,
    location: row.job.location,
    isRemote: (row.job.workType ?? '').toLowerCase() === 'remote',
  });
}

const BANK_ORDER: BankId[] = ['robohire', 'gohire'];

// ─── preMatchCandidates — the orchestrated pure pass (spec §5.2/§5.5) ───────
export function preMatchCandidates(input: PreMatchInput): PreMatchResult {
  const now = Date.now();
  const scored: PreMatchedCandidate[] = [];

  for (const row of input.rows) {
    if (isDealbroken(row, input.draft)) continue;
    const ps = computePreScore(row, input.plan, input.signals, input.resumeTokens, now);
    if (ps.preScore < PRE_FLOOR) continue;
    // Some transferable overlap required for a pure stretch (spec §5.2 tier).
    if (ps.tier === 'stretch' && ps.requiredCoverage === 0 && ps.keywordCoverage < 1 && ps.titleAffinity === 0)
      continue;
    scored.push({
      bank: row.bank,
      job: row.job,
      company: row.company,
      retrievedVia: row.retrievedVia,
      preScore: ps.preScore,
      tier: ps.tier,
      requiredCoverage: ps.requiredCoverage,
      keywordCoverage: ps.keywordCoverage,
      preferredOverlap: ps.preferredOverlap,
      projectedScore: ps.projectedScore,
      inviteBar: ps.inviteBar,
      barIsDefault: ps.barIsDefault,
      fingerprint: fingerprintOf(row),
      alsoOnBank: null,
      recency01: ps.recency01,
      missingRequiredTags: ps.missingRequiredTags,
      missingRequiredKeywords: ps.missingRequiredKeywords,
    });
  }

  // Dedup cross-bank twins by fingerprint, keeping max preScore; ties → bank
  // order → newer publishedAt. Winner records alsoOnBank = loser's bank.
  const byFp = new Map<string, PreMatchedCandidate>();
  let droppedTwins = 0;
  for (const c of scored) {
    const prev = byFp.get(c.fingerprint);
    if (!prev) {
      byFp.set(c.fingerprint, c);
      continue;
    }
    droppedTwins++;
    const winner = pickTwinWinner(prev, c);
    const loser = winner === prev ? c : prev;
    winner.alsoOnBank = winner.alsoOnBank ?? (loser.bank !== winner.bank ? loser.bank : null);
    byFp.set(c.fingerprint, winner);
  }

  const deduped = [...byFp.values()].sort((a, b) => b.preScore - a.preScore);
  const coverageSet = deduped.slice(0, MATERIALIZE_CAP);
  const toScore = reserveScorerBudgetByTier(coverageSet, input.scorerBudget, input.aggressiveness);
  return { coverageSet, toScore, droppedTwins };
}

function pickTwinWinner(a: PreMatchedCandidate, b: PreMatchedCandidate): PreMatchedCandidate {
  if (a.preScore !== b.preScore) return a.preScore > b.preScore ? a : b;
  const ai = BANK_ORDER.indexOf(a.bank);
  const bi = BANK_ORDER.indexOf(b.bank);
  if (ai !== bi) return ai < bi ? a : b;
  const at = a.job.publishedAt?.getTime() ?? 0;
  const bt = b.job.publishedAt?.getTime() ?? 0;
  return at >= bt ? a : b;
}

// ─── reserveScorerBudgetByTier (spec §5.2) ─────────────────────────────────
export function reserveScorerBudgetByTier(
  coverageSet: readonly PreMatchedCandidate[],
  budget: number,
  aggressiveness: PreMatchInput['aggressiveness'],
): PreMatchedCandidate[] {
  if (budget <= 0) return [];
  const split = AGGRESSIVENESS_SPLIT[aggressiveness];
  const byTier: Record<'core' | 'adjacent' | 'stretch', PreMatchedCandidate[]> = {
    core: [],
    adjacent: [],
    stretch: [],
  };
  for (const c of coverageSet) byTier[c.tier].push(c);
  for (const t of ['core', 'adjacent', 'stretch'] as const)
    byTier[t].sort((a, b) => b.preScore - a.preScore);

  const quota = {
    core: Math.round(budget * split.core),
    adjacent: Math.round(budget * split.adjacent),
    stretch: Math.max(Math.round(budget * split.stretch), Math.min(MIN_STRETCH_SCORED, byTier.stretch.length)),
  };

  const picked: PreMatchedCandidate[] = [];
  const takeFrom = (t: 'core' | 'adjacent' | 'stretch', n: number) => {
    const rows = byTier[t].slice(0, n);
    picked.push(...rows);
    byTier[t] = byTier[t].slice(rows.length);
  };
  takeFrom('core', quota.core);
  takeFrom('adjacent', quota.adjacent);
  takeFrom('stretch', quota.stretch);

  // Spill remaining budget to whoever has the highest-preScore leftovers.
  const leftover = [...byTier.core, ...byTier.adjacent, ...byTier.stretch].sort(
    (a, b) => b.preScore - a.preScore,
  );
  for (const c of leftover) {
    if (picked.length >= budget) break;
    picked.push(c);
  }
  return picked.slice(0, budget);
}

// ─── Acceptance-odds (spec §5.3, accuracy-first composite) ─────────────────
export interface AcceptanceOddsInput {
  llmScore: number;
  inviteBar: number;
  barIsDefault: boolean;
  requiredCoverage: number;
  keywordCoverage: number;
  preferredOverlap: number;
  inviteScaleOffset?: number;
}

export function computeAcceptanceOdds(v: AcceptanceOddsInput): {
  acceptanceOdds: number;
  acceptanceBand: AcceptanceBand;
  aboveBar: boolean;
} {
  const offset = v.inviteScaleOffset ?? 0;
  const margin = v.llmScore - offset - v.inviteBar;
  const inviteConfidence = 1 / (1 + Math.exp(-margin / INVITE_CONF_SPREAD));
  const reqCoverageAnchor = 0.6 * v.requiredCoverage + 0.4 * v.keywordCoverage;
  // Default-bar degeneracy handling [FIX-3(bar)]: an untuned @default(60) bar
  // makes inviteConfidence collapse to "llm>60", so lean on the scale-free
  // required-coverage anchor instead.
  const [wInvite, wReqCov, wPref] = v.barIsDefault ? [0.35, 0.55, 0.1] : [0.6, 0.3, 0.1];
  const odds01 = wInvite * inviteConfidence + wReqCov * reqCoverageAnchor + wPref * v.preferredOverlap;
  const acceptanceOdds = Math.round(100 * clamp01(odds01));
  const aboveBar = v.llmScore >= v.inviteBar;
  return { acceptanceOdds, acceptanceBand: inviteBand(v.llmScore, v.inviteBar, v.barIsDefault), aboveBar };
}

export function inviteBand(llmScore: number, inviteBar: number, barIsDefault: boolean): AcceptanceBand {
  if (barIsDefault) return 'bar_unset';
  if (llmScore >= inviteBar + 8) return 'strong';
  if (Math.abs(llmScore - inviteBar) < 8) return 'on_the_bar';
  return 'reach';
}

// ─── Raise-odds levers (spec §3.3) ─────────────────────────────────────────
export function computeRaiseOddsLevers(c: PreMatchedCandidate, scorerGaps: string[]): string[] {
  const levers = dedupeStrings([...c.missingRequiredTags, ...c.missingRequiredKeywords]);
  // When the recruiter predicates are empty (common — producers absent), fall
  // back to the Sonnet scorer's observed gaps for this job.
  if (levers.length === 0) return dedupeStrings(scorerGaps).slice(0, 4);
  return levers.slice(0, 4);
}

// ─── Field normalizers for Job→RAJob mapping (spec §6.1) ───────────────────
export function normalizeWorkMode(raw: string | null | undefined): 'remote' | 'hybrid' | 'onsite' {
  const s = (raw ?? '').trim().toLowerCase();
  if (s === 'remote') return 'remote';
  if (s === 'hybrid') return 'hybrid';
  return 'onsite';
}

export function normalizeEmploymentType(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!s) return null;
  if (s.includes('full')) return 'full_time';
  if (s.includes('part')) return 'part_time';
  if (s.includes('contract') || s.includes('contractor')) return 'contract';
  if (s.includes('intern')) return 'internship';
  return s;
}

/**
 * [FIX-7, load-bearing] recruiter Job.salaryPeriod is monthly|yearly (default
 * monthly); RAJob.salaryPeriod is year|month|week|hour (default year). A wrong
 * map silently corrupts the downstream salary prefilter — unit-tested.
 */
export function normalizeSalaryPeriod(
  raw: string | null | undefined,
): 'year' | 'month' | 'week' | 'hour' {
  const s = (raw ?? '').trim().toLowerCase();
  if (s === 'monthly' || s === 'month') return 'month';
  if (s === 'weekly' || s === 'week') return 'week';
  if (s === 'hourly' || s === 'hour') return 'hour';
  // yearly | annual | annually | year | '' → year (RAJob default)
  return 'year';
}

export function bankDisplayName(bank: BankId): string {
  return bank === 'robohire' ? 'RoboHire' : 'GoHire';
}

export function synthesizeApplyUrl(bank: BankId, jobId: string): string {
  const base =
    bank === 'robohire'
      ? process.env.ROBOHIRE_PUBLIC_JOB_BASE_URL?.replace(/\/$/, '') || 'https://www.robohire.io'
      : process.env.GOHIRE_PUBLIC_JOB_BASE_URL?.replace(/\/$/, '') || 'https://www.gohire.io';
  return `${base}/jobs/${jobId}`;
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, ' ');
}
function stripControl(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
}

// ─── mapRecruiterJobToRAJobUpsert (spec §6.1) — pure ───────────────────────
export interface RAJobUpsertVerdict {
  inviteBar: number;
  barIsDefault: boolean;
  alsoOnBank: BankId | null;
  retrievedVia: BankJobRow['retrievedVia'];
  missingRequiredTags: string[];
  missingRequiredKeywords: string[];
}

export function mapRecruiterJobToRAJobUpsert(c: PreMatchedCandidate): {
  where: { externalId_sourceBoard: { externalId: string; sourceBoard: BankId } };
  create: Record<string, unknown>;
  update: Record<string, unknown>;
} {
  const job = c.job;
  const description = job.description ?? '';
  const qualifications = [job.qualifications, job.hardRequirements].filter(Boolean).join('\n\n') || null;
  const data: Record<string, unknown> = {
    applyUrl: synthesizeApplyUrl(c.bank, job.id),
    title: job.title,
    titleNormalized: normalizeForSearch(job.title),
    companyName: c.company.companyName,
    companyNameNormalized: normalizeForSearch(c.company.companyName),
    companyLogoUrl: c.company.companyLogoUrl,
    location: job.location,
    locationCity: job.locationCity,
    locationCountry: job.locationCountry,
    workType: normalizeWorkMode(job.workType),
    employmentType: normalizeEmploymentType(job.employmentType),
    salaryMin: job.salaryMin,
    salaryMax: job.salaryMax,
    salaryCurrency: job.salaryCurrency ?? 'USD',
    salaryPeriod: normalizeSalaryPeriod(job.salaryPeriod),
    description,
    descriptionPlain: stripControl(stripHtml(description)),
    qualifications,
    responsibilities: null,
    benefits: job.benefits,
    postedAt: job.publishedAt,
    seedTags: {
      bank: c.bank,
      sourcePublisher: bankDisplayName(c.bank),
      requiredTagSet: job.requiredTagSet,
      preferredTagSet: job.preferredTagSet,
      requiredKeywordSet: job.requiredKeywordSet,
      preferredKeywordSet: job.preferredKeywordSet,
      matchInviteScore: c.inviteBar,
      barIsDefault: c.barIsDefault,
      alsoOnBank: c.alsoOnBank,
      retrievedVia: c.retrievedVia,
      ingestedVia: 'crossbank_v1',
      missingRequiredTags: c.missingRequiredTags,
      missingRequiredKeywords: c.missingRequiredKeywords,
    },
    archivedAt: null,
  };
  return {
    where: { externalId_sourceBoard: { externalId: job.id, sourceBoard: c.bank } },
    create: { externalId: job.id, sourceBoard: c.bank, ...data },
    update: data,
  };
}

// ─── Bounded concurrency ([FIX-4], spec §4) ────────────────────────────────
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (t: T, i: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

// ─── Coverage stats builder ────────────────────────────────────────────────
export function buildCoverageStats(args: {
  banksSwept: BankId[];
  banksDegraded: BankId[];
  totalRetrieved: number;
  materialized: number;
  droppedTwins: number;
  recommended: DiscoverJobCard[];
  explore: DiscoverJobCard[];
  perBankRetrieved: Record<string, number>;
  minSolidTarget: number;
}): CrossBankCoverageStats {
  const perBank: CrossBankCoverageStats['perBank'] = {};
  for (const b of args.banksSwept) {
    perBank[b] = {
      retrieved: args.perBankRetrieved[b] ?? 0,
      recommended: args.recommended.filter((c) => c.source === b).length,
    };
  }
  return {
    banksSwept: args.banksSwept,
    banksDegraded: args.banksDegraded,
    totalRetrieved: args.totalRetrieved,
    materialized: args.materialized,
    recommendedCount: args.recommended.length,
    exploreCount: args.explore.length,
    droppedTwins: args.droppedTwins,
    metSolidTarget: args.recommended.length >= args.minSolidTarget,
    perBank,
  };
}

// ─── freshnessCutoff helper ────────────────────────────────────────────────
export function freshnessCutoff(now: number = Date.now()): Date {
  return new Date(now - FRESHNESS_DAYS * 86_400_000);
}
