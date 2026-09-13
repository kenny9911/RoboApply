// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
vi.mock('../lib/prisma.js', () => ({ default: {} }));
import { JobSearchKeys, hashSearchKey, JOB_SEARCH_SCOPE } from './keys.js';

function store() {
  const rows: any[] = [];
  const apiKey = {
    count: vi.fn(async () => rows.filter(r => r.isActive && r.expiresAt > new Date()).length),
    create: vi.fn(async ({ data }: any) => {
      const row = { id: `key-${rows.length}`, createdAt: new Date(), lastUsedAt: null, isActive: true, status: 'active', user: { isActive: true }, ...data };
      rows.push(row); return row;
    }),
    findMany: vi.fn(async ({ where }: any) => rows.filter(r => r.userId === where.userId && r.isActive)),
    findUnique: vi.fn(async ({ where }: any) => rows.find(r => r.key === where.key) ?? null),
    updateMany: vi.fn(async ({ where, data }: any) => {
      const row = rows.find(r => r.id === where.id && r.userId === where.userId && r.status === where.status);
      if (row) Object.assign(row, data);
      return { count: row ? 1 : 0 };
    }),
  };
  const tx = { apiKey, $queryRaw: vi.fn(async () => []) };
  const db = { ...tx, $transaction: (fn: any) => fn(tx) };
  return { rows, apiKey, keys: new JobSearchKeys(db as never) };
}

describe('scoped job-search API keys', () => {
  it('reveals a random token once, stores only its hash and authenticates the owner', async () => {
    const { keys, rows } = store();
    const created = await keys.create('owner', { name: 'Integration' });
    expect(created.token).toMatch(/^rajs_[a-f0-9]{64}$/);
    expect(rows[0].key).toBe(hashSearchKey(created.token));
    expect(rows[0].key).not.toContain(created.token);
    expect(rows[0].scopes).toEqual([JOB_SEARCH_SCOPE]);
    expect(JSON.stringify(await keys.list('owner'))).not.toContain(created.token);
    expect(JSON.stringify(await keys.list('owner'))).not.toContain(rows[0].key);
    await expect(keys.authenticate(`Bearer ${created.token}`)).resolves.toEqual({ userId: 'owner', apiKeyId: created.key.id });
  });
  it('does not let another owner revoke a key; revocation takes effect immediately', async () => {
    const { keys } = store();
    const created = await keys.create('owner', { name: 'App' });
    await expect(keys.revoke('other', created.key.id)).rejects.toMatchObject({ status: 404 });
    await keys.revoke('owner', created.key.id);
    await expect(keys.authenticate(`Bearer ${created.token}`)).rejects.toMatchObject({ status: 401 });
    expect(await keys.list('owner')).toEqual({ keys: [] });
  });
  it.each(['expired', 'disabled_user', 'wrong_scope'])('rejects %s keys', async (mode) => {
    const { keys, rows } = store();
    const created = await keys.create('owner', { name: 'App' });
    if (mode === 'expired') rows[0].expiresAt = new Date(0);
    if (mode === 'disabled_user') rows[0].user.isActive = false;
    if (mode === 'wrong_scope') rows[0].scopes = ['read', 'write'];
    await expect(keys.authenticate(`Bearer ${created.token}`)).rejects.toMatchObject({ status: 401 });
  });
  it('rejects legacy keys and never queries storage with an invalid token', async () => {
    const { keys, apiKey } = store();
    for (const token of [undefined, 'Bearer rh_example', 'Basic abcd', `Bearer ${'x'.repeat(1000)}`]) {
      await expect(keys.authenticate(token)).rejects.toMatchObject({ status: 401 });
    }
    expect(apiKey.findUnique).not.toHaveBeenCalled();
  });
  it('enforces bounded expiry and key count', async () => {
    const { keys } = store();
    await expect(keys.create('owner', { name: 'x', expiresInDays: 0 })).rejects.toMatchObject({ status: 400 });
    for (let i = 0; i < 5; i++) await keys.create('owner', { name: `App ${i}` });
    await expect(keys.create('owner', { name: 'sixth' })).rejects.toMatchObject({ status: 409 });
  });
});
