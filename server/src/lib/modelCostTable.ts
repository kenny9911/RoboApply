// backend/src/lib/modelCostTable.ts
//
// ═══════════════════════════════════════════════════════════════════════════
// THE LLM COST TABLE — edit THIS file when a provider changes its prices.
// ═══════════════════════════════════════════════════════════════════════════
//
// One row per model. A row is declared ONCE with its canonical OpenRouter-style
// `vendor/model` id; every other id shape the runtime can hand us is DERIVED,
// not hand-copied:
//
//   'openai/gpt-5.6-luna'  →  'openai/gpt-5.6-luna'   (OpenRouter route)
//                          →  'gpt-5.6-luna'          (OpenAI-direct route, the
//                                                       provider prefix is
//                                                       stripped in
//                                                       LLMService.normalizeModel)
//
// Anything the derivation can't guess (Anthropic's dashed API ids, LiveKit's
// `deepseek-ai/` namespace, price-sharing `-pro` twins) goes in `aliases`.
//
// ── Adding or repricing a model ────────────────────────────────────────────
//   1. Add/edit ONE row below. Prices are USD per 1,000,000 tokens.
//   2. `npm run llm:costs -- --write` to refresh docs/LLM_COSTS.md.
//   3. `npx vitest run server/src/lib/modelCostTable.test.ts` — the test fails
//      loudly if two rows fight over the same alias.
//
// ── Where these rates are actually used ────────────────────────────────────
//   modelPricing.ts   derives MODEL_PRICING + calculateModelCost() from this
//                     table; LoggerService prices every LLM call through it.
//   rateCard.ts       uses MODEL_PRICING as the hardcoded DEFAULT tier. An
//                     admin-saved `rate_card.{env}` AppConfig row is deep-merged
//                     OVER it, so a stale DB override SHADOWS a price bump made
//                     here — clear the override key for a repriced model.
//   Historical spend is stored denormalized, so repricing never rewrites past
//   rows; it only affects calls made from here on.

/** One priced model. Prices are USD per 1M tokens. */
export interface ModelCostRow {
  /** Canonical id — the OpenRouter `vendor/model` slug where one exists, else
   *  the bare id (self-hosted models have no vendor namespace). */
  id: string;
  /** USD per 1M input (prompt) tokens. */
  input: number;
  /** USD per 1M output (completion) tokens. */
  output: number;
  /** Extra ids that must price to this row, beyond the auto-derived ones. */
  aliases?: readonly string[];
  /** Why this row is priced the way it is, when that isn't obvious. */
  note?: string;
}

/** The fallback tier: what an unpriced model is billed at. `calculateModelCost`
 *  warns once per unknown id so the gap is visible in the logs. */
export const DEFAULT_MODEL_COST = { input: 1.0, output: 3.0 } as const;

/** OpenRouter serves `…:free` variants at no charge. They are priced by RULE
 *  rather than by row, so a free model never silently bills at the default. */
export const FREE_VARIANT_COST = { input: 0, output: 0 } as const;

