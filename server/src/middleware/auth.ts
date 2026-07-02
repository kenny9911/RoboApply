import type { Request, Response, NextFunction } from 'express';
import authService from '../services/AuthService.js';
import prisma from '../lib/prisma.js';
import type { AuthUser, ApiKeyScope } from '../types/auth.js';
import { withUserUsageLimits } from './usageMeter.js';
import { setCurrentUserId, setCurrentUserName } from '../lib/requestContext.js';
import { logger } from '../services/LoggerService.js';
import { evaluateSubscriptionGate } from '../lib/subscriptionGate.js';
import { resolveGraceDaysForUser } from '../lib/subscriptionGraceConfig.js';
import { SESSION_COOKIE_NAME } from '../lib/cookieOptions.js';
// Import auth types to extend Express
import '../types/auth.js';

type LimitAwareAuthUser = AuthUser & {
  customMaxInterviews?: number | null;
  customMaxMatches?: number | null;
};

async function toAuthenticatedUser(user: LimitAwareAuthUser): Promise<AuthUser> {
  const enrichedUser = await withUserUsageLimits(user);
  const {
    customMaxInterviews: _customMaxInterviews,
    customMaxMatches: _customMaxMatches,
    ...sanitizedUser
  } = enrichedUser;

  // Pre-compute the subscription gate result so downstream code
  // (requireActiveSubscription middleware, /api/auth/me response, WS
  // upgrade handler) can read it without re-walking the rules. The pure
  // gate is sync; the only async bit is resolving the effective grace days
  // (per-user override ?? global default — 60s cached, no per-request DB
  // hit in steady state). See lib/subscriptionGate.ts + subscriptionGraceConfig.ts.
  const graceDays = await resolveGraceDaysForUser(
    (sanitizedUser as { subscriptionGraceDays?: number | null }).subscriptionGraceDays ?? null,
  );
  const subscriptionGate = evaluateSubscriptionGate({
    subscriptionTier: sanitizedUser.subscriptionTier ?? null,
    subscriptionStatus: sanitizedUser.subscriptionStatus ?? null,
    currentPeriodEnd: sanitizedUser.currentPeriodEnd ?? null,
    isActive: sanitizedUser.isActive ?? true,
    role: sanitizedUser.role ?? null,
    graceDays,
    // Free-trial anchor fallbacks (used only when currentPeriodEnd is null).
    trialEnd: (sanitizedUser as { trialEnd?: Date | null }).trialEnd ?? null,
    createdAt: (sanitizedUser as { createdAt?: Date | null }).createdAt ?? null,
  });

  // Whether this user is on a LIVE auto-renewing Stripe subscription (Stripe
  // bills every cycle automatically). The recruiter `User` only ever holds a
  // real Stripe `sub_…` id here — Alipay/one-time plans leave subscriptionId
  // null — so its presence on an active/trialing paid tier IS the auto-renew
  // signal. The UI uses this to suppress the manual one-time Renew button (a
  // manual charge on top of Stripe's auto-charge would double-bill). See
  // routes/checkout.ts `/checkout/renew` (which enforces the same guard).
  const tier = (sanitizedUser.subscriptionTier ?? 'free').toLowerCase();
  const status = (sanitizedUser.subscriptionStatus ?? 'active').toLowerCase();
  const autoRenew =
    tier !== 'free' &&
    tier !== 'custom' &&
    !!sanitizedUser.subscriptionId &&
    (status === 'active' || status === 'trialing' || status === 'past_due');

  return { ...sanitizedUser, subscriptionGate, autoRenew } as AuthUser;
}

// Resolve a short display label for log lines: prefer the user's name,
// fall back to the email local-part, then the bare email. Keeps the
// `[user:<id8> <label>]` token compact and recognizable at a glance.
function resolveLogDisplayName(user: { name?: string | null; email?: string | null }): string | undefined {
  const name = user.name?.trim();
  if (name) return name;
  const email = user.email?.trim();
  if (!email) return undefined;
  const local = email.split('@')[0];
  return local || email;
}

/**
 * Validate an API key and return the associated user
 */
