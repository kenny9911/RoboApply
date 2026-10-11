// server/src/features/match/eval/live/index.ts
//
// `npm run eval:match -- --live` (strategy 2.6; needs EVAL_LIVE=1): a frozen
// snapshot of the real index for the synthetic personas, graded by the LLM
// judge (cached), the fit order measured against those grades, the scorer's
// stability over three runs, the optional recruiter audit export, and a dated
// report. Everything it writes goes under eval/.snapshots/, which is
// git-ignored. The database is read in read-only transactions; the only
// people in the run are the synthetic personas.
//
// A market is measured as its brand (D5, D6): `intl` inside RoboApply's
// context, `cn` inside GoApply's. The scorer model is resolved per market, the
// judge is refused per market when it is that market's scorer, and every
// scorer and judge call is made inside the market's brand, with the persona's
// own locale. The scorer and estimate-against-AI gates are reported per
// market, on a fixed pseudo-random draw over all of the market's pooled pairs.
//
// Every dependency that touches a database or a model is injected, so the
// tests run this file with fakes and nothing else.

import path from 'node:path';
import { runWithBrand } from '../../../../lib/requestContext.js';
import type { BrandId } from '../../../../platform/brand/registry.js';
import type { MatchJobRecord } from '../../context.js';
import { loadPersonas } from '../fixtures/load.js';
import type { Persona } from '../fixtures/schema.js';
import { CAREER_CHANGER_SUBSET, LANGUAGE_GATED_SUBSETS, LANGUAGE_REFERENCE_SUBSET, type GateLayer, type JudgeUse } from '../gates.js';
import { ndcgAtK, shareEstimateGreatAiBelowPossible, tierOfScore, weightedKappa } from '../metrics.js';
import type { Report, SuiteRun } from '../run.js';
import { fitKind, isSeamMissing, loadSeam, type FitApi, type FitLike } from '../seams.js';
import type { SuiteContext, SuiteMarket, SuiteMeasure } from '../suite.js';
import { recordsWorld } from '../world.js';
import { exportAudit, type AuditPair } from './audit.js';
import { JudgeRefused, assertJudgeModel, defaultJudgeCall, judgePairs, type JudgeCall, type JudgeVerdict } from './judge.js';
import { JUDGE_PROMPT_VERSION, type JudgePersona, type JudgePosting } from './judgePrompt.js';
import { writeLiveReport, type LiveReportMeta } from './report.js';
import { RETRIEVAL_VARIANTS, defaultWithReadOnly, snapshotDate, takeSnapshot, writeSnapshot, type RetrievalVariant, type Snapshot, type SnapshotRow, type WithReadOnly } from './snapshot.js';
import { runStability, stabilitySample, type ScoreOnce } from './stability.js';

export class LiveRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LiveRefused';
  }
}

/** The one switch of live mode: without EVAL_LIVE=1 nothing reads a database or calls a model. */
export function assertLive(env: NodeJS.ProcessEnv): void {
  if (env.EVAL_LIVE !== '1') throw new LiveRefused('Live mode is off: set EVAL_LIVE=1 in the shell for this command (it is not read from .env) to let the harness read the database (read-only) and call models.');
}

/** The brand a market is measured as. */
export const brandOfMarket = (market: SuiteMarket): BrandId => (market === 'cn' ? 'goapply' : 'roboapply');

export interface LiveDeps {
  withReadOnly: WithReadOnly;
  variants: RetrievalVariant[];
  /** Called inside the brand of the market being judged. */
  judgeCall: JudgeCall;
  /** The model the production scorer resolves to for the CURRENT brand, or null when none is configured. Called once per market, inside its brand. */
  scorerModel: () => Promise<string | null>;
  /** One scorer run for one pair, or null to leave the scorer layer unmeasured. Called inside the brand of the pair's market. */
  scoreOnce: (input: { persona: Persona; row: SnapshotRow; estimate: FitLike | null; model: string; market: SuiteMarket }) => Promise<number | null>;
}

export interface LiveInput {
  exportAudit: boolean;
  ctx: SuiteContext;
  snapshotsDir: string;
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
  deps?: Partial<LiveDeps>;
}