export const MODEL_COST_TABLE: readonly ModelCostRow[] = [
  // ── Google Gemini ───────────────────────────────────────────────────────
  { id: 'google/gemini-3.7-flash', input: 0.375, output: 1.875 },
  { id: 'google/gemini-3.5-flash', input: 1.5, output: 9.0 },
  { id: 'google/gemini-3-flash-preview', input: 0.5, output: 3.0 },
  { id: 'google/gemini-3.1-pro-preview', input: 2.0, output: 12.0 },
  { id: 'google/gemini-3.1-flash-lite-preview', input: 0.25, output: 1.5 },
  { id: 'google/gemini-3.1-flash-image-preview', input: 0.25, output: 1.5 },
  { id: 'google/gemini-pro-latest', input: 2.0, output: 12.0 },
  { id: 'google/gemini-flash-latest', input: 1.5, output: 9.0 },

  // ── Anthropic Claude ────────────────────────────────────────────────────
  // The dotted OpenRouter slug and its bare form are derived; `aliases` carries
  // the DASHED id the Anthropic-direct API uses, where the two spellings differ.
  // Date-stamped snapshots (`claude-opus-4-6-20250408`) need no alias — a
  // trailing `-YYYYMMDD` is stripped at lookup and priced as the family.
  { id: 'anthropic/claude-opus-5', input: 5.0, output: 25.0 },
  { id: 'anthropic/claude-sonnet-5', input: 2.0, output: 10.0 },
  { id: 'anthropic/claude-opus-4.8', input: 5.0, output: 25.0, aliases: ['claude-opus-4-8'] },
  { id: 'anthropic/claude-opus-4.7', input: 5.0, output: 25.0, aliases: ['claude-opus-4-7'] },
  { id: 'anthropic/claude-opus-4.6', input: 5.0, output: 25.0, aliases: ['claude-opus-4-6'] },
  { id: 'anthropic/claude-sonnet-4.6', input: 3.0, output: 15.0, aliases: ['claude-sonnet-4-6'] },
  { id: 'anthropic/claude-haiku-4.5', input: 1.0, output: 5.0, aliases: ['claude-haiku-4-5'] },

  // ── OpenAI ──────────────────────────────────────────────────────────────
  // The 5.6 line is the current default (LLM_MODEL=openrouter/openai/gpt-5.6-luna).
  // `-pro` twins that share a price point ride along as aliases; terra-pro is
  // priced independently, so it keeps its own row.
  { id: 'openai/gpt-5.6-luna', input: 0.2, output: 1.2, aliases: ['openai/gpt-5.6-luna-pro'] },
  { id: 'openai/gpt-5.6-sol', input: 2.0, output: 10.0, aliases: ['openai/gpt-5.6-sol-pro'] },
  { id: 'openai/gpt-5.6-terra', input: 2.0, output: 12.0 },
  { id: 'openai/gpt-5.6-terra-pro', input: 2.5, output: 15.0 },
  { id: 'openai/gpt-5.5', input: 5.0, output: 30.0 },
  { id: 'openai/gpt-5.4', input: 2.5, output: 15.0 },
  { id: 'openai/gpt-5.4-mini', input: 0.75, output: 4.5 },
  { id: 'openai/gpt-oss-120b', input: 0.039, output: 0.19 },

  // ── DeepSeek ────────────────────────────────────────────────────────────
  // LiveKit Inference reports its own hosted `deepseek-ai/` namespace.
  {
    id: 'deepseek/deepseek-v4-pro',
    input: 0.435,
    output: 0.87,
    aliases: ['deepseek-ai/deepseek-v4-pro'],
  },
  { id: 'deepseek/deepseek-v4-flash', input: 0.1, output: 0.2 },

  // ── Moonshot Kimi ───────────────────────────────────────────────────────
  {
    id: 'moonshotai/kimi-k2.6',
    input: 0.7448,
    output: 4.655,
    note:
      'Non-thinking list price. Thinking mode (256K ctx) is $0.60/$3.00 at the ' +
      'provider but shares this model id, so one row covers both; price a ' +
      'thinking-heavy workload by hand if it matters.',
  },
  { id: 'moonshotai/kimi-k2.5', input: 0.6, output: 3.0 },

  // ── Z.ai GLM ────────────────────────────────────────────────────────────
  { id: 'z-ai/glm-5.3-flash', input: 0.075, output: 0.25 },
  { id: 'z-ai/glm-5', input: 0.95, output: 2.55 },
  { id: 'z-ai/glm-4.7', input: 0.4, output: 1.5 },

  // ── Alibaba Qwen ────────────────────────────────────────────────────────
  { id: 'qwen/qwen3.8-flash', input: 0.15, output: 0.47 },

  // ── NVIDIA ──────────────────────────────────────────────────────────────
  {
    id: 'nvidia/nemotron-3-ultra-550b-a55b:free',
    input: 0,
    output: 0,
    note: 'OpenRouter free tier — no per-token charge, rate-limited instead.',
  },

  // ── MiniMax ─────────────────────────────────────────────────────────────
  // Direct api.minimax.chat serves the bare id; the derived alias covers it.
  { id: 'minimax/minimax-m3', input: 0.3, output: 1.2 },
  { id: 'minimax/minimax-m2.7', input: 0.3, output: 1.2 },

  // ── Xiaomi MiMo ─────────────────────────────────────────────────────────
  { id: 'xiaomi/mimo-v2.5-pro', input: 1.0, output: 3.0 },
  { id: 'xiaomi/mimo-v2.5-flash', input: 0.09, output: 0.29 },

  // ── xAI Grok ────────────────────────────────────────────────────────────
  { id: 'x-ai/grok-4.1-fast', input: 0.2, output: 0.5 },
  { id: 'x-ai/grok-code-fast-1', input: 0.2, output: 1.5 },

  // ── Ollama (self-hosted) ────────────────────────────────────────────────
  // Local inference has no marginal token cost, so bill at $0 rather than let
  // it fall through to the $1/$3 default and over-report platform spend. Add
  // the specific tags you actually run.
  { id: 'qwen3', input: 0, output: 0, note: 'Self-hosted via Ollama.' },
  { id: 'qwen2.5', input: 0, output: 0, note: 'Self-hosted via Ollama.' },
  { id: 'llama3.3', input: 0, output: 0, note: 'Self-hosted via Ollama.' },
  { id: 'llama3.1', input: 0, output: 0, note: 'Self-hosted via Ollama.' },
  { id: 'mistral', input: 0, output: 0, note: 'Self-hosted via Ollama.' },
];