async function validateApiKey(apiKey: string): Promise<{
  user: AuthUser | null;
  apiKeyId: string | null;
  scopes: ApiKeyScope[] | null;
}> {
  try {
    const keyRecord = await prisma.apiKey.findUnique({
      where: { key: apiKey },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            name: true,
            phone: true,
            jobTitle: true,
            company: true,
            avatar: true,
            role: true,
            isActive: true,
            provider: true,
            providerId: true,
            teamId: true,
            createdAt: true,
            updatedAt: true,
            stripeCustomerId: true,
            subscriptionTier: true,
            subscriptionStatus: true,
            subscriptionId: true,
            currentPeriodEnd: true,
            subscriptionGraceDays: true,
            trialEnd: true,
            interviewsUsed: true,
            resumeMatchesUsed: true,
            topUpBalance: true,
            customMaxInterviews: true,
            customMaxMatches: true,
          },
        },
      },
    });

    if (!keyRecord) {
      return { user: null, apiKeyId: null, scopes: null };
    }

    // Check if key is active. A soft-deleted key (status='deleted') always also
    // has isActive=false, so the first check already rejects it; we test status
    // explicitly as defense-in-depth in case the two ever drift.
    if (!keyRecord.isActive || keyRecord.status === 'deleted') {
      return { user: null, apiKeyId: null, scopes: null };
    }

    // Check if key has expired
    if (keyRecord.expiresAt && keyRecord.expiresAt < new Date()) {
      return { user: null, apiKeyId: null, scopes: null };
    }

    // Update lastUsedAt (async, don't wait)
    prisma.apiKey.update({
      where: { id: keyRecord.id },
      data: { lastUsedAt: new Date() },
    }).catch(err => console.error('Failed to update API key lastUsedAt:', err));

    return {
      user: keyRecord.user,
      apiKeyId: keyRecord.id,
      scopes: keyRecord.scopes as ApiKeyScope[],
    };
  } catch (error) {
    console.error('API key validation error:', error);
    return { user: null, apiKeyId: null, scopes: null };
  }
}

/**
 * Token bundle that the WS upgrade handler (and similar non-Express
 * contexts) can assemble from a raw IncomingMessage. Any field can be
 * undefined; resolution precedence matches requireAuth.
 */
export interface AuthTokenBundle {
  apiKeyHeader?: string;
  authorizationHeader?: string;
  cookieSessionToken?: string;
  headerSessionToken?: string;
  queryToken?: string;
}

/**
 * Resolve an AuthUser from an already-parsed set of tokens. Extracted so
 * the WebSocket upgrade path can authenticate without going through
 * Express middleware. Returns null on any failure (no token, expired,
 * revoked, etc.) — caller decides whether to reject or continue anonymously.
 *
 * Mirrors the precedence in requireAuth: API key → Authorization → cookie
 * session → header session → query param.
 */
