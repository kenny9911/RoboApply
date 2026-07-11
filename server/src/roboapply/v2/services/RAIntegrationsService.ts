// backend/src/roboapply/v2/services/RAIntegrationsService.ts
//
// Connected-services state for RoboApply V3's Integrations surface. Persists
// real per-user connection state in the `RAIntegration` Prisma table
// (`@@unique([userId, provider])`) and merges it with a STATIC catalog
// (name / description / brandColor per provider) so the wire shape always
// matches `RAIntegration` from lib/api/v2/types.ts.
//
// Contract parity (mirrors lib/stub/raV2.stub.ts §Integrations):
//   - list()       -> all 6 providers, default { connected:false, account:null }
//                     for providers the user never touched.
//   - connect(p)   -> upsert the row connected=true + a derived account label.
//   - disconnect(p)-> upsert the row connected=false + account=null.
//
// OAuth reality: real per-provider OAuth needs client id/secret env vars that
// are NOT configured here, so `connect` does a *persisted demo-connect* (mark
// connected, derive a plausible account, store it). The row survives reloads
// (real DB) — which IS the contract behavior. Swapping in real OAuth later is
// localized to `deriveConnect()` / the route handler (see the TODO scaffold).
//
// Allowed imports (V2 boundary §10): lib/* + services/LoggerService.
//
// Wire types are redeclared locally (kept structurally identical to
// roboapply/lib/api/v2/types.ts) — the same convention used by RAQueueService /
// RAResumeAIService / RAPreferencesService, because the backend tsconfig
// rootDir is `./src` and can't reach the sibling `roboapply/` workspace.

import prisma from '../../../lib/prisma.js';
import { logger } from '../../../services/LoggerService.js';

// ─── Wire types (mirror roboapply/lib/api/v2/types.ts exactly) ────────────

export type RAIntegrationProvider =
  | 'linkedin'
  | 'gmail'
  | 'gcal'
  | 'slack'
  | 'notion'
  | 'github';

export interface RAIntegration {
  provider: RAIntegrationProvider;
  /** display name, e.g. "Google Calendar" */
  name: string;
  /** what it does, e.g. "Auto-detect responses + classify replies" */
  description: string;
  connected: boolean;
  /** connected account label, e.g. "maya@chen.io" — null when disconnected */
  account: string | null;
  /** brand color for the tile icon */
  brandColor: string;
}

export interface IntegrationsListResponse {
  integrations: RAIntegration[];
}

export interface IntegrationResponse {
  integration: RAIntegration;
}

// ─────────────────────────────────────────────────────────────────────
// Static catalog
// ─────────────────────────────────────────────────────────────────────
//
// Transcribed from the V3 prototype's `INTEGRATIONS` (RoboApply_V3/data.jsx)
// — also mirrored by lib/fixtures/integrations.ts. This is the source of the
// display metadata (name / description / brandColor); per-user state
// (connected / account) is layered on top from the DB at read time.
//
// NOTE: the `connected` / `account` values here are the *seed defaults* only —
// they describe the demo persona in the prototype. The real merge ignores
// them: a provider with no `RAIntegration` row resolves to
// { connected:false, account:null }. They're kept only so this constant is a
// faithful 1:1 transcription of the proto catalog.

interface IntegrationCatalogEntry {
  provider: RAIntegrationProvider;
  name: string;
  description: string;
  brandColor: string;
}

const INTEGRATION_CATALOG: readonly IntegrationCatalogEntry[] = [
  {
    provider: 'linkedin',
    name: 'LinkedIn',
    description: 'Pull profile data + apply on platform',
    brandColor: '#0A66C2',
  },
  {
    provider: 'gmail',
    name: 'Gmail',
    description: 'Auto-detect responses + classify replies',
    brandColor: '#EA4335',
  },
  {
    provider: 'gcal',
    name: 'Google Calendar',
    description: 'Schedule interviews · know your blockers',
    brandColor: '#4285F4',
  },
  {
    provider: 'slack',
    name: 'Slack',
    description: 'Get notifications in your work / DM space',
    brandColor: '#4A154B',
  },
  {
    provider: 'notion',
    name: 'Notion',
    description: 'Export tracker rows to your job-hunt DB',
    brandColor: '#FFFFFF',
  },
  {
    provider: 'github',
    name: 'GitHub',
    description: 'Pull starred repos as portfolio evidence',
    brandColor: '#FFFFFF',
  },
];

export const RA_INTEGRATION_PROVIDERS: readonly RAIntegrationProvider[] =
  INTEGRATION_CATALOG.map((c) => c.provider);

/** Validate an arbitrary `:provider` path param against the 6-value enum. */
export function isRAIntegrationProvider(
  value: unknown,
): value is RAIntegrationProvider {
  return (
    typeof value === 'string' &&
    (RA_INTEGRATION_PROVIDERS as readonly string[]).includes(value)
  );
}

// ─────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────

export class IntegrationProviderNotFoundError extends Error {
  constructor(provider: string) {
    super(`Unknown integration provider: ${provider}`);
    this.name = 'IntegrationProviderNotFoundError';
  }
}

/** Thrown when a provider has no real OAuth credentials configured. The
 *  pre-launch behaviour was a "persisted demo-connect" (flip connected + a
 *  derived account label) — silent fake success telling production users
 *  Gmail/LinkedIn/… were live while nothing was wired. connect() now refuses
 *  until <PROVIDER>_CLIENT_ID creds exist; the route maps this to
 *  503 { error: 'integration_unavailable' }. */
export class IntegrationUnavailableError extends Error {
  constructor(provider: string) {
    super(`Integration ${provider} has no OAuth credentials configured`);
    this.name = 'IntegrationUnavailableError';
  }
}

