// Per-model pricing math. The RATES themselves live in one place —
// `modelCostTable.ts` — and this module derives the lookup map and the costing
// functions from it. To bump a price or add a model, edit the cost table; you
// should not need to touch this file.
//
// Exported so the unified rate-card resolver (lib/rateCard.ts) can use
// MODEL_PRICING as its hardcoded DEFAULT tier — keeping the project invariant
// that an empty rate-card DB resolves to the cost table's constants.

import {
  AUDIO_MODEL_COST_TABLE,
  DEFAULT_MODEL_COST,
  FREE_VARIANT_COST,
  MODEL_COST_TABLE,
  buildCostLookup,
} from './modelCostTable.js';

const lookup = buildCostLookup(MODEL_COST_TABLE);

// A table bug (two rows fighting over one id at different rates) would silently
// mis-bill, so shout about it at import time. modelCostTable.test.ts asserts
// this list is empty, which is where it should actually get caught. NB: we use
// console.* here, not LoggerService, because LoggerService imports this module —
// importing it back would be a require cycle.
if (lookup.conflicts.length > 0) {
  for (const c of lookup.conflicts) {
    console.error(
      `[modelPricing] Cost-table conflict on id "${c.id}": kept the rate from ` +
        `"${c.keptRow}", ignored "${c.ignoredRow}". Fix MODEL_COST_TABLE in ` +
        'server/src/lib/modelCostTable.ts.',
    );
  }
}

/** Flat id → USD-per-1M-token lookup, derived from MODEL_COST_TABLE. Includes
 *  every canonical id, its bare (prefix-stripped) form, and every alias, plus
 *  the `default` fallback tier. Read-only: reprice in the cost table. */
export const MODEL_PRICING: Record<string, { input: number; output: number }> = Object.freeze({
  ...lookup.pricing,
  default: { ...DEFAULT_MODEL_COST },
});

/** Audio models billed per minute of audio (not per token). Used by ASR and
 *  TTS surfaces (e.g. the GoHire `/transcribe` endpoint that uses
 *  `gpt-4o-transcribe` via OpenAI's audio API). */
export const AUDIO_MODEL_PRICING_PER_MINUTE: Record<string, number> = AUDIO_MODEL_COST_TABLE;

/** Strip the decoration providers add around a model id: surrounding
 *  whitespace and Google's `models/` prefix. */
