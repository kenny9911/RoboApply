// server/src/features/alice/skills/followUps.ts — when an application needs the person.
//
// Facts, not predictions (rulings C11, C40): the tracker's follow-up facts
// (`computeFollowUps`: interview tomorrow, a saved job's deadline soon, a
// follow-up date due, no reply 10 days after applying) and the applications
// the Ready to apply agent prepared that wait for the person's check. Ordered
// by what costs most to miss; one item per application, the first that holds.

import type { AliceNeedsKind, AliceNeedsYouItem } from '../contract.js';

/** Tracker facts as the tracker states them (FollowUpView). */
export interface TrackerFact {
  entryId: string;
  reason: 'interview_tomorrow' | 'deadline_soon' | 'follow_up_due' | 'no_reply_10d';
  at: string;
  days: number | null;
  companyName: string | null;
  title: string | null;
}

/** A prepared application waiting for the person's check (Ready to apply `ready_for_review`). */
export interface ReadyToCheck {
  queueItemId: string;
  entryId: string | null;
  company: string | null;
  title: string | null;
  at: string;
}

export const NEEDS_ORDER: readonly AliceNeedsKind[] = ['interview_tomorrow', 'ready_to_check', 'deadline_soon', 'follow_up_due', 'no_reply_10d'];

export function needsYou(facts: readonly TrackerFact[], ready: readonly ReadyToCheck[], limit = 8): AliceNeedsYouItem[] {
  const items: AliceNeedsYouItem[] = [
    ...facts.map((f) => ({ kind: f.reason, entryId: f.entryId, queueItemId: null, company: f.companyName, title: f.title, at: f.at, days: f.days })),
    ...ready.map((r) => ({ kind: 'ready_to_check' as const, entryId: r.entryId, queueItemId: r.queueItemId, company: r.company, title: r.title, at: r.at, days: null })),
  ];
  items.sort((a, b) => NEEDS_ORDER.indexOf(a.kind) - NEEDS_ORDER.indexOf(b.kind) || a.at.localeCompare(b.at));
  const seen = new Set<string>();
  const out: AliceNeedsYouItem[] = [];
  for (const item of items) {
    const key = item.entryId ?? `q:${item.queueItemId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}
