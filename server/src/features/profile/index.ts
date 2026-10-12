// server/src/features/profile/index.ts — public surface of the profile area (WP-19).
//
// `profileSnapshotForLlm()` is the ONLY context builder COP/MATCH/RES/CL/EXT
// may put in a prompt (TASK_PLAN.md §2.2, H32): it never contains sensitive
// answers, EEO answers, the photo, 籍贯, 政治面貌, gender, birth date, family
// members, contact details or school tags (snapshot.ts).
// `sensitiveAnswersForAutofill()` is the only way out for sensitive answers:
// the extension's autofill payload (WP-55a), with a live `autofill_sensitive`
// consent, never a prompt.

import type { ProfileSnapshotForLlm, ProfileView, SensitiveAnswers } from './contract.js';
import { brandForUser, createProfileService, type ProfileServiceImpl } from './service.js';

export * from './contract.js';
export { createProfileRouter } from './routes.js';
export type { ProfileRouterDeps } from './routes.js';
export { createProfileService, type ProfileServiceImpl, type ProfileServiceDeps, type ProfileContext } from './service.js';
export { computeCompleteness, COMPLETENESS_RULES } from './completeness.js';
export { buildSnapshotText, CN_SNAPSHOT_KEYS, NEVER_IN_PROMPT } from './snapshot.js';

export interface ProfileService {
  get(userId: string): Promise<ProfileView>;
  completeness(userId: string): Promise<{ completeness: number; missing: Array<{ key: string; label: string }> }>;
  profileSnapshotForLlm(userId: string): Promise<ProfileSnapshotForLlm>;
  sensitiveAnswersForAutofill(userId: string): Promise<SensitiveAnswers | null>;
}

let impl: ProfileServiceImpl | null = null;
const service = () => (impl ??= createProfileService());

/** Bare-user-id surface for other areas. The brand is the user's stored brand (never guessed from an unset context). */
export const profileService: ProfileService = {
  async get(userId) {
    return service().get(userId, { brand: await brandForUser(userId) });
  },
  async completeness(userId) {
    return service().completeness(userId, { brand: await brandForUser(userId) });
  },
  async profileSnapshotForLlm(userId) {
    return service().snapshotForLlm(userId, { brand: await brandForUser(userId) });
  },
  async sensitiveAnswersForAutofill(userId) {
    return service().sensitiveForAutofill(userId);
  },
};

export const profileSnapshotForLlm = (userId: string) => profileService.profileSnapshotForLlm(userId);
export const sensitiveAnswersForAutofill = (userId: string) => profileService.sensitiveAnswersForAutofill(userId);
