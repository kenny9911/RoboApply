// server/src/features/admin/viewAs.ts — start and end an admin "view as"
// grant (the god's-eye view; the grant itself is platform/viewAs).
//
//   POST /view-as       { userId }: checks who may be viewed, signs a grant for
//                       this admin and this browser's session, and says where
//                       the person lands (their onboarding screen while it is
//                       unfinished, else the first-value page). The route sets
//                       the cookie and writes admin_view_as_started.
//   POST /view-as/stop  forgets the grant; admin_view_as_ended when one was in
//                       place for this admin.
//
// Who can be viewed: an account with a RoboApply/GoApply profile that is not
// deleted, is not an admin (nor the admin themself) and belongs to the brand
// of this host. The other brand's users are viewed from that brand's admin
// console, so the admin sees the app the person actually uses.

import prisma from '../../lib/prisma.js';
import { getBrand, parseBrandId, type BrandId } from '../../platform/brand/registry.js';
import type { EnvSource } from '../../platform/brand/brandEnv.js';
import { isEnabledForBrand } from '../../platform/flags.js';
import { HttpError } from '../../platform/http.js';
import { isAdminAccount, signViewAsGrant, verifyViewAsGrant, type ViewAsGrant } from '../../platform/viewAs/index.js';
import { buildOnboardingMe, firstValueRoute, nextStage, routeForStage } from '../onboarding/contract.js';
import type { ViewAsBlockedReason, ViewAsPerson, ViewAsStartResponse } from './contract.js';

/** The account to be viewed, as far as the checks need it. */
export interface ViewAsSubject extends ViewAsPerson {
  role: string | null;
  roles: string[];
  brand: string | null;
  /** The RoboApply/GoApply profile; null for an account that never used the app. */
  profile: { deletedAt: Date | null; onboardingStep: string | null; onboardingPath: string | null } | null;
}

export interface ViewAsStore {
  findSubject(userId: string): Promise<ViewAsSubject | null>;
}

type Db = Pick<typeof prisma, 'user'>;

export function createPrismaViewAsStore(db: Db = prisma): ViewAsStore {
  return {
    async findSubject(userId) {
      const row = await db.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          roles: true,
          brand: true,
          seekerProfile: { select: { deletedAt: true, onboardingStep: true, onboardingPath: true } },
        },
      });
      if (!row) return null;
      return {
        id: row.id,
        email: row.email,
        name: row.name ?? null,
        role: row.role ?? null,
        roles: row.roles ?? [],
        brand: row.brand ?? null,
        profile: row.seekerProfile
          ? {
              deletedAt: row.seekerProfile.deletedAt ?? null,
              onboardingStep: row.seekerProfile.onboardingStep ?? null,
              onboardingPath: row.seekerProfile.onboardingPath ?? null,
            }
          : null,
      };
    },
  };
}

/** Why `admin` may not view as `subject` on a `brand` host; null when they may. */
export function viewAsBlockedReason(
  admin: { id: string },
  subject: Pick<ViewAsSubject, 'id' | 'role' | 'roles' | 'brand' | 'profile'>,
  brand: BrandId,
): Exclude<ViewAsBlockedReason, 'needs_session'> | null {
  if (subject.id === admin.id) return 'self';
  if (isAdminAccount(subject)) return 'admin_account';
  if (!subject.profile) return 'not_seeker';
  if (subject.profile.deletedAt) return 'deleted';
  const own = parseBrandId(subject.brand);
  if (own && own !== brand) return 'other_brand';
  return null;
}

/**
 * Where the person lands right after signing in (lib/auth/signInRoute.ts):
 * the onboarding screen they left while onboarding is unfinished, else the
 * brand's first-value page.
 */
export function viewAsLanding(
  brand: BrandId,
  profile: { onboardingStep: string | null; onboardingPath: string | null } | null,
  env: EnvSource = process.env,
): string {
  const product = getBrand(brand);
  const ctx = {
    campusCalendar: isEnabledForBrand('jobs.campusCalendar', product, env),
    jobsFeed: isEnabledForBrand('jobs.feed', product, env),
  };
  const me = buildOnboardingMe(brand, profile, ctx);
  if (!me.completed) {
    // A fresh account sits at `account` (the signup page); its next screen is the first onboarding step.
    const route = me.step === 'account' ? routeForStage(brand, nextStage(brand, 'account', me.path), ctx) : me.nextRoute;
    if (route) return route;
  }
  return firstValueRoute(brand, ctx);
}

export interface StartViewAsInput {
  admin: ViewAsPerson;
  subjectUserId: string;
  brand: BrandId;
  /** The browser's session token (the grant is tied to it); null when it has none. */
  sessionToken: string | null;
  now?: Date;
  /** For the landing page's capability checks (the grant key always comes from process.env). */
  env?: EnvSource;
}

export interface StartedViewAs {
  /** The cookie value. */
  token: string;
  grant: ViewAsGrant;
  view: ViewAsStartResponse;
}

function refuse(reason: ViewAsBlockedReason, brand?: string | null): never {
  if (reason === 'admin_account') throw new HttpError('forbidden', 'Admin accounts cannot be viewed as.', { reason });
  const message: Record<Exclude<ViewAsBlockedReason, 'admin_account'>, string> = {
    self: 'This is your own account.',
    not_seeker: 'This account has never used the app, so there is nothing to view.',
    deleted: 'This account was deleted.',
    other_brand: 'This account belongs to the other site. View it from that site\'s admin console.',
    needs_session: 'Sign in again in this browser to view as someone.',
  };
  const other = reason === 'other_brand' ? parseBrandId(brand) : null;
  throw new HttpError('conflict', message[reason], {
    reason,
    ...(other ? { brand: other, adminUrl: `${getBrand(other).canonicalOrigin}/admin` } : {}),
  });
}

/** Check and sign a grant. Throws HttpError (404, 403 or 409 with `details.reason`). */
export async function startViewAs(store: ViewAsStore, input: StartViewAsInput): Promise<StartedViewAs> {
  const subject = await store.findSubject(input.subjectUserId);
  if (!subject) throw new HttpError('not_found', 'No account with this id.');
  const blocked = viewAsBlockedReason(input.admin, subject, input.brand);
  if (blocked) refuse(blocked, subject.brand);
  if (!input.sessionToken) refuse('needs_session');
  // Signed with the process key: the auth middleware verifies with the same one.
  const signed = signViewAsGrant(
    { adminId: input.admin.id, subjectUserId: subject.id, sessionToken: input.sessionToken },
    { now: input.now },
  );
  if (!signed) throw new HttpError('internal_error', 'View as is not available on this deployment.');
  return {
    token: signed.token,
    grant: signed.grant,
    view: {
      admin: input.admin,
      subject: { id: subject.id, email: subject.email, name: subject.name },
      startedAt: new Date(signed.grant.iat * 1000).toISOString(),
      expiresAt: new Date(signed.grant.exp * 1000).toISOString(),
      landing: viewAsLanding(input.brand, subject.profile, input.env),
    },
  };
}

/** The grant in the cookie when it is this admin's and still valid; null otherwise (nothing to end). */
export function grantToEnd(token: string | null, adminId: string, options: { now?: Date } = {}): ViewAsGrant | null {
  if (!token) return null;
  const grant = verifyViewAsGrant(token, options);
  return grant && grant.adminId === adminId ? grant : null;
}
