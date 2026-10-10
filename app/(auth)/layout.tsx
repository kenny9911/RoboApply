'use client';

// (auth) route-group layout — the authenticated app shell.
//
// The frame itself (rail, topbar, bottom bar, ⌘K, toasts) is AppShell in
// components/v3/shell/HybridShell.tsx, shared with public pages that signed-in
// users also use (R-23). The nav inside it is the per-brand registry in
// components/v3/shell/destinations.ts (PRODUCT_PLAN.md §3.3).
//
// A live practice interview is a focused fullscreen mode → no rail or topbar
// (the screen owns its own LiveBar + back link): /practice/[id] but NOT
// /report and NOT /custom/.
//
// LAYOUT SLOTS (FND-6a; each renders nothing until its owner fills it):
//   CopilotRail        WP-51   the Assistant rail. Opens only on an explicit
//                              action (useOpenAssistant); this layout never
//                              touches it on navigation.
//   AnnouncementModal  WP-61   "What's new"      — through lib/ui/popupGate.ts
//   InstallPrompt      WP-55a  extension prompt  — through lib/ui/popupGate.ts
//   TourOverlay        WP-30   first-visit tour on /jobs (stage `tour`)
//   ToolResultClaimHost WP-57  keeps a free-tool result run before signup
//                              (sessionStorage; renders nothing). Wave 4 gate.
//   OutOfCreditsSheet  WP-21b  opens on a 402 credits_exhausted reported
//                              through hooks/shared/useCreditGate.ts. Mounted
//                              in the fullscreen practice room too, so an
//                              exhausted bucket there is never a dead end.
//
// The popup gate learns about page views here (one popup per view) and is
// seeded once with the server's last-shown time (24 h between popups).
//
// Gates, outermost first: AuthGate (signed-out visitors → /login?next=…, the
// client backstop for soft navigations the edge proxy never sees), then
// RoboApplyAccessGate (confirmed RoboHire recruiters → the /job-seeker
// bridge). Nothing replaces the shell itself: a user with a stale session
// must always keep the avatar menu (sign out), settings, locale and theme.

import { useEffect, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';

import { AppShell, isPracticeLivePath } from '../../components/v3/shell/HybridShell';
import { AuthGate } from '../../components/AuthGate';
import { RoboApplyAccessGate } from '../../components/RoboApplyAccessGate';
import { CopilotRail } from '../../components/features/copilot/CopilotRail';
import { AnnouncementModal } from '../../components/features/notifications/AnnouncementModal';
import { OutOfCreditsSheet } from '../../components/features/credits';
import { InstallPrompt } from '../../components/features/extension/InstallPrompt';
import { TourOverlay } from '../../components/features/onboarding/TourOverlay';
import { ToolResultClaimHost } from '../../components/features/tools';
import { useAuth } from '../../lib/auth/useAuth';
import { notePageView, usePopupGateSync } from '../../lib/ui/popupGate';

/** Layout slots, rendered once beside the frame. */
function AuthLayoutSlots() {
  const pathname = usePathname() ?? '';
  const { status } = useAuth();

  // One popup per page view: every route change is a new view.
  useEffect(() => {
    notePageView(pathname);
  }, [pathname]);
  // 24 h between popups across devices: seed from RAUserUiState.
  usePopupGateSync(status === 'authenticated');

  return (
    <>
      <CopilotRail />
      <AnnouncementModal />
      <InstallPrompt mode="popup" />
      <TourOverlay />
      <OutOfCreditsSheet />
      <ToolResultClaimHost />
    </>
  );
}

export default function AuthLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? '';
  const fullscreen = isPracticeLivePath(pathname);

  return (
    <AuthGate>
      <RoboApplyAccessGate>
        <AppShell fullscreen={fullscreen} slots={fullscreen ? <OutOfCreditsSheet /> : <AuthLayoutSlots />}>
          {children}
        </AppShell>
      </RoboApplyAccessGate>
    </AuthGate>
  );
}
