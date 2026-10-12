// server/src/features/skills/seed/index.ts
//
// The committed seed: what a fresh environment knows before RASkill holds a
// row, and what `current()` returns before the first load. The file is
// generated (seed/build.ts); this module only reads it.

import type { SkillRecord } from '../types.js';
import data from './skills.seed.json' with { type: 'json' };

export const SEED_VERSION: number = data.version;

/** Every seed skill: reviewed, no ESCO or O*NET identifier unless a reviewer's export carried one. */
export const SEED_SKILLS: readonly SkillRecord[] = data.skills as unknown as SkillRecord[];

/** The ids of the seed skills. */
export const SEED_SKILL_IDS: ReadonlySet<string> = new Set(SEED_SKILLS.map((s) => s.id));

/**
 * Comparison keys of strings a reviewer dropped ("fast-paced environment"),
 * carried by `export-seed` so they are no skill in any environment, also one
 * whose table was never reviewed.
 */
export const SEED_DROPPED_KEYS: readonly string[] = ((data as { dropped?: unknown }).dropped as string[] | undefined) ?? [];