function cleanModelId(model: string): string {
  return (model ?? '').trim().replace(/^models\//i, '');
}

/** Resolve a model id to its cost-table row, following the same ladder as
 *  `calculateModelCost`: exact id → OpenRouter `:variant` handling → miss. */
function resolveRate(
  model: string,
): { rate: { input: number; output: number }; canonical: string } | null {
  const cleaned = cleanModelId(model);
  const exact = lookup.pricing[cleaned];
  if (exact) return { rate: exact, canonical: lookup.canonicalId[cleaned] };

  // OpenRouter appends a `:variant` suffix to some ids. `:free` costs nothing
  // whatever the base model charges; every other variant (`:nitro`, `:floor`,
  // …) is a routing preference billed at the base model's rate. Ollama's
  // `name:tag` ids fall out of the same rule.
  const colon = cleaned.lastIndexOf(':');
  if (colon > 0) {
    const base = cleaned.slice(0, colon);
    if (cleaned.slice(colon + 1).toLowerCase() === 'free') {
      return { rate: { ...FREE_VARIANT_COST }, canonical: lookup.canonicalId[base] ?? cleaned };
    }
    const baseRate = lookup.pricing[base];
    if (baseRate) return { rate: baseRate, canonical: lookup.canonicalId[base] };
  }

  // Anthropic-direct replies carry the RESOLVED, date-stamped id
  // (`claude-opus-5-20260101`) rather than the alias that was requested, and
  // AnthropicProvider bills `response.model`. A dated snapshot is the same
  // model at the same rate, so drop the stamp and price the family.
  const dated = /^(.*)-\d{8}$/.exec(cleaned);
  if (dated) {
    const base = dated[1];
    const baseRate = lookup.pricing[base];
    if (baseRate) return { rate: baseRate, canonical: lookup.canonicalId[base] };
  }

  return null;
}

/** Canonical cost-table id for a model, or the cleaned id when it isn't priced.
 *  Used for log/warning attribution — billing goes through `calculateModelCost`. */
export function normalizeModelForPricing(model: string): string {
  return resolveRate(model)?.canonical ?? cleanModelId(model);
}

/** The rate `calculateModelCost` would bill this model at, or null when it has
 *  no row and would fall through to the default tier. Same resolution ladder,
 *  so tooling can ask "is this model priced?" without re-deriving the answer. */
export function lookupModelRate(model: string): { input: number; output: number } | null {
  return resolveRate(model)?.rate ?? null;
}

// Models we've already warned about hitting the default tier — one warning per
// unique id per process keeps the signal visible without flooding the logs (this
// runs on every LLM call).
const warnedUnpricedModels = new Set<string>();

export function calculateModelCost(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number {
  const resolved = resolveRate(model);
  const pricing = resolved?.rate ?? MODEL_PRICING.default;

  if (!resolved && cleanModelId(model) !== 'default') {
    // No cost-table row — this model is being billed at the $1/$3 default, which
    // silently mis-costs any newly added model. Surface it once so a row can be
    // added to MODEL_COST_TABLE.
    const cleaned = cleanModelId(model);
    if (!warnedUnpricedModels.has(cleaned)) {
      warnedUnpricedModels.add(cleaned);
      console.warn(
        `[modelPricing] No cost-table row for model "${model}"` +
          (cleaned !== model ? ` (normalized "${cleaned}")` : '') +
          ` — billing at default $${MODEL_PRICING.default.input}/$${MODEL_PRICING.default.output} per 1M. ` +
          'Add a row to MODEL_COST_TABLE in server/src/lib/modelCostTable.ts.',
      );
    }
  }

  const inputCost = (promptTokens / 1_000_000) * pricing.input;
  const outputCost = (completionTokens / 1_000_000) * pricing.output;
  return inputCost + outputCost;
}

export function calculateAudioModelCost(model: string, minutes: number): number {
  const normalized = cleanModelId(model).toLowerCase();
  const rate = AUDIO_MODEL_PRICING_PER_MINUTE[normalized] ?? 0;
  return rate * Math.max(0, minutes);
}

// Tavily web-search pricing. Tavily bills per "API credit": a basic search
// costs 1 credit, an advanced search 2 credits. The per-credit USD rate is
// plan-dependent (pay-as-you-go ≈ $0.008/credit); override at runtime with
// TAVILY_COST_PER_CREDIT_USD (no redeploy) to match the active Tavily plan.
export const DEFAULT_TAVILY_COST_PER_CREDIT_USD = 0.008;

export function calculateSearchCost(credits: number): number {
  if (!Number.isFinite(credits) || credits <= 0) return 0;
  const perCredit = Number(process.env.TAVILY_COST_PER_CREDIT_USD) || DEFAULT_TAVILY_COST_PER_CREDIT_USD;
  return credits * perCredit;
}

// Firecrawl scrape pricing. Firecrawl bills per page scraped; the per-page USD
// rate is plan-dependent (pay-as-you-go ≈ $0.001/page for /scrape). Override at
// runtime with FIRECRAWL_COST_PER_PAGE_USD (no redeploy) to match the plan.
export const DEFAULT_FIRECRAWL_COST_PER_PAGE_USD = 0.001;

export function calculateFireCrawlCost(pages: number): number {
  if (!Number.isFinite(pages) || pages <= 0) return 0;
  const perPage = Number(process.env.FIRECRAWL_COST_PER_PAGE_USD) || DEFAULT_FIRECRAWL_COST_PER_PAGE_USD;
  return pages * perPage;
}

/** True when the model prices off an explicit Anthropic row in the cost table
 *  (i.e. we know its real rate rather than falling back to the default tier). */
export function isClaudeModelWithFixedPricing(model: string): boolean {
  return resolveRate(model)?.canonical.startsWith('anthropic/') ?? false;
}
