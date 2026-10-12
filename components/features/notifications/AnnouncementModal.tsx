'use client';

// AnnouncementModal — WP-61's slot in the authenticated shell (FND-6a layout
// slot, mounted once by app/(auth)/layout.tsx). It renders WP-61's two
// unprompted popups; each asks lib/ui/popupGate.ts for the page view's one
// slot (24 h between non-essential popups), so at most one of them shows:
//   WhatsNew          "What's new": one server-driven announcement at most,
//                     `requestPopup('announcement:<id>', 'announcement')`,
//                     shown once and then marked seen (F-NOTIF-09).
//   PwaInstallPrompt  "Add <brand> to your home screen", once per device and
//                     account, from the second session on (F-MOB-03).
// The implementations live in the PWA area (components/features/pwa).

import { PwaInstallPrompt, WhatsNew } from '../pwa';

export type AnnouncementModalProps = Record<string, never>;

export function AnnouncementModal(_props: AnnouncementModalProps = {}) {
  return (
    <>
      <WhatsNew />
      <PwaInstallPrompt />
    </>
  );
}

export default AnnouncementModal;
