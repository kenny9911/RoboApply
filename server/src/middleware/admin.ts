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

