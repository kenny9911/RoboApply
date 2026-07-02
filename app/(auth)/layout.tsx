'use client';

// (auth) route-group layout — the V3 authenticated app shell.
//
// Replaces the V2 LeftRail + BottomNav with the V3 nav shell
// (docs/roboapply/v3/00-design-system.md §6):
//
//   .app grid → 248px Sidebar (md+) + scrollable .main with a sticky Topbar.
//   < md → the Sidebar is hidden and a MobileNav bottom bar takes over.
//   The live mock-interview session is a focused fullscreen mode → no
//   Sidebar/Topbar (the screen owns its own LiveBar + back link).
//
// Theme wiring: the dcTheme accent/density/aggressiveness/tone are written as
// data-* on the wrapper so the CSS accent swap ([data-accent]) and density
// multiplier resolve. `--density` is set imperatively from the density key
// (0.7 / 1 / 1.2) — CSS can't map an enum to a number.
//
// `.dark-canvas` is kept on the wrapper so surviving V2 pages (not yet
// replaced by a V3 screen lane) still pick up the legacy retint rules in
// globals.css. `.v3-root` scopes the V3 scrollbar styling.
//
// The edge proxy (roboapply/proxy.ts) gates these paths; we don't re-check.

import type { ReactNode } from 'react';
import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { Sidebar, Topbar, MobileNav, CommandPaletteProvider } from '../../components/v3/shell';
import { useDcTheme, densityMultiplier } from '../../lib/dcTheme';
import { AuthGate } from '../../components/AuthGate';
import { RoboApplyAccessGate } from '../../components/RoboApplyAccessGate';
import { ResumeGate } from '../../components/ResumeGate';
import { JobApplyingGate } from '../../components/JobApplyingGate';

export default function AuthLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? '';
  const theme = useDcTheme();

  // Live mock-interview session = focused fullscreen (no shell). Setup +
  // report keep the shell so the user can navigate away mid-flow. Mirrors the
  // V2 detection: /mock-interview/[id] but NOT /report and NOT /custom/.
  const isMockInterviewLive =
    /^\/mock-interview\/[^/]+($|\/$)/.test(pathname) &&
    !pathname.endsWith('/report') &&
    !pathname.includes('/custom/');

  // Map the density enum → the --density multiplier on the wrapper.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.style.setProperty(
      '--density',
      String(densityMultiplier(theme.density)),
    );
  }, [theme.density]);

  const wrapperProps = {
    'data-accent': theme.accent,
    'data-density': theme.density,
    'data-aggressiveness': theme.aggressiveness,
    'data-tone': theme.tone,
  } as const;

  // Fullscreen live interview — no grid, no shell.
  const shell = isMockInterviewLive ? (
    <div {...wrapperProps} className="dark-canvas v3-root min-h-screen">
      <main className="min-h-screen">{children}</main>
    </div>
  ) : (
    <CommandPaletteProvider>
      <div {...wrapperProps} className="dark-canvas v3-root">
        <div className="app">
          {/* Sidebar — a direct grid child (248px). Hidden below 760px by
           *  v3.css (`.app > .side`), where MobileNav takes over. */}
          <Sidebar />

          {/* Main column: sticky Topbar + scrollable content. */}
          <main className="main">
            <Topbar />
            <div className="main-inner">{children}</div>
          </main>
        </div>

        {/* Mobile bottom bar — shown below 760px (same breakpoint as the grid
         *  collapse), hidden otherwise. */}
        <MobileNav />
      </div>
    </CommandPaletteProvider>
  );

  // Four gates wrap the shell, outermost first:
  //   1. AuthGate — redirects UNauthenticated visitors to /login (?next=… round
  //      trip). The client-side backstop for soft navigations (e.g. the logo
  //      <Link>) and for any request the edge proxy doesn't gate; without it a
  //      logged-out user lands on a protected route and JobApplyingGate hangs
  //      on an infinite spinner (blank page).
  //   2. RoboApplyAccessGate — bounces confirmed RoboHire recruiters to the
  //      /job-seeker bridge (role check); everyone else falls through.
  //   3. JobApplyingGate — when JOB_APPLYING_ENABLED is off, redirects the
  //      hidden auto-apply routes (/home, /queue, /tracker, /activity) to the
  //      Mock Interview home so direct links can't reach a hidden screen.
  //   4. ResumeGate — for authenticated candidates with ZERO résumés, blocks
  //      every authed page (except /resumes + live mock-interview) with an
  //      upload prompt, so the rest of the app always has a résumé to work on.
  return (
    <AuthGate>
      <RoboApplyAccessGate>
        <JobApplyingGate>
          <ResumeGate>{shell}</ResumeGate>
        </JobApplyingGate>
      </RoboApplyAccessGate>
    </AuthGate>
  );
}
