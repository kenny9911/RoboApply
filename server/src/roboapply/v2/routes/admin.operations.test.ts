// @vitest-environment node
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ overview: vi.fn(), users: vi.fn(), payments: vi.fn(), activity: vi.fn() }));
vi.mock('../../../lib/prisma.js', () => ({ default: {} }));
vi.mock('../../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../lib/raAuth.js', () => ({ requireAuth: (req: any, res: any, next: () => void) => {
  const role = req.headers['x-test-role'];
  if (!role) return res.status(401).json({ success: false, code: 'AUTH_REQUIRED' });
  req.user = { id: 'test', role };
  next();
} }));
vi.mock('../services/RAAdminOperationsService.js', () => ({
  getOperationsOverview: (...args: unknown[]) => mocks.overview(...args),
  getOperationsUsers: (...args: unknown[]) => mocks.users(...args),
  getOperationsPayments: (...args: unknown[]) => mocks.payments(...args),
  getOperationsActivity: (...args: unknown[]) => mocks.activity(...args),
}));

describe('admin operations authorization and exports', () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    const express = (await import('express')).default;
    const router = (await import('./admin.js')).default;
    const app = express();
    app.use('/admin', router);
    server = await new Promise<Server>((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/admin`;
  });
  afterAll(async () => { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); });
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.overview.mockResolvedValue({ users: { total: 2 } });
    mocks.users.mockResolvedValue({ rows: [], total: 0, page: 1, pageSize: 25 });
    mocks.payments.mockResolvedValue({ rows: [], total: 0, page: 1, pageSize: 25, coverage: { stripe: 'complete', refundsIncluded: false } });
    mocks.activity.mockResolvedValue({ rows: [], total: 0, page: 1, pageSize: 25 });
  });

  it.each(['/operations', '/operations/users', '/payments', '/activity', '/payments.csv', '/activity.csv', '/operations/users.csv'])(
    'requires the admin role before reading %s', async (path) => {
      expect((await fetch(base + path)).status).toBe(401);
      expect((await fetch(base + path, { headers: { 'x-test-role': 'candidate' } })).status).toBe(403);
      expect(mocks.overview).not.toHaveBeenCalled();
      expect(mocks.payments).not.toHaveBeenCalled();
      expect(mocks.users).not.toHaveBeenCalled();
      expect(mocks.activity).not.toHaveBeenCalled();
    },
  );

  it('passes the exact filter set and resolves local date boundaries', async () => {
    const response = await fetch(`${base}/payments?from=2026-10-09&to=2026-10-09&tz=Asia%2FShanghai&q=Ada&userId=u1&region=cn&provider=alipay&type=plan_purchase&status=paid&currency=CNY&page=2&pageSize=50`, { headers: { 'x-test-role': 'admin' } });
    expect(response.status).toBe(200);
    expect(mocks.payments).toHaveBeenCalledWith({
      range: { from: new Date('2026-10-08T16:00:00Z'), to: new Date('2026-10-09T16:00:00Z'), tz: 'Asia/Shanghai' },
      q: 'Ada', userId: 'u1', region: 'cn', provider: 'alipay', type: 'plan_purchase', status: 'paid', currency: 'CNY', page: 2, pageSize: 50,
    });
  });

  it('rejects invalid date windows before querying', async () => {
    const response = await fetch(`${base}/operations?from=invalid&to=2026-10-09`, { headers: { 'x-test-role': 'admin' } });
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('invalid_range');
    expect(mocks.overview).not.toHaveBeenCalled();
  });

  it('exports native minor units and neutralizes spreadsheet formulas in user text', async () => {
    mocks.payments.mockResolvedValue({ rows: [{ id: 'p1', userId: 'u1', email: '=HYPERLINK("evil")', name: 'Name, Example', currency: 'CNY', amountMinor: 1900 }],
      total: 1, coverage: { stripe: 'partial', refundsIncluded: false } });
    const response = await fetch(`${base}/payments.csv`, { headers: { 'x-test-role': 'admin' } });
    const csv = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get('x-payment-coverage')).toBe('partial');
    expect(csv).toContain('amountMinor,currency');
    expect(csv).toContain('1900,CNY');
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).toContain('"Name, Example"');
    expect(mocks.payments.mock.calls[0][0]).toMatchObject({ page: 1, pageSize: 10000 });
  });

  it('does not silently export only a truncated first page', async () => {
    mocks.users.mockResolvedValue({ rows: [], total: 10001 });
    const response = await fetch(`${base}/operations/users.csv`, { headers: { 'x-test-role': 'admin' } });
    expect(response.status).toBe(422);
    expect((await response.json()).code).toBe('export_too_large');
  });
});