export async function resolveUserFromTokens(
  tokens: AuthTokenBundle,
): Promise<{ user: AuthUser; apiKeyId?: string; sessionToken?: string } | null> {
  try {
    let token: string | undefined;
    let isSessionToken = false;
    let isApiKey = false;
    let tokenSource: 'api_key' | 'authorization' | 'cookie' | 'session_header' | 'query' | null = null;

    if (
      tokens.apiKeyHeader &&
      typeof tokens.apiKeyHeader === 'string' &&
      tokens.apiKeyHeader.startsWith('rh_')
    ) {
      token = tokens.apiKeyHeader;
      isApiKey = true;
      tokenSource = 'api_key';
    }

    if (!token && tokens.authorizationHeader?.startsWith('Bearer ')) {
      const bearerToken = tokens.authorizationHeader.slice(7);
      if (bearerToken.startsWith('rh_')) {
        token = bearerToken;
        isApiKey = true;
        tokenSource = 'authorization';
      } else {
        token = bearerToken;
        tokenSource = 'authorization';
      }
    }

    if (!token && tokens.cookieSessionToken) {
      token = tokens.cookieSessionToken;
      isSessionToken = true;
      tokenSource = 'cookie';
    }

    if (!token && tokens.headerSessionToken) {
      token = tokens.headerSessionToken;
      isSessionToken = true;
      tokenSource = 'session_header';
    }

    if (!token && tokens.queryToken) {
      token = tokens.queryToken;
      tokenSource = 'query';
    }

    if (!token) return null;

    let user: AuthUser | null = null;
    let apiKeyId: string | undefined;
    let resolvedSessionToken: string | undefined;

    if (isApiKey) {
      const { user: apiKeyUser, apiKeyId: id } = await validateApiKey(token);
      if (apiKeyUser) {
        user = apiKeyUser;
        apiKeyId = id || undefined;
      }
    } else if (isSessionToken) {
      const sessionUser = await authService.validateSession(token);
      if (sessionUser) {
        const { passwordHash: _, ...userWithoutPassword } = sessionUser;
        user = userWithoutPassword;
        resolvedSessionToken = token;
      }
    } else {
      const payload = authService.verifyToken(token);
      if (payload) {
        user = await authService.getUserById(payload.userId);
      } else if (tokenSource === 'authorization') {
        const fallback = tokens.cookieSessionToken || tokens.headerSessionToken;
        if (fallback) {
          const sessionUser = await authService.validateSession(fallback);
          if (sessionUser) {
            const { passwordHash: _, ...userWithoutPassword } = sessionUser;
            user = userWithoutPassword;
            resolvedSessionToken = fallback;
          }
        }
      }
    }

    if (!user) return null;
    // Same hard-disable gate as requireAuth. WS callers may interpret a
    // null return as "no valid token" — that's fine for security; the
    // WS upgrade handler in index.ts closes the socket either way.
    if ((user as { isActive?: boolean }).isActive === false) {
      logger.info('AUTH', 'WS blocked disabled account', { userId: user.id, email: user.email });
      return null;
    }
    const enriched = await toAuthenticatedUser(user as LimitAwareAuthUser);
    return { user: enriched, apiKeyId, sessionToken: resolvedSessionToken };
  } catch (error) {
    console.error('resolveUserFromTokens error:', error);
    return null;
  }
}

