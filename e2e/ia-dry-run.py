#!/usr/bin/env python3
"""RoboApply — information-architecture dry run.

Walks the product that exists after the 2026 overhaul (docs/roboapply/
OVERHAUL_RULINGS.md) via REAL UI interaction — page.goto / click / fill, never
ctx.request.* API calls — and checks the things the rulings actually decided:

  A  Shell + IA          four destinations, exact labels, exact order
  B  Mobile parity       the bottom bar IS the IA; account plumbing reachable
  C  Old links           every deleted route 308s to its successor
  D  /jobs               tier word leads, the score never stands alone
  E  /resume             library → editor
  F  /applications       stage columns under the C1 ladder
  G  /practice           setup, and the free first interview
  H  /settings           one page, seven sections, billing reachable
  I  Vocabulary          the banned words are absent from rendered DOM
  J  Theme               light default, dark toggle, no accent/density knobs
  K  i18n                zh renders Chinese nav, not literal dotted paths
  L  Console             no React/runtime errors anywhere in the walk

REPLACES e2e/v3-uc-dry-run.py (1,669 lines, 22 "UC-V3-NN" flows). That file
tested a product that no longer exists: /home, /queue, /tracker, /preferences,
the Tweaks panel, `data-accent`, `data-density`, the aggressiveness mood card,
the integrations screen, and the onboarding interstitial are all deleted. Its
infrastructure was sound and is carried over verbatim — the console-error trap,
`safe_goto` retry, the screenshot helper, the PASS/FAIL `assert_` and summary,
and the per-iteration cookie re-plant. Only the walk is new, and it is
organized by destination rather than by use-case number, because the IA is now
the thing under test.

Auth: proxy.ts only checks that the session cookie is PRESENT, never validating
it in stub mode. So we plant a dummy `session_token` + seed
`localStorage.auth_token` the same way — no real /api/auth/login.

Pre-req: the dev server is up on :3611 in stub mode
(`NEXT_PUBLIC_USE_STUB_API=true` in .env.local). No backend required.

Run from the repo root:
  python3 e2e/ia-dry-run.py

Captures screenshots per group to /tmp/ra-ia-shots/<group>-<name>.png and a
structured PASS/FAIL summary to stdout. Exit 0 if every group is green, 1
otherwise.
"""

import re
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright, Page, BrowserContext

APP = "http://localhost:3611"
SHOTS = Path("/tmp/ra-ia-shots")
SHOTS.mkdir(exist_ok=True)

# ── The IA under test ────────────────────────────────────────────────────────
#
# Route, nav label and i18n namespace share a name by construction (ruling
# D2/D3). This tuple is the assertion: if the app disagrees with it in label,
# order or count, the IA has drifted and the run is red. Keep it in sync with
# DESTINATIONS in components/v3/shell/Sidebar.tsx — deliberately duplicated
# here rather than imported, because a test that reads its expectation out of
# the code under test cannot fail.
DESTINATIONS = [
    ("/jobs", "Jobs"),
    ("/resume", "Resume"),
    ("/applications", "Applications"),
    ("/practice", "Interview prep"),
]

# Behind the avatar menu, at every width. Not destinations (ruling D2).
AVATAR_ITEMS = ["Settings", "Billing", "Sign out"]

# Old route → where next.config.mjs redirects() sends it. Every one of these
# was a real URL of this app; the landing page, old emails, the sitemap and
# nine locale bundles still point at some of them, so a 404 here is a dead
# first click after signup.
REDIRECTS = [
    ("/home", "/jobs"),
    ("/tracker", "/applications"),
    ("/resumes", "/resume"),
    ("/mock-interview", "/practice"),
    ("/queue", "/jobs"),
    ("/activity", "/applications"),
    ("/insights", "/applications"),
    ("/search", "/jobs"),
    ("/preferences", "/settings"),
    ("/plans", "/settings"),
    ("/account", "/settings"),
    ("/choose-plan", "/jobs"),
    ("/onboarding", "/jobs"),
]

