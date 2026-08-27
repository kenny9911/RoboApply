import { describe, expect, it } from 'vitest';

import {
  MODEL_COST_TABLE,
  buildCostLookup,
  idsForRow,
  type ModelCostRow,
} from './modelCostTable.js';
import {
  MODEL_PRICING,
  calculateModelCost,
  isClaudeModelWithFixedPricing,
  normalizeModelForPricing,
} from './modelPricing.js';

/** Cost of 1M input + 1M output tokens — the rate pair read straight off. */
const per1M = (model: string) => calculateModelCost(model, 1_000_000, 1_000_000);

const rowFor = (id: string): ModelCostRow => {
  const row = MODEL_COST_TABLE.find((r) => r.id === id);
  if (!row) throw new Error(`No cost-table row for "${id}"`);
  return row;
};

describe('MODEL_COST_TABLE integrity', () => {
  it('has no two rows claiming the same id at different rates', () => {
    // The guard that matters: a derived alias colliding with another row would
    // silently bill one of the two models at the wrong rate.
    expect(buildCostLookup(MODEL_COST_TABLE).conflicts).toEqual([]);
  });

  it('detects a conflict when one is actually present', () => {
    // Proves the assertion above can fail — an empty `conflicts` list means the
    // table is clean, not that the detector is dead.
    const clash = buildCostLookup([
      { id: 'acme/widget', input: 1, output: 2 },
      // Derives the bare id `widget`, which the next row claims at another rate.
      { id: 'other/widget', input: 9, output: 9, aliases: ['widget'] },
    ]);
    expect(clash.conflicts).toEqual([{ id: 'widget', keptRow: 'acme/widget', ignoredRow: 'other/widget' }]);
    // First row wins, so the kept rate is deterministic.
    expect(clash.pricing.widget).toEqual({ input: 1, output: 2 });
  });

  it('does not report a conflict when two rows agree on a shared id', () => {
    const shared = buildCostLookup([
      { id: 'acme/widget', input: 1, output: 2 },
      { id: 'other/widget', input: 1, output: 2 },
    ]);
    expect(shared.conflicts).toEqual([]);
  });

  it('declares each canonical id exactly once', () => {
    const ids = MODEL_COST_TABLE.map((r) => r.id);
    expect(ids).toEqual([...new Set(ids)]);
  });

  it('prices every row under its canonical id, its bare id, and each alias', () => {
    // Spelled out independently of idsForRow — asserting against that helper
    // would only be checking the derivation against itself.
    for (const row of MODEL_COST_TABLE) {
      const rate = { input: row.input, output: row.output };
      const expectedIds = new Set([row.id, row.id.slice(row.id.lastIndexOf('/') + 1)]);
      for (const alias of row.aliases ?? []) {
        expectedIds.add(alias);
        expectedIds.add(alias.slice(alias.lastIndexOf('/') + 1));
      }
      for (const id of expectedIds) {
        expect({ id, rate: MODEL_PRICING[id] }).toEqual({ id, rate });
      }
    }
  });

  it('derives exactly the ids the lookup was built from', () => {
    const derived = new Set(MODEL_COST_TABLE.flatMap((r) => idsForRow(r)));
    // +1 for the `default` fallback tier, which is not a table row.
    expect(Object.keys(MODEL_PRICING).length).toBe(derived.size + 1);
  });

  it('rejects negative or non-finite rates', () => {
    for (const row of MODEL_COST_TABLE) {
      expect(Number.isFinite(row.input) && row.input >= 0).toBe(true);
      expect(Number.isFinite(row.output) && row.output >= 0).toBe(true);
    }
  });

  it('survives the JSON round trip the admin rate-card panel depends on', () => {
    // GET /admin/rate-card hands MODEL_PRICING to res.json() by reference and
    // the panel renders Object.entries() of it, so every id must survive
    // serialization with its rate intact.
    const roundTripped = JSON.parse(JSON.stringify(MODEL_PRICING));
    expect(roundTripped).toEqual({ ...MODEL_PRICING });
    expect(roundTripped['openai/gpt-5.6-luna']).toEqual({ input: 0.2, output: 1.2 });
  });

  it('is frozen, since the resolved rate card shares this exact object', () => {
    // rateCard.buildDefaultRateCard() assigns `llm: MODEL_PRICING` by reference;
    // mutating a resolved card would otherwise corrupt pricing process-wide.
    expect(Object.isFrozen(MODEL_PRICING)).toBe(true);
  });
});

