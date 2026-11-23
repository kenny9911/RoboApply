// __tests__/fixtures/notifications — message center (fictional data).
import type { RequestFixture } from '../types';

export const notificationsRequests: RequestFixture[] = [
  { contract: 'notifications', schema: 'ListNotificationsQuerySchema', value: { limit: '20' } },
  { contract: 'notifications', schema: 'ListNotificationsQuerySchema', value: { limit: '500' }, valid: false },
];