/**
 * Authentication middleware - requires valid JWT, session token, or API key
 * Extracts token from:
 * 1. Authorization header: "Bearer <token>" (JWT or API key starting with "rh_")
 * 2. X-API-Key header: "<api_key>"
 * 3. Cookie: "session_token=<token>"
 * 4. X-Session-Token header: "<session_token>"
 * 5. Query parameter: "?token=<token>"
 */
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    let token: string | undefined;
    let isSessionToken = false;
    let isApiKey = false;
    let tokenSource: 'api_key' | 'authorization' | 'cookie' | 'session_header' | 'query' | null = null;
    const cookieSessionToken = req.cookies?.[SESSION_COOKIE_NAME] as string | undefined;
    const headerSessionToken = typeof req.headers['x-session-token'] === 'string'
      ? req.headers['x-session-token']
      : undefined;

    // Check X-API-Key header first (API key)
    const apiKeyHeader = req.headers['x-api-key'];
    if (apiKeyHeader && typeof apiKeyHeader === 'string' && apiKeyHeader.startsWith('rh_')) {
      token = apiKeyHeader;
      isApiKey = true;
      tokenSource = 'api_key';
    }

    // Check Authorization header (JWT or API key)
    if (!token) {
      const authHeader = req.headers.authorization;
      if (authHeader?.startsWith('Bearer ')) {
        const bearerToken = authHeader.slice(7);
        if (bearerToken.startsWith('rh_')) {
          token = bearerToken;
          isApiKey = true;
          tokenSource = 'authorization';
        } else {
          token = bearerToken;
          tokenSource = 'authorization';
        }
      }
    }

    // Check for session token in cookie
    if (!token && cookieSessionToken) {
      token = cookieSessionToken;
      isSessionToken = true;
      tokenSource = 'cookie';
    }

    // Check for session token in header
    if (!token && headerSessionToken) {
      token = headerSessionToken;
      isSessionToken = true;
      tokenSource = 'session_header';
    }

    // Check query parameter (for OAuth callbacks)
    if (!token && req.query.token) {
      token = req.query.token as string;
      tokenSource = 'query';
    }

    if (!token) {
      res.status(401).json({
        success: false,
        error: 'Authentication required',
        code: 'AUTH_REQUIRED',
      });
      return;
    }

    let user: AuthUser | null = null;

    if (isApiKey) {
      // Validate API key
      const { user: apiKeyUser, apiKeyId, scopes } = await validateApiKey(token);
      if (apiKeyUser) {
        user = apiKeyUser;
        req.apiKeyId = apiKeyId || undefined;
        req.apiKeyScopes = scopes || undefined;
      }
    } else if (isSessionToken) {
      // Validate session token
      const sessionUser = await authService.validateSession(token);
      if (sessionUser) {
        const { passwordHash: _, ...userWithoutPassword } = sessionUser;
        user = userWithoutPassword;
        req.sessionToken = token;
      }
    } else {
      // Validate JWT
      const payload = authService.verifyToken(token);
      if (payload) {
        user = await authService.getUserById(payload.userId);
      } else if (tokenSource === 'authorization') {
        // If local JWT is stale, fall back to session tokens (cookie/header) when available.
        const fallbackSessionToken = cookieSessionToken || headerSessionToken;
        if (fallbackSessionToken) {
          const sessionUser = await authService.validateSession(fallbackSessionToken);
          if (sessionUser) {
            const { passwordHash: _, ...userWithoutPassword } = sessionUser;
            user = userWithoutPassword;
            req.sessionToken = fallbackSessionToken;
          }
        }
      }
    }

    if (!user) {
      res.status(401).json({
        success: false,
        error: 'Invalid or expired token',
        code: 'INVALID_TOKEN',
      });
      return;
    }

    // Hard admin-disable check. Distinct from subscription expiration —
    // an `isActive=false` account cannot use the system at all (not even
    // read-only). Set by admin /users/:id/disable. Applies equally to
    // JWT, session, and API-key auth paths.
    if ((user as { isActive?: boolean }).isActive === false) {
      logger.info('AUTH', 'Blocked disabled account', { userId: user.id, email: user.email });
      res.status(401).json({
        success: false,
        error: 'This account has been suspended. Contact support if you believe this is an error.',
        code: 'ACCOUNT_DISABLED',
      });
      return;
    }

    req.user = await toAuthenticatedUser(user as LimitAwareAuthUser);
    // Thread the authenticated userId + display name through the async
    // context + logger so every subsequent log line within this request
    // carries them — lets ops scan server logs by name without joining
    // requestId ↔ user.
    const displayName = resolveLogDisplayName(req.user);
    setCurrentUserId(req.user.id);
    setCurrentUserName(displayName);
    if (req.requestId) logger.setRequestUserId(req.requestId, req.user.id, displayName);
    next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    res.status(500).json({
      success: false,
      error: 'Authentication error',
      code: 'AUTH_ERROR',
    });
  }
}

/**
 * Optional authentication middleware - attaches user if token is valid, but doesn't require it
 */