describe('published rates', () => {
  it.each([
    ['google/gemini-3.7-flash', 0.375, 1.875],
    ['openai/gpt-5.6-sol', 2, 10],
    ['openai/gpt-5.6-terra', 2, 12],
    ['openai/gpt-5.6-luna', 0.2, 1.2],
    ['anthropic/claude-opus-5', 5, 25],
    ['anthropic/claude-sonnet-5', 2, 10],
    ['z-ai/glm-5.3-flash', 0.075, 0.25],
    ['qwen/qwen3.8-flash', 0.15, 0.47],
    ['nvidia/nemotron-3-ultra-550b-a55b:free', 0, 0],
  ])('%s is $%s in / $%s out per 1M', (id, input, output) => {
    expect(rowFor(id)).toMatchObject({ input, output });
    expect(per1M(id)).toBeCloseTo(input + output, 10);
  });

  it('keeps the -pro twins that share a price point aligned with their base', () => {
    expect(per1M('openai/gpt-5.6-luna-pro')).toBe(per1M('openai/gpt-5.6-luna'));
    expect(per1M('openai/gpt-5.6-sol-pro')).toBe(per1M('openai/gpt-5.6-sol'));
    // terra-pro is priced independently, so it must NOT track terra.
    expect(per1M('openai/gpt-5.6-terra-pro')).not.toBe(per1M('openai/gpt-5.6-terra'));
  });
});

describe('id resolution', () => {
  it('prices the bare id a direct-provider route bills under', () => {
    // LLMService.normalizeModel strips the routing prefix before the call is
    // costed, so both shapes have to land on the same rate.
    expect(per1M('gpt-5.6-luna')).toBe(per1M('openai/gpt-5.6-luna'));
    expect(per1M('gemini-3.7-flash')).toBe(per1M('google/gemini-3.7-flash'));
    expect(per1M('claude-opus-5')).toBe(per1M('anthropic/claude-opus-5'));
    expect(per1M('glm-5.3-flash')).toBe(per1M('z-ai/glm-5.3-flash'));
  });

  it("prices Anthropic's dashed API ids and dated snapshots", () => {
    expect(per1M('claude-opus-4-8')).toBe(30);
    expect(per1M('claude-opus-4.8')).toBe(30);
    expect(per1M('claude-sonnet-4-6-20250408')).toBe(18);
  });

  it('prices the LiveKit-hosted DeepSeek namespace at the backend rate', () => {
    expect(per1M('deepseek-ai/deepseek-v4-pro')).toBeCloseTo(1.305, 10);
  });

  it("strips Google's models/ prefix and surrounding whitespace", () => {
    expect(per1M('models/gemini-3.7-flash')).toBe(per1M('google/gemini-3.7-flash'));
    expect(per1M('  openai/gpt-5.6-luna  ')).toBe(per1M('openai/gpt-5.6-luna'));
  });

  it('bills any OpenRouter :free variant at zero', () => {
    // The rule, not the row: a free variant we have never listed must not fall
    // through to the $1/$3 default tier.
    expect(per1M('meta-llama/llama-3.3-70b-instruct:free')).toBe(0);
    // …and it beats a priced base row, which is the case that actually occurs —
    // OpenRouter ships `:free` twins of models this table charges for.
    expect(per1M('z-ai/glm-4.7')).toBeGreaterThan(0);
    expect(per1M('z-ai/glm-4.7:free')).toBe(0);
  });

  it('bills a non-free :variant at the base model rate', () => {
    expect(per1M('openai/gpt-5.6-luna:nitro')).toBe(per1M('openai/gpt-5.6-luna'));
    // Ollama's `name:tag` ids fall out of the same rule.
    expect(per1M('llama3.1:70b')).toBe(0);
  });

  it("prices a date-stamped Anthropic snapshot as its family", () => {
    // AnthropicProvider bills `response.model`, and the direct API answers with
    // the resolved dated id rather than the alias that was requested.
    expect(per1M('claude-opus-5-20260101')).toBe(30);
    expect(per1M('claude-sonnet-4-6-20250408')).toBe(18);
    expect(normalizeModelForPricing('claude-opus-5-20260101')).toBe('anthropic/claude-opus-5');
  });

  it('falls back to the $1/$3 default tier for an unknown model', () => {
    expect(MODEL_PRICING.default).toEqual({ input: 1, output: 3 });
    expect(per1M('some/model-we-have-never-seen')).toBe(4);
  });

  it('reports the canonical id for any alias', () => {
    expect(normalizeModelForPricing('claude-opus-4-8')).toBe('anthropic/claude-opus-4.8');
    expect(normalizeModelForPricing('gpt-5.6-luna')).toBe('openai/gpt-5.6-luna');
    expect(normalizeModelForPricing('models/gemini-3.7-flash')).toBe('google/gemini-3.7-flash');
    // Unknown ids come back cleaned but otherwise untouched.
    expect(normalizeModelForPricing('  unknown/model  ')).toBe('unknown/model');
  });

  it('recognises Anthropic models as explicitly priced', () => {
    expect(isClaudeModelWithFixedPricing('claude-opus-5')).toBe(true);
    expect(isClaudeModelWithFixedPricing('anthropic/claude-sonnet-5')).toBe(true);
    expect(isClaudeModelWithFixedPricing('openai/gpt-5.6-luna')).toBe(false);
    expect(isClaudeModelWithFixedPricing('claude-something-unlisted')).toBe(false);
  });
});
