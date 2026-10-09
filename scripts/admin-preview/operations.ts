// Fictional, browser-only data. Never imported by the production app.
import type { OperationsActivity, OperationsFilters, OperationsOverview, OperationsPage, OperationsPayment, OperationsPayments, OperationsUser, NativeRevenue } from '../../lib/api/adminOperations';

const dayMs = 86400000;
const now = Date.now();
export const ago = (days: number) => new Date(now - days * dayMs).toISOString();
const scenario = () => new URLSearchParams(window.location.search).get('scenario');
const names = ['林小雨', '张明', 'Sofia Chen', '陈思远', '李佳宁', 'Daniel Park', 'Alex Morgan', '王子涵'];
const regions = ['cn', 'cn', 'cn', 'us', 'cn', 'tw', 'cn', 'jp', 'cn', 'eu', 'cn', 'other', 'cn', 'unknown'];
const currencyFor = (region: string) => ({ cn: 'CNY', us: 'USD', tw: 'TWD', jp: 'JPY', eu: 'EUR' })[region] ?? 'USD';
const priceFor = (currency: string, plus: boolean) => ({ CNY: plus ? 29900 : 9900, USD: plus ? 3900 : 1900, TWD: plus ? 119000 : 59000, JPY: plus ? 6000 : 3000, EUR: plus ? 3900 : 1900 })[currency] ?? 1900;
export const users: OperationsUser[] = Array.from({ length: 34 }, (_, index) => ({
  userId: `preview-user-${String(index + 1).padStart(2, '0')}`,
  email: `member${String(index + 1).padStart(2, '0')}@example.test`,
  name: names[index % names.length] + (index >= 8 ? ` ${Math.floor(index / 8) + 1}` : ''),
  role: 'seeker', isActive: index !== 11, region: regions[index % regions.length],
  tier: index % 5 === 0 ? 'premium_plus' : index % 3 === 0 ? 'free' : 'premium',
  status: index === 11 ? 'past_due' : 'active', createdAt: ago(index < 7 ? index + 1 : index + 35),
  subscription: { currency: currencyFor(regions[index % regions.length]), amountMinor: index % 3 === 0 && index % 5 !== 0 ? 0 : priceFor(currencyFor(regions[index % regions.length]), index % 5 === 0) },
  loginEvents: 0, featureEvents: 0, usageUnits: 0, periodCostUsd: 0,
  lastLoginAt: null, lastActiveAt: null,
}));

export const payments: OperationsPayment[] = Array.from({ length: 64 }, (_, index) => {
  const user = users[index % users.length];
  const currency = currencyFor(user.region);
  const createdAt = ago(index / 2.4 + 0.01);
  const status = index === 2 ? 'pending' : index === 19 ? 'open' : index === 7 ? 'uncollectible' : index === 14 ? 'cancelled' : index === 17 ? 'void' : index === 9 ? 'draft' : index === 22 ? 'failed' : 'paid';
  return {
    id: `preview-payment-${index + 1}`, userId: user.userId, email: user.email, name: user.name,
    provider: currency === 'CNY' ? 'alipay' : 'stripe', type: currency !== 'CNY' && index % 2 === 1 ? 'renewal' : 'plan_purchase',
    status, region: user.region, amountMinor: priceFor(currency, index % 3 === 0),
    currency, reference: `${currency === 'CNY' ? 'ra_example_' : 'in_example_'}${String(index + 1).padStart(8, '0')}`,
    tier: currency === 'CNY' ? index % 3 === 0 ? 'premium_plus' : 'premium' : null,
    createdAt, paidAt: status === 'paid' ? createdAt : null,
  };
});

