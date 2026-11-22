// server/src/roboapply/v2/routes/adminLlm.ts
//
// LLM gateway admin API. Mounted at /api/v1/roboapply/v2/admin/llm (see
// routes/index.ts). Admin only. Handlers are thin: the rules live in
// lib/llm/gatewayAdmin.ts (overview, area assignments) and
// lib/llm/gatewayProviders.ts (provider entries, model lists).
//
//   GET    /                     overview: provider entries, areas, what each resolves to
//   PUT    /routes               assign or clear areas for a brand
//   POST   /providers            add an entry (and fetch its model list)
//   PUT    /providers/:id        change an entry (re-fetches the list when the key or endpoint changed)
//   DELETE /providers/:id        remove an entry no area is assigned to
//   POST   /providers/:id/models fetch the saved entry's model list again
//   POST   /providers/test       fetch a model list for unsaved values; saves nothing
//
// No response ever carries an API key: entries return a preview (`sk-…ab12`).
// Model-list failures are fixed codes; a provider's own error text is never
// passed on.

import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../lib/raAuth.js';
import { requireAdmin } from '../../../middleware/admin.js';
import { logger } from '../../../services/LoggerService.js';
import { contextlessLlmBrand } from '../../../lib/llm/llmBrand.js';
import { GatewayRouteError, getGatewayOverview, removeGatewayProvider, saveGatewayRoutes } from '../../../lib/llm/gatewayAdmin.js';
import {
  GatewayProviderError,
  fetchProviderModels,
  refreshGatewayProviderModels,
  saveGatewayProvider,
  type ModelListResult,
} from '../../../lib/llm/gatewayProviders.js';
import type { LlmStackBrand } from '../../../lib/llm/llmStackConfigSchema.js';

const router = Router();
router.use(requireAuth, requireAdmin);

/** The brand whose assignments are read or saved: `?brand=`, else the request's own. */
function brandOf(req: Request): LlmStackBrand {
  const q = req.query.brand ?? (req.body as { brand?: unknown } | undefined)?.brand;
  if (q === 'roboapply' || q === 'goapply') return q;
  return contextlessLlmBrand().brandId === 'goapply' ? 'goapply' : 'roboapply';
}

const STATUS: Record<string, number> = {
  not_found: 404,
  unknown_provider: 404,
  provider_in_use: 409,
  duplicate_name: 409,
  encryption_unavailable: 503,
};

function fail(req: Request, res: Response, err: unknown, fallback: string): Response {
  if (err instanceof GatewayProviderError || err instanceof GatewayRouteError) {
    return res.status(STATUS[err.code] ?? 400).json({
      success: false,
      code: err.code,
      error: err.message,
      ...(err instanceof GatewayRouteError && err.detail ? { detail: err.detail } : {}),
    });
  }
  logger.error('RA_ADMIN', `LLM gateway: ${fallback}`, { error: err instanceof Error ? err.message : String(err) }, req.requestId);
  return res.status(500).json({ success: false, code: 'llm_gateway_failed', error: fallback });
}

function text(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

router.get('/', async (req: Request, res: Response) => {
  try {
    return res.json({ success: true, data: await getGatewayOverview(brandOf(req)) });
  } catch (err) {
    return fail(req, res, err, 'Failed to load the LLM gateway');
  }
});

router.put('/routes', async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as { routes?: unknown };
    if (!body.routes || typeof body.routes !== 'object' || Array.isArray(body.routes)) {
      return res.status(400).json({ success: false, code: 'invalid_route', error: 'routes object required' });
    }
    const brand = brandOf(req);
    await saveGatewayRoutes(brand, body.routes as Record<string, unknown>, req.user!.id);
    return res.json({ success: true, data: await getGatewayOverview(brand) });
  } catch (err) {
    return fail(req, res, err, 'Failed to save the area assignments');
  }
});

async function saveProvider(req: Request, res: Response, id: string | null): Promise<Response> {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const apiKey = text(body.apiKey).trim();
    const saved = await saveGatewayProvider(
      {
        id,
        name: text(body.name),
        type: text(body.type),
        baseUrl: text(body.baseUrl) || null,
        apiKey: apiKey || null,
        ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
        notes: text(body.notes) || null,
      },
      req.user!.id,
    );
    // A new key or endpoint has no model list yet: fetch it now, so one save
    // leaves the entry ready to assign. A failed fetch does not undo the save.
    let models: ModelListResult | null = null;
    let provider = saved;
    if (saved.enabled && saved.models.length === 0) {
      const refreshed = await refreshGatewayProviderModels(saved.id, req.user!.id);
      models = refreshed.result;
      provider = refreshed.provider;
    }
    return res.json({ success: true, data: { provider, models, overview: await getGatewayOverview(brandOf(req)) } });
  } catch (err) {
    return fail(req, res, err, 'Failed to save the provider');
  }
}

router.post('/providers', (req: Request, res: Response) => saveProvider(req, res, null));

// Before `/providers/:id`: "test" is not an entry id.
router.post('/providers/test', async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await fetchProviderModels({ type: text(body.type), baseUrl: text(body.baseUrl) || null, apiKey: text(body.apiKey) });
    return res.json({ success: true, data: { models: result } });
  } catch (err) {
    return fail(req, res, err, 'Failed to test the provider');
  }
});

router.put('/providers/:id', (req: Request<{ id: string }>, res: Response) => saveProvider(req, res, req.params.id));

router.delete('/providers/:id', async (req: Request<{ id: string }>, res: Response) => {
  try {
    await removeGatewayProvider(req.params.id, req.user!.id);
    return res.json({ success: true, data: await getGatewayOverview(brandOf(req)) });
  } catch (err) {
    return fail(req, res, err, 'Failed to remove the provider');
  }
});

router.post('/providers/:id/models', async (req: Request<{ id: string }>, res: Response) => {
  try {
    const { result, provider } = await refreshGatewayProviderModels(req.params.id, req.user!.id);
    return res.json({ success: true, data: { provider, models: result, overview: await getGatewayOverview(brandOf(req)) } });
  } catch (err) {
    return fail(req, res, err, 'Failed to fetch the model list');
  }
});

export default router;
