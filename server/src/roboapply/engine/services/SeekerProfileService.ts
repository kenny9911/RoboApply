// backend/src/seeker/services/SeekerProfileService.ts
//
// Lifecycle + read helpers for the SeekerProfile row.
//
// Boundary: only imports from backend/src/lib/* and seeker-local code, per
// backend/src/seeker/README.md.

import prisma from '../../../lib/prisma.js';
import type { ExtendedTransactionClient } from '../../../lib/prisma.js';
import { SEEKER_CONSENT_PROSE_VERSION } from '../lib/seekerConsentTypes.js';

export type OnboardingStep =
  | 'resume'
  | 'preferences'
  | 'interview'
  | 'profile_video'
  | 'complete';

export interface OnboardingState {
  /** Step the seeker should land on next. `complete` once everything is done. */
  step: OnboardingStep;
  /** Steps already finished, in declared order. */
  completedSteps: OnboardingStep[];
  /** Whether onboardingCompletedAt is set (i.e. seeker pressed Done). */
  completed: boolean;
}

export interface SeekerProfileSummary {
  id: string;
  userId: string;
  source: string;
  readinessScore: number;
  locale: string | null;
  market: string | null;
  masterResumeId: string | null;
  visibilityInternal: boolean;
  visibilityExternal: boolean;
  stealthFromInviter: boolean;
  onboardingCompletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The seeker schema doesn't have a dedicated `onboardingCompletedAt` column
 * today — Phase 1 wraps onboarding completion in a deletionEmailSentAt-style
 * column added by Phase 0. Until that field lands we encode "onboarding done"
 * as a deterministic JSON pin on the fusedProfile field's `onboardingCompletedAt`
 * key. Frontend should treat the boolean `completed` field on OnboardingState
 * as the truth — keeping the storage detail hidden in this service.
 */
const ONBOARDING_COMPLETED_AT_KEY = '__onboardingCompletedAt';

type FusedProfileWithOnboarding = {
  [key: string]: unknown;
  [ONBOARDING_COMPLETED_AT_KEY]?: string;
};

function extractOnboardingCompletedAt(
  fusedProfile: unknown,
): Date | null {
  if (!fusedProfile || typeof fusedProfile !== 'object' || Array.isArray(fusedProfile)) {
    return null;
  }
  const blob = fusedProfile as FusedProfileWithOnboarding;
  const stamp = blob[ONBOARDING_COMPLETED_AT_KEY];
  if (typeof stamp !== 'string') return null;
  const parsed = new Date(stamp);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function setOnboardingCompletedAt(
  fusedProfile: unknown,
  at: Date,
): FusedProfileWithOnboarding {
  const base =
    fusedProfile && typeof fusedProfile === 'object' && !Array.isArray(fusedProfile)
      ? (fusedProfile as FusedProfileWithOnboarding)
      : {};
  return { ...base, [ONBOARDING_COMPLETED_AT_KEY]: at.toISOString() };
}

function toProfileSummary(profile: {
  id: string;
  userId: string;
  source: string;
  readinessScore: number;
  locale: string | null;
  market: string | null;
  masterResumeId: string | null;
  visibilityInternal: boolean;
  visibilityExternal: boolean;
  stealthFromInviter: boolean;
  fusedProfile: unknown;
  createdAt: Date;
  updatedAt: Date;
}): SeekerProfileSummary {
  return {
    id: profile.id,
    userId: profile.userId,
    source: profile.source,
    readinessScore: profile.readinessScore,
    locale: profile.locale,
    market: profile.market,
    masterResumeId: profile.masterResumeId,
    visibilityInternal: profile.visibilityInternal,
    visibilityExternal: profile.visibilityExternal,
    stealthFromInviter: profile.stealthFromInviter,
    onboardingCompletedAt: extractOnboardingCompletedAt(profile.fusedProfile),
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

export interface CreateSeekerProfileOpts {
  /** 'organic' | 'invited' | 'imported'. Defaults to 'organic'. */
  source?: string;
  invitedByCompanyName?: string | null;
  invitedByInterviewId?: string | null;
  locale?: string | null;
  market?: string | null;
}

/**
 * Create the SeekerProfile + default SeekerConsentRecord(s) in a single
 * transaction. Idempotent on the unique `userId` constraint — callers that
 * may race (signup vs. opt-in-from-invite) should catch and retry by
 * calling `getByUserId`.
 *
 * Note: this does NOT touch the User row itself. Callers (e.g.
 * SeekerAuthService) are responsible for setting User.role / User.roles
 * together to satisfy the role-invariant guard.
 */
async function createForUser(
  userId: string,
  opts: CreateSeekerProfileOpts = {},
  tx?: ExtendedTransactionClient,
): Promise<SeekerProfileSummary> {
  const client = tx ?? prisma;
  const profile = await client.seekerProfile.create({
    data: {
      userId,
      source: opts.source ?? 'organic',
      invitedByCompanyName: opts.invitedByCompanyName ?? null,
      invitedByInterviewId: opts.invitedByInterviewId ?? null,
      locale: opts.locale ?? null,
      market: opts.market ?? null,
      // Default-grant of seeker_app_optin so the audit row exists from the
      // moment the seeker account does. Biometric / auto-apply consents are
      // collected at the surface that needs them (record video, toggle
      // auto-apply) — not at signup.
      consentRecords: {
        create: {
          consentType: 'seeker_app_optin',
          granted: true,
          proseVersion: SEEKER_CONSENT_PROSE_VERSION,
        },
      },
    },
    select: {
      id: true,
      userId: true,
      source: true,
      readinessScore: true,
      locale: true,
      market: true,
      masterResumeId: true,
      visibilityInternal: true,
      visibilityExternal: true,
      stealthFromInviter: true,
      fusedProfile: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  return toProfileSummary(profile);
}

async function getByUserId(userId: string): Promise<SeekerProfileSummary | null> {
  const profile = await prisma.seekerProfile.findUnique({
    where: { userId },
    select: {
      id: true,
      userId: true,
      source: true,
      readinessScore: true,
      locale: true,
      market: true,
      masterResumeId: true,
      visibilityInternal: true,
      visibilityExternal: true,
      stealthFromInviter: true,
      fusedProfile: true,
      deletedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  if (!profile) return null;
  if (profile.deletedAt) return null;
  return toProfileSummary(profile);
}

async function computeOnboardingState(userId: string): Promise<OnboardingState> {
  const profile = await prisma.seekerProfile.findUnique({
    where: { userId },
    select: {
      id: true,
      masterResumeId: true,
      fusedProfile: true,
      preferences: { select: { id: true } },
      profileVideos: {
        // A profile video counts toward the onboarding step once we've
        // persisted the row (status: 'processing' or later). Skipping the
        // step is handled separately via /profile/skip-profile-video.
        where: {
          activeTake: true,
          deletedAt: null,
          status: { in: ['processing', 'ready', 'complete', 'uploading'] },
        },
        select: { id: true },
        take: 1,
      },
      onboardingInterviews: {
        // The 20-minute LiveKit onboarding interview. Distinct from
        // mock interviews (those run post-onboarding). Either an
        // in-progress or finished session counts toward the step.
        where: { status: { in: ['in_progress', 'processing', 'complete'] } },
        select: { id: true },
        take: 1,
      },
    },
  });

  if (!profile) {
    return { step: 'resume', completedSteps: [], completed: false };
  }

  const completedSteps: OnboardingStep[] = [];
  if (profile.masterResumeId) completedSteps.push('resume');
  if (profile.preferences) completedSteps.push('preferences');
  if (profile.onboardingInterviews.length > 0) completedSteps.push('interview');
  if (profile.profileVideos.length > 0) completedSteps.push('profile_video');

  const completedAt = extractOnboardingCompletedAt(profile.fusedProfile);
  const completed = completedAt !== null;

  // `step` is the next thing the seeker should do. Resume + preferences are
  // mandatory in week 1; everything else is opt-in but still surfaced.
  let step: OnboardingStep;
  if (completed) {
    step = 'complete';
  } else if (!completedSteps.includes('resume')) {
    step = 'resume';
  } else if (!completedSteps.includes('preferences')) {
    step = 'preferences';
  } else if (!completedSteps.includes('interview')) {
    step = 'interview';
  } else if (!completedSteps.includes('profile_video')) {
    step = 'profile_video';
  } else {
    step = 'complete';
  }

  return { step, completedSteps, completed };
}

async function markComplete(userId: string): Promise<SeekerProfileSummary> {
  const existing = await prisma.seekerProfile.findUnique({
    where: { userId },
    select: { id: true, fusedProfile: true },
  });
  if (!existing) {
    throw new Error('Seeker profile not found');
  }
  const nextBlob = setOnboardingCompletedAt(existing.fusedProfile, new Date());
  const updated = await prisma.seekerProfile.update({
    where: { id: existing.id },
    data: {
      fusedProfile: nextBlob as unknown as object,
      fusedProfileAt: new Date(),
    },
    select: {
      id: true,
      userId: true,
      source: true,
      readinessScore: true,
      locale: true,
      market: true,
      masterResumeId: true,
      visibilityInternal: true,
      visibilityExternal: true,
      stealthFromInviter: true,
      fusedProfile: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  return toProfileSummary(updated);
}

/**
 * Attach a master Resume row (the seeker's primary resume) to their profile.
 * Idempotent — calling with the same resumeId is a no-op.
 */
async function setMasterResume(
  userId: string,
  resumeId: string,
): Promise<SeekerProfileSummary> {
  const profile = await prisma.seekerProfile.update({
    where: { userId },
    data: { masterResumeId: resumeId },
    select: {
      id: true,
      userId: true,
      source: true,
      readinessScore: true,
      locale: true,
      market: true,
      masterResumeId: true,
      visibilityInternal: true,
      visibilityExternal: true,
      stealthFromInviter: true,
      fusedProfile: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  return toProfileSummary(profile);
}

export const seekerProfileService = {
  createForUser,
  getByUserId,
  computeOnboardingState,
  markComplete,
  setMasterResume,
};

export default seekerProfileService;
