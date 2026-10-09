// server/src/features/notifications/index.ts — public surface of the message center (FND-5; owner WP-39b).
// `unreadCount` feeds `/auth/me.unreadCount` (WP-10); producers write
// SeekerNotification rows directly or through WP-39a's delivery.

import { NotImplementedError } from '../../platform/http.js';

export * from './contract.js';
export { createEmailPublicRouter, createNotificationsRouter } from './routes.js';
export { NOTIFICATIONS_WORK_KINDS } from './workers.js';

export interface NotificationCenterService {
  unreadCount(userId: string): Promise<number>;
}

export const notificationCenterService: NotificationCenterService = {
  async unreadCount() {
    throw new NotImplementedError('notifications.unreadCount');
  },
};
