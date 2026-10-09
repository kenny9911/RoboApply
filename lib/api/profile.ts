// lib/api/profile.ts — Profile: basics, education, experience, skills, sensitive answers, resume sync.
//
// Thin typed wrappers over the area contract (FND-7). Owner: WP-19.
// Request types are the contract's zod input types; response types are the
// contract's views. Change a signature here only together with its contract.
//
// Endpoints:
//   GET    /api/v1/roboapply/profile
//   PATCH  /api/v1/roboapply/profile
//   POST   /api/v1/roboapply/profile/education
//   PATCH  /api/v1/roboapply/profile/education/:id
//   DELETE /api/v1/roboapply/profile/education/:id
//   POST   /api/v1/roboapply/profile/experience
//   PATCH  /api/v1/roboapply/profile/experience/:id
//   DELETE /api/v1/roboapply/profile/experience/:id
//   PUT    /api/v1/roboapply/profile/skills
//   GET    /api/v1/roboapply/profile/sensitive
//   PUT    /api/v1/roboapply/profile/sensitive
//   POST   /api/v1/roboapply/profile/sync-from-resume
//   POST   /api/v1/roboapply/profile/sync-from-resume/apply

import { call, type CallOptions, type In, seg } from './contracts/wire';
import type * as P from './contracts/profile';

/** `profile.get` — GET /api/v1/roboapply/profile */
export function getProfile(opts?: CallOptions): Promise<P.ProfileView> {
  return call<P.ProfileView>('GET', `/api/v1/roboapply/profile`, opts);
}

/** `profile.patch` — PATCH /api/v1/roboapply/profile */
export function patchProfile(body: In<typeof P.ProfilePatchSchema> = {}, opts?: CallOptions): Promise<P.ProfileView> {
  return call<P.ProfileView>('PATCH', `/api/v1/roboapply/profile`, { ...opts, body });
}

/** `profile.addEducation` — POST /api/v1/roboapply/profile/education */
export function addEducation(body: In<typeof P.EducationBodySchema>, opts?: CallOptions): Promise<P.ProfileEducationView> {
  return call<P.ProfileEducationView>('POST', `/api/v1/roboapply/profile/education`, { ...opts, body });
}

/** `profile.updateEducation` — PATCH /api/v1/roboapply/profile/education/:id */
export function updateEducation(id: string, body: In<typeof P.EducationPatchSchema> = {}, opts?: CallOptions): Promise<P.ProfileEducationView> {
  return call<P.ProfileEducationView>('PATCH', `/api/v1/roboapply/profile/education/${seg(id)}`, { ...opts, body });
}

/** `profile.deleteEducation` — DELETE /api/v1/roboapply/profile/education/:id */
export function deleteEducation(id: string, opts?: CallOptions): Promise<void> {
  return call<void>('DELETE', `/api/v1/roboapply/profile/education/${seg(id)}`, opts);
}

/** `profile.addExperience` — POST /api/v1/roboapply/profile/experience */
export function addExperience(body: In<typeof P.ExperienceBodySchema>, opts?: CallOptions): Promise<P.ProfileExperienceView> {
  return call<P.ProfileExperienceView>('POST', `/api/v1/roboapply/profile/experience`, { ...opts, body });
}

/** `profile.updateExperience` — PATCH /api/v1/roboapply/profile/experience/:id */
export function updateExperience(id: string, body: In<typeof P.ExperiencePatchSchema> = {}, opts?: CallOptions): Promise<P.ProfileExperienceView> {
  return call<P.ProfileExperienceView>('PATCH', `/api/v1/roboapply/profile/experience/${seg(id)}`, { ...opts, body });
}

/** `profile.deleteExperience` — DELETE /api/v1/roboapply/profile/experience/:id */
export function deleteExperience(id: string, opts?: CallOptions): Promise<void> {
  return call<void>('DELETE', `/api/v1/roboapply/profile/experience/${seg(id)}`, opts);
}

/** `profile.putSkills` — PUT /api/v1/roboapply/profile/skills */
export function putSkills(body: In<typeof P.PutSkillsBodySchema>, opts?: CallOptions): Promise<P.ProfileView> {
  return call<P.ProfileView>('PUT', `/api/v1/roboapply/profile/skills`, { ...opts, body });
}

/** `profile.getSensitive` — GET /api/v1/roboapply/profile/sensitive */
export function getSensitiveAnswers(opts?: CallOptions): Promise<P.SensitiveAnswers> {
  return call<P.SensitiveAnswers>('GET', `/api/v1/roboapply/profile/sensitive`, opts);
}

/** `profile.putSensitive` — PUT /api/v1/roboapply/profile/sensitive */
export function putSensitiveAnswers(body: In<typeof P.SensitiveAnswersSchema> = {}, opts?: CallOptions): Promise<P.SensitiveAnswers> {
  return call<P.SensitiveAnswers>('PUT', `/api/v1/roboapply/profile/sensitive`, { ...opts, body });
}

/** `profile.syncPreview` — POST /api/v1/roboapply/profile/sync-from-resume */
export function previewSyncFromResume(body: In<typeof P.SyncFromResumeBodySchema>, opts?: CallOptions): Promise<P.SyncFromResumeResponse> {
  return call<P.SyncFromResumeResponse>('POST', `/api/v1/roboapply/profile/sync-from-resume`, { ...opts, body });
}

/** `profile.syncApply` — POST /api/v1/roboapply/profile/sync-from-resume/apply */
export function applySyncFromResume(body: In<typeof P.SyncFromResumeApplyBodySchema>, opts?: CallOptions): Promise<P.ProfileView> {
  return call<P.ProfileView>('POST', `/api/v1/roboapply/profile/sync-from-resume/apply`, { ...opts, body });
}

/** Every wrapper of this area, for callers that prefer one import. */
export const profileApi = {
  getProfile,
  patchProfile,
  addEducation,
  updateEducation,
  deleteEducation,
  addExperience,
  updateExperience,
  deleteExperience,
  putSkills,
  getSensitiveAnswers,
  putSensitiveAnswers,
  previewSyncFromResume,
  applySyncFromResume,
};
