// __tests__/fixtures/notifications — message center (fictional data).
import type * as N from '../../../lib/api/contracts/notifications';
import type { RequestFixture } from '../types';

export const notificationsResponse = {
  items: [
    {
      id: 'n_fixture_1',
      category: 'reminder',
      templateKey: 'tracker.followUp',
      params: { company: 'Example Labs' },
      title: null,
      body: null,
      href: '/applications',
      readAt: null,
      createdAt: '2026-10-09T00:00:00.000Z',
    },
  ],
  cursor: null,
} satisfies N.NotificationsResponse;

export const notificationsRequests: RequestFixture[] = [
  { contract: 'notifications', schema: 'ListNotificationsQuerySchema', value: { limit: '20' } },
  { contract: 'notifications', schema: 'ListNotificationsQuerySchema', value: { limit: '500' }, valid: false },
];
