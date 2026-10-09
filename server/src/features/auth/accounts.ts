// server/src/features/auth/accounts.ts
//
// The one place a seeker account is created (WP-10). Email/password signup
// (SeekerAuthService.signup) and OAuth sign-up (Google, LINE) both call
// `createSeekerAccount` inside their transaction, so every account gets:
//   - role='seeker' and roles=['seeker'] together (lib/prisma.ts role guard);
//   - `User.brand` from the request (immutable afterwards) and `User.market`
//     per ARCHITECTURE.md §1.10;
//   - `SeekerProfile.onboardingStep = 'account'` written explicitly (the
//     column defaults to 'done' so the additive push never sent existing users
//     back through onboarding; R-06), plus the entry attribution and timezone;
//   - the audit consent rows (`seeker_app_optin` + what the signup screen
//     collected, incl. the required `age_16_plus`).
// No V1 `RoboApplyMission` is created any more.

import type prismaClient from '../../lib/prisma.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { BrandId } from '../../platform/brand/registry.js';
import { SEEKER_CONSENT_PROSE_VERSION } from '../../roboapply/engine/lib/seekerConsentTypes.js';
import type { OnboardingEntry } from '../onboarding/contract.js';
import type { ConsentRow } from './signupPolicy.js';

type Tx = Pick<typeof prismaClient, 'user' | 'seekerProfile' | 'seekerConsentRecord'>;

/** Flow version stamped on new accounts (`SeekerProfile.onboardingVersion`). */
export const ONBOARDING_VERSION = 'v6-jobright';

export interface CreateSeekerAccountInput {
  email: string;
  passwordHash: string | null;
  name?: string | null;
  provider: 'email' | 'google' | 'line';
  providerId?: string | null;
  /** False for email/password (verification email follows); true when the provider or our link verified it. */
  emailVerified: boolean;
  /** Omitted → the column default ('roboapply'). */
  brand?: BrandId;
  market: string;
  locale: string | null;
  source?: string;
  consentRows: ConsentRow[];
  entry?: OnboardingEntry | null;
  timezone?: string | null;
  now?: Date;
}

export interface CreatedSeekerAccount {
  user: { id: string; email: string; name: string | null; role: string; subscriptionTier: string; market: string };
  profile: { id: string; source: string; readinessScore: number; locale: string | null };
}

export async function createSeekerAccount(tx: Tx, input: CreateSeekerAccountInput): Promise<CreatedSeekerAccount> {
  const now = input.now ?? new Date();
  const user = await tx.user.create({
    data: {
      email: input.email,
      passwordHash: input.passwordHash,
      name: input.name ?? null,
      provider: input.provider,
      providerId: input.providerId ?? null,
      role: 'seeker',
      roles: ['seeker'],
      market: input.market,
      emailVerified: input.emailVerified,
      emailVerifiedAt: input.emailVerified ? now : null,
      ...(input.brand ? { brand: input.brand } : {}),
    },
    select: { id: true, email: true, name: true, role: true, subscriptionTier: true, market: true },
  });
  const profile = await tx.seekerProfile.create({
    data: {
      userId: user.id,
      source: input.source ?? 'organic',
      locale: input.locale,
      market: input.market,
      onboardingStep: 'account',
      onboardingVersion: ONBOARDING_VERSION,
      onboardingStartedAt: now,
      ...(input.entry ? { onboardingEntry: input.entry as Prisma.InputJsonValue } : {}),
      ...(input.timezone ? { timezone: input.timezone } : {}),
    },
    select: { id: true, source: true, readinessScore: true, locale: true },
  });
  // Audit rows: the implicit "signing up for the seeker app" plus what the
  // signup screen collected (age, PDPA notice, marketing choice, …).
  await tx.seekerConsentRecord.createMany({
    data: [
      { seekerProfileId: profile.id, consentType: 'seeker_app_optin', granted: true, proseVersion: SEEKER_CONSENT_PROSE_VERSION },
      ...input.consentRows.map((c) => ({
        seekerProfileId: profile.id,
        consentType: c.consentType,
        granted: c.granted,
        proseVersion: c.proseVersion,
      })),
    ],
  });
  return { user, profile };
}
