// Legacy session/detail tabs share the same fictional identities as operations.
import type { AdminRange, AdminSessionRow, AdminSessionsParams, AdminUserDetailResponse, AdminUsersParams, AdminSetPlanBody, AdminRateCardResponse } from '../../lib/api/admin';
import { users, ago } from './operations';

const sessions: AdminSessionRow[] = Array.from({ length: 18 }, (_, index) => ({
  id: `preview-session-${String(index + 1).padStart(2, '0')}`, userId: users[index].userId,
  email: users[index].email, role: ['Product Manager', 'Software Engineer', 'Data Analyst'][index % 3],
  status: index === 3 ? 'failed' : index === 7 ? 'in_progress' : 'completed',
  durationSec: 900 + index * 40, costUsd: 0.82 + index * 0.06, createdAt: ago(index + 0.3),
  cost: { blueprint: 0.02, liveLlm: 0.13, stt: 0.18, tts: 0.3, evaluation: 0.08, coach: 0.05, recording: 0.06 },
}));
const page = <T,>(rows: T[], params: { page?: number; pageSize?: number } = {}) => ({ rows: rows.slice(((params.page ?? 1) - 1) * (params.pageSize ?? 25), (params.page ?? 1) * (params.pageSize ?? 25)), total: rows.length, page: params.page ?? 1, pageSize: params.pageSize ?? 25 });

export const adminApi = {
  async overview() { throw new Error('Legacy overview is not included in this preview.'); },
  async users(params: AdminUsersParams = {}) {
    return { ...page(users.map(user => ({ ...user, mrrUsd: 0, marginUsd: 0, marginPct: null, profitable: null, sessions: 1, interviewDebits: 1, hasStripeCustomer: user.region !== 'cn', currentPeriodEnd: ago(-25) })), params), truncated: false };
  },
  async user(userId: string, _params?: AdminRange): Promise<AdminUserDetailResponse> {
    const user = users.find(row => row.userId === userId) ?? users[0];
    return {
      user: { id: user.userId, email: user.email, name: user.name, role: user.role, provider: 'email', createdAt: user.createdAt },
      subscription: { tier: user.tier, status: user.status, mrrUsd: user.region === 'cn' ? 0 : 19, amountMinor: user.subscription.amountMinor, currency: user.subscription.currency ?? 'CNY', dailyCap: 10, stripeCustomerId: user.region === 'cn' ? null : 'cus_example', currentPeriodEnd: ago(-25), cancelAtPeriodEnd: false },
      profitability: { lifetimeCostUsd: 8.74, periodCostUsd: 2.18, mrrUsd: user.region === 'cn' ? 0 : 19, marginUsd: 0, marginPct: null, profitable: null },
      costByFeature: [{ key: 'job_match', label: 'Job matching', costUsd: 0.48, units: 24 }, { key: 'interview', label: 'Interview', costUsd: 1.7, units: 2 }],
      dailyUsage: Array.from({ length: 14 }, (_, index) => ({ day: ago(13 - index).slice(0, 10), count: 2 + index % 4, costUsd: 0.09 + (index % 4) * 0.03 })),
      interviewSessions: sessions.filter(row => row.userId === user.userId).map(row => ({ ...row, cost: { llm: 0.23, stt: 0.18, tts: 0.3, recording: 0.06 } })),
    };
  },
  async setPlan(_userId: string, _body: AdminSetPlanBody): Promise<never> { throw new Error('Live plan changes are disabled in the example-data preview.'); },
  async sessions(params: AdminSessionsParams = {}) {
    return page(sessions.filter(row => (!params.status || row.status === params.status) && (!params.userId || row.userId === params.userId)), params);
  },
  async session(id: string) {
    const row = sessions.find(item => item.id === id) ?? sessions[0];
    const user = users.find(item => item.userId === row.userId)!;
    return { ...row, interviewType: 'behavioral', mode: 'voice', language: 'zh-CN', recordingDurationSec: row.durationSec, recordingBytes: 1400000, costBreakdown: row.cost, promptTokens: 8200, completionTokens: 2400, totalTokens: 10600, overall: 82, endedAt: row.createdAt, user: { email: user.email, name: user.name } };
  },
  async rateCard(): Promise<AdminRateCardResponse> {
    return { source: 'env', cacheAgeMs: null, card: {
      llm: { 'example/fast-model': { input: 0.3, output: 1.2 }, 'example/reasoning-model': { input: 2, output: 8 } },
      llmDefault: { input: 1, output: 4 }, stt: { default: 0.0043 }, tts: { usdPer1MChars: 15, usdPerMin: 0.016 },
      egress: { usdPerGb: 0.12 }, storage: { usdPerGbMonth: 0.023 },
      tiers: { free: { priceUsdMonthly: 0, dailyCap: 3, stripePriceId: null }, premium: { priceUsdMonthly: 19, dailyCap: 10, stripePriceId: null }, premium_plus: { priceUsdMonthly: 39, dailyCap: 30, stripePriceId: null } },
    } };
  },
};
export function adminCsvUrl(kind: string) { return `/api/preview-disabled/${kind}.csv`; }