const features = ['job_search', 'job_match', 'resume_tailor', 'resume_import', 'interview_start', 'tracker_update'];
const ledgerFeatures = ['ra_match_score', 'ra_resume_tailor', 'mock_interview'];
export const activity: OperationsActivity[] = Array.from({ length: 270 }, (_, index) => {
  const user = users[index % users.length];
  const isLogin = index % 5 === 0;
  const isSignup = !isLogin && index % 41 === 0;
  const isLedger = !isLogin && !isSignup && index % 4 === 0;
  const feature = isLogin || isSignup ? null : isLedger ? ledgerFeatures[index % ledgerFeatures.length] : features[index % features.length];
  return {
    id: `preview-activity-${index + 1}`, userId: user.userId, email: user.email, name: user.name, region: user.region,
    type: isLogin ? 'login' : isSignup ? 'signup' : isLedger ? 'usage_debit' : 'feature_use', feature,
    path: isLedger ? null : isLogin ? '/api/v1/roboapply/auth/login' : isSignup ? '/api/v1/roboapply/auth/signup' : `/api/v1/roboapply/v2/${feature}`,
    units: isLedger ? 1 : null, costUsd: isLedger ? Number((0.003 + (index % 7) * 0.018).toFixed(3)) : null,
    source: isLedger ? 'usage_ledger' : 'activity', createdAt: ago(index / 10 + 0.005),
  };
});

function inside(date: string, filters: OperationsFilters) {
  const time = new Date(date).getTime();
  return (!filters.from || time >= new Date(filters.from).getTime()) && (!filters.to || time < new Date(filters.to).getTime());
}
function filterRows<T extends { userId: string; name: string | null; email: string; region: string; createdAt: string }>(rows: T[], filters: OperationsFilters, dateFilter = true): T[] {
  if (scenario() === 'empty') return [];
  if (scenario() === 'error') throw new Error('Fictional preview error');
  const query = filters.q?.toLowerCase();
  return rows.filter(row => {
    const other = row as T & { provider?: string; type?: string; status?: string; currency?: string; reference?: string; paidAt?: string | null };
    return (!dateFilter || inside(other.paidAt ?? row.createdAt, filters)) &&
      (!filters.userId || row.userId === filters.userId) && (!filters.region || row.region === filters.region) &&
      (!filters.provider || other.provider === filters.provider) && (!filters.type || other.type === filters.type) &&
      (!filters.status || other.status === filters.status) && (!filters.currency || other.currency === filters.currency) &&
      (!query || `${row.name} ${row.email} ${row.userId} ${other.reference ?? ''}`.toLowerCase().includes(query));
  });
}
function paginate<T>(rows: T[], filters: OperationsFilters): OperationsPage<T> {
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 25;
  return { rows: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length, page, pageSize };
}
function totals(rows: OperationsPayment[]): NativeRevenue[] {
  const sums = new Map<string, NativeRevenue>();
  for (const row of rows.filter(row => row.status === 'paid')) {
    const current = sums.get(row.currency) ?? { currency: row.currency, paidMinor: 0, paidCount: 0 };
    current.paidMinor += row.amountMinor; current.paidCount++;
    sums.set(row.currency, current);
  }
  return [...sums.values()].sort((a, b) => a.currency === 'CNY' ? -1 : b.currency === 'CNY' ? 1 : a.currency.localeCompare(b.currency));
}
const coverage = () => ({ stripe: scenario() === 'partial' ? 'partial' as const : 'complete' as const, refundsIncluded: false as const });

