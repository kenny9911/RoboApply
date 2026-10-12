// server/src/features/uistate/service.ts
//
// Read and update `RAUserUiState` (one row per user). The patch is applied
// in memory (pure `applyUiStatePatch`) and written with an optimistic check
// on `updatedAt`, retried a few times, so concurrent PATCHes from two tabs
// both land.

import prisma from '../../lib/prisma.js';
import { Prisma } from '../../generated/prisma/client.js';
import { HttpError } from '../../platform/http.js';
import {
  EMPTY_UI_STATE,
  UI_KEY_RE,
  UI_STATE_LIMITS,
  type UiState,
  type UiStatePatch,
  type UiStateResponse,
} from './contract.js';

export type UiStateDb = Pick<typeof prisma, 'rAUserUiState'>;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isIso(v: unknown): v is string {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v));
}

/** Tolerant read of the stored JSON: unknown or malformed parts are dropped. */
export function normalizeUiState(raw: unknown): UiState {
  const src = isObject(raw) ? raw : {};
  const tours: UiState['tours'] = {};
  if (isObject(src.tours)) {
    for (const [k, v] of Object.entries(src.tours)) if (UI_KEY_RE.test(k) && isIso(v)) tours[k] = v;
  }
  const dismissals: UiState['dismissals'] = {};
  if (isObject(src.dismissals)) {
    for (const [k, v] of Object.entries(src.dismissals)) {
      if (!UI_KEY_RE.test(k) || !isObject(v)) continue;
      const count = Number(v.count);
      if (Number.isInteger(count) && count >= 0 && isIso(v.at)) dismissals[k] = { count, at: v.at };
    }
  }
  const values: UiState['values'] = {};
  if (isObject(src.values)) {
    for (const [k, v] of Object.entries(src.values)) {
      if (!UI_KEY_RE.test(k)) continue;
      if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'string') values[k] = v;
    }
  }
  const announcementsSeen = Array.isArray(src.announcementsSeen)
    ? src.announcementsSeen.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 64)
    : [];
  return {
    tours,
    dismissals,
    popupLastShownAt: isIso(src.popupLastShownAt) ? src.popupLastShownAt : null,
    announcementsSeen: [...new Set(announcementsSeen)].slice(-UI_STATE_LIMITS.announcementsSeen),
    values,
  };
}

function trimOldest<T>(record: Record<string, T>, max: number, at: (v: T) => string): Record<string, T> {
  const entries = Object.entries(record);
  if (entries.length <= max) return record;
  entries.sort((a, b) => Date.parse(at(a[1])) - Date.parse(at(b[1])));
  return Object.fromEntries(entries.slice(entries.length - max));
}

/** Pure: apply one PATCH to a state at time `now`. Throws HttpError(invalid_request) when values exceed the cap. */
export function applyUiStatePatch(state: UiState, patch: UiStatePatch, now: Date): UiState {
  const iso = now.toISOString();
  const next: UiState = {
    tours: { ...state.tours },
    dismissals: { ...state.dismissals },
    popupLastShownAt: state.popupLastShownAt,
    announcementsSeen: [...state.announcementsSeen],
    values: { ...state.values },
  };
  for (const k of patch.toursReset ?? []) delete next.tours[k];
  for (const k of patch.toursSeen ?? []) if (!next.tours[k]) next.tours[k] = iso;
  for (const k of patch.undismiss ?? []) delete next.dismissals[k];
  for (const k of patch.dismiss ?? []) next.dismissals[k] = { count: (next.dismissals[k]?.count ?? 0) + 1, at: iso };
  if (patch.popupShown) next.popupLastShownAt = iso;
  if (patch.announcementsSeen?.length) {
    const seen = next.announcementsSeen.filter((id) => !patch.announcementsSeen!.includes(id));
    next.announcementsSeen = [...seen, ...new Set(patch.announcementsSeen)].slice(-UI_STATE_LIMITS.announcementsSeen);
  }
  for (const [k, v] of Object.entries(patch.values ?? {})) {
    if (v === null) delete next.values[k];
    else next.values[k] = v;
  }
  if (Object.keys(next.values).length > UI_STATE_LIMITS.values) {
    throw new HttpError('invalid_request', `At most ${UI_STATE_LIMITS.values} values can be stored.`, {
      where: 'body',
      issues: [{ path: ['values'], code: 'too_big', message: 'Too many stored values.' }],
    });
  }
  next.tours = trimOldest(next.tours, UI_STATE_LIMITS.tours, (v) => v);
  next.dismissals = trimOldest(next.dismissals, UI_STATE_LIMITS.dismissals, (v) => v.at);
  return next;
}

interface Row {
  state: Prisma.JsonValue;
  lastFeedVisitAt: Date | null;
  updatedAt: Date;
}

function toResponse(row: Row | null): UiStateResponse {
  if (!row) return { state: normalizeUiState(EMPTY_UI_STATE), lastFeedVisitAt: null, updatedAt: null };
  return {
    state: normalizeUiState(row.state),
    lastFeedVisitAt: row.lastFeedVisitAt ? row.lastFeedVisitAt.toISOString() : null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

const SELECT = { state: true, lastFeedVisitAt: true, updatedAt: true } as const;
const MAX_RETRIES = 4;

export class UiStateService {
  constructor(private readonly db: UiStateDb = prisma) {}

  async get(userId: string): Promise<UiStateResponse> {
    const row = await this.db.rAUserUiState.findUnique({ where: { userId }, select: SELECT });
    return toResponse(row);
  }

  async patch(userId: string, patch: UiStatePatch, now: Date = new Date()): Promise<UiStateResponse> {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
      const row = await this.db.rAUserUiState.findUnique({ where: { userId }, select: SELECT });
      const next = applyUiStatePatch(normalizeUiState(row?.state), patch, now);
      const state = next as unknown as Prisma.InputJsonValue;
      if (!row) {
        try {
          const created = await this.db.rAUserUiState.create({ data: { userId, state }, select: SELECT });
          return toResponse(created);
        } catch (err) {
          if ((err as { code?: string })?.code === 'P2002') continue; // another tab created it first
          throw err;
        }
      }
      const { count } = await this.db.rAUserUiState.updateMany({
        where: { userId, updatedAt: row.updatedAt },
        data: { state },
      });
      if (count > 0) {
        const fresh = await this.db.rAUserUiState.findUnique({ where: { userId }, select: SELECT });
        return toResponse(fresh);
      }
    }
    throw new HttpError('conflict', 'Your settings changed in another window. Try again.');
  }
}

export const uiStateService = new UiStateService();