/** Audio models billed per MINUTE of audio rather than per token — ASR/TTS
 *  surfaces (e.g. the GoHire `/transcribe` endpoint on `gpt-4o-transcribe`).
 *  Keyed by the lower-cased bare model id. USD per minute. */
export const AUDIO_MODEL_COST_TABLE: Readonly<Record<string, number>> = {
  'gpt-4o-transcribe': 0.006,
  'gpt-4o-mini-transcribe': 0.012,
  'gpt-4o-mini-tts': 0.012,
  'whisper-1': 0.006,
  whisper: 0.006,
};

// ─── Derivation ───────────────────────────────────────────────────────────────

/** Every id shape a row answers to: its canonical id, each hand-written alias,
 *  and — for each of those — the bare id with the vendor prefix stripped, which
 *  is the shape a direct-provider route bills under (LLMService.normalizeModel
 *  drops the prefix before the call is costed). */
export function idsForRow(row: ModelCostRow): string[] {
  const ids: string[] = [];
  const add = (id: string) => {
    if (!id || ids.includes(id)) return;
    ids.push(id);
    const slash = id.lastIndexOf('/');
    if (slash > 0) add(id.slice(slash + 1));
  };
  add(row.id);
  for (const alias of row.aliases ?? []) add(alias);
  return ids;
}

/** Two rows claiming the same id at different prices — a table bug, surfaced by
 *  the unit test rather than by a mis-billed invoice. */
export interface CostTableConflict {
  id: string;
  keptRow: string;
  ignoredRow: string;
}

export interface CostLookup {
  /** id → rate, for every derived and explicit id in the table. */
  pricing: Record<string, { input: number; output: number }>;
  /** id → canonical row id, so a bare/aliased id can be reported canonically. */
  canonicalId: Record<string, string>;
  conflicts: CostTableConflict[];
}

/** Flatten the table into the lookup maps the pricing math runs on. */
export function buildCostLookup(rows: readonly ModelCostRow[] = MODEL_COST_TABLE): CostLookup {
  const pricing: Record<string, { input: number; output: number }> = {};
  const canonicalId: Record<string, string> = {};
  const conflicts: CostTableConflict[] = [];

  for (const row of rows) {
    for (const id of idsForRow(row)) {
      const existing = pricing[id];
      if (existing) {
        // Same rate from two rows is harmless (a shared bare id); a different
        // rate means one of the two rows is silently losing. Keep the first —
        // table order is the tiebreak — and report it.
        if (existing.input !== row.input || existing.output !== row.output) {
          conflicts.push({ id, keptRow: canonicalId[id], ignoredRow: row.id });
        }
        continue;
      }
      pricing[id] = { input: row.input, output: row.output };
      canonicalId[id] = row.id;
    }
  }

  return { pricing, canonicalId, conflicts };
}
