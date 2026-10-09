'use client';
import { useQuery } from '@tanstack/react-query';
import { operationsApi, type OperationsFilters } from '../lib/api/adminOperations';

export function useOperationsOverview(params: OperationsFilters, enabled = true) {
  return useQuery({ queryKey: ['admin', 'operations', params], queryFn: () => operationsApi.overview(params), enabled });
}
export function useOperationsUsers(params: OperationsFilters) {
  return useQuery({ queryKey: ['admin', 'operationsUsers', params], queryFn: () => operationsApi.users(params) });
}
export function useOperationsPayments(params: OperationsFilters) {
  return useQuery({ queryKey: ['admin', 'payments', params], queryFn: () => operationsApi.payments(params) });
}
export function useOperationsActivity(params: OperationsFilters) {
  return useQuery({ queryKey: ['admin', 'activity', params], queryFn: () => operationsApi.activity(params) });
}
