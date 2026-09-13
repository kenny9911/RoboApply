import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';

/** Body parsing runs before route middleware. Preserve the API error contract
 * there without logging the rejected body, which may contain credentials. */
export function handleJobSearchBodyError(error: unknown, req: Request, res: Response): boolean {
  if (!/^\/api\/v1\/(?:job-search|roboapply\/v2\/job-search)(?:\/|$)/.test(req.path)) return false;
  const type = (error as { type?: string } | null)?.type;
  if (type !== 'entity.parse.failed' && type !== 'entity.too.large') return false;
  if (res.headersSent) return true;
  req.requestId ??= randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  res.setHeader('Cache-Control', 'no-store');
  const tooLarge = type === 'entity.too.large';
  res.status(tooLarge ? 413 : 400).json({
    error: tooLarge ? 'Request body exceeds the server size limit.' : 'Request body must contain valid JSON.',
    code: tooLarge ? 'request_too_large' : 'invalid_request', requestId: req.requestId,
  });
  return true;
}
