// server/src/features/offers/service.ts — offer comparison (WP-64).
//
// Offers are the user's own numbers on their tracker entries, read and written
// only through the tracker's public surface (`trackerCore` / `updateOffer`,
// which records an `offer` event in the application's history).
//
//   list / put / remove        the offer on an application
//   compare                    deterministic totals + stated assumptions (compute.ts)
//   benchmark                  posted pay for the role from our index, N shown, ≥ 20 rows (postedRange.ts)
//   negotiationDraft / explain AI text that may only repeat numbers it was given (numberGuard.ts)
//
// AI gate (TASK_PLAN §2.2): `aiAvailable(userId)` = aiAllowed(user) AND the
// brand's `ai.text` capability; when false the AI calls answer 503
// ai_unavailable before anything is sent to a model (zero LLMService calls).
// GoApply's phone-binding gate and the daily limit sit on the routes.

import { HttpError, MIN_SAMPLE } from '../../platform/http.js';
import type { TrackerEntryView, TrackerOffer } from '../tracker/index.js';
import {
  CnOfferFieldsSchema,
  OFFERS_ERROR_CODES,
  PutOfferBodySchema,
  type NegotiationDraft,
  type NegotiationFocus,
  type OfferBenchmark,
  type OfferComparison,
  type OfferExplanation,
  type OfferInput,
  type OfferView,
} from './contract.js';
import { baseInPeriod, compareOffers, percentDiff, positionAgainst, totalsFor } from './compute.js';
import { checkNumbers, mergeAllowed, numbersInText, type AllowedNumbers } from './numberGuard.js';
import { roleScopeFor, type PostedPaySource } from './postedRange.js';
import type { OfferWriterInput, OfferWriterOutput } from './OfferWriterAgent.js';

export interface OffersTrackerPort {
  /** Every live entry of the user (newest activity first). */
  entries(userId: string): Promise<TrackerEntryView[]>;
  /** One live entry; throws the tracker's not-found error otherwise. */
  entry(userId: string, entryId: string): Promise<TrackerEntryView>;
  updateOffer(userId: string, entryId: string, offer: TrackerOffer | null): Promise<void>;
}

export interface OffersServiceDeps {
  tracker: OffersTrackerPort;
  postedPay: PostedPaySource;
  market: () => 'intl' | 'cn';
  now?: () => Date;
  /** aiAllowed(user) AND isEnabled('ai.text'). */
  aiAvailable: (userId: string) => Promise<boolean>;
  write: (input: OfferWriterInput) => Promise<OfferWriterOutput>;
  /** Maps the tracker's not-found error (anything else is rethrown). */
  isEntryNotFound?: (err: unknown) => boolean;
  /** PII redaction for the user's free-text offer fields before they reach a prompt (default: none). */
  redact?: (text: string) => string;
}

// ── Reading stored offers ────────────────────────────────────────────────

const OFFER_KEYS = Object.keys(PutOfferBodySchema.shape) as Array<keyof OfferInput>;
const CN_KEYS = Object.keys(CnOfferFieldsSchema.shape);

/**
 * The stored JSON (`RATrackerEntry.offer`, passthrough) as an offer, or null.
 * Unknown keys are dropped; an invalid optional field is dropped rather than
 * losing the whole offer.
 */
export function readStoredOffer(raw: unknown): OfferInput | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const src = raw as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const k of OFFER_KEYS) if (src[k] !== undefined && src[k] !== null) picked[k] = src[k];
  if (picked.cn && typeof picked.cn === 'object' && !Array.isArray(picked.cn)) {
    const cn: Record<string, unknown> = {};
    for (const k of CN_KEYS) {
      const v = (picked.cn as Record<string, unknown>)[k];
      if (v === undefined || v === null) continue;
      const one = CnOfferFieldsSchema.safeParse({ [k]: v });
      if (one.success) cn[k] = v;
    }
    picked.cn = Object.keys(cn).length ? cn : undefined;
  } else delete picked.cn;
  const full = PutOfferBodySchema.safeParse(picked);
  if (full.success) return full.data;
  // Keep what is valid.
  const core = PutOfferBodySchema.safeParse({ base: picked.base, currency: picked.currency, period: picked.period });
  if (!core.success) return null;
  const out: Record<string, unknown> = { ...core.data };
  for (const k of OFFER_KEYS) {
    if (k in out || picked[k] === undefined) continue;
    const trial = PutOfferBodySchema.safeParse({ ...out, [k]: picked[k] });
    if (trial.success) out[k] = picked[k];
  }
  return PutOfferBodySchema.parse(out);
}

