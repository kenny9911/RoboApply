// backend/src/roboapply/v2/routes/integrations.ts
//
// Mounted at /api/v1/roboapply/v2/integrations.
//
//   GET    /                       — list all 6 providers (merged state)
//   POST   /:provider/connect      — connect (persisted demo-connect today)
//   POST   /:provider/disconnect   — disconnect (clear connected + account)
//
// Contract (`RaV2Api.integrations`, lib/api/v2/types.ts):
//   list()             -> IntegrationsListResponse  ({ integrations })
//   connect(provider)  -> IntegrationResponse       ({ integration })
//   disconnect(provider) -> IntegrationResponse     ({ integration })
//
// `:provider` is validated against the 6-value `RAIntegrationProvider` enum
// (400 on anything else). All reads/writes are scoped to the authed user via
// `requireAuth` → RAIntegrationsService.

import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../lib/raAuth.js';
import { logger } from '../../../services/LoggerService.js';
import {
  raIntegrationsService,
  isRAIntegrationProvider,
  IntegrationProviderNotFoundError,
  IntegrationUnavailableError,
} from '../services/RAIntegrationsService.js';

const router = Router();

router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const result = await raIntegrationsService.list(userId);
    return res.json(result);
  } catch (err) {
    logger.error('RA_V2_INTEGRATIONS', 'list failed', {
      userId: req.user?.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.post(
  '/:provider/connect',
  requireAuth,
  async (req: Request, res: Response) => {
    const provider = req.params.provider;
    if (!isRAIntegrationProvider(provider)) {
      return res.status(400).json({
        error: 'invalid_provider',
        details: { provider },
      });
    }
    try {
      const userId = req.user!.id;

      // TODO(oauth): real <provider> authorize+callback.
      // When `<PROVIDER>_CLIENT_ID` (+ secret + redirect) is configured we'd
      // instead build the provider's OAuth authorize URL here and return it for
      // the client to redirect to; the callback route would exchange the code,
      // store accessToken/refreshToken/expiresAt, and resolve the real account.
      // Providers WITHOUT creds are refused by the service (no more silent
      // demo-connect) and surface as 503 integration_unavailable below.
      const result = await raIntegrationsService.connect(userId, provider, {
        email: req.user?.email,
        name: req.user?.name,
      });
      return res.json(result);
    } catch (err) {
      if (err instanceof IntegrationProviderNotFoundError) {
        return res.status(400).json({ error: 'invalid_provider' });
      }
      if (err instanceof IntegrationUnavailableError) {
        return res.status(503).json({ error: 'integration_unavailable' });
      }
      logger.error('RA_V2_INTEGRATIONS', 'connect failed', {
        userId: req.user?.id,
        provider,
        error: err instanceof Error ? err.message : String(err),
      });
      return res.status(500).json({ error: 'internal_error' });
    }
  },
);

router.post(
  '/:provider/disconnect',
  requireAuth,
  async (req: Request, res: Response) => {
    const provider = req.params.provider;
    if (!isRAIntegrationProvider(provider)) {
      return res.status(400).json({
        error: 'invalid_provider',
        details: { provider },
      });
    }
    try {
      const userId = req.user!.id;
      const result = await raIntegrationsService.disconnect(userId, provider);
      return res.json(result);
    } catch (err) {
      if (err instanceof IntegrationProviderNotFoundError) {
        return res.status(400).json({ error: 'invalid_provider' });
      }
      logger.error('RA_V2_INTEGRATIONS', 'disconnect failed', {
        userId: req.user?.id,
        provider,
        error: err instanceof Error ? err.message : String(err),
      });
      return res.status(500).json({ error: 'internal_error' });
    }
  },
);

export default router;
