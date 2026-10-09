'use client';

// AnnouncementModal — server-driven "What's new" (ARCHITECTURE.md §8.5),
// mounted once by the app shell (FND-6a layout slot).
//
// STUB (FND-6a). Owner: WP-61. Renders nothing. When filled it must ask
// `requestPopup('announcement:<id>', 'announcement')` (lib/ui/popupGate.ts)
// before showing: one popup per page view, 24 h between non-essential popups.

export type AnnouncementModalProps = Record<string, never>;

export function AnnouncementModal(_props: AnnouncementModalProps = {}): null {
  return null;
}

export default AnnouncementModal;