# Words the product is not allowed to say to a user, and why. This is the DOM
# half of `node scripts/check-copy.mjs`: that gate reads the locale bundles,
# this one reads what actually rendered, so a hardcoded literal in a component
# is caught too. Terms only — the reasons live in scripts/check-copy.mjs.
BANNED_IN_DOM = [
    "auto-apply", "auto-applied", "autopilot", "review queue",
    "threshold", "long shot", "stretch role", "strong match",
    "ats-safe", "ats-friendly", "parser", "applicant tracking",
    "recruiter screen", "onsite", "trajectory", "dimension",
    "kanban", "funnel", "pipeline", "mission control", "aggressiveness",
    "on your behalf", "on my end", "while you slept",
]


# ----- assertion + console-error infrastructure (carried verbatim) -----

results: list = []
bugs_filed: list = []


def shot(page: Page, name: str) -> None:
    try:
        page.screenshot(path=str(SHOTS / f"{name}.png"), full_page=True)
    except Exception as e:
        print(f"   (screenshot failed for {name}: {e})")


def safe_goto(page: Page, url: str, *, retries: int = 3, wait_until: str = "domcontentloaded") -> bool:
    """Navigate with retry — Next.js dev server occasionally drops a connection."""
    last_err = None
    for attempt in range(retries):
        try:
            page.goto(url, wait_until=wait_until, timeout=30_000)
            return True
        except Exception as e:
            last_err = e
            print(f"   (goto attempt {attempt + 1}/{retries} failed: {type(e).__name__}; retrying)")
            time.sleep(2.0)
    print(f"   (all goto retries exhausted: {last_err})")
    return False


def capture_console(page: Page) -> list:
    msgs: list = []
    page.on("console", lambda m: msgs.append({"type": m.type, "text": m.text}))
    page.on("pageerror", lambda e: msgs.append({"type": "pageerror", "text": str(e)}))
    return msgs


def real_errs(msgs) -> list:
    """Filter console messages down to genuine React/runtime errors. Benign dev
    noise (favicon, resource 404s, hydration warnings) is tolerated."""
    out = []
    for m in msgs:
        if m["type"] not in ("error", "pageerror"):
            continue
        text = m["text"]
        if any(skip in text for skip in (
            "Failed to load resource",  # logo / next dev quirks
            "favicon",
            "manifest",
            "Hydration failed",  # tolerated for stub-mode SSR mismatch
            "hydrat",            # next dev hydration warning variants
            "preconnect",
            "Download the React DevTools",
            "[Fast Refresh]",
        )):
            continue
        if any(k in text for k in (
            "MISSING_MESSAGE",
            "IntlError",
            "Could not resolve",
            "is not a valid React child",
            "TypeError",
            "Uncaught",
            "ReferenceError",
            "Cannot read",
            "Maximum update depth",
            "Objects are not valid",
            "Each child in a list",
            "Warning: Encountered two children",
        )):
            out.append(m)
    return out


def assert_(condition: bool, msg: str, group: str) -> None:
    status = "PASS" if condition else "FAIL"
    results.append({"uc": group, "check": msg, "status": status})
    print(f"   [{status}] {msg}")


def file_bug(bug_id: str, title: str, severity: str, group: str, repro: str, layer: str = "F") -> None:
    bugs_filed.append({
        "id": bug_id, "title": title, "severity": severity,
        "uc": group, "repro": repro, "layer": layer,
    })
    print(f"   [BUG] {bug_id} ({severity}) — {title}")


def header(label: str, subtitle: str = "") -> None:
    print(f"\n{label}")
    if subtitle:
        print(f"   ({subtitle})")


# ----- session bootstrap (stub mode — presence-only cookie) ------------
#
# Stub mode ignores the token value entirely; proxy.ts only checks the cookie
# exists. So plant a fixed dummy value, never a real login. The localStorage
# seed mirrors the cookie (roboApi never reads it in stub mode — harmless noise
# that keeps the real-backend swap path honest).

STUB_TOKEN = "stub-ia"


def set_session_cookie(ctx: BrowserContext) -> None:
    ctx.add_cookies([{
        "name": "session_token",
        "value": STUB_TOKEN,
        "domain": "localhost",
        "path": "/",
        "httpOnly": False,
        "secure": False,
        "sameSite": "Lax",
    }])


