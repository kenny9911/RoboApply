// server/src/platform/viewAs/index.ts — public surface of admin "view as" (see viewAs.ts).

export {
  VIEW_AS_COOKIE,
  VIEW_AS_ENDED_HEADER,
  VIEW_AS_READ_ONLY,
  VIEW_AS_READ_POSTS,
  VIEW_AS_TTL_SECONDS,
  ViewAsReadOnlyError,
  clearViewAsCookieOptions,
  isAdminAccount,
  isReadOnlyMethod,
  isViewAsRead,
  requestSessionToken,
  requestViewAsToken,
  sessionFingerprint,
  signViewAsGrant,
  verifyViewAsGrant,
  viewAsAvailable,
  viewAsCookieOptions,
} from './viewAs.js';
export type { ViewAsGrant, ViewAsOnRequest } from './viewAs.js';
