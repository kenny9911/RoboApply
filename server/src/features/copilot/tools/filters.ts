// server/src/features/copilot/tools/filters.ts — the saved search (F-ORION-04/05; WP-50).
//
// get_current_filters · propose_filter_change · set_sort. Nothing here changes
// the saved search: `propose_filter_change` validates the ops against the
// FilterSet schema for the brand's market, computes the diff and the feed
// counts before and after, and stores a pending proposal. The user applies it
// from the `filter_diff` card (POST /copilot/proposals/:id/apply), which
// checks `baseVersion` (proposals.ts).

import { z } from 'zod';
import type { Market } from '../../../platform/brand/registry.js';
import { FEED_SORTS, type FeedCountResult } from '../../feed/contract.js';
import {
  FILTER_FIELDS,
  FILTER_SET_ALIASES,
  diffFilterSets,
  mergeFilterSet,
  parseFilterSet,
  parseFilterSetPatch,
  stableStringify,
  type FilterSet,
  type FilterSetPatch,
  type SearchProfileWire,
} from '../../search/index.js';
import type { ActionCardData, FilterDiffCardData } from '../contract.js';
import type { CopilotAreas, CopilotTool } from '../types.js';
import { card, countView, requireUser } from './util.js';

export interface FilterOp {
  op: 'add' | 'remove' | 'set';
  path: string;
  value?: unknown;
}

const OpSchema = z
  .object({
    op: z.enum(['add', 'remove', 'set']),
    path: z.string().min(1).max(60).describe('A filter field name, e.g. workModels, salaryMin, excludedCompanies, seniority.'),
    value: z.unknown().optional().describe('For add/remove: one item or a list of items. For set: the new value, or null to clear.'),
  })
  .strict();

function fieldOf(path: string): string | null {
  const name = path.replace(/^\/+/, '').split(/[./]/)[0] ?? '';
  const canonical = FILTER_SET_ALIASES[name] ?? name;
  return (FILTER_FIELDS as readonly string[]).includes(canonical) ? canonical : null;
}

const itemKey = (x: unknown) => (typeof x === 'string' ? x.trim().toLowerCase() : stableStringify(x));

/** Turn ops into a FilterSetPatch relative to `base` (pure). */
export function opsToPatch(base: FilterSet, ops: readonly FilterOp[]): { ok: true; patch: FilterSetPatch } | { ok: false; issues: Array<{ path: string; message: string }> } {
  const working: Record<string, unknown> = { ...base };
  const touched = new Set<string>();
  const issues: Array<{ path: string; message: string }> = [];
  for (const op of ops) {
    const field = fieldOf(op.path);
    if (!field) {
      issues.push({ path: op.path, message: 'unknown filter field' });
      continue;
    }
    touched.add(field);
    const current = working[field];
    if (op.op === 'set') {
      working[field] = op.value === undefined ? null : op.value;
      continue;
    }
    const items = Array.isArray(op.value) ? op.value : op.value === undefined ? [] : [op.value];
    if (op.op === 'add') {
      if (Array.isArray(current) || current === undefined || current === null) {
        const list = Array.isArray(current) ? [...current] : [];
        const keys = new Set(list.map(itemKey));
        for (const it of items) if (!keys.has(itemKey(it))) (list.push(it), keys.add(itemKey(it)));
        working[field] = list;
      } else {
        working[field] = items.length === 1 ? items[0] : op.value;
      }
      continue;
    }
    // remove
    if (Array.isArray(current)) {
      const drop = new Set(items.map(itemKey));
      const next = items.length ? current.filter((x) => !drop.has(itemKey(x))) : [];
      working[field] = next.length ? next : null;
    } else {
      working[field] = null;
    }
  }
  if (issues.length) return { ok: false, issues };
  const raw: Record<string, unknown> = {};
  for (const f of touched) raw[f] = working[f] === undefined ? null : working[f];
  const parsed = parseFilterSetPatch(raw);
  if (!parsed.ok) return { ok: false, issues: parsed.issues };
  return { ok: true, patch: parsed.value };
}

export interface FilterDiff {
  after: FilterSet;
  patch: FilterSetPatch;
  changes: FilterDiffCardData['changes'];
  countBefore: FeedCountResult | null;
  countAfter: FeedCountResult | null;
}

async function safeCount(areas: CopilotAreas, userId: string, filters: FilterSet): Promise<FeedCountResult | null> {
  try {
    return await areas.countForFilters(userId, filters);
  } catch {
    return null;
  }
}

