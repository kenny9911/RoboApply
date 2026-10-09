import { createHash, randomUUID } from 'node:crypto';
import type { Request } from 'express';
import prisma from './prisma.js';
import { SESSION_COOKIE_NAME } from './cookieOptions.js';
import { logger } from '../services/LoggerService.js';

type ActivityInput = {
  userId: string;
  eventType: 'login' | 'signup' | 'feature_use';
  path: string;
  feature?: string;
  sessionToken?: string;
  market?: string;
  statusCode: number;
};

/** Server-observed activity, separate from billable deductions and browser clicks.
 * Await before ending the response so serverless runtimes can finish the write.
 * Telemetry failures must never turn a completed user action into a failure.
 */
export async function recordUserActivity(req: Request, input: ActivityInput): Promise<void> {
  try {
    const sessionToken = input.sessionToken ?? req.sessionToken ?? req.cookies?.[SESSION_COOKIE_NAME];
    // Never put an authentication credential, request body, query, or IP into
    // the analytics table. A one-way digest can group opaque login sessions.
    const sessionId = typeof sessionToken === 'string'
      ? `sha256:${createHash('sha256').update(sessionToken).digest('hex')}`
      : `request:${req.requestId ?? randomUUID()}`;
    await prisma.userActivity.create({
      data: {
        userId: input.userId,
        sessionId,
        eventType: input.eventType,
        path: input.path,
        element: input.feature ?? null,
        timestamp: new Date(),
        metadata: {
          source: 'server',
          method: req.method,
          statusCode: input.statusCode,
          ...(input.market ? { market: input.market } : {}),
        },
      },
    });
  } catch {
    logger.warn('USER_ACTIVITY', 'Activity recording failed', {
      userId: input.userId,
      eventType: input.eventType,
    }, req.requestId);
  }
}
