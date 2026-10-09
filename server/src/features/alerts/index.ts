// server/src/features/alerts/index.ts — public surface of alerts + reminders (FND-5; owner WP-39a).
//
// Extension point (TASK_PLAN.md §2.1 rule 3): `registerDeliveryChannel(id,
// impl)` lets WP-61 (web push) and WP-73 (WeChat 公众号) add channels after
// WP-39a's wave. The registry below is real (a map); WP-39a's runner reads
// it through `deliveryChannels()` and keeps this API.

import type { DeliveryChannel, DeliveryChannelId } from './contract.js';

export * from './contract.js';
export { createAlertsRouter } from './routes.js';

const channels = new Map<string, DeliveryChannel>();

/** Register (or replace with the same impl) a delivery channel. A different impl for a taken id throws. */
export function registerDeliveryChannel(id: DeliveryChannelId, impl: DeliveryChannel): void {
  if (impl.id !== id) throw new Error(`alerts: channel id mismatch ("${id}" vs "${impl.id}")`);
  const existing = channels.get(id);
  if (existing && existing !== impl) throw new Error(`alerts: a delivery channel "${id}" is already registered`);
  channels.set(id, impl);
}

/** Registered channels, optionally only those serving a brand. */
export function deliveryChannels(brand?: 'roboapply' | 'goapply'): DeliveryChannel[] {
  const all = [...channels.values()];
  return brand ? all.filter((c) => c.brands.includes(brand)) : all;
}

/** Test seam. */
export function resetDeliveryChannelsForTests(): void {
  channels.clear();
}
