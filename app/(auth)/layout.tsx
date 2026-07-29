'use client';

// (auth) route-group layout — the V3 authenticated app shell.
//
// Replaces the V2 LeftRail + BottomNav with the V3 nav shell
// (docs/roboapply/v3/00-design-system.md §6):
//
//   .app grid → 248px Sidebar (md+) + scrollable .main with a sticky Topbar.
//   < md → the Sidebar is hidden and a MobileNav bottom bar takes over.
//   A live practice interview is a focused fullscreen mode → no Sidebar/Topbar
//   (the screen owns its own LiveBar + back link).
//
// Theme wiring: none, here. Appearance is a single light/dark bit written to
// <html data-theme> by lib/theme's provider, so the shell needs no data-* of
// its own. The wrapper used to carry data-accent / data-density /
// data-aggressiveness / data-tone plus an imperative `--density` multiplier;
// all four knobs are deleted (OVERHAUL_RULINGS.md R3).
//
// `.dark-canvas` is kept on the wrapper so surviving V2 pages (not yet
// replaced by a V3 screen lane) still pick up the legacy retint rules in
// globals.css. `.v3-root` scopes the V3 scrollbar styling.
//
// The edge proxy (roboapply/proxy.ts) gates these paths; we don't re-check.

import type { ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { Sidebar, Topbar, MobileNav, CommandPaletteProvider } from '../../components/v3/shell';
import { AuthGate } from '../../components/AuthGate';
import { RoboApplyAccessGate } from '../../components/RoboApplyAccessGate';

export default function AuthLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? '';

  // A live practice interview = focused fullscreen (no shell). Setup + report
  // keep the shell so the user can navigate away mid-flow: /practice/[id] but
  // NOT /report and NOT /custom/.
  const isPracticeLive =
    /^\/practice\/[^/]+($|\/$)/.test(pathname) &&
    !pathname.endsWith('/report') &&
    !pathname.includes('/custom/');

  // Fullscreen live interview — no grid, no shell.
  const shell = isPracticeLive ? (
    <div className="dark-canvas v3-root min-h-screen">
      <main className="min-h-screen">{children}</main>
    </div>
  ) : (
    <CommandPaletteProvider>
      <div className="dark-canvas v3-root">
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

  // TWO gates wrap the shell, outermost first:
  //   1. AuthGate — redirects UNauthenticated visitors to /login (?next=… round
  //      trip). The client-side backstop for soft navigations (e.g. the logo
  //      <Link>) and for any request the edge proxy doesn't gate.
  //   2. RoboApplyAccessGate — bounces confirmed RoboHire recruiters to the
  //      /job-seeker bridge (role check); everyone else falls through.
  //
  // ─── WHAT THE THIRD GATE WAS, AND WHY IT IS GONE ────────────────────────
  //
  // `ResumeGate` sat inside RoboApplyAccessGate and, for any authenticated
  // candidate with ZERO résumés, REPLACED THIS ENTIRE SHELL with an upload
  // prompt. Not the page slot — the shell. No Sidebar, no Topbar, no avatar
  // menu, so no settings, no locale switch, no theme toggle and, decisively,
  // NO SIGN-OUT. A user landing on it with a stale session had no way to
  // recover except clearing cookies by hand: exactly the failure commit
  // 212a2e6 exists to prevent, re-introduced one layer higher.
  //
  // It also captured nothing. A user could upload a résumé, satisfy the gate,
  // and arrive at /jobs having told the product not one thing about what work
  // they want — which is the whole reason first-run setup exists.
  //
  // Setup is now a PANEL inside app/(auth)/jobs/page.tsx (ONBOARDING_SPEC §2.1,
  // "ResumeGate as a wall dies"). It gates /jobs only, because /jobs is the one
  // screen that genuinely cannot do its job without a parsed résumé to compare
  // against. /applications, /practice and /resume render normally with none:
  // each already has an empty state that names the next action ("Save or apply
  // to a job and it shows up here", "Start from scratch"), and /practice treats
  // résumé text as optional context it simply omits.
  //
  // There used to be a fifth gate, JobApplyingGate, redirecting /home, /queue,
  // /tracker and /activity when JOB_APPLYING_ENABLED was off. All four routes
  // are gone and so is the flag (ruling C33) — /jobs IS the product, so there
  // is nothing left to gate.
  return (
    <AuthGate>
      <RoboApplyAccessGate>{shell}</RoboApplyAccessGate>
    </AuthGate>
  );
}