export function entryTitle(e: TrackerEntryView): string {
  return e.job?.title ?? e.externalSnapshot?.title ?? '';
}

export function entryCompany(e: TrackerEntryView): string {
  return e.job?.companyName ?? e.externalSnapshot?.companyName ?? '';
}

export function toOfferView(e: TrackerEntryView): OfferView | null {
  const offer = readStoredOffer(e.offer);
  if (!offer) return null;
  return { trackerEntryId: e.id, jobId: e.jobId, title: entryTitle(e), companyName: entryCompany(e), status: e.status, offer, totals: totalsFor(e.id, offer), updatedAt: e.updatedAt };
}

// ── Facts for the AI (every number the output may use) ───────────────────

interface FactsBundle {
  text: string;
  allowed: AllowedNumbers;
}

function dateParts(d: string | undefined): number[] {
  return d ? d.split('-').map(Number).filter(Number.isFinite) : [];
}

function offerFacts(label: string, v: OfferView, redact: (text: string) => string): { lines: string[]; allowed: AllowedNumbers } {
  const raw = v.offer;
  // Free text the user typed is redacted before it can reach a prompt.
  const clean = (x: string | undefined) => (x ? redact(x) : x);
  const o: OfferInput = {
    ...raw,
    bonus: clean(raw.bonus),
    equity: clean(raw.equity),
    location: clean(raw.location),
    cn: raw.cn ? { ...raw.cn, yearEndBonus: clean(raw.cn.yearEndBonus) } : undefined,
  };
  const t = totalsFor(v.trackerEntryId, o);
  const lines = [
    `${label}: ${v.title || 'Role'} at ${v.companyName || 'the company'}`,
    `  currency: ${o.currency}`,
    `  base pay: ${o.base} per ${o.period}`,
  ];
  const values: number[] = [o.base, t.baseAnnual, t.recurringAnnual, t.firstYear];
  if (o.period === 'month') lines.push(`  months of base pay a year: ${o.cn?.salaryMonths ?? 12}`);
  if (o.period === 'hour') lines.push(`  hours a week: ${o.hoursPerWeek ?? 40}`);
  lines.push(`  base pay a year: ${t.baseAnnual}`);
  if (o.bonusAmount !== undefined) {
    lines.push(`  yearly bonus amount: ${o.bonusAmount}`);
    values.push(o.bonusAmount);
  }
  if (o.bonus) lines.push(`  bonus as written in the offer (not counted): ${o.bonus}`);
  if (o.signingBonus !== undefined) {
    lines.push(`  signing bonus (one time): ${o.signingBonus}`);
    values.push(o.signingBonus);
  }
  if (o.equity) lines.push(`  equity as written (never valued, not counted): ${o.equity}`);
  if (o.cn?.yearEndBonus) lines.push(`  year-end bonus as written (not counted): ${o.cn.yearEndBonus}`);
  if (o.cn?.socialInsuranceBase !== undefined) {
    lines.push(`  social insurance and housing fund base (a month): ${o.cn.socialInsuranceBase}`);
    values.push(o.cn.socialInsuranceBase);
  }
  if (o.cn?.housingFundPercent !== undefined) lines.push(`  housing fund percent: ${o.cn.housingFundPercent}%`);
  if (t.housingFundAnnual !== null) {
    lines.push(`  housing fund, company part a year: ${t.housingFundAnnual}`);
    values.push(t.housingFundAnnual);
  }
  if (o.cn?.hukou !== undefined) lines.push(`  hukou included: ${o.cn.hukou ? 'yes' : 'no'}`);
  if (o.location) lines.push(`  location: ${o.location}`);
  if (o.startDate) lines.push(`  start date: ${o.startDate}`);
  if (o.deadline) lines.push(`  reply by: ${o.deadline}`);
  lines.push(`  total a year before tax (base + counted bonus + housing fund): ${t.recurringAnnual}`);
  lines.push(`  first-year total before tax (adds the signing bonus): ${t.firstYear}`);
  values.push(...dateParts(o.startDate), ...dateParts(o.deadline));
  const percents = o.cn?.housingFundPercent !== undefined ? [o.cn.housingFundPercent] : [];
  if (o.cn?.salaryMonths) values.push(o.cn.salaryMonths);
  if (o.hoursPerWeek) values.push(o.hoursPerWeek);
  return {
    lines,
    allowed: mergeAllowed({ values, percents }, numbersInText([o.bonus, o.equity, o.cn?.yearEndBonus, o.location, v.title, v.companyName])),
  };
}

