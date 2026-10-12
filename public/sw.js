/* public/sw.js — web push service worker (RoboApply; ARCHITECTURE.md §8.4; WP-61).
 *
 * Handles ONLY `push` and `notificationclick`. No `fetch` handler and no
 * caching: the app is never served from here, so a deploy can never be stuck
 * behind a stale worker. Registered by hooks/pwa/usePushSubscription.ts only
 * after the person clicks "Get alerts on this device" (never on page load).
 *
 * Payload (server/src/features/push/contract.ts PushPayload):
 *   { title: string, body: string | null, href: string (same-site path), tag: string }
 * The icon is the brand's own mark, from the host-aware manifest route.
 */

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

function sameSitePath(href) {
  if (typeof href !== 'string' || !href.startsWith('/') || href.startsWith('//') || href.indexOf('\\') !== -1) return '/inbox';
  return href;
}

function readPayload(event) {
  if (!event.data) return null;
  try {
    const data = event.data.json();
    if (!data || typeof data.title !== 'string' || !data.title) return null;
    return data;
  } catch (_err) {
    return null;
  }
}

self.addEventListener('push', (event) => {
  const data = readPayload(event);
  // A push that carries nothing we can show still has to show something
  // (browsers penalise silent pushes); point it at the inbox, where the
  // message itself lives.
  const title = data ? data.title : self.registration.scope ? new URL(self.registration.scope).hostname : 'Inbox';
  const options = {
    body: data && typeof data.body === 'string' ? data.body : undefined,
    tag: data && typeof data.tag === 'string' ? data.tag : undefined,
    icon: '/manifest.webmanifest/icon/192',
    badge: '/manifest.webmanifest/icon/192',
    data: { href: sameSitePath(data ? data.href : '/inbox') },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Click: focus a tab that is ALREADY on the alert's page; otherwise open a
// new window. Never navigates some other app tab (it may hold unsaved work,
// e.g. the resume editor), and never relies on WindowClient.navigate(),
// which rejects for a tab this worker does not control (a hard reload).
// If focusing fails, fall back to opening the link.
function samePage(clientUrl, target) {
  try {
    const a = new URL(clientUrl);
    const b = new URL(target);
    return a.origin === b.origin && a.pathname === b.pathname && a.search === b.search;
  } catch (_err) {
    return false;
  }
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const href = sameSitePath(event.notification.data && event.notification.data.href);
  const target = new URL(href, self.location.origin).href;
  const open = () => self.clients.openWindow(target);
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((windows) => {
        const match = windows.find((client) => samePage(client.url, target) && 'focus' in client);
        return match ? match.focus().catch(open) : open();
      })
      .catch(open),
  );
});