def set_locale_cookie(ctx: BrowserContext, locale: str) -> None:
    """Plant the next-intl locale cookie (read server-side in app/layout.tsx
    via cookies().get('robo_locale')). Used by group K."""
    ctx.add_cookies([{
        "name": "robo_locale",
        "value": locale,
        "domain": "localhost",
        "path": "/",
        "httpOnly": False,
        "secure": False,
        "sameSite": "Lax",
    }])


def clear_locale_cookie(ctx: BrowserContext) -> None:
    # Re-plant en so a stray zh from a prior partial run can't leak.
    set_locale_cookie(ctx, "en")


def seed_local_storage(page: Page) -> None:
    page.add_init_script(
        f"try {{ window.localStorage.setItem('auth_token', '{STUB_TOKEN}'); }} catch (e) {{}}"
    )


def grant_media(ctx: BrowserContext) -> None:
    """A live practice interview calls getUserMedia (webcam). Grant camera/mic
    so the permission prompt never blocks; headless Chromium has no real device
    but the component handles the unavailable/denied states gracefully."""
    try:
        ctx.grant_permissions(["camera", "microphone"], origin=APP)
    except Exception as e:
        print(f"   (grant_permissions skipped: {type(e).__name__})")


# Common selectors -----------------------------------------------------

NAV_ITEM = "aside.side a.nav-item"
MOBILE_NAV_ITEM = "nav.v3-mobile-nav a"
AVATAR = "button.avatar"


def wait_shell(page: Page) -> None:
    """Wait for the (auth) shell to mount (sidebar + topbar)."""
    page.wait_for_selector("aside.side", timeout=20_000)


def preflight(page: Page) -> bool:
    """Confirm the app is up AND authenticated before walking ten groups.

    Without this the whole run is ten identical 20-second `aside.side` timeouts
    and one 3-minute wall of red that says nothing about the actual cause. The
    cause is almost always the same: the dev server is not in stub mode, so the
    planted cookie clears proxy.ts (which only checks the cookie is PRESENT)
    but AuthGate's real /auth/me 401s and bounces every route to /login.
    """
    if not safe_goto(page, f"{APP}/jobs"):
        print(f"\n   PREFLIGHT FAILED — {APP} is not answering.")
        print("   Start the dev server first:  npm run dev:web")
        return False
    try:
        page.wait_for_selector("aside.side", timeout=20_000)
        return True
    except Exception:
        pass
    if "/login" in page.url:
        print("\n   PREFLIGHT FAILED — /jobs bounced to /login.")
        print("   The planted cookie clears proxy.ts (presence-only), but AuthGate")
        print("   calls the real /auth/me and it 401s. Run the dev server in stub")
        print("   mode:  NEXT_PUBLIC_USE_STUB_API=true in .env.local, then restart.")
    else:
        print(f"\n   PREFLIGHT FAILED — the shell never mounted (url={page.url}).")
    shot(page, "preflight-FAILED")
    return False


def visible_text(page: Page) -> str:
    """Everything the user can actually read on this screen, lowercased."""
    try:
        return (page.locator("body").inner_text() or "").lower()
    except Exception:
        return ""


def check_banned(page: Page, where: str, group: str) -> None:
    """Assert none of the banned terms rendered. Reported as one check per
    screen rather than one per term, so a clean screen is one green line."""
    text = visible_text(page)
    hits = [w for w in BANNED_IN_DOM if w in text]
    assert_(not hits, f"{where}: no banned vocabulary in the DOM ({', '.join(hits) or 'clean'})", group)


# ============================================================================
# A — Shell + IA: four destinations, exact labels, exact order
# ============================================================================