export interface LiveOutcome {
  suites: SuiteRun[];
  note: string;
  /** The judge that graded this run and the markets it graded; null when nothing was judged. */
  judge: JudgeUse | null;
  /** Write the dated report for the final table; answers the report.md path. */
  finish(report: Report, audit: LiveReportMeta['audit']): string;
}

export function personaSummary(p: Persona): string {
  return [
    `Looking for: ${p.targetRoleId.replace(/_/g, ' ')}${p.kind === 'career_changer' ? ` (moving from ${p.roleId.replace(/_/g, ' ')})` : ''}`,
    `Level: ${p.level.replace(/_/g, ' ')}; ${p.yearsExperience} years of experience`,
    `Where: ${p.location.label}${p.location.city ? '' : ' (anywhere in the country)'}`,
    `Pay floor: ${p.payFloor.currency} ${p.payFloor.amount} a ${p.payFloor.period}`,
    p.market === 'intl' ? `Needs visa sponsorship: ${p.needsSponsorship ? 'yes' : 'no'}` : `Class year: ${p.classYear ?? 'not a recent graduate'}; degree: ${p.degree}`,
  ].join('\n');
}

const judgePersona = (p: Persona): JudgePersona => ({ id: p.id, summary: personaSummary(p), resumeMarkdown: p.resumeMarkdown });
const judgePosting = (r: SnapshotRow): JudgePosting => ({ id: r.id, title: r.title, companyName: r.companyName, location: r.location, payText: r.salaryText ?? null, description: r.descriptionPlain, qualifications: r.qualifications });

/** The scorer model of the brand in context (`resolvedJobMatchScorerModel` reads the brand of the unit of work). */
async function defaultScorerModel(): Promise<string | null> {
  try {
    const { resolvedJobMatchScorerModel } = await import('../../../../roboapply/v2/agents/RAJobMatchScorerAgent.js');
    return resolvedJobMatchScorerModel();
  } catch {
    return null;
  }
}

/** The production scorer on a synthetic persona and a snapshot posting, in the persona's locale; the total uses the product's own arithmetic. */
const defaultScoreOnce: LiveDeps['scoreOnce'] = async ({ persona, row, estimate, model }) => {
  const { RAJobMatchScorerV3Agent } = await import('../../../../roboapply/v2/agents/RAJobMatchScorerAgent.js');
  const combine = await loadSeam<(dims: unknown[]) => number | null>('server/src/features/match/preScore.ts#combineDimensions');
  const logistics = estimate?.dimensions.find((d) => d.key === 'logistics') ?? null;
  const out = await new RAJobMatchScorerV3Agent().run(
    {
      resumeMarkdown: persona.resumeMarkdown,
      profileContext: null,
      job: { title: row.title, companyName: row.companyName, seniority: row.seniority, educationLevel: row.educationLevel, minYears: row.minYears, skills: row.skills, description: row.descriptionPlain, qualifications: row.qualifications, responsibilities: null },
      logistics: { score: logistics?.score ?? null, lines: [] },
      targets: { titles: [], seniority: [] },
    },
    { locale: persona.locale, model },
  );
  const weights = { title_level: 35, skills: 30, industry: 15, career_path: 10 } as const;
  const dims: unknown[] = (Object.keys(weights) as Array<keyof typeof weights>).map((key) => ({ key, weight: weights[key], score: out.dimensions[key].score, status: out.dimensions[key].score === null ? 'not_stated' : 'scored', evidence: [] }));
  if (logistics) dims.push(logistics);
  return combine(dims);
};

function rankByFit(ids: string[], fits: Map<string, FitLike>): string[] {
  const score = (id: string) => {
    const s = fits.get(id)?.score;
    return typeof s === 'number' && Number.isFinite(s) ? s : null;
  };
  return [...ids].sort((a, b) => {
    const sa = score(a);
    const sb = score(b);
    if (sa === null || sb === null) return sa === sb ? a.localeCompare(b) : sa === null ? 1 : -1;
    return sb - sa || a.localeCompare(b);
  });
}

const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

interface PersonaLive {
  persona: Persona;
  ndcg10: number | null;
  ndcg20: number | null;
}

