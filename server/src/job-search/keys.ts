import { createHash, randomBytes } from 'node:crypto';
import prisma from '../lib/prisma.js';

export const JOB_SEARCH_SCOPE = 'jobs:search';
const KEY_PATTERN = /^rajs_[a-f0-9]{64}$/;
const MAX_KEYS = 5;

export class JobSearchAccessError extends Error {
  constructor(public code: string, public status: number, message: string) {
    super(message);
    this.name = 'JobSearchAccessError';
  }
}

export function hashSearchKey(token: string): string {
  return `rajs_sha256:${createHash('sha256').update(token).digest('hex')}`;
}

type KeyRecord = {
  id: string; name: string; prefix: string; createdAt: Date;
  lastUsedAt: Date | null; expiresAt: Date | null;
};
function publicKey(key: KeyRecord) {
  return {
    id: key.id, name: key.name, prefix: key.prefix,
    createdAt: key.createdAt.toISOString(),
    lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
    expiresAt: key.expiresAt?.toISOString() ?? null,
  };
}
const publicSelect = {
  id: true, name: true, prefix: true, createdAt: true, lastUsedAt: true, expiresAt: true,
} as const;

export class JobSearchKeys {
  constructor(private readonly db = prisma) {}

  async list(userId: string) {
    const keys = await this.db.apiKey.findMany({
      where: { userId, scopes: { has: JOB_SEARCH_SCOPE }, status: 'active', isActive: true },
      select: publicSelect, orderBy: { createdAt: 'desc' },
    });
    return { keys: keys.map(publicKey) };
  }

  async create(userId: string, input: unknown) {
    const body = input as Record<string, unknown> | null;
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    const days = body?.expiresInDays ?? 90;
    if (!name || name.length > 80 || /[\u0000-\u001f]/.test(name) ||
        typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 365) {
      throw new JobSearchAccessError('invalid_request', 400, 'Use a name of 1–80 characters and an expiry of 1–365 days.');
    }
    const token = `rajs_${randomBytes(32).toString('hex')}`;
    const key = await this.db.$transaction(async (tx) => {
      // A DB lock makes the cap effective across concurrent Vercel instances.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`job-search-keys:${userId}`}))::text`;
      const count = await tx.apiKey.count({ where: {
        userId, scopes: { has: JOB_SEARCH_SCOPE }, status: 'active', isActive: true,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      } });
      if (count >= MAX_KEYS) throw new JobSearchAccessError('key_limit', 409, 'Revoke an existing key before creating another.');
      return tx.apiKey.create({ data: {
        userId, name, key: hashSearchKey(token), prefix: token.slice(0, 13),
        scopes: [JOB_SEARCH_SCOPE],
        expiresAt: new Date(Date.now() + days * 86_400_000),
      }, select: publicSelect });
    }, { isolationLevel: 'ReadCommitted' });
    return { key: publicKey(key), token };
  }

  async revoke(userId: string, id: string) {
    const result = await this.db.apiKey.updateMany({
      where: { id, userId, scopes: { has: JOB_SEARCH_SCOPE }, status: 'active' },
      data: { isActive: false, status: 'deleted', deletedAt: new Date() },
    });
    if (!result.count) throw new JobSearchAccessError('not_found', 404, 'API key not found.');
  }

  async authenticate(authorization: string | undefined) {
    const token = authorization?.match(/^Bearer (\S+)$/i)?.[1];
    if (!token || !KEY_PATTERN.test(token)) {
      throw new JobSearchAccessError('invalid_api_key', 401, 'A valid job-search Bearer API key is required.');
    }
    const record = await this.db.apiKey.findUnique({
      where: { key: hashSearchKey(token) },
      select: {
        id: true, userId: true, scopes: true, isActive: true, status: true,
        expiresAt: true, user: { select: { isActive: true } },
      },
    });
    if (!record || !record.isActive || record.status !== 'active' ||
        !record.user.isActive || (record.expiresAt && record.expiresAt <= new Date()) ||
        !record.scopes.includes(JOB_SEARCH_SCOPE)) {
      throw new JobSearchAccessError('invalid_api_key', 401, 'This API key is invalid, expired, or revoked.');
    }
    return { userId: record.userId, apiKeyId: record.id };
  }
}

export const jobSearchKeys = new JobSearchKeys();
