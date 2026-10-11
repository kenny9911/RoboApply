// server/src/features/jobs/enrich/roleNeighbours.ts
//
// The roles nearest to a posting's title by embedding (SM-2 refinement; MATCH
// 4.5 point 3). When a title does not name its role outright, the three roles
// whose label is closest to it are added to the candidates the model chooses
// from (candidates.ts `extraIds`), so it always sees a plausible alternative.
//
//   - Role-label vectors: the English and the Simplified Chinese label of
//     every role a model may be offered (level 3 of the tree), embedded ONCE
//     per worker process and model tag (`purpose: 'skill'`, no user data) and
//     kept in memory. Jobs enriched in parallel share the one request.
//   - Per job: one request for the title, then the cosine to every label; a
//     role's similarity is the better of its two labels.
//   - Only the enrichment of a public posting asks (service.ts): a user's own
//     import is enriched inside its request and its text is that user's data,
//     so it never reaches this module.
//   - The embeddings client unavailable (no key, policy, budget) → no
//     neighbours, silently. A failed call → no neighbours and one warning,
//     and the step is not tried again for ROLE_VECTOR_RETRY_MS (a failing
//     endpoint is not asked once per job). This step never fails an
//     enrichment.
// Nothing here runs at import time.

import type { BrandId } from '../../../platform/brand/index.js';
import type { EmbedOptions, EmbedResult } from '../../../platform/embeddings/index.js';
import { logger } from '../../../services/LoggerService.js';
import { CANDIDATE_ROLES, MAX_NEIGHBOUR_CANDIDATES } from './candidates.js';

/** After a failed request the step is skipped for this long. */
export const ROLE_VECTOR_RETRY_MS = 5 * 60_000;

type Embed = (brand: BrandId, texts: readonly string[], options: EmbedOptions) => Promise<EmbedResult>;

export interface RoleNeighbourDeps {
  /** Default: the embeddings client, imported on first use. */
  embed?: Embed;
  /** Default: every role a model may be offered, with its two labels. */
  roles?: ReadonlyArray<{ id: string; en: string; zh: string }>;
  now?: () => number;
}

export interface RoleNeighbourContext {
  brand: BrandId;
  requestId?: string;
}

/** The roles nearest to `title`, best first (at most MAX_NEIGHBOUR_CANDIDATES); empty when the step cannot run. */
export type RoleNeighbours = (title: string, ctx: RoleNeighbourContext) => Promise<string[]>;

interface LabelVectors {
  model: string;
  /** One entry per label: the role it belongs to and its unit vector. */
  labels: Array<{ id: string; vector: Float32Array }>;
}

function unit(vector: readonly number[]): Float32Array | null {
  let norm = 0;
  for (const x of vector) norm += x * x;
  if (!Number.isFinite(norm) || norm <= 0) return null;
  const scale = 1 / Math.sqrt(norm);
  const out = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i++) out[i] = vector[i]! * scale;
  return out;
}

function dot(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return Number.NaN;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
  return sum;
}

const embedLazy: Embed = async (brand, texts, options) => (await import('../../../platform/embeddings/index.js')).embedTexts(brand, texts, options);

export function createRoleNeighbours(deps: RoleNeighbourDeps = {}): RoleNeighbours {
  const embed = deps.embed ?? embedLazy;
  const roles = deps.roles ?? CANDIDATE_ROLES;
  const now = deps.now ?? Date.now;
  /** Label vectors per brand (a brand has one embedding model at a time); the promise is shared by parallel jobs. */
  const cache = new Map<BrandId, Promise<LabelVectors | null>>();
  const retryAt = new Map<BrandId, number>();

  async function loadLabels(brand: BrandId): Promise<LabelVectors | null> {
    const texts: string[] = [];
    const owners: string[] = [];
    for (const role of roles) {
      for (const label of new Set([role.en, role.zh])) {
        if (!label?.trim()) continue;
        texts.push(label.trim());
        owners.push(role.id);
      }
    }
    if (!texts.length) return null;
    const result = await embed(brand, texts, { purpose: 'skill', carriesUserData: false });
    if ('unavailable' in result || result.vectors.length !== texts.length) return null;
    const labels: LabelVectors['labels'] = [];
    result.vectors.forEach((vector, i) => {
      const v = unit(vector);
      if (v) labels.push({ id: owners[i]!, vector: v });
    });
    return labels.length ? { model: result.model, labels } : null;
  }

  function labelsFor(brand: BrandId): Promise<LabelVectors | null> {
    const cached = cache.get(brand);
    if (cached) return cached;
    const loading = loadLabels(brand).then(
      (loaded) => {
        // Unavailable is not kept: a key or a budget may be there for the next job.
        if (!loaded) cache.delete(brand);
        return loaded;
      },
      (err: unknown) => {
        cache.delete(brand);
        throw err;
      },
    );
    cache.set(brand, loading);
    return loading;
  }

  return async (title, ctx) => {
    const text = title.replace(/\s+/g, ' ').trim();
    if (!text || (retryAt.get(ctx.brand) ?? 0) > now()) return [];
    try {
      // The title first: when the client is unavailable nothing else is asked.
      const asked = await embed(ctx.brand, [text], { purpose: 'skill', carriesUserData: false, requestId: ctx.requestId ?? null });
      if ('unavailable' in asked) return [];
      const titleVector = unit(asked.vectors[0] ?? []);
      if (!titleVector) return [];
      let labels = await labelsFor(ctx.brand);
      // Vectors of two models are never compared: a changed model means new label vectors.
      if (labels && labels.model !== asked.model) {
        cache.delete(ctx.brand);
        labels = await labelsFor(ctx.brand);
      }
      if (!labels || labels.model !== asked.model) return [];
      const best = new Map<string, number>();
      for (const label of labels.labels) {
        const cosine = dot(titleVector, label.vector);
        if (!Number.isFinite(cosine)) continue;
        if (cosine > (best.get(label.id) ?? -Infinity)) best.set(label.id, cosine);
      }
      return [...best.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, MAX_NEIGHBOUR_CANDIDATES)
        .map(([id]) => id);
    } catch (err) {
      // Said once per pause, not once per job.
      if ((retryAt.get(ctx.brand) ?? 0) <= now()) {
        logger.warn('JOB_ENRICH', 'nearest roles by embedding failed; postings are enriched without them for a while', { brand: ctx.brand, retryInMs: ROLE_VECTOR_RETRY_MS, error: err instanceof Error ? err.message : String(err) });
      }
      retryAt.set(ctx.brand, now() + ROLE_VECTOR_RETRY_MS);
      return [];
    }
  };
}