def group_a(page: Page) -> None:
    header("A — Shell + IA (four destinations)")
    msgs = capture_console(page)

    if not safe_goto(page, f"{APP}/jobs"):
        assert_(False, "GET /jobs loads", "A")
        return
    wait_shell(page)
    shot(page, "a-shell")

    items = page.locator(NAV_ITEM)
    # The four, plus /admin only for an admin session (the stub user is not).
    labels = [items.nth(i).inner_text().strip().split("\n")[0] for i in range(items.count())]
    assert_(labels == [lbl for _, lbl in DESTINATIONS],
            f"Rail is exactly the four destinations, in order (got {labels})", "A")

    # Deleted rail entries must not have crept back as extra items.
    for gone in ("Today", "Review queue", "Pipeline", "Activity", "Preferences", "Plans", "Account"):
        assert_(gone not in labels, f"Deleted rail entry '{gone}' is absent", "A")

    # aria-current is how a screen reader knows where it is; without it the
    # rail is four identical links.
    for href, label in DESTINATIONS:
        if not safe_goto(page, f"{APP}{href}"):
            assert_(False, f"GET {href} loads", "A")
            continue
        wait_shell(page)
        active = page.locator(f'{NAV_ITEM}[href="{href}"][aria-current="page"]').count() == 1
        assert_(active, f"Nav '{label}' marks itself current on {href}", "A")

    # The avatar menu holds everything that is not a destination.
    safe_goto(page, f"{APP}/jobs")
    wait_shell(page)
    assert_(page.locator(AVATAR).count() == 1, "Topbar renders one avatar trigger", "A")
    page.locator(AVATAR).first.click()
    menu = page.locator('[role="menu"]')
    assert_(menu.count() == 1, "Avatar trigger opens a menu", "A")
    if menu.count() == 1:
        menu_text = menu.inner_text()
        for item in AVATAR_ITEMS:
            assert_(item in menu_text, f"Avatar menu holds '{item}'", "A")
        # Escape must return focus to the trigger — losing it to <body> strands
        # a keyboard user at the top of the document.
        page.keyboard.press("Escape")
        focused_is_trigger = page.evaluate(
            "() => document.activeElement?.classList?.contains('avatar') === true"
        )
        assert_(focused_is_trigger, "Escape closes the menu and restores focus to the trigger", "A")

    check_banned(page, "/jobs", "A")
    errs = real_errs(msgs)
    assert_(len(errs) == 0, f"zero real console errors (got {len(errs)})", "A")


# ============================================================================
# B — Mobile parity: the bottom bar IS the IA
# ============================================================================

def group_b(page: Page) -> None:
    header("B — Mobile parity (375px)",
           "before this, a phone user could not reach billing at all")
    msgs = capture_console(page)

    page.set_viewport_size({"width": 375, "height": 812})
    if not safe_goto(page, f"{APP}/jobs"):
        assert_(False, "GET /jobs loads at 375px", "B")
        return
    page.wait_for_selector("nav.v3-mobile-nav", timeout=20_000)
    shot(page, "b-mobile-jobs")

    # styles/v3.css hides the rail below 760px.
    rail_shown = page.evaluate(
        "() => { const el = document.querySelector('aside.side');"
        " return el ? getComputedStyle(el).display !== 'none' : false; }"
    )
    assert_(not rail_shown, "The 248px rail is hidden below 760px", "B")

    tabs = page.locator(MOBILE_NAV_ITEM)
    mobile_labels = [tabs.nth(i).inner_text().strip() for i in range(tabs.count())]
    assert_(mobile_labels == [lbl for _, lbl in DESTINATIONS],
            f"Bottom bar is the same four, same order (got {mobile_labels})", "B")

    # 44px is the floor for a tap target, and the bottom row of a phone screen
    # is the one place a 4px miss costs a wrong destination.
    small = []
    for i in range(tabs.count()):
        box = tabs.nth(i).bounding_box()
        if box and (box["height"] < 44 or box["width"] < 44):
            small.append(f"{mobile_labels[i]}={int(box['width'])}x{int(box['height'])}")
    assert_(not small, f"Every tab clears 44x44 ({', '.join(small) or 'all pass'})", "B")

    # The parity claim: account plumbing is reachable on a phone.
    assert_(page.locator(AVATAR).count() == 1, "Avatar trigger renders at 375px", "B")
    page.locator(AVATAR).first.click()
    menu = page.locator('[role="menu"]')
    assert_(menu.count() == 1, "Avatar menu opens at 375px", "B")
    if menu.count() == 1:
        menu.get_by_text("Billing", exact=True).click()
        page.wait_for_url(re.compile(r"/settings"), timeout=20_000)
        assert_("/settings" in page.url, f"Billing is reachable on a phone (url={page.url})", "B")
        shot(page, "b-mobile-settings")

    check_banned(page, "/settings at 375px", "B")
    errs = real_errs(msgs)
    assert_(len(errs) == 0, f"zero real console errors (got {len(errs)})", "B")
    page.set_viewport_size({"width": 1440, "height": 900})