function benchmarkFacts(b: OfferBenchmark): { lines: string[]; allowed: AllowedNumbers } {
  const r = b.postedRange;
  if (!r) {
    return { lines: ['POSTED PAY FOR THIS ROLE: not enough data (do not mention market pay).'], allowed: { values: [], percents: [] } };
  }
  const lines = [
    `POSTED PAY FOR THIS ROLE (from ${r.sampleSize} job postings that list pay in ${r.currency} per ${r.period}, last 12 months):`,
    `  25th percentile: ${r.low.value}`,
    `  median: ${r.median.value}`,
    `  75th percentile: ${r.high.value}`,
  ];
  // 25 / 50 / 75 name the percentiles; they are not pay figures.
  const values = [r.low.value, r.median.value, r.high.value, r.sampleSize, b.totalCount, b.listedCount, 25, 50, 75];
  const percents: number[] = [];
  if (b.offerBaseInRangePeriod !== null) {
    lines.push(`  the focus offer's base per ${r.period}: ${b.offerBaseInRangePeriod} (${b.position} the middle half of posted pay)`);
    values.push(b.offerBaseInRangePeriod);
    const vsMedian = percentDiff(b.offerBaseInRangePeriod, r.median.value);
    if (vsMedian !== null) {
      lines.push(`  difference from the posted median: ${vsMedian}%`);
      percents.push(vsMedian);
    }
  }
  return { lines, allowed: { values, percents } };
}

function differenceFacts(offers: readonly OfferView[]): { lines: string[]; allowed: AllowedNumbers } {
  const lines: string[] = [];
  const values: number[] = [];
  const percents: number[] = [];
  const totals = offers.map((o) => totalsFor(o.trackerEntryId, o.offer));
  for (let i = 0; i < offers.length; i += 1) {
    for (let j = i + 1; j < offers.length; j += 1) {
      const a = totals[i]!;
      const b = totals[j]!;
      if (a.currency !== b.currency) {
        lines.push(`OFFER ${i + 1} vs OFFER ${j + 1}: different currencies, not converted.`);
        continue;
      }
      const diff = Math.round((a.recurringAnnual - b.recurringAnnual) * 100) / 100;
      const pct = percentDiff(a.recurringAnnual, b.recurringAnnual);
      const first = Math.round((a.firstYear - b.firstYear) * 100) / 100;
      lines.push(`OFFER ${i + 1} vs OFFER ${j + 1}: yearly total difference ${diff}${pct !== null ? ` (${pct}%)` : ''}; first-year difference ${first}`);
      values.push(Math.abs(diff), Math.abs(first));
      if (pct !== null) percents.push(pct);
    }
  }
  return { lines, allowed: { values, percents } };
}

// ── The service ───────────────────────────────────────────────────────────

const MAX_WRITE_ATTEMPTS = 2;

