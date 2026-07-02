// backend/src/interview-engine/routes/index.ts
//
// Interview Engine router aggregate. Mounted at /api/v1/interview-engine in
// backend/src/index.ts.
//
//   /catalog, /sessions/*          — internal (cookie/JWT) UI surface
//   /requirements/preview          — internal pre-launch requirements preview
//   /v1/sessions/*                 — external (X-API-Key) developer surface
//   /callbacks/sessions/*          — worker callbacks (shared-secret gated)
//   /webhooks/livekit              — LiveKit Cloud webhook (raw body, signed)

import { Router } from 'express';
import internalRoutes from './internalRoutes.js';
import previewRoutes from './previewRoutes.js';
import externalRoutes from './externalRoutes.js';
import callbackRoutes from './callbackRoutes.js';
import webhookRoutes from './webhookRoutes.js';

const router = Router();

router.use('/webhooks', webhookRoutes);
router.use('/callbacks', callbackRoutes);
router.use('/v1', externalRoutes);
router.use('/', previewRoutes);
router.use('/', internalRoutes);

export default router;
