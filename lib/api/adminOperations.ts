import { roboApi } from './client';
import { API_BASE } from '../config';
import type { AdminRange } from './admin';

export interface OperationsFilters extends AdminRange {
  q?: string;
  userId?: string;
  region?: string;
  provider?: string;
  type?: string;
  status?: string;
  currency?: string;
  page?: number;
  pageSize?: number;
}
export interface NativeRevenue {
  currency: string;
  paidMinor: number;
  paidCount: number;
}
export interface PaymentCoverage {
  stripe: 'complete' | 'partial' | 'unavailable' | 'not_configured';
  /** Only recorded collections, not net revenue: refunds are not reconciled here. */
  refundsIncluded: false;
}
export interface OperationsOverview {
  range: { from: string; to: string; tz: string };
  users: { total: number; new: number; active: number; loginUsers: number; loginEvents: number; featureEvents: number; payingUsers: number };
  payments: { currencies: NativeRevenue[]; total: number; paid: number; pending: number; failed: number; coverage: PaymentCoverage };
  costUsd: number;
  activitySeries: { day: string; logins: number; featureEvents: number; activeUsers: number }[];
  featureUsage: { key: string; events: number; users: number; units: number; costUsd: number; source: 'usage_ledger' | 'feature_event' }[];
  regions: { region: string; users: number }[];
  trackingSince: string | null;
}
export interface OperationsUser {
  userId: string; email: string; name: string | null; role: string; isActive: boolean;
  region: string; tier: string; status: string; createdAt: string;
  subscription: { currency: string | null; amountMinor: number | null };
  loginEvents: number; featureEvents: number; usageUnits: number; periodCostUsd: number;
  lastLoginAt: string | null; lastActiveAt: string | null;
}
export interface OperationsPayment {
  id: string; userId: string; email: string; name: string | null;
  provider: 'alipay' | 'stripe'; type: string; status: string; region: string;
  amountMinor: number; currency: string; reference: string; tier: string | null;
  createdAt: string; paidAt: string | null;
}
export interface OperationsActivity {
  id: string; userId: string; email: string; name: string | null; region: string;
  type: string; feature: string | null; path: string | null; units: number | null;
  costUsd: number | null; source: 'activity' | 'usage_ledger'; createdAt: string;
}
export interface OperationsPage<T> { rows: T[]; total: number; page: number; pageSize: number }
export interface OperationsPayments extends OperationsPage<OperationsPayment> { currencies: NativeRevenue[]; coverage: PaymentCoverage }

const BASE = '/api/v1/roboapply/v2/admin';
function qs(params: OperationsFilters = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '') query.set(key, String(value));
  return `?${query.toString()}`;
}
export const operationsApi = {
  overview: (params: OperationsFilters) => roboApi.get<OperationsOverview>(`${BASE}/operations${qs(params)}`),
  users: (params: OperationsFilters) => roboApi.get<OperationsPage<OperationsUser>>(`${BASE}/operations/users${qs(params)}`),
  payments: (params: OperationsFilters) => roboApi.get<OperationsPayments>(`${BASE}/payments${qs(params)}`),
  activity: (params: OperationsFilters) => roboApi.get<OperationsPage<OperationsActivity>>(`${BASE}/activity${qs(params)}`),
};
export function operationsCsvUrl(kind: 'payments' | 'activity' | 'operations/users', params: OperationsFilters) {
  return `${API_BASE}${BASE}/${kind}.csv${qs(params)}`;
}