export async function optionalAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    let token: string | undefined;
    let isSessionToken = false;
    let isApiKey = false;
    let tokenSource: 'api_key' | 'authorization' | 'cookie' | 'session_header' | null = null;
    const cookieSessionToken = req.cookies?.[SESSION_COOKIE_NAME] as string | undefined;
    const headerSessionToken = typeof req.headers['x-session-token'] === 'string'
      ? req.headers['x-session-token']
      : undefined;

    // Check X-API-Key header first (API key)
    const apiKeyHeader = req.headers['x-api-key'];
    if (apiKeyHeader && typeof apiKeyHeader === 'string' && apiKeyHeader.startsWith('rh_')) {
      token = apiKeyHeader;
      isApiKey = true;
      tokenSource = 'api_key';
    }

    // Check Authorization header (JWT or API key)
    if (!token) {
      const authHeader = req.headers.authorization;
      if (authHeader?.startsWith('Bearer ')) {
        const bearerToken = authHeader.slice(7);
        if (bearerToken.startsWith('rh_')) {
          token = bearerToken;
          isApiKey = true;
          tokenSource = 'authorization';
        } else {
          token = bearerToken;
          tokenSource = 'authorization';
        }
      }
    }

    // Check for session token in cookie
    if (!token && cookieSessionToken) {
      token = cookieSessionToken;
      isSessionToken = true;
      tokenSource = 'cookie';
    }

    // Check for session token in header
    if (!token && headerSessionToken) {
      token = headerSessionToken;
      isSessionToken = true;
      tokenSource = 'session_header';
    }

    if (token) {
      let user: AuthUser | null = null;

      if (isApiKey) {
        // Validate API key
        const { user: apiKeyUser, apiKeyId, scopes } = await validateApiKey(token);
        if (apiKeyUser) {
          user = apiKeyUser;
          req.apiKeyId = apiKeyId || undefined;
          req.apiKeyScopes = scopes || undefined;
        }
      } else if (isSessionToken) {
        const sessionUser = await authService.validateSession(token);
        if (sessionUser) {
          const { passwordHash: _, ...userWithoutPassword } = sessionUser;
          user = userWithoutPassword;
          req.sessionToken = token;
        }
      } else {
        const payload = authService.verifyToken(token);
        if (payload) {
          user = await authService.getUserById(payload.userId);
        } else if (tokenSource === 'authorization') {
          const fallbackSessionToken = cookieSessionToken || headerSessionToken;
          if (fallbackSessionToken) {
            const sessionUser = await authService.validateSession(fallbackSessionToken);
            if (sessionUser) {
              const { passwordHash: _, ...userWithoutPassword } = sessionUser;
              user = userWithoutPassword;
              req.sessionToken = fallbackSessionToken;
            }
          }
        }
      }

      if (user) {
        req.user = await toAuthenticatedUser(user as LimitAwareAuthUser);
        const displayName = resolveLogDisplayName(req.user);
        setCurrentUserId(req.user.id);
        setCurrentUserName(displayName);
        if (req.requestId) logger.setRequestUserId(req.requestId, req.user.id, displayName);
      }
    }

    next();
  } catch (error) {
    // Don't fail on optional auth errors, just continue without user
    console.error('Optional auth error:', error);
    next();
  }
}

/**
 * Middleware to require specific API key scopes
 */
export function requireScopes(...requiredScopes: ApiKeyScope[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // If not using API key auth, allow (JWT/session users have full access)
    if (!req.apiKeyId) {
      next();
      return;
    }

    // Check if API key has all required scopes
    const userScopes = req.apiKeyScopes || [];
    const hasAllScopes = requiredScopes.every(scope => userScopes.includes(scope));

    if (!hasAllScopes) {
      res.status(403).json({
        success: false,
        error: `API key missing required scopes: ${requiredScopes.join(', ')}`,
        code: 'INSUFFICIENT_SCOPES',
        requestId: req.requestId,
      });
      return;
    }

    next();
  };
}

/**
 * Rate limiting helper for auth endpoints
 * Simple in-memory rate limiter
 */
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(maxAttempts: number, windowMs: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const key = `${ip}:${req.path}`;
    const now = Date.now();

    const record = rateLimitMap.get(key);

    if (!record || record.resetAt < now) {
      rateLimitMap.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }

    if (record.count >= maxAttempts) {
      const retryAfter = Math.ceil((record.resetAt - now) / 1000);
      res.status(429).json({
        success: false,
        error: 'Too many requests. Please try again later.',
        code: 'RATE_LIMITED',
        retryAfter,
      });
      return;
    }

    record.count++;
    next();
  };
}

// Clean up rate limit map periodically. Skipped on Vercel serverless — there
// is no long-lived process for the interval to run in (the in-memory map is
// per-instance and evaporates with the instance anyway).
if (!process.env.VERCEL) {
  setInterval(() => {
    const now = Date.now();
    for (const [key, record] of rateLimitMap.entries()) {
      if (record.resetAt < now) {
        rateLimitMap.delete(key);
      }
    }
  }, 60000); // Every minute
}