// ─────────────────────────────────────────────────────────────────────
// Merge helpers
// ─────────────────────────────────────────────────────────────────────

type StoredState = { connected: boolean; account: string | null };

/** Merge one catalog entry with the user's stored row (or the disconnected
 *  default when the user never touched this provider). */
function toRAIntegration(
  entry: IntegrationCatalogEntry,
  stored: StoredState | undefined,
): RAIntegration {
  return {
    provider: entry.provider,
    name: entry.name,
    description: entry.description,
    connected: stored?.connected ?? false,
    account: stored?.account ?? null,
    brandColor: entry.brandColor,
  };
}

/** Derive a plausible connected-account label for the demo-connect path.
 *
 *  TODO(oauth): real flows replace this with the account returned by the
 *  provider's token/profile endpoint after a successful authorize+callback.
 *  - gmail / gcal  -> the user's Google email (here: their RoboHire email)
 *  - linkedin      -> their email (LinkedIn profile resolves the handle)
 *  - github        -> a handle derived from the email local-part
 *  - slack / notion-> their email (workspace membership)
 */
function deriveAccount(
  provider: RAIntegrationProvider,
  user: { email?: string | null; name?: string | null },
): string {
  const email = user.email?.trim() || '';
  const local = email.includes('@') ? email.split('@')[0] : email;
  switch (provider) {
    case 'github':
      // GitHub shows a handle, not an email — slugify the local-part.
      return (local || 'user').toLowerCase().replace(/[^a-z0-9-]/g, '') || 'user';
    case 'gmail':
    case 'gcal':
    case 'linkedin':
    case 'slack':
    case 'notion':
    default:
      return email || local || 'connected-account';
  }
}

// ─────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────

class RAIntegrationsService {
  /** List all 6 providers, merging static metadata with the user's stored
   *  connection state. Providers with no row default to disconnected. */
  async list(userId: string): Promise<IntegrationsListResponse> {
    const rows = await prisma.rAIntegration.findMany({
      where: { userId },
      select: { provider: true, connected: true, account: true },
    });
    const stateByProvider = new Map<string, StoredState>();
    for (const row of rows) {
      stateByProvider.set(row.provider, {
        connected: row.connected,
        account: row.account ?? null,
      });
    }
    const integrations = INTEGRATION_CATALOG.map((entry) =>
      toRAIntegration(entry, stateByProvider.get(entry.provider)),
    );
    return { integrations };
  }

  /** Connect a provider. PRODUCTION HONESTY GATE: refuses when the provider
   *  has no real OAuth creds — a "connected" state must never be persisted
   *  for a provider that cannot actually sync (the old demo-connect did
   *  exactly that). */
  async connect(
    userId: string,
    provider: RAIntegrationProvider,
    user: { email?: string | null; name?: string | null },
  ): Promise<IntegrationResponse> {
    const entry = INTEGRATION_CATALOG.find((c) => c.provider === provider);
    if (!entry) throw new IntegrationProviderNotFoundError(provider);
    if (!hasOauthCreds(provider)) {
      throw new IntegrationUnavailableError(provider);
    }

    const account = deriveAccount(provider, user);
    const now = new Date();

    // Creds exist → record the connection. TODO(oauth): the real authorize +
    // callback + token exchange replaces deriveAccount; until then no tokens
    // are stored (accessToken/refreshToken/expiresAt stay null).
    const row = await prisma.rAIntegration.upsert({
      where: { userId_provider: { userId, provider } },
      create: {
        userId,
        provider,
        connected: true,
        account,
        connectedAt: now,
      },
      update: {
        connected: true,
        account,
        connectedAt: now,
      },
      select: { connected: true, account: true },
    });

    logger.info('RA_V2_INTEGRATIONS', 'connect', {
      userId,
      provider,
      hasOauthCreds: true,
    });

    return {
      integration: toRAIntegration(entry, {
        connected: row.connected,
        account: row.account ?? null,
      }),
    };
  }

  /** Disconnect a provider — flip `connected` off, clear the account + any
   *  stored tokens. Upserts so disconnecting a never-touched provider is a
   *  no-op-shaped success (returns the disconnected merged row). */
  async disconnect(
    userId: string,
    provider: RAIntegrationProvider,
  ): Promise<IntegrationResponse> {
    const entry = INTEGRATION_CATALOG.find((c) => c.provider === provider);
    if (!entry) throw new IntegrationProviderNotFoundError(provider);

    await prisma.rAIntegration.upsert({
      where: { userId_provider: { userId, provider } },
      create: {
        userId,
        provider,
        connected: false,
        account: null,
      },
      update: {
        connected: false,
        account: null,
        accessToken: null,
        refreshToken: null,
        expiresAt: null,
        connectedAt: null,
      },
      select: { connected: true, account: true },
    });

    logger.info('RA_V2_INTEGRATIONS', 'disconnect', { userId, provider });

    return {
      integration: toRAIntegration(entry, { connected: false, account: null }),
    };
  }
}

/** Whether real OAuth creds are configured for a provider. When true, the
 *  route handler would kick off a real authorize+callback flow instead of the
 *  demo-connect (see TODO(oauth) in routes/integrations.ts). Today this is
 *  always false in this environment — no `<PROVIDER>_CLIENT_ID` is set. */
export function hasOauthCreds(provider: RAIntegrationProvider): boolean {
  const key = `${provider.toUpperCase()}_CLIENT_ID`;
  return Boolean(process.env[key] && process.env[key]!.trim().length > 0);
}

export const raIntegrationsService = new RAIntegrationsService();