# ============================================================================
# C — Old links: every deleted route lands somewhere real
# ============================================================================

def group_c(page: Page) -> None:
    header("C — Old links (308s)", "a 404 on the first click after signup is not recoverable")
    msgs = capture_console(page)

    for src, dest in REDIRECTS:
        if not safe_goto(page, f"{APP}{src}"):
            assert_(False, f"{src} loads", "C")
            continue
        landed = page.url.replace(APP, "").split("?")[0].rstrip("/") or "/"
        assert_(landed == dest, f"{src} → {dest} (got {landed})", "C")

    errs = real_errs(msgs)
    assert_(len(errs) == 0, f"zero real console errors (got {len(errs)})", "C")


# ============================================================================
# D — /jobs: the tier word leads, the score never stands alone
# ============================================================================

def group_d(page: Page) -> None:
    header("D — /jobs", "ruling C5: a naked 0-100 has exactly one folk meaning")
    msgs = capture_console(page)

    if not safe_goto(page, f"{APP}/jobs"):
        assert_(False, "GET /jobs loads", "D")
        return
    wait_shell(page)
    page.wait_for_selector(".match", timeout=20_000)
    shot(page, "d-jobs")

    cards = page.locator(".match")
    assert_(cards.count() >= 1, f"At least one job card renders (got {cards.count()})", "D")

    # The header states two things and both are measured (rule D9).
    h1 = page.locator("h1").first.inner_text().strip()
    assert_(re.match(r"^(\d+ jobs? that fits? you\.|No jobs fit you yet\.|Jobs that fit you\.)$", h1),
            f"H1 is the measured count, never a guess (got {h1!r})", "D")

    text = visible_text(page)

    # ONE quality ladder, four rungs (C2). At least one rung must be on screen,
    # and no fifth word may be.
    ladder = ["great fit", "good fit", "possible", "unlikely"]
    assert_(any(w in text for w in ladder), "A fit tier word is on the card", "D")
    for stray in ("strong match", "long shot", "stretch role", "moderate fit"):
        assert_(stray not in text, f"No fifth quality word: '{stray}' absent", "D")

    # Expand a card: the reasoning speaks about the evidence, with no speaker.
    cards.first.click()
    page.wait_for_selector(".match-expanded", timeout=20_000)
    expanded = page.locator(".match-expanded").first
    body = expanded.inner_text()
    assert_("Why you fit" in body, "Expanded card labels the reasoning 'Why you fit'", "D")
    assert_("Why I think" not in body, "No first-person speaker in the reasoning (C9)", "D")
    # The face-shaped hole: the orb is gone and so is its empty slot.
    assert_(page.locator(".ai-avatar").count() == 0, "No leftover agent avatar slot (D4)", "D")

    # The permanent, non-dismissible line under the meter (C5). Required
    # string, not FAQ.
    assert_("this is not your chance of getting hired" in visible_text(page),
            "The score disclaimer is present", "D")

    # The primary action is honest about what it does (R1), and the dismiss
    # action names the outcome rather than saying "Pass" (C7).
    assert_(page.get_by_role("button", name=re.compile("Apply on company site", re.I)).count() >= 1,
            "Primary action is 'Apply on company site'", "D")
    assert_(page.get_by_role("button", name=re.compile("^Not interested$", re.I)).count() >= 1,
            "Dismiss action is 'Not interested'", "D")
    assert_(page.get_by_role("button", name=re.compile(r"^Pass$", re.I)).count() == 0,
            "'Pass' is absent — it means SUCCEED in job-search context", "D")

    check_banned(page, "/jobs expanded", "D")
    errs = real_errs(msgs)
    assert_(len(errs) == 0, f"zero real console errors (got {len(errs)})", "D")


# ============================================================================
# E — /resume: library → editor
# ============================================================================

