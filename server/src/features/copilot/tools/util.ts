// server/src/features/copilot/tools/util.ts — shared helpers for the Assistant tools (WP-50).

import { z } from 'zod';
import type { Sourced } from '../../../platform/http.js';
import type { FeedItem, PublicFeedItem } from '../../feed/index.js';
import type { CardType, CopilotCard, CountView } from '../contract.js';
import type { ToolContext, ToolOutput } from '../types.js';

export const JobId = z.string().min(1).max(64).describe('A job id returned by a tool (search_jobs, top_fit_jobs) or the job in context.');

/** A seam that is still a stub, or a feature that is off, answers this (the model says it is not available). */
export function notAvailable(reason: string, extra: Record<string, unknown> = {}): ToolOutput {
  return { data: { available: false, reason, ...extra } };
}

export function isNotImplemented(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: unknown }).code === 'not_implemented';
}

export function isNotFound(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'not_found' || (err as { status?: unknown } | null)?.status === 404;
}

export function card<T>(ctx: ToolContext, type: CardType, data: T, sources?: CopilotCard['sources']): CopilotCard<T> {
  return { type, id: ctx.newCardId(), data, ...(sources && sources.length ? { sources } : {}) };
}

/** The compact job line the model reads (cards carry the full item). */
export function jobForModel(item: FeedItem | PublicFeedItem): Record<string, unknown> {
  const fit = 'fit' in item ? item.fit : null;
  return {
    jobId: item.jobId,
    title: item.title,
    company: item.company.name,
    location: item.location,
    workModel: item.workModel,
    pay: item.pay ? { min: item.pay.min, max: item.pay.max, currency: item.pay.currency, period: item.pay.period, text: item.pay.text } : 'not listed',
    postedAt: item.postedAt,
    fit: fit ? { tier: fit.tier, score: fit.score, kind: fit.kind === 'pre' ? 'quick estimate' : 'ai', topGap: fit.topGap, topOverlap: fit.topOverlap } : null,
    badges: item.badges.map((b) => b.kind),
  };
}

export function clip(text: string | null | undefined, max: number): string | null {
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Credit-action cost line for the card (`Uses N … credits; you have M left`). */
export async function costLine(ctx: ToolContext, bucket: string): Promise<{ remaining: number | null; resetsAt: string | null }> {
  try {
    const left = await ctx.creditsLeft(bucket);
    return { remaining: left?.remaining ?? null, resetsAt: left?.resetsAt ?? null };
  } catch {
    return { remaining: null, resetsAt: null };
  }
}

export function requireUser(ctx: ToolContext): string {
  if (!ctx.userId) throw new Error('This tool needs a signed-in user.');
  return ctx.userId;
}

/** A count computed over our job index, as it goes on the wire (D3: every non-user number is Sourced). */
export function indexCount(value: number, asOf: Date, sampleSize: number = value): Sourced<number> {
  return { value, source: 'index', sampleSize, asOf: asOf.toISOString(), method: 'computed' };
}

/** A feed count result for a card: the number wrapped as Sourced; unknown stays null. */
export function countView(res: { count: number | null; capped: boolean } | null, asOf: Date): CountView | null {
  if (!res) return null;
  return { count: res.count === null ? null : indexCount(res.count, asOf), capped: res.capped };
}