export const operationsApi = {
  async overview(filters: OperationsFilters): Promise<OperationsOverview> {
    const events = filterRows(activity, filters);
    const orders = filterRows(payments, filters);
    const visibleUsers = filterRows(users, filters, false);
    const logins = events.filter(row => row.type === 'login');
    const functional = events.filter(row => row.type === 'feature_use');
    const timezone = filters.tz ?? 'Asia/Shanghai';
    const dateKey = (date: string | number) => new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(date));
    const days = new Map<string, { day: string; logins: number; featureEvents: number; active: Set<string> }>();
    const finalDay = dateKey(new Date(filters.to ?? ago(0)).getTime() - 1);
    const cursor = new Date(`${dateKey(filters.from ?? ago(30))}T00:00:00Z`);
    while (cursor.toISOString().slice(0, 10) <= finalDay) {
      const day = cursor.toISOString().slice(0, 10);
      days.set(day, { day, logins: 0, featureEvents: 0, active: new Set() });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    for (const event of events) {
      const day = dateKey(event.createdAt);
      const current = days.get(day) ?? { day, logins: 0, featureEvents: 0, active: new Set() };
      current.logins += event.type === 'login' ? 1 : 0;
      current.featureEvents += event.type === 'feature_use' ? 1 : 0;
      current.active.add(event.userId); days.set(day, current);
    }
    return {
      range: { from: filters.from ?? ago(30), to: filters.to ?? ago(0), tz: filters.tz ?? 'Asia/Shanghai' },
      users: { total: visibleUsers.length, new: visibleUsers.filter(row => inside(row.createdAt, filters)).length, active: new Set(events.map(row => row.userId)).size, loginUsers: new Set(logins.map(row => row.userId)).size, loginEvents: logins.length, featureEvents: functional.length, payingUsers: new Set(orders.filter(row => row.status === 'paid').map(row => row.userId)).size },
      payments: { currencies: totals(orders), total: orders.length, paid: orders.filter(row => row.status === 'paid').length, pending: orders.filter(row => ['pending', 'open', 'draft'].includes(row.status)).length, failed: orders.filter(row => ['failed', 'uncollectible'].includes(row.status)).length, coverage: coverage() },
      costUsd: events.reduce((sum, row) => sum + (row.costUsd ?? 0), 0),
      activitySeries: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)).map(({ active, ...row }) => ({ ...row, activeUsers: active.size })),
      featureUsage: [...features.map(key => {
        const rows = functional.filter(row => row.feature === key);
        return { key, events: rows.length, users: new Set(rows.map(row => row.userId)).size, units: 0, costUsd: 0, source: 'feature_event' as const };
      }), ...ledgerFeatures.map(key => {
        const rows = events.filter(row => row.type === 'usage_debit' && row.feature === key);
        return { key, events: rows.length, users: new Set(rows.map(row => row.userId)).size, units: rows.reduce((sum, row) => sum + (row.units ?? 0), 0), costUsd: rows.reduce((sum, row) => sum + (row.costUsd ?? 0), 0), source: 'usage_ledger' as const };
      })].filter(row => row.events > 0).sort((a, b) => b.events - a.events),
      regions: [...new Set(regions)].map(region => ({ region, users: visibleUsers.filter(row => row.region === region).length })),
      trackingSince: ago(28),
    };
  },
  async users(filters: OperationsFilters): Promise<OperationsPage<OperationsUser>> {
    const rows = filterRows(users, filters, false).map(user => {
      const events = activity.filter(row => row.userId === user.userId && inside(row.createdAt, filters));
      return { ...user, loginEvents: events.filter(row => row.type === 'login').length, featureEvents: events.filter(row => row.type === 'feature_use').length, usageUnits: events.reduce((sum, row) => sum + (row.units ?? 0), 0), periodCostUsd: events.reduce((sum, row) => sum + (row.costUsd ?? 0), 0), lastLoginAt: events.find(row => row.type === 'login')?.createdAt ?? null, lastActiveAt: events[0]?.createdAt ?? null };
    });
    return paginate(rows, filters);
  },
  async payments(filters: OperationsFilters): Promise<OperationsPayments> {
    const rows = filterRows(payments, filters);
    return { ...paginate(rows, filters), currencies: totals(rows), coverage: coverage() };
  },
  async activity(filters: OperationsFilters): Promise<OperationsPage<OperationsActivity>> {
    return paginate(filterRows(activity, filters), filters);
  },
};

// Preview exports never reach a live API. The loopback server rejects /api/.
export function operationsCsvUrl(kind: string) { return `/api/preview-disabled/${kind}.csv`; }
