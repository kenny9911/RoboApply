import type { Request, Response, NextFunction } from 'express';

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const user = req.user;
  if (!user) {
    res.status(401).json({ success: false, error: 'Authentication required', code: 'AUTH_REQUIRED' });
    return;
  }

  if ((user as any).role !== 'admin') {
    res.status(403).json({ success: false, error: 'Admin access required', code: 'ADMIN_REQUIRED' });
    return;
  }

  next();
}

/**
 * Gate for surfaces that admin *and* internal role users can read. Admins
 * can still mutate; internal users get a read-only slice (the individual
 * mutating handlers stack `requireAdmin` on top of this one).
 *
 * Used by the Agent Manager (docs/admin-agent-manager-prd.md §4 Phase 4):
 * internal SREs need fleet-wide visibility into runs and costs, but only
 * admins should be able to cancel, force-run, or delete.
 */
export function requireAdminOrInternal(req: Request, res: Response, next: NextFunction): void {
  const user = req.user;
  if (!user) {
    res.status(401).json({ success: false, error: 'Authentication required', code: 'AUTH_REQUIRED' });
    return;
  }
  const role = (user as any).role;
  if (role !== 'admin' && role !== 'internal') {
    res.status(403).json({ success: false, error: 'Admin or internal access required', code: 'ADMIN_OR_INTERNAL_REQUIRED' });
    return;
  }
  next();
}
