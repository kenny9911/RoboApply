'use client';

// AppShell — the one implementation of the authenticated frame, used by
// app/(auth)/layout.tsx and, once a session is known, by HybridShell:
//
//   .app grid → 248px Sidebar (md+) + scrollable .main with a sticky Topbar.
//   < 760px → the Sidebar is hidden and MobileNav takes over.
//   `fullscreen` → no grid, no shell (a live practice interview).
//
// `.dark-canvas` stays on the wrapper so pre-V3 pages still pick up the
// legacy retint rules in globals.css; `.v3-root` scopes the V3 scrollbars.
//
// Its own module, apart from HybridShell: the frame (sidebar, topbar, the
// command palette, the assistant rail, the credits sheet) is most of the
// shell's JavaScript, and a signed-out visitor on a public page never sees
// it. HybridShell loads this module only when there is a session.

import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, type ReactNode } from 'react';

import { CopilotRail } from '../../features/copilot/CopilotRail';
import { OutOfCreditsSheet } from '../../features/credits/OutOfCreditsSheet';
import { Toaster } from '../primitives/Toast';
import { CommandPaletteProvider } from './CommandPalette';
import { MobileNav } from './MobileNav';
import { Sidebar } from './Sidebar';
import { useSessionCleanupRegistration } from './signOutCleanup';
import { Topbar } from './Topbar';

export interface AppShellProps {
  children: ReactNode;
  /** No rail, topbar or bottom bar (focused full-screen mode). */
  fullscreen?: boolean;
  /** Layout slots rendered once beside the frame (rail, modals, tour). */
  slots?: ReactNode;
}

export function AppShell({ children, fullscreen = false, slots }: AppShellProps) {
  const pathname = usePathname() ?? '';
  const t = useTranslations('nav');
  const mainRef = useRef<HTMLElement>(null);

  // While the app shell is up, a session that dies (`auth_expired` in
  // lib/api/client.ts) forgets this device before it is cleared.
  useSessionCleanupRegistration();

  // The workspace scrolls inside main on desktop. Reset that region when the
  // destination changes; same-page setting anchors keep their own position.
  useEffect(() => {
    if (!window.location.hash) mainRef.current?.scrollTo?.(0, 0);
  }, [pathname]);

  if (fullscreen) {
    return (
      <div className="dark-canvas v3-root min-h-screen">
        <main id="main-content" tabIndex={-1} className="min-h-screen">
          {children}
        </main>
        {slots}
      </div>
    );
  }

  return (
    <CommandPaletteProvider>
      <div className="dark-canvas v3-root">
        <a className="workspace-skip" href="#main-content">
          {t('skip_content')}
        </a>
        <div className="app">
          {/* A direct grid child (248px). Hidden below 760px by v3.css. */}
          <Sidebar />
          <main className="main" id="main-content" tabIndex={-1} ref={mainRef}>
            <Topbar />
            <div className="main-inner">{children}</div>
          </main>
        </div>
        {/* Shown below 760px (same breakpoint as the grid collapse). */}
        <MobileNav />
        {slots}
        <Toaster />
      </div>
    </CommandPaletteProvider>
  );
}

/** HybridShell's frame for a signed-in user: the app shell with the assistant rail and the credits sheet. */
export function HybridAppFrame({ children }: { children: ReactNode }) {
  return (
    <AppShell
      slots={
        <>
          <CopilotRail />
          <OutOfCreditsSheet />
        </>
      }
    >
      {children}
    </AppShell>
  );
}
