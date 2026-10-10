// server/src/features/extension/auth.ts — `requireExtensionDevice`
// (ARCHITECTURE.md §6.3, §10.5).
//
// `Authorization: Bearer rax_…` → sha256 → RAExtensionDevice (not revoked) →
// the device's brand must equal the request's brand → `req.user` is the
// device owner. `lastSeenAt` is written at most every 10 minutes.
//
// Scope: this middleware is mounted only on the /ext device routes. A device
// token is not a session: `requireAuth` treats it as an invalid bearer token
// (401), so it opens nothing outside /api/v1/roboapply/ext/* (auth.test.ts).
// Revoking a device (Settings → Devices) takes effect on the next call.

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { getCurrentBrandOrDefault } from '../../platform/brand/brandContext.js';
import type { ProductBrand } from '../../platform/brand/registry.js';
import { fail } from '../../platform/http.js';
import { setCurrentUserId } from '../../lib/requestContext.js';
import { logger } from '../../services/LoggerService.js';
import { EXTENSION_ERROR_CODES, LAST_SEEN_WRITE_MS } from './contract.js';
import type { DeviceWithUser, ExtensionRepo } from './repository.js';
import { bearerDeviceToken, hashDeviceToken } from './tokens.js';

/** What the device routes read from the request. */
export interface ExtDeviceOnRequest {
  id: string;
  name: string;
  extVersion: string | null;
}

export type ExtRequest = Request & { extDevice?: ExtDeviceOnRequest; brand?: ProductBrand };

export interface DeviceAuthDeps {
  repo: () => Pick<ExtensionRepo, 'findDeviceByTokenHash' | 'touchDevice'>;
  now?: () => Date;
}

function deny(res: Response, reason?: string): void {
  fail(res, 'unauthorized', reason === EXTENSION_ERROR_CODES.deviceRevoked ? 'This browser was disconnected. Connect it again.' : 'Extension device token required.', reason ? { reason } : undefined);
}

export function createRequireExtensionDevice(deps: DeviceAuthDeps): RequestHandler {
  const now = deps.now ?? (() => new Date());
  return async function requireExtensionDevice(req: Request, res: Response, next: NextFunction): Promise<void> {
    const token = bearerDeviceToken(req.headers.authorization);
    if (!token) {
      deny(res);
      return;
    }
    let device: DeviceWithUser | null;
    try {
      device = await deps.repo().findDeviceByTokenHash(hashDeviceToken(token));
    } catch (err) {
      next(err);
      return;
    }
    if (!device) {
      deny(res);
      return;
    }
    if (device.revokedAt) {
      deny(res, EXTENSION_ERROR_CODES.deviceRevoked);
      return;
    }
    if (!device.user.isActive) {
      deny(res);
      return;
    }
    const brand = (req as ExtRequest).brand ?? getCurrentBrandOrDefault();
    if (device.brand !== brand.id || (device.user.brand && device.user.brand !== brand.id)) {
      fail(res, 'auth_other_brand', 'This browser is connected to the other site.');
      return;
    }

    const at = now();
    if (!device.lastSeenAt || at.getTime() - device.lastSeenAt.getTime() >= LAST_SEEN_WRITE_MS) {
      const header = req.headers['x-ext-version'];
      const version = typeof header === 'string' && /^[0-9][0-9A-Za-z.+-]{0,19}$/.test(header) ? header : null;
      deps
        .repo()
        .touchDevice(device.id, at, version)
        .catch((err: unknown) => logger.warn('EXTENSION', 'device lastSeenAt not written', { deviceId: device!.id, error: String(err) }));
    }

    (req as unknown as { user?: unknown }).user = { id: device.user.id, email: device.user.email, role: device.user.role, brand: device.user.brand };
    (req as ExtRequest).extDevice = { id: device.id, name: device.name, extVersion: device.extVersion };
    setCurrentUserId(device.user.id);
    next();
  };
}