def group_e(page: Page) -> None:
    header("E — /resume")
    msgs = capture_console(page)

    if not safe_goto(page, f"{APP}/resume"):
        assert_(False, "GET /resume loads", "E")
        return
    wait_shell(page)
    page.wait_for_selector(".rb-card, .rb-create", timeout=20_000)
    shot(page, "e-resume-library")

    cards = page.locator(".rb-card")
    assert_(cards.count() >= 1, f"Resume library renders cards (got {cards.count()})", "E")

    # Opening one lands on /resume/[id] — the rename carries the deep link.
    cards.first.click()
    try:
        page.wait_for_url(re.compile(r"/resume/[^/]+$"), timeout=20_000)
        assert_(True, f"A library card opens /resume/[id] (url={page.url})", "E")
        shot(page, "e-resume-editor")
    except Exception:
        assert_(False, f"A library card opens /resume/[id] (url={page.url})", "E")

    # Export vocabulary: no ATS, no parser (C8).
    check_banned(page, "/resume editor", "E")
    errs = real_errs(msgs)
    assert_(len(errs) == 0, f"zero real console errors (got {len(errs)})", "E")


# ============================================================================
# F — /applications: stage columns under the C1 ladder
# ============================================================================

def group_f(page: Page) -> None:
    header("F — /applications", "ruling C1: Saved · Applied · First call · Interviewing · …")
    msgs = capture_console(page)

    if not safe_goto(page, f"{APP}/applications"):
        assert_(False, "GET /applications loads", "F")
        return
    wait_shell(page)
    page.wait_for_selector(".pipe-col", timeout=20_000)
    shot(page, "f-applications")

    names = [n.inner_text().strip() for n in page.locator(".pipe-head .name").all()]
    # Only four of the seven rungs render today — RATrackerStatus has no
    # first_call / final_round member yet (see components/v3/pipeline/
    # columns.ts). Assert the four that DO render are the C1 words, and that
    # the pre-ruling labels are gone.
    assert_(names == ["Saved", "Applied", "Interviewing", "Offer"],
            f"Columns are the C1 words (got {names})", "F")
    for stray in ("Interview", "Recruiter screen", "Hiring manager", "Onsite", "Closed"):
        assert_(stray not in names, f"Retired column label '{stray}' is absent", "F")

    assert_(page.locator(".pipe-card").count() >= 1,
            f"Cards land from the tracker (got {page.locator('.pipe-card').count()})", "F")

    # The H1 is the question this destination answers.
    h1 = page.locator("h1").first.inner_text().strip()
    assert_("Where did you apply" in h1, f"H1 is the user's question (got {h1!r})", "F")

    check_banned(page, "/applications", "F")
    errs = real_errs(msgs)
    assert_(len(errs) == 0, f"zero real console errors (got {len(errs)})", "F")


# ============================================================================
# G — /practice: the differentiator, and the free first taste
# ============================================================================

def group_g(page: Page) -> None:
    header("G — /practice", "nav label is 'Interview prep' (C14); route stays /practice")
    msgs = capture_console(page)

    if not safe_goto(page, f"{APP}/practice"):
        assert_(False, "GET /practice loads", "G")
        return
    wait_shell(page)
    shot(page, "g-practice")

    # The rail label is the noun; the route is the verb. C14 is explicit that
    # a bare verb among three nouns reads as an instruction on a tab bar.
    rail_label = page.locator(f'{NAV_ITEM}[href="/practice"]').first.inner_text().strip()
    assert_(rail_label.startswith("Interview prep"),
            f"Rail says 'Interview prep' (got {rail_label!r})", "G")

    # The setup screen must offer a way to start, not just describe itself.
    start = page.get_by_role("button", name=re.compile("start|practice", re.I))
    assert_(start.count() >= 1, f"A start control is present (got {start.count()})", "G")

    check_banned(page, "/practice", "G")
    errs = real_errs(msgs)
    assert_(len(errs) == 0, f"zero real console errors (got {len(errs)})", "G")


# ============================================================================
# H — /settings: ONE page, seven sections
# ============================================================================