interface ScoredPair {
  personaId: string;
  postingId: string;
  persona: Persona;
  row: SnapshotRow;
  estimate: FitLike | null;
}

const NDCG = [
  ['ndcg_at_10', 'ndcg10'],
  ['ndcg_at_20', 'ndcg20'],
] as const;

export async function runLive(input: LiveInput): Promise<LiveOutcome> {
  assertLive(input.env);
  const deps: LiveDeps = {
    withReadOnly: input.deps?.withReadOnly ?? defaultWithReadOnly,
    variants: input.deps?.variants ?? RETRIEVAL_VARIANTS,
    judgeCall: input.deps?.judgeCall ?? defaultJudgeCall,
    scorerModel: input.deps?.scorerModel ?? defaultScorerModel,
    scoreOnce: input.deps?.scoreOnce ?? defaultScoreOnce,
  };
  const now = input.ctx.now;
  const date = snapshotDate(now);
  const dir = path.join(input.snapshotsDir, date);
  const notes: string[] = [];
  const samples: LiveReportMeta['samples'] = [];
  const measures: Array<SuiteMeasure & { layer: GateLayer }> = [];
  const scorerModels: Record<string, string | null> = {};
  const judgedMarkets: SuiteMarket[] = [];
  const wantedJudge = (input.env.EVAL_JUDGE_MODEL ?? '').trim() || null;
  if (!wantedJudge) notes.push('Not judged: EVAL_JUDGE_MODEL is not set: nothing is judged.');

  const perPersona: PersonaLive[] = [];
  const auditPairs: AuditPair[] = [];

  for (const market of input.ctx.markets as SuiteMarket[]) {
    const personas = loadPersonas(market, input.ctx.fixturesDir);
    if (!personas) {
      notes.push(`No personas for ${market} in fixtures/: the market was left out.`);
      continue;
    }
    // Everything of a market runs as its brand: model resolution, the judge, the scorer.
    const inMarket = <T>(fn: () => T): T => runWithBrand(brandOfMarket(market), fn);
    const scorerModel = await inMarket(() => deps.scorerModel());
    scorerModels[market] = scorerModel;

    // The judge must not be the model this market's scorer uses.
    let judgeModel: string | null = null;
    if (wantedJudge) {
      try {
        judgeModel = assertJudgeModel(wantedJudge, scorerModel);
        judgedMarkets.push(market);
      } catch (err) {
        if (!(err instanceof JudgeRefused)) throw err;
        notes.push(`Not judged (${market}): ${err.message}`);
      }
    }

    const snapshot: Snapshot = await takeSnapshot({ market, personas, withReadOnly: deps.withReadOnly, variants: deps.variants, now });
    writeSnapshot(snapshot, input.snapshotsDir);
    const rows = new Map(snapshot.rows.map((r) => [r.id, r]));
    const pooled = snapshot.pools.reduce((s, p) => s + p.pooled.length, 0);
    samples.push({ what: `${market}: personas`, n: personas.length }, { what: `${market}: pooled candidates (${snapshot.variants.join(' + ')}, top 50 each)`, n: pooled }, { what: `${market}: distinct postings read`, n: snapshot.rows.length });
    input.log(`${market}: ${personas.length} personas, ${pooled} pooled candidates, ${snapshot.rows.length} postings read (read-only).`);

    // The judge grades every pooled pair (cached by prompt version, persona text and posting text).
    let verdicts: JudgeVerdict[] = [];
    if (judgeModel) {
      const pairs = snapshot.pools.flatMap((pool) => {
        const persona = personas.find((p) => p.id === pool.personaId)!;
        return pool.pooled.filter((id) => rows.has(id)).map((id) => ({ persona: judgePersona(persona), posting: judgePosting(rows.get(id)!) }));
      });
      const call: JudgeCall = (messages, options) => inMarket(() => deps.judgeCall(messages, options));
      const batch = await judgePairs(pairs, { judgeModel, scorerModel, call, cacheDir: path.join(input.snapshotsDir, 'judge-cache') });
      verdicts = batch.verdicts;
      samples.push({ what: `${market}: pairs judged (${batch.calls} model calls, ${batch.cacheHits} from the cache)`, n: verdicts.length });
      if (batch.failed.length) notes.push(`${market}: ${batch.failed.length} pair(s) could not be judged and carry no grade (first: ${batch.failed[0]!.error}).`);
      for (const v of verdicts) {
        const persona = personas.find((p) => p.id === v.personaId)!;
        const row = rows.get(v.postingId)!;
        auditPairs.push({
          personaId: v.personaId,
          postingId: v.postingId,
          market,
          judgeGrade: v.grade,
          personaSummary: personaSummary(persona),
          personaResume: persona.resumeMarkdown,
          postingTitle: row.title,
          postingText: [row.descriptionPlain, row.qualifications ?? ''].filter(Boolean).join('\n\n'),
        });
      }
    }

    // The fit order of each pool against the judge's grades.
    let fit: FitApi | null = null;
    try {
      fit = await recordsWorld(market, personas, snapshot.rows as MatchJobRecord[]).fit();
    } catch (err) {
      if (!isSeamMissing(err)) throw err;
      for (const [metric] of NDCG) measures.push({ layer: 'ranking', metric, market, scope: 'live', value: null, status: 'not_built', note: err.message });
    }
    const marketPairs: ScoredPair[] = [];
    if (fit) {
      const marketRows: PersonaLive[] = [];
      for (const pool of snapshot.pools) {
        const persona = personas.find((p) => p.id === pool.personaId)!;
        const ids = pool.pooled.filter((id) => rows.has(id));
        const fits = ids.length ? await fit.getFits(persona.id, ids) : new Map<string, FitLike>();
        const labels = Object.fromEntries(verdicts.filter((v) => v.personaId === persona.id).map((v) => [v.postingId, v.grade]));
        const ranked = rankByFit(ids, fits);
        marketRows.push({ persona, ndcg10: Object.keys(labels).length ? ndcgAtK(ranked, labels, 10) : null, ndcg20: Object.keys(labels).length ? ndcgAtK(ranked, labels, 20) : null });
        for (const id of ids) marketPairs.push({ personaId: persona.id, postingId: id, persona, row: rows.get(id)!, estimate: fits.get(id) ?? null });
      }
      perPersona.push(...marketRows);
      if (judgeModel) {
        // Career changers are reported apart and not gated, as in the fixture suite (suites/ranking.suite.ts).
        const gated = marketRows.filter((r) => r.persona.kind !== CAREER_CHANGER_SUBSET);
        const changers = marketRows.filter((r) => r.persona.kind === CAREER_CHANGER_SUBSET);
        for (const [metric, key] of NDCG) {
          const values = gated.map((r) => r[key]).filter((v): v is number => v !== null);
          measures.push({ layer: 'ranking', metric, market, scope: 'live', value: mean(values), n: values.length, labels: 'judged' });
        }
        for (const [metric, key] of NDCG) {
          const values = changers.map((r) => r[key]).filter((v): v is number => v !== null);
          if (values.length) measures.push({ layer: 'ranking', metric, market, subset: CAREER_CHANGER_SUBSET, scope: 'live', value: mean(values), n: values.length, labels: 'judged', note: 'career changers: reported, not gated (the labels follow the wanted role, which the fit must not read)' });
        }
      }
    }

    // Scorer stability of this market: three runs on a fixed draw over all its pooled pairs, with
    // this market's scorer model. The first run is also the AI side of estimate-against-AI.
    if (!scorerModel) {
      notes.push(`No scorer model is configured for ${market}: the scorer layer was not measured there.`);
      continue;
    }
    const drawn = stabilitySample(marketPairs);
    if (drawn.length < 2) continue;
    const byId = new Map(drawn.map((p) => [`${p.personaId}::${p.postingId}`, p]));
    const score: ScoreOnce = (pair) => {
      const item = byId.get(`${pair.personaId}::${pair.postingId}`)!;
      return inMarket(() => deps.scoreOnce({ persona: item.persona, row: item.row, estimate: item.estimate, model: scorerModel, market }));
    };
    const st = await runStability(drawn.map((p) => ({ personaId: p.personaId, postingId: p.postingId })), score);
    const personasInDraw = new Set(drawn.map((p) => p.personaId)).size;
    samples.push({ what: `${market}: scorer stability pairs (${st.runs} runs, ${st.dropped} dropped for a failed run; drawn over ${personasInDraw} personas of ${marketPairs.length} pooled pairs)`, n: st.pairs });
    measures.push({ layer: 'scorer', metric: 'icc_3_runs', market, scope: 'live', value: st.icc, n: st.pairs, labels: 'none' });
    measures.push({ layer: 'scorer', metric: 'tier_flip_rate', market, scope: 'live', value: st.tierFlipRate, n: st.pairs, labels: 'none' });
    const pairs = st.kept
      .map((k, i) => {
        const est = byId.get(`${k.personaId}::${k.postingId}`)?.estimate;
        return est && fitKind(est.kind) === 'estimate' && typeof est.score === 'number' ? { estimate: est.score, ai: st.scores[0]![i]! } : null;
      })
      .filter((p): p is { estimate: number; ai: number } => p !== null);
    if (pairs.length) {
      const tiers = ['unlikely', 'possible', 'good', 'great'] as const;
      measures.push({ layer: 'estimate_vs_ai', metric: 'tier_kappa', market, scope: 'live', value: weightedKappa(pairs.map((p) => tierOfScore(p.estimate)), pairs.map((p) => tierOfScore(p.ai)), tiers), n: pairs.length, labels: 'none' });
      const over = shareEstimateGreatAiBelowPossible(pairs);
      measures.push({ layer: 'estimate_vs_ai', metric: 'estimate_great_ai_below_possible', market, scope: 'live', value: over.share, n: over.estimateGreat, labels: 'none', note: `${over.count} of ${over.estimateGreat} Great estimates; ${pairs.length} pairs in all` });
    }
  }

  // Language subsets over every judged market of the run (career changers left out, as in the fixture suite).
  if (judgedMarkets.length && perPersona.length) {
    for (const subset of [LANGUAGE_REFERENCE_SUBSET, ...LANGUAGE_GATED_SUBSETS]) {
      const rows = perPersona.filter((r) => r.persona.subset === subset && r.persona.kind !== CAREER_CHANGER_SUBSET);
      for (const [metric, key] of NDCG) {
        const values = rows.map((r) => r[key]).filter((v): v is number => v !== null);
        if (values.length) measures.push({ layer: 'language', metric, market: 'all', subset, scope: 'live', value: mean(values), n: values.length, labels: 'judged' });
      }
    }
  }

  if (input.exportAudit) {
    if (auditPairs.length && wantedJudge) {
      const out = exportAudit({ pairs: auditPairs, dir, judgeModel: wantedJudge, promptVersion: JUDGE_PROMPT_VERSION });
      const perMarket = Object.entries(out.markets).map(([m, n]) => `${m} ${n}`).join(', ');
      notes.push(`Audit sample: ${out.sampled} of ${auditPairs.length} judged pairs (${perMarket}) written to ${path.basename(out.csvFile)} (grade column empty). Read it back with --import-audit.`);
    } else notes.push('No audit sample: nothing was judged in this run.');
  }

  const judge: JudgeUse | null = wantedJudge && judgedMarkets.length ? { judgeModel: wantedJudge, promptVersion: JUDGE_PROMPT_VERSION, markets: judgedMarkets } : null;
  const layers = [...new Set(measures.map((m) => m.layer))];
  const suites: SuiteRun[] = layers.map((layer) => ({ file: 'live', name: `live ${layer}`, layer, measures: measures.filter((m) => m.layer === layer), error: null, notBuilt: null }));
  const meta = (audit: LiveReportMeta['audit']): LiveReportMeta => ({
    date,
    takenAt: now.toISOString(),
    markets: [...input.ctx.markets],
    models: { judge: judge?.judgeModel ?? null, judgePromptVersion: JUDGE_PROMPT_VERSION, judgedMarkets: [...judgedMarkets], scorer: scorerModels },
    samples,
    audit,
    notes,
  });
  return {
    suites,
    note: notes.join('\n'),
    judge,
    finish(report, audit) {
      return writeLiveReport(dir, meta(audit), report).md;
    },
  };
}