export function createOffersService(deps: OffersServiceDeps) {
  const clock = deps.now ?? (() => new Date());
  const isNotFound = deps.isEntryNotFound ?? (() => false);
  const redact = deps.redact ?? ((text: string) => text);

  async function entryOrThrow(userId: string, entryId: string): Promise<TrackerEntryView> {
    try {
      return await deps.tracker.entry(userId, entryId);
    } catch (err) {
      if (isNotFound(err)) throw new HttpError('not_found', 'Application not found.', { reason: OFFERS_ERROR_CODES.entryNotFound });
      throw err;
    }
  }

  async function offerOrThrow(userId: string, entryId: string): Promise<OfferView> {
    const view = toOfferView(await entryOrThrow(userId, entryId));
    if (!view) throw new HttpError('not_found', 'This application has no offer yet.', { reason: OFFERS_ERROR_CODES.notFound });
    return view;
  }

  async function listViews(userId: string): Promise<OfferView[]> {
    const entries = await deps.tracker.entries(userId);
    return entries
      .map(toOfferView)
      .filter((v): v is OfferView => v !== null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async function pick(userId: string, ids: readonly string[]): Promise<OfferView[]> {
    const unique = [...new Set(ids)];
    const all = new Map((await listViews(userId)).map((v) => [v.trackerEntryId, v]));
    const missing = unique.filter((id) => !all.has(id));
    if (missing.length) throw new HttpError('not_found', 'Some of these applications have no offer.', { reason: OFFERS_ERROR_CODES.notFound, missing });
    return unique.map((id) => all.get(id)!);
  }

  async function benchmarkFor(view: OfferView): Promise<OfferBenchmark> {
    const now = clock();
    const empty = (reason: OfferBenchmark['reason'], scope: OfferBenchmark['scope'], counts = { totalCount: 0, listedCount: 0 }): OfferBenchmark => ({
      trackerEntryId: view.trackerEntryId,
      postedRange: null,
      ...counts,
      minSample: MIN_SAMPLE,
      scope,
      position: null,
      offerBaseInRangePeriod: null,
      reason,
    });
    let scope: OfferBenchmark['scope'] = { title: null, taxonomyId: null, country: null, city: null };
    try {
      const job = view.jobId ? await deps.postedPay.jobScope(view.jobId) : null;
      scope = roleScopeFor(job, view.title || null);
      if (!scope.taxonomyId && !scope.title) return empty('no_role', scope);
      const summary = await deps.postedPay.summary({ ...scope, market: deps.market(), currency: view.offer.currency, preferredPeriod: view.offer.period, now });
      const counts = { totalCount: summary.totalCount, listedCount: summary.listedCount };
      const r = summary.postedRange;
      if (!r) return empty('not_enough_data', scope, counts);
      const inPeriod = baseInPeriod(view.offer, r.period);
      return {
        trackerEntryId: view.trackerEntryId,
        postedRange: r,
        ...counts,
        minSample: MIN_SAMPLE,
        scope,
        position: inPeriod === null ? null : positionAgainst(inPeriod, r.low.value, r.high.value),
        offerBaseInRangePeriod: inPeriod,
        reason: null,
      };
    } catch {
      // The index is a nice-to-have here: no data is shown rather than a guess.
      return empty('unavailable', scope);
    }
  }

  async function assertAi(userId: string): Promise<void> {
    if (!(await deps.aiAvailable(userId))) {
      throw new HttpError('ai_unavailable', 'AI writing is not available for this account.', { reason: 'ai_off' });
    }
  }

  /** Write, check the numbers, retry once with the offending numbers named; fail closed. */
  async function writeChecked(input: OfferWriterInput, allowed: AllowedNumbers): Promise<OfferWriterOutput> {
    let note: string | undefined;
    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
      const out = await deps.write({ ...input, retryNote: note });
      if (!out.text) {
        note = 'Your last answer was empty or not valid JSON. Output the JSON object.';
        continue;
      }
      const verdict = checkNumbers([out.text, ...out.talkingPoints].join('\n'), allowed, clock());
      if (verdict.ok) return out;
      note = `Your last answer used numbers that are not in FACTS (${verdict.unsupported.slice(0, 8).join(', ')}). Rewrite it using only numbers from FACTS, or no numbers.`;
    }
    throw new HttpError('ai_unavailable', 'A draft that only uses your own numbers could not be written right now. Try again.', {
      reason: OFFERS_ERROR_CODES.unsupportedNumbers,
    });
  }

  return {
    async list(userId: string): Promise<OfferView[]> {
      return listViews(userId);
    },

    /** The AI gate as a boolean for the UI (fails closed). */
    async aiAvailable(userId: string): Promise<boolean> {
      try {
        return await deps.aiAvailable(userId);
      } catch {
        return false;
      }
    },

    async get(userId: string, entryId: string): Promise<OfferView> {
      return offerOrThrow(userId, entryId);
    },

    /**
     * The checks an AI call makes before it can reach the model (AI on, the
     * offers are the user's): run by the routes before the daily limit, so a
     * request that could never be written does not use one of the day's calls.
     */
    async precheckDraft(userId: string, entryId: string, compareWith: readonly string[] = []): Promise<void> {
      await assertAi(userId);
      await offerOrThrow(userId, entryId);
      const others = compareWith.filter((id) => id !== entryId);
      if (others.length) await pick(userId, others);
    },

    async precheckExplain(userId: string, ids: readonly string[]): Promise<void> {
      await assertAi(userId);
      await pick(userId, ids);
    },

    async put(userId: string, entryId: string, body: OfferInput): Promise<OfferView> {
      await entryOrThrow(userId, entryId);
      await deps.tracker.updateOffer(userId, entryId, body as TrackerOffer);
      return offerOrThrow(userId, entryId);
    },

    async remove(userId: string, entryId: string): Promise<{ deleted: true }> {
      await offerOrThrow(userId, entryId);
      await deps.tracker.updateOffer(userId, entryId, null);
      return { deleted: true };
    },

    async compare(userId: string, ids: readonly string[]): Promise<OfferComparison> {
      return compareOffers(await pick(userId, ids), deps.market());
    },

    async benchmark(userId: string, entryId: string): Promise<OfferBenchmark> {
      return benchmarkFor(await offerOrThrow(userId, entryId));
    },

    async negotiationDraft(
      userId: string,
      entryId: string,
      body: { focus?: NegotiationFocus; compareWith?: string[] },
      locale: string,
    ): Promise<NegotiationDraft> {
      await assertAi(userId);
      const focus = await offerOrThrow(userId, entryId);
      const others = body.compareWith?.length ? await pick(userId, body.compareWith.filter((id) => id !== entryId)) : [];
      const bench = await benchmarkFor(focus);
      const parts = [offerFacts('FOCUS OFFER (OFFER 1)', focus, redact), ...others.map((o, i) => offerFacts(`OTHER OFFER (OFFER ${i + 2})`, o, redact))];
      const bf = benchmarkFacts(bench);
      const diff = differenceFacts([focus, ...others]);
      const facts = [...parts.flatMap((p) => p.lines), '', ...bf.lines, ...(diff.lines.length ? ['', ...diff.lines] : [])].join('\n');
      const allowed = mergeAllowed(...parts.map((p) => p.allowed), bf.allowed, diff.allowed);
      const out = await writeChecked({ mode: 'negotiation', locale, facts, focus: body.focus ?? 'overall' }, allowed);
      return { text: out.text, talkingPoints: out.talkingPoints, aiWritten: true, postedRange: bench.postedRange, position: bench.position };
    },

    async explain(userId: string, ids: readonly string[], locale: string): Promise<OfferExplanation> {
      await assertAi(userId);
      const offers = await pick(userId, ids);
      const parts = offers.map((o, i) => offerFacts(`OFFER ${i + 1}`, o, redact));
      const diff = differenceFacts(offers);
      const facts = [...parts.flatMap((p) => p.lines), '', 'POSTED PAY: not part of this explanation (do not mention market pay).', ...(diff.lines.length ? ['', ...diff.lines] : [])].join('\n');
      const allowed = mergeAllowed(...parts.map((p) => p.allowed), diff.allowed);
      const out = await writeChecked({ mode: 'explain', locale, facts }, allowed);
      return { text: out.text, aiWritten: true, trackerEntryIds: offers.map((o) => o.trackerEntryId) };
    },
  };
}

export type OffersService = ReturnType<typeof createOffersService>;