/** Validate ops against a profile and compute the diff and counts (used by the tool and by a conflict re-diff). */
export async function diffForOps(
  areas: CopilotAreas,
  userId: string,
  profile: SearchProfileWire,
  ops: readonly FilterOp[],
  market: Market,
): Promise<{ ok: true; diff: FilterDiff } | { ok: false; issues: Array<{ path: string; message: string }> }> {
  const res = opsToPatch(profile.filters, ops);
  if (!res.ok) return res;
  const merged = mergeFilterSet(profile.filters, res.patch);
  const checked = parseFilterSet(merged, { market });
  if (!checked.ok) return { ok: false, issues: checked.issues };
  if (checked.dropped.length) return { ok: false, issues: checked.dropped.map((f) => ({ path: f, message: 'not available on this site' })) };
  const after = checked.value;
  const changes = diffFilterSets(profile.filters, after) as FilterDiffCardData['changes'];
  const [countBefore, countAfter] = changes.length
    ? await Promise.all([safeCount(areas, userId, profile.filters), safeCount(areas, userId, after)])
    : [null, null];
  return { ok: true, diff: { after, patch: res.patch, changes, countBefore, countAfter } };
}

export function filterDiffCard(input: {
  proposalId: string;
  expiresAt: Date;
  profile: SearchProfileWire;
  diff: FilterDiff;
  reason: string | null;
  /** When the counts were taken (the turn's or the apply's clock). */
  now: Date;
}): FilterDiffCardData {
  return {
    proposalId: input.proposalId,
    status: 'pending',
    expiresAt: input.expiresAt.toISOString(),
    searchProfileId: input.profile.id,
    baseVersion: input.profile.version,
    reason: input.reason,
    changes: input.diff.changes,
    countBefore: countView(input.diff.countBefore, input.now),
    countAfter: countView(input.diff.countAfter, input.now),
  };
}

export const getCurrentFilters: CopilotTool<Record<string, never>> = {
  name: 'get_current_filters',
  description: "The user's active saved search (filters) with its version.",
  schema: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
  async run(_args, ctx) {
    const userId = requireUser(ctx);
    const profile = await ctx.areas.activeSearchProfile(userId);
    return {
      data: { searchProfileId: profile.id, name: profile.name || null, version: profile.version, filters: profile.filters },
      cards: [card(ctx, 'filters', { searchProfileId: profile.id, name: profile.name || null, version: profile.version, filters: profile.filters })],
    };
  },
};

const ProposeArgs = z
  .object({
    ops: z.array(OpSchema).min(1).max(12),
    reason: z.string().trim().min(1).max(300).describe('One plain sentence: why this change, in the user\'s words where possible.'),
  })
  .strict();

export const proposeFilterChange: CopilotTool<z.infer<typeof ProposeArgs>> = {
  name: 'propose_filter_change',
  description:
    'Propose a change to the saved search. Nothing changes until the user taps "Apply changes" on the card; the card shows what changes and the job counts before and after.',
  schema: ProposeArgs,
  async run(args, ctx) {
    const userId = requireUser(ctx);
    const profile = await ctx.areas.activeSearchProfile(userId);
    const res = await diffForOps(ctx.areas, userId, profile, args.ops as FilterOp[], ctx.market);
    if (!res.ok) return { data: { error: 'invalid_change', issues: res.issues } };
    if (!res.diff.changes.length) return { data: { noChange: true, note: 'The saved search already has these values.' } };
    const proposal = await ctx.propose({
      kind: 'filter_change',
      payload: { searchProfileId: profile.id, baseVersion: profile.version, ops: args.ops, reason: args.reason, messageId: ctx.messageId },
    });
    const data = filterDiffCard({ proposalId: proposal.id, expiresAt: proposal.expiresAt, profile, diff: res.diff, reason: args.reason, now: ctx.now });
    return {
      data: {
        proposed: true,
        applied: false,
        note: 'Waiting for the user to apply it on the card.',
        changes: data.changes,
        jobsBefore: res.diff.countBefore?.count ?? null,
        jobsAfter: res.diff.countAfter?.count ?? null,
      },
      cards: [card(ctx, 'filter_diff', data)],
    };
  },
};

const SortArgs = z.object({ sort: z.enum(FEED_SORTS) }).strict();

export const setSort: CopilotTool<z.infer<typeof SortArgs>> = {
  name: 'set_sort',
  description: 'Change how the job list is sorted (recommended, newest, best_fit, highest_pay; deadline on campus listings). The page applies it.',
  schema: SortArgs,
  async run(args, ctx) {
    if (args.sort === 'deadline' && ctx.market !== 'cn') return { data: { error: 'deadline_sort_not_available' } };
    const data: ActionCardData = { kind: 'set_sort', sort: args.sort };
    return { data: { offered: true, sort: args.sort, note: 'The list re-sorts when the user confirms on the card.' }, cards: [card(ctx, 'action', data)] };
  },
};