def group_h(page: Page) -> None:
    header("H — /settings", "one page with sections; it is not a destination")
    msgs = capture_console(page)

    if not safe_goto(page, f"{APP}/settings"):
        assert_(False, "GET /settings loads", "H")
        return
    wait_shell(page)
    page.wait_for_selector(".pref-nav-item", timeout=20_000)
    shot(page, "h-settings")

    sections = [s.inner_text().strip() for s in page.locator(".pref-nav-item").all()]
    expected = ["Your search", "Resume", "Notifications", "Appearance",
                "Plan and billing", "Account", "Danger zone"]
    assert_(sections == expected, f"Seven sections, in order (got {sections})", "H")

    # C21: setup has ONE name in ONE place, and it is the same sentence the
    # /jobs filter bar uses.
    text = visible_text(page)
    assert_("you're looking for" in text, "Setup is named 'Tell us what you're looking for'", "H")
    for stray in ("tune my matches", "redo setup chat"):
        assert_(stray not in text, f"Competing setup name '{stray}' is absent", "H")

    # /settings is NOT in the rail — it lives behind the avatar (D2).
    rail_hrefs = [a.get_attribute("href") for a in page.locator(NAV_ITEM).all()]
    assert_("/settings" not in rail_hrefs, "Settings is not a rail destination", "H")

    check_banned(page, "/settings", "H")
    errs = real_errs(msgs)
    assert_(len(errs) == 0, f"zero real console errors (got {len(errs)})", "H")


# ============================================================================
# J — Theme: light default, dark first-class, nothing else themeable
# ============================================================================

def group_j(page: Page) -> None:
    header("J — Theme", "ruling R3: warm theme and the accent picker are deleted")
    msgs = capture_console(page)

    if not safe_goto(page, f"{APP}/jobs"):
        assert_(False, "GET /jobs loads", "J")
        return
    wait_shell(page)

    # Light is the default (R3). A fresh context has no stored preference.
    theme = page.evaluate("() => document.documentElement.getAttribute('data-theme')")
    assert_(theme in (None, "light"), f"Light is the default theme (data-theme={theme!r})", "J")

    # The deleted knobs must leave no attribute behind — they were read by CSS,
    # so a stale attribute silently re-tints the app.
    for attr in ("data-accent", "data-density", "data-tone"):
        present = page.evaluate(f"() => document.documentElement.hasAttribute('{attr}')")
        assert_(not present, f"Deleted knob attribute '{attr}' is absent", "J")

    # Dark is first-class, not an afterthought: the toggle must actually flip.
    toggle = page.get_by_role("button", name=re.compile("switch to dark", re.I))
    if toggle.count() >= 1:
        toggle.first.click()
        page.wait_for_timeout(300)
        after = page.evaluate("() => document.documentElement.getAttribute('data-theme')")
        assert_(after == "dark", f"The theme toggle reaches dark (got {after!r})", "J")
        shot(page, "j-dark")
    else:
        assert_(False, "A theme toggle is present in the topbar", "J")

    errs = real_errs(msgs)
    assert_(len(errs) == 0, f"zero real console errors (got {len(errs)})", "J")


# ============================================================================
# K — i18n: a renamed namespace with a stale call site ships a dotted path
# ============================================================================

def group_k(page: Page, ctx: BrowserContext) -> None:
    header("K — i18n (zh)",
           "next-intl renders the literal key on a miss; it never throws (C30)")
    msgs = capture_console(page)

    set_locale_cookie(ctx, "zh")
    if not safe_goto(page, f"{APP}/jobs"):
        assert_(False, "GET /jobs loads under zh", "K")
        return
    wait_shell(page)
    shot(page, "k-zh-jobs")

    text = visible_text(page)
    # A literal dotted path is what a renamed namespace ships in nine languages
    # when a call site is left behind. It is invisible to `next build` and to
    # vitest, so this is the only place it gets caught in a running app.
    leaked = re.findall(r"\b(?:jobs|resume|applications|practice|settings|nav|common|errors)\.[a-z][\w.]*\b", text)
    assert_(not leaked, f"No untranslated dotted key rendered ({leaked[:5]})", "K")

    # The nav genuinely swapped language rather than falling through to the
    # English deep-merge base.
    rail = " ".join(a.inner_text() for a in page.locator(NAV_ITEM).all())
    has_cjk = bool(re.search(r"[一-鿿]", rail))
    assert_(has_cjk, f"Nav renders Chinese under zh (rail={rail!r})", "K")

    errs = real_errs(msgs)
    assert_(len(errs) == 0, f"zero real console errors (got {len(errs)})", "K")


# ============================================================================
# L — Console-error trap (aggregate across the whole walk)
# ============================================================================

