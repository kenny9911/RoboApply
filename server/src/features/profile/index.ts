// server/src/features/profile/index.ts — public surface (FND-5; owner WP-19).
//
// `profileSnapshotForLlm()` is the ONLY context builder COP/MATCH/RES/CL/EXT
// may put in a prompt (TASK_PLAN.md §2.2). Stub until WP-19.

import { NotImplementedError } from '../../platform/http.js';
import type { ProfileSnapshotForLlm, ProfileView } from './contract.js';

export * from './contract.js';
export { createProfileRouter } from './routes.js';

export interface ProfileService {
  get(userId: string): Promise<ProfileView>;
  completeness(userId: string): Promise<{ completeness: number; missing: Array<{ key: string; label: string }> }>;
  profileSnapshotForLlm(userId: string): Promise<ProfileSnapshotForLlm>;
}

export const profileService: ProfileService = {
  async get() {
    throw new NotImplementedError('profile.get');
  },
  async completeness() {
    throw new NotImplementedError('profile.completeness');
  },
  async profileSnapshotForLlm() {
    throw new NotImplementedError('profile.profileSnapshotForLlm');
  },
};

export const profileSnapshotForLlm = (userId: string) => profileService.profileSnapshotForLlm(userId);