def group_l() -> None:
    header("L — Console-error trap (aggregate)")
    console_checks = [r for r in results if "console errors" in r["check"]]
    failed = [r for r in console_checks if r["status"] == "FAIL"]
    assert_(len(console_checks) >= 8,
            f"Console-error trap ran on every group ({len(console_checks)} checks)", "L")
    assert_(len(failed) == 0,
            f"No group emitted a React/runtime console error ({len(failed)} offending groups)", "L")
    if failed:
        for r in failed:
            print(f"     offending: {r['uc']} — {r['check']}")


# ============================================================================
# Main runner
# ============================================================================

GROUP_NAMES = {
    "A": "Shell + IA",
    "B": "Mobile parity",
    "C": "Old links",
    "D": "/jobs",
    "E": "/resume",
    "F": "/applications",
    "G": "/practice",
    "H": "/settings",
    "J": "Theme",
    "K": "i18n",
    "L": "Console trap",
}


def main() -> int:
    print("=" * 80)
    print("RoboApply — information-architecture dry run (stub data only, no backend)")
    print("=" * 80)
    print(f"App: {APP}")
    print(f"Shots: {SHOTS}")

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
        )
        ctx = browser.new_context(viewport={"width": 1440, "height": 900})
        set_session_cookie(ctx)
        clear_locale_cookie(ctx)
        grant_media(ctx)

        # Each group gets its own page (fresh console listener). Per-process
        # stub state persists across groups (one dev server), so groups are
        # written to be order-independent: none of them drains a fixture.
        def run(group: str, fn, *, locale_group: bool = False) -> None:
            set_session_cookie(ctx)
            if not locale_group:
                clear_locale_cookie(ctx)
            page = ctx.new_page()
            seed_local_storage(page)
            try:
                fn(page)
            except Exception as e:
                print(f"\n   [FAIL/EXC] {group} threw: {type(e).__name__}: {e}")
                results.append({"uc": group, "check": f"runtime exception: {type(e).__name__}: {e}", "status": "FAIL"})
                try:
                    shot(page, f"{group.lower()}-EXCEPTION")
                except Exception:
                    pass
            finally:
                page.close()

        # ── preflight ──
        pf = ctx.new_page()
        seed_local_storage(pf)
        ok = preflight(pf)
        pf.close()
        if not ok:
            browser.close()
            print("\nOVERALL: FAIL ✗ (preflight — nothing was walked)")
            return 1

        # ── ordered walk ──
        run("A", group_a)
        run("B", group_b)
        run("C", group_c)
        run("D", group_d)
        run("E", group_e)
        run("F", group_f)
        run("G", group_g)
        run("H", group_h)
        run("J", group_j)
        # K needs the ctx to swap the locale cookie.
        run("K", lambda pg: group_k(pg, ctx), locale_group=True)

        browser.close()

    # L is computed from the aggregate results (no browser needed).
    group_l()

    # ============ Report ============
    print("\n" + "=" * 80)
    print("SUMMARY")
    print("=" * 80)
    by_group: dict = {}
    for r in results:
        by_group.setdefault(r["uc"], []).append(r)

    overall_pass = True
    total_pass = 0
    total_checks = 0
    for group in sorted(by_group):
        checks = by_group[group]
        pass_n = sum(1 for c in checks if c["status"] == "PASS")
        total = len(checks)
        total_pass += pass_n
        total_checks += total
        if pass_n != total:
            overall_pass = False
        bar = "✓" if pass_n == total else "✗"
        print(f"{bar} {group} — {GROUP_NAMES.get(group, '')}: {pass_n}/{total}")
        for c in checks:
            mark = "  ✓" if c["status"] == "PASS" else "  ✗"
            print(f"   {mark} {c['check']}")

    group_total = len(by_group)
    group_green = sum(1 for g in by_group if all(c["status"] == "PASS" for c in by_group[g]))

    print()
    if bugs_filed:
        print("Bugs filed during this run:")
        for b in bugs_filed:
            print(f"  {b['id']} ({b['severity']}, layer={b['layer']}, {b['uc']}): {b['title']}")
        print()

    print(f"Groups green: {group_green}/{group_total}")
    print(f"Assertions: {total_pass}/{total_checks} passed")
    print(f"Screenshots: {SHOTS}")
    print(f"OVERALL: {'PASS ✓' if overall_pass else 'FAIL ✗'}")
    return 0 if overall_pass else 1


if __name__ == "__main__":
    sys.exit(main())
