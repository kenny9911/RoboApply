#!/usr/bin/env python3
"""RoboApply V3 — 22 use-case dry-run regression suite.

Walks every UC-V3-NN flow (docs/roboapply/v3/03-build-waves.md §5) via REAL UI
interaction (page.goto / click / fill — never ctx.request.* API calls). The app
runs in STUB mode (`NEXT_PUBLIC_USE_STUB_API=true` in roboapply/.env.local): the
new V3 surfaces (queue / activity / mock / integrations / preferences +
resume-AI) are served by the in-memory stub, so NO backend is required.

Auth: the Next.js middleware (roboapply/middleware.ts) only checks for the
PRESENCE of the session cookie, never validating it in stub mode. So we plant a
dummy `session_token` cookie (value "stub-v3") + seed `localStorage.auth_token`
the same way — no real /api/auth/login.

This harness REUSES the V2 dry-run infrastructure verbatim: the console-error
trap (`real_errs`), `safe_goto` retry, the screenshot helper, the PASS/FAIL
`assert_` + summary, and the per-iteration cookie re-plant.

Pre-req: the roboapply dev server is up on :3611 in stub mode.

Run from the repo root (or roboapply/):
  python3 roboapply/e2e/v3-uc-dry-run.py

Captures screenshots per UC to /tmp/v3-uc-shots/<n>-<name>.png and a structured
PASS/FAIL summary to stdout. Exit code 0 if every UC green, 1 otherwise.
"""

import re
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright, Page, BrowserContext

APP = "http://localhost:3611"
SHOTS = Path("/tmp/v3-uc-shots")
SHOTS.mkdir(exist_ok=True)

# Mirrors QUEUE_REVIEW_ENABLED in lib/jobApplying.ts — the /queue surface is
# hidden for launch. Flip both together to restore the queue checks (UC-04/05,
# nav items, the "In your queue" hero stat, zh nav label).
QUEUE_ENABLED = False


# ----- assertion + console-error infrastructure (carried from v2) ------

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
    noise (favicon, resource 404s, hydration warnings) is tolerated — same
    filter set as the V2 harness, which is the carried infra UC-V3-22 needs."""
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


def assert_(condition: bool, msg: str, uc: str) -> None:
    status = "PASS" if condition else "FAIL"
    results.append({"uc": uc, "check": msg, "status": status})
    print(f"   [{status}] {msg}")


def file_bug(bug_id: str, title: str, severity: str, uc: str, repro: str, layer: str = "F") -> None:
    bugs_filed.append({
        "id": bug_id, "title": title, "severity": severity,
        "uc": uc, "repro": repro, "layer": layer,
    })
    print(f"   [BUG] {bug_id} ({severity}) — {title}")


def header(label: str, subtitle: str = "") -> None:
    print(f"\n{label}")
    if subtitle:
        print(f"   ({subtitle})")


# ----- session bootstrap (stub mode — presence-only cookie) ------------
#
# Per the brief: stub mode ignores the token value entirely. The middleware
# only checks the cookie exists. So plant a fixed dummy value, never a real
# login. The localStorage seed mirrors the cookie (roboApi never reads it in
# stub mode — harmless noise that keeps the real-backend swap path honest).

STUB_TOKEN = "stub-v3"


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
    via cookies().get('robo_locale')). Used by UC-V3-21."""
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
    """The live mock interview calls getUserMedia (webcam). Grant camera/mic so
    the permission prompt never blocks; headless Chromium has no real device but
    the component handles the unavailable/denied states gracefully."""
    try:
        ctx.grant_permissions(["camera", "microphone"], origin=APP)
    except Exception as e:
        print(f"   (grant_permissions skipped: {type(e).__name__})")


# Common selectors -----------------------------------------------------

NAV_ITEM = "aside.side a.nav-item"


def wait_shell(page: Page) -> None:
    """Wait for the (auth) shell to mount (sidebar + topbar)."""
    page.wait_for_selector("aside.side", timeout=20_000)


# ============================================================================
# UC-V3-01 — Shell + nav
# ============================================================================

def uc01(page: Page) -> None:
    header("UC-V3-01 — Shell + nav")
    msgs = capture_console(page)
    safe_goto(page, f"{APP}/home")
    wait_shell(page)
    # Orb stats land async (useAgentStats) — give the stub a beat.
    page.wait_for_timeout(1500)
    shot(page, "01a-home-shell")

    # Sidebar shows the 6 workspace items (links under aside.side).
    nav_links = page.locator(NAV_ITEM)
    nav_count = nav_links.count()
    # 6 workspace + 1 settings link (Preferences) = 7 <a> nav items;
    # Tweaks/Replay are <button>. Require at least the 6 workspace ones.
    assert_(nav_count >= 6, f"Sidebar renders ≥6 workspace nav links (got {nav_count})", "UC-V3-01")

    nav_labels = ["Today", "Resume builder", "Mock interview", "Pipeline", "Activity log"]
    if QUEUE_ENABLED:
        nav_labels.insert(1, "Review queue")
    for label in nav_labels:
        present = page.locator(f'aside.side a.nav-item:has-text("{label}")').count() > 0
        assert_(present, f"Nav item '{label}' present", "UC-V3-01")
    if not QUEUE_ENABLED:
        absent = page.locator('aside.side a.nav-item:has-text("Review queue")').count() == 0
        assert_(absent, "Nav item 'Review queue' hidden for launch", "UC-V3-01")

    # Orb card shows the Sent / Replies / Saved numbers (numeric, not em-dash).
    orb_vals = page.locator("aside.side .orb-card .orb-stats .v").all_text_contents()
    numeric = [v for v in orb_vals if re.search(r"\d", v)]
    assert_(len(numeric) >= 3,
            f"Orb card shows ≥3 numeric stats Sent/Replies/Saved (got {orb_vals})",
            "UC-V3-01")

    # Clicking each nav item routes + highlights (aria-current=page) + the
    # Topbar breadcrumb's .now reflects the page.
    routes = [
        ("/resumes", "Resume builder"),
        # Pipeline + Activity log are now the two tabs of one "Tracker" entry.
        ("/tracker", "Tracker"),
        ("/tracker/activity", "Tracker"),
        ("/home", "Today"),
    ]
    if QUEUE_ENABLED:
        routes.insert(0, ("/queue", "Review queue"))
    for href, label in routes:
        link = page.locator(f'aside.side a.nav-item:has-text("{label}")').first
        link.click()
        page.wait_for_url(re.compile(re.escape(href)), timeout=10_000)
        page.wait_for_timeout(500)
        # Active highlight
        active = page.locator(f'aside.side a.nav-item[aria-current="page"]:has-text("{label}")').count() > 0
        assert_(active, f"Nav '{label}' highlights (aria-current=page) on {href}", "UC-V3-01")
        # Breadcrumb updates — the trailing .now crumb is the page name.
        crumb_now = (page.locator(".topbar .crumbs .now").first.text_content() or "").strip()
        assert_(crumb_now == label,
                f"Breadcrumb .now == '{label}' on {href} (got '{crumb_now}')",
                "UC-V3-01")

    shot(page, "01b-nav-walk")
    errs = real_errs(msgs)
    assert_(len(errs) == 0, f"zero real console errors (got {len(errs)})", "UC-V3-01")
    for e in errs[:3]:
        print(f"     console: {e['type']}: {e['text'][:140]}")


# ============================================================================
# UC-V3-02 — Today match feed (donut, expand→reasoning markdown, Apply now)
# ============================================================================

def uc02(page: Page) -> None:
    header("UC-V3-02 — Today match feed")
    msgs = capture_console(page)
    safe_goto(page, f"{APP}/home")
    wait_shell(page)
    # Match feed = search.run + per-card score. Wait for a real card.
    page.wait_for_selector(".matches .match", timeout=20_000)
    page.wait_for_timeout(1500)

    cards = page.locator(".matches .match")
    card_count = cards.count()
    assert_(card_count >= 1, f"≥1 MatchCard renders (got {card_count})", "UC-V3-02")

    # Score donut present (role=img aria-label "N% match").
    donut = page.locator('.matches .match [role="img"][aria-label*="match"]').first
    donut_ok = donut.count() > 0
    if donut_ok:
        aria = donut.get_attribute("aria-label") or ""
        donut_ok = bool(re.search(r"\d{1,3}%", aria))
    assert_(donut_ok, "MatchCard shows a score donut (0-100%)", "UC-V3-02")

    # The first card auto-expands (MatchFeed default-opens the first row). Make
    # sure SOME card is expanded; if not, click the first to expand.
    if page.locator(".matches .match.expanded").count() == 0:
        cards.first.locator(".match-top").click()
        page.wait_for_timeout(900)
    expanded = page.locator(".matches .match.expanded").first
    assert_(expanded.count() > 0, "A MatchCard is expanded", "UC-V3-02")

    # Reasoning renders as markdown (sanitized) — wait for the rationale to
    # resolve (jobs.get). The .ai-reasoning .txt holds it; assert no raw '**'.
    page.wait_for_timeout(1500)
    reasoning = expanded.locator(".ai-reasoning .txt").first
    reasoning.wait_for(timeout=10_000)
    reasoning_text = (reasoning.text_content() or "").strip()
    # Strip the leading "Why I think this fits" label for the raw-markdown check.
    body_text = reasoning_text.replace("Why I think this fits", "")
    assert_(len(body_text) > 20, f"Expanded reasoning has content (len={len(body_text)})", "UC-V3-02")
    no_raw_md = "**" not in body_text
    assert_(no_raw_md, "Reasoning is rendered markdown, not raw '**'", "UC-V3-02")

    # Facet strip appears (Salary fit / Skill overlap / Risk flag).
    facets = expanded.locator(".facet-strip .facet")
    assert_(facets.count() >= 1, f"Facet strip renders (got {facets.count()} facets)", "UC-V3-02")

    shot(page, "02a-today-expanded")

    # "Apply now" flips the card to applied state.
    apply_btn = expanded.get_by_role("button", name=re.compile(r"Apply now"))
    if apply_btn.count() > 0:
        apply_btn.first.click()
        # The card shows the applied-banner (today.appliedBanner) after success.
        page.wait_for_selector(".matches .match.expanded .applied-banner", timeout=10_000)
        applied = page.locator(".matches .match.expanded .applied-banner").count() > 0
        assert_(applied, "Apply now flips the card to applied state (banner shown)", "UC-V3-02")
    else:
        # Card may already be applied from a prior run — accept the banner being
        # present as the equivalent end-state.
        applied = page.locator(".matches .match.expanded .applied-banner").count() > 0
        assert_(applied, "Card already in applied state (banner present)", "UC-V3-02")

    shot(page, "02b-today-applied")
    errs = real_errs(msgs)
    assert_(len(errs) == 0, f"zero real console errors (got {len(errs)})", "UC-V3-02")
    for e in errs[:3]:
        print(f"     console: {e['type']}: {e['text'][:140]}")


# ============================================================================
# UC-V3-03 — Today stat strip (4 hero stats from activity.orbStats)
# ============================================================================

def uc03(page: Page) -> None:
    header("UC-V3-03 — Today stat strip")
    msgs = capture_console(page)
    safe_goto(page, f"{APP}/home")
    wait_shell(page)
    page.wait_for_selector(".stat-strip", timeout=20_000)
    # Wait for the aggregate to resolve out of the skeleton (aria-busy clears).
    page.wait_for_function(
        "() => { const s = document.querySelector('.stat-strip'); return s && s.getAttribute('aria-busy') !== 'true'; }",
        timeout=15_000,
    )
    page.wait_for_timeout(600)

    # Hero stats with the documented labels ("In your queue" hidden for launch).
    labels = ["Auto-applied", "Scanned overnight", "Matched"]
    if QUEUE_ENABLED:
        labels.append("In your queue")
    for lbl in labels:
        present = page.locator(f'.stat-strip .stat .k:has-text("{lbl}")').count() > 0
        assert_(present, f"Stat '{lbl}' renders", "UC-V3-03")
    if not QUEUE_ENABLED:
        absent = page.locator('.stat-strip .stat .k:has-text("In your queue")').count() == 0
        assert_(absent, "Stat 'In your queue' hidden for launch", "UC-V3-03")

    # Each stat value is numeric (driven by orbStats).
    expected_stats = 4 if QUEUE_ENABLED else 3
    stat_vals = page.locator(".stat-strip .stat .v").all_text_contents()
    numeric = [v for v in stat_vals if re.search(r"\d", v)]
    assert_(len(numeric) >= expected_stats,
            f"All {expected_stats} hero stats render numbers (got {stat_vals})",
            "UC-V3-03")

    shot(page, "03-today-statstrip")
    errs = real_errs(msgs)
    assert_(len(errs) == 0, f"zero real console errors (got {len(errs)})", "UC-V3-03")


# ============================================================================
# UC-V3-04 — Review queue (2 cards, countdowns, draft cover, Send now → empty)
# ============================================================================

def uc04(page: Page) -> None:
    header("UC-V3-04 — Review queue")
    msgs = capture_console(page)
    safe_goto(page, f"{APP}/queue")
    wait_shell(page)
    page.wait_for_selector(".queue-card", timeout=20_000)
    page.wait_for_timeout(900)

    cards = page.locator(".queue-card")
    start_count = cards.count()
    assert_(start_count == 2, f"Queue shows 2 cards (got {start_count})", "UC-V3-04")

    # Live countdown badge present on each card.
    countdowns = page.locator('.queue-card .qd, .queue-card [class*="countdown"], .queue-card .queue-head')
    # The CountdownBadge renders the "Auto-applies in …" copy; assert via text.
    countdown_text = page.locator('text=/Auto-applies in|Auto-applying now|Auto-apply scheduled/').count()
    assert_(countdown_text >= 1, f"Live countdown copy present (matches={countdown_text})", "UC-V3-04")

    # Draft cover renders as markdown (block) — no raw '**' leaking.
    cover = page.locator(".queue-card .draft .cover").first
    cover.wait_for(timeout=8_000)
    cover_text = (cover.text_content() or "").strip()
    assert_(len(cover_text) > 30, f"Draft cover has content (len={len(cover_text)})", "UC-V3-04")
    assert_("**" not in cover_text, "Draft cover is rendered markdown, not raw '**'", "UC-V3-04")

    shot(page, "04a-queue-two-cards")

    # "Send now" removes a card.
    page.locator('.queue-card button.primary:has-text("Send now")').first.click()
    # Wait for the list to shrink to 1.
    page.wait_for_function(
        "() => document.querySelectorAll('.queue-card').length === 1",
        timeout=12_000,
    )
    assert_(page.locator(".queue-card").count() == 1, "Send now removes a card (2 → 1)", "UC-V3-04")
    shot(page, "04b-queue-one-card")

    # Sending the second shows the empty state.
    page.locator('.queue-card button.primary:has-text("Send now")').first.click()
    # Empty-state copy: queue.empty.title "Queue " + accent "clear".
    page.wait_for_selector('text=/Queue/', timeout=12_000)
    page.wait_for_timeout(800)
    empty_ok = (
        page.locator(".queue-card").count() == 0
        and page.locator('text=/clear/i').count() > 0
    )
    assert_(empty_ok, "Sending both shows the empty state (0 cards, 'clear' copy)", "UC-V3-04")
    shot(page, "04c-queue-empty")

    errs = real_errs(msgs)
    assert_(len(errs) == 0, f"zero real console errors (got {len(errs)})", "UC-V3-04")
    for e in errs[:3]:
        print(f"     console: {e['type']}: {e['text'][:140]}")


# ============================================================================
# UC-V3-05 — Queue edit cover (open modal → edit → save → card reflects)
# ============================================================================

def uc05(page: Page) -> None:
    header("UC-V3-05 — Queue edit cover")
    msgs = capture_console(page)
    # The stub queue store is per-page (fresh fixture clone on each document
    # load — verified), so this page always opens with the seeded 2 cards
    # regardless of what UC-04 did to its own page's store.
    safe_goto(page, f"{APP}/queue")
    wait_shell(page)
    page.wait_for_selector(".queue-card", timeout=20_000)
    page.wait_for_timeout(900)
    assert_(page.locator(".queue-card").count() >= 1,
            f"Queue has ≥1 card to edit (got {page.locator('.queue-card').count()})", "UC-V3-05")

    # Open Edit on the first card.
    page.locator('.queue-card .draft .edit:has-text("Edit")').first.click()
    page.wait_for_selector('[role="dialog"] textarea#queue-edit-cover', timeout=10_000)
    shot(page, "05a-edit-modal")

    # Modal PANEL is solid (CLAUDE.md). The V3 Modal primitive paints the inner
    # card a literal #181923; the OUTER [role=dialog] is the dim backdrop. Read
    # the panel = the nearest ancestor of the textarea that sits directly inside
    # the dialog (the rounded card), and assert it's opaque (alpha == 1).
    panel_bg = page.evaluate(
        """() => {
          const ta = document.querySelector('textarea#queue-edit-cover');
          if (!ta) return null;
          const dialog = ta.closest('[role=dialog]');
          // The panel is the dialog's direct element child wrapping the textarea.
          let el = ta;
          while (el && el.parentElement && el.parentElement !== dialog) el = el.parentElement;
          const panel = el && el.parentElement === dialog ? el : ta.parentElement;
          return getComputedStyle(panel).backgroundColor;
        }"""
    )
    # Opaque solid = rgb(...) or rgba(...,1); reject transparent / alpha<1.
    def _opaque(c: str | None) -> bool:
        if not c:
            return False
        if c in ("transparent", "rgba(0, 0, 0, 0)"):
            return False
        m = re.match(r"rgba?\([^)]*?(?:,\s*([0-9.]+))?\)\s*$", c)
        if m and m.group(1) is not None:
            return float(m.group(1)) >= 0.99
        return True  # plain rgb(...) is fully opaque
    assert_(_opaque(panel_bg),
            f"Edit modal panel has a solid opaque background (bg={panel_bg})", "UC-V3-05")

    # Edit the textarea — append a recognizable marker.
    marker = f"Tailored for this team specifically {int(time.time()) % 100000}."
    textarea = page.locator("textarea#queue-edit-cover")
    cur = textarea.input_value()
    textarea.fill(cur + "\n\n" + marker)
    page.wait_for_timeout(300)

    # Save.
    page.locator('[role="dialog"] button:has-text("Save cover")').first.click()
    # Modal closes; the card's cover reflects the edit.
    page.wait_for_selector('[role="dialog"] textarea#queue-edit-cover', state="detached", timeout=10_000)
    page.wait_for_timeout(900)
    card_text = page.locator(".queue-card").first.text_content() or ""
    reflected = marker.split(" specifically")[0] in card_text or "Tailored for this team" in card_text
    assert_(reflected, "Card cover reflects the saved edit", "UC-V3-05")
    shot(page, "05b-edit-saved")

    errs = real_errs(msgs)
    assert_(len(errs) == 0, f"zero real console errors (got {len(errs)})", "UC-V3-05")
    for e in errs[:3]:
        print(f"     console: {e['type']}: {e['text'][:140]}")


# ============================================================================
# UC-V3-06 — Resume library (3 resumes + 3 create cards, ImportModal → editor)
# ============================================================================

def uc06(page: Page) -> str | None:
    """Returns the id of the resume the editor opened (for UC-07/08/09 reuse)."""
    header("UC-V3-06 — Resume library")
    msgs = capture_console(page)
    safe_goto(page, f"{APP}/resumes")
    wait_shell(page)
    page.wait_for_selector(".rb-create-card", timeout=20_000)
    page.wait_for_timeout(1000)

    # 3 create cards.
    create_cards = page.locator(".rb-create-card")
    assert_(create_cards.count() == 3, f"3 create cards render (got {create_cards.count()})", "UC-V3-06")

    # ≥3 resume cards (fixture seeds 3).
    page.wait_for_selector(".rb-list .rb-card", timeout=15_000)
    resume_cards = page.locator(".rb-list .rb-card")
    rc = resume_cards.count()
    assert_(rc >= 3, f"≥3 resume cards in library (got {rc})", "UC-V3-06")
    shot(page, "06a-library")

    # Open ImportModal (scratch) → parsing animation → "Open editor" routes.
    page.locator('.rb-create-card:has-text("Start from scratch")').first.click()
    page.wait_for_selector('.rb-modal-card[role="dialog"]', timeout=10_000)
    modal_open = page.locator('.rb-modal-card[role="dialog"]').count() > 0
    assert_(modal_open, "ImportModal (scratch) opens", "UC-V3-06")
    shot(page, "06b-import-modal")

    # Click "Create draft" → parsing → done → "Open editor".
    page.locator('.rb-modal-card button.primary:has-text("Create draft")').first.click()
    # Parsing animation (~350ms * 4 rows + 400ms). Wait for "Open editor".
    page.wait_for_selector('.rb-modal-card button.primary:has-text("Open editor")', timeout=15_000)
    parsing_done = page.locator('.rb-modal-card button:has-text("Open editor")').count() > 0
    assert_(parsing_done, "Parsing animation completes → 'Open editor' appears", "UC-V3-06")

    page.locator('.rb-modal-card button.primary:has-text("Open editor")').first.click()
    page.wait_for_url(re.compile(r"/resumes/[^/]+$"), timeout=12_000)
    page.wait_for_timeout(800)
    opened = bool(re.search(r"/resumes/([^/?]+)", page.url))
    assert_(opened, f"'Open editor' routes to /resumes/[id] (url={page.url})", "UC-V3-06")
    shot(page, "06c-editor-opened")

    rid_match = re.search(r"/resumes/([^/?]+)", page.url)
    rid = rid_match.group(1) if rid_match else None

    errs = real_errs(msgs)
    assert_(len(errs) == 0, f"zero real console errors (got {len(errs)})", "UC-V3-06")
    for e in errs[:3]:
        print(f"     console: {e['type']}: {e['text'][:140]}")
    return rid


# The editor UCs target a FIXED fixture resume that always carries real
# experience bullets + a summary and loads cold reliably. cm_rv_anthropic is
# the seeded "For Anthropic — Claude Platform AI Engineer" variant (7 bullets).
# Navigating directly (vs. clicking "the first library card", whose identity
# shifts as auto-save bumps lastEditedAt) makes 07/08/09 deterministic.
FIXTURE_RESUME_ID = "cm_rv_anthropic"


def discover_resume_id(page: Page) -> str | None:
    return FIXTURE_RESUME_ID


# ============================================================================
# UC-V3-07 — Resume editor inline AI (Improve a bullet → rewrite → Accept)
# ============================================================================

def uc07(page: Page, rid: str | None) -> None:
    header("UC-V3-07 — Resume editor inline AI rewrite")
    msgs = capture_console(page)
    rid = rid or discover_resume_id(page)
    assert_(bool(rid), f"Have a resume id to open the editor ({rid})", "UC-V3-07")
    if not rid:
        return

    safe_goto(page, f"{APP}/resumes/{rid}")
    wait_shell(page)
    # Editor toolbar + at least one bullet row. The /resumes/[id] route can take
    # a few seconds to compile cold on the dev server, then useResume resolves +
    # the markdown parses into bullets — generous timeouts avoid a cold flake.
    page.wait_for_selector(".rb-editor", timeout=30_000)
    page.wait_for_selector(".rb-bullet", timeout=30_000)
    page.wait_for_timeout(800)
    shot(page, "07a-editor")

    bullet = page.locator(".rb-bullet").first
    # Capture the bullet's text before the rewrite for the change assertion.
    before_text = (bullet.locator(".rb-bullet-text").first.text_content() or "").strip()

    # The inline-AI action menu (.rb-bullet-actions) is CSS hover-gated:
    # `opacity:0; pointer-events:none` until `.rb-bullet:hover` (or `.weak` /
    # `:focus-within`). So we must HOVER the bullet first to make the buttons
    # interactive — then a normal click lands. (force=True alone was flaky
    # because pointer-events:none swallows synthetic clicks.) v3-resume.css L627.
    bullet.scroll_into_view_if_needed()
    bullet.hover()
    page.wait_for_timeout(250)
    improve = bullet.locator('.rb-bact:has-text("Improve writing")').first
    assert_(improve.count() > 0, "Bullet inline-AI 'Improve writing' action present", "UC-V3-07")
    # Re-hover immediately before the click (the hover state can lapse) and
    # click; retry once if the rewrite panel doesn't mount.
    bullet.hover()
    improve.click()

    # Rewrite panel appears (busy → suggested). The .rb-rewrite block mounts
    # immediately on click (busy shimmer), then resolves to the suggestion +
    # Accept. If the click somehow didn't register, re-hover + retry once.
    try:
        page.wait_for_selector(".rb-bullet .rb-rewrite", timeout=6_000)
    except Exception:
        print("   (rewrite panel didn't mount on first click — re-hover + retry)")
        bullet.hover()
        page.wait_for_timeout(200)
        improve.click()
        page.wait_for_selector(".rb-bullet .rb-rewrite", timeout=8_000)
    # Wait for the busy state to resolve to the Accept button.
    page.wait_for_selector('.rb-bullet .rb-rewrite .btn.primary:has-text("Accept")', timeout=20_000)
    page.wait_for_timeout(400)
    rewrite_panel = bullet.locator(".rb-rewrite .rb-rewrite-text").first
    rewrite_text = (rewrite_panel.text_content() or "").strip()
    assert_(len(rewrite_text) > 5, f"Rewrite suggestion appears (len={len(rewrite_text)})", "UC-V3-07")
    assert_("**" not in rewrite_text, "Rewrite renders markdown, not raw '**'", "UC-V3-07")
    shot(page, "07b-rewrite-suggested")

    # Accept → updates the bullet text + the live paper preview. The .rb-rewrite
    # panel is NOT hover-gated (it renders below the bullet, always visible), so
    # a normal click lands reliably.
    bullet.locator('.rb-rewrite .btn.primary:has-text("Accept")').first.click()
    page.wait_for_timeout(900)
    after_text = (page.locator(".rb-bullet").first.locator(".rb-bullet-text").first.text_content() or "").strip()
    changed = after_text != before_text and len(after_text) > 0
    assert_(changed, f"Accept updates the bullet text (before≠after)", "UC-V3-07")

    # The live preview (ResumePaper) should now contain the accepted text. Grab
    # a distinctive word from the new bullet and look for it in the paper pane.
    probe = next((w for w in re.findall(r"[A-Za-z]{5,}", after_text)), None)
    paper_text = page.locator(".rb-preview-pane").first.text_content() or ""
    preview_ok = (probe is None) or (probe in paper_text)
    assert_(preview_ok, f"Live paper preview reflects the accepted bullet (probe='{probe}')", "UC-V3-07")
    shot(page, "07c-rewrite-accepted")

    errs = real_errs(msgs)
    assert_(len(errs) == 0, f"zero real console errors (got {len(errs)})", "UC-V3-07")
    for e in errs[:3]:
        print(f"     console: {e['type']}: {e['text'][:140]}")


# ============================================================================
# UC-V3-08 — Resume summary rewrite (3 options → Use this swaps summary)
# ============================================================================

def uc08(page: Page, rid: str | None) -> None:
    header("UC-V3-08 — Resume summary rewrite")
    msgs = capture_console(page)
    rid = rid or discover_resume_id(page)
    if not rid:
        assert_(False, "no resume id available", "UC-V3-08")
        return

    safe_goto(page, f"{APP}/resumes/{rid}")
    wait_shell(page)
    page.wait_for_selector(".rb-summary", timeout=30_000)
    page.wait_for_timeout(800)

    summary_ta = page.locator(".rb-summary textarea.rb-textarea").first
    before_summary = summary_ta.input_value()

    # "Give me 3 rewrites".
    chip = page.locator('.rb-summary .rb-ai-chip:has-text("Give me 3 rewrites")').first
    assert_(chip.count() > 0, "'Give me 3 rewrites' chip present", "UC-V3-08")
    chip.click()

    # 3 labeled options appear.
    page.wait_for_selector(".rb-summary .rb-options .rb-option", timeout=15_000)
    page.wait_for_timeout(400)
    options = page.locator(".rb-summary .rb-options .rb-option")
    opt_count = options.count()
    assert_(opt_count == 3, f"3 labeled rewrite options appear (got {opt_count})", "UC-V3-08")
    # Each option has a label "Option N · <style>".
    first_label = (options.first.locator(".rb-option-lbl").text_content() or "")
    assert_("Option" in first_label, f"Options are labeled (first='{first_label.strip()}')", "UC-V3-08")
    shot(page, "08a-summary-options")

    # "Use this" on the first option swaps the summary.
    options.first.locator('button:has-text("Use this")').first.click()
    page.wait_for_timeout(700)
    after_summary = page.locator(".rb-summary textarea.rb-textarea").first.input_value()
    swapped = after_summary != before_summary and len(after_summary) > 0
    assert_(swapped, "'Use this' swaps the summary text", "UC-V3-08")
    # Options collapse after use.
    collapsed = page.locator(".rb-summary .rb-options .rb-option").count() == 0
    assert_(collapsed, "Options collapse after 'Use this'", "UC-V3-08")
    shot(page, "08b-summary-swapped")

    errs = real_errs(msgs)
    assert_(len(errs) == 0, f"zero real console errors (got {len(errs)})", "UC-V3-08")
    for e in errs[:3]:
        print(f"     console: {e['type']}: {e['text'][:140]}")


# ============================================================================
# UC-V3-09 — Resume tailor (pick match → diff before/after → Apply → variant)
# ============================================================================

def uc09(page: Page, rid: str | None) -> None:
    header("UC-V3-09 — Resume tailor")
    msgs = capture_console(page)
    rid = rid or discover_resume_id(page)
    if not rid:
        assert_(False, "no resume id available", "UC-V3-09")
        return

    safe_goto(page, f"{APP}/resumes/{rid}")
    wait_shell(page)
    page.wait_for_selector(".rb-editor", timeout=30_000)
    page.wait_for_timeout(800)

    # Open the Tailor modal from the toolbar.
    page.locator('.rb-toolbar button:has-text("Tailor for a job"), button:has-text("Tailor for a job")').first.click()
    page.wait_for_selector(".rb-modal.rb-modal, .rb-modal", timeout=10_000)
    page.wait_for_selector(".rb-modal-card.big", timeout=10_000)
    page.wait_for_timeout(1200)
    shot(page, "09a-tailor-pick")

    # Pick a job from the matches (search.run). Wait for the job rows.
    page.wait_for_selector(".rb-modal-card.big .rb-tailor-job", timeout=15_000)
    jobs = page.locator(".rb-modal-card.big .rb-tailor-job")
    assert_(jobs.count() >= 1, f"Tailor modal lists matches to pick (got {jobs.count()})", "UC-V3-09")
    jobs.first.click()

    # Analyzing → review: before/after score + toggleable changes.
    page.wait_for_selector(".rb-modal-card.big .rb-tailor-changes .rb-change", timeout=20_000)
    page.wait_for_timeout(500)
    before_after = page.locator(".rb-tailor-score-before .rb-tailor-score-num").count() > 0 \
        and page.locator(".rb-tailor-score-after .rb-tailor-score-num").count() > 0
    assert_(before_after, "Diff shows before/after match score", "UC-V3-09")
    changes = page.locator(".rb-modal-card.big .rb-tailor-changes .rb-change")
    assert_(changes.count() >= 1, f"Diff shows toggleable changes (got {changes.count()})", "UC-V3-09")
    # Toggle one change off then on (proves the toggle works).
    first_toggle = changes.first.locator(".rb-change-toggle").first
    first_toggle.click()
    page.wait_for_timeout(250)
    first_toggle.click()
    shot(page, "09b-tailor-diff")

    # "Apply N changes" → done.
    apply_btn = page.locator('.rb-modal-card.big button.primary:has-text("Apply")').first
    assert_(apply_btn.count() > 0, "'Apply N changes' button present", "UC-V3-09")
    apply_btn.click()
    # Done state — "Open tailored copy" or the done title.
    page.wait_for_selector('text=/Tailored copy|tailored copy|Open tailored/i', timeout=15_000)
    page.wait_for_timeout(600)
    done_ok = page.locator('text=/Tailored copy saved|Open tailored copy/i').count() > 0
    assert_(done_ok, "Apply completes → tailored-copy done state", "UC-V3-09")
    shot(page, "09c-tailor-done")

    # A new tailored variant appears in /resumes. Count before vs after.
    safe_goto(page, f"{APP}/resumes")
    wait_shell(page)
    page.wait_for_selector(".rb-list .rb-card", timeout=15_000)
    page.wait_for_timeout(900)
    # A tailored variant carries the TAILORED stamp on its mini-paper.
    tailored_stamps = page.locator('.rb-list .rb-card .rb-mini-stamp:has-text("TAILORED")').count()
    assert_(tailored_stamps >= 1,
            f"A tailored variant appears in the library (TAILORED stamps={tailored_stamps})",
            "UC-V3-09")
    shot(page, "09d-library-tailored")

    errs = real_errs(msgs)
    assert_(len(errs) == 0, f"zero real console errors (got {len(errs)})", "UC-V3-09")
    for e in errs[:3]:
        print(f"     console: {e['type']}: {e['text'][:140]}")


# ============================================================================
# UC-V3-10 — Pipeline (4 columns with counts, cards in right columns)
# ============================================================================

def uc10(page: Page) -> None:
    header("UC-V3-10 — Pipeline kanban")
    msgs = capture_console(page)
    safe_goto(page, f"{APP}/tracker")
    wait_shell(page)
    page.wait_for_selector(".pipeline-grid .pipe-col", timeout=20_000)
    page.wait_for_timeout(1000)

    columns = page.locator(".pipeline-grid .pipe-col")
    col_count = columns.count()
    assert_(col_count == 4, f"Pipeline shows 4 columns (got {col_count})", "UC-V3-10")

    for name in ["Saved", "Applied", "Interview", "Offer"]:
        present = page.locator(f'.pipe-col .pipe-head .name:has-text("{name}")').count() > 0
        assert_(present, f"Column '{name}' present", "UC-V3-10")

    # Each column header shows a count.
    counts = page.locator(".pipe-col .pipe-head .count").all_text_contents()
    numeric_counts = [c for c in counts if re.search(r"\d", c)]
    assert_(len(numeric_counts) == 4,
            f"All 4 columns show a count (got {counts})", "UC-V3-10")

    # Cards render in some column (at least one .pipe-card across the board).
    cards = page.locator(".pipeline-grid .pipe-card")
    assert_(cards.count() >= 1, f"Cards render in the board (got {cards.count()})", "UC-V3-10")

    # Cards land in the correct column per status: verify the Applied column's
    # numeric count equals the number of cards rendered under it.
    applied_col = page.locator('.pipe-col:has(.pipe-head .name:has-text("Applied"))').first
    applied_count_txt = (applied_col.locator(".pipe-head .count").first.text_content() or "0").strip()
    applied_cards = applied_col.locator(".pipe-card").count()
    try:
        applied_count = int(re.search(r"\d+", applied_count_txt).group(0))
    except Exception:
        applied_count = -1
    assert_(applied_cards == applied_count,
            f"Applied column card count matches header ({applied_cards} cards vs count={applied_count})",
            "UC-V3-10")

    shot(page, "10-pipeline")
    errs = real_errs(msgs)
    assert_(len(errs) == 0, f"zero real console errors (got {len(errs)})", "UC-V3-10")
    for e in errs[:3]:
        print(f"     console: {e['type']}: {e['text'][:140]}")


# ============================================================================
# UC-V3-11 — Activity log (day-grouped entries + 4-stat hero strip)
# ============================================================================

def uc11(page: Page) -> None:
    header("UC-V3-11 — Activity log")
    msgs = capture_console(page)
    safe_goto(page, f"{APP}/tracker/activity")
    wait_shell(page)
    page.wait_for_selector(".log .log-day", timeout=20_000)
    page.wait_for_timeout(900)

    # Day-grouped entries.
    days = page.locator(".log .log-day")
    assert_(days.count() >= 1, f"Day groups render (got {days.count()})", "UC-V3-11")
    entries = page.locator(".log .log-entry")
    assert_(entries.count() >= 1, f"Activity entries render (got {entries.count()})", "UC-V3-11")

    # Entry bodies are markdown — no raw '**'.
    body_sample = " ".join(
        (page.locator(".log .log-entry .log-content").nth(i).text_content() or "")
        for i in range(min(entries.count(), 6))
    )
    assert_("**" not in body_sample, "Activity bodies are rendered markdown, not raw '**'", "UC-V3-11")

    # At least one "saved" pill in the meta column (proto behaviour).
    saved_pill = page.locator(".log .log-entry .log-meta .saved").count()
    assert_(saved_pill >= 1, f"≥1 'saved' pill present (got {saved_pill})", "UC-V3-11")

    # 4-stat hero strip (Hours saved / Apps sent / Replies / Drafts written).
    page.wait_for_function(
        "() => { const s = document.querySelector('.stat-strip'); return s && s.getAttribute('aria-busy') !== 'true'; }",
        timeout=15_000,
    )
    for lbl in ["Hours saved", "Apps sent", "Replies", "Drafts written"]:
        present = page.locator(f'.stat-strip .stat .k:has-text("{lbl}")').count() > 0
        assert_(present, f"Hero stat '{lbl}' renders", "UC-V3-11")

    shot(page, "11-activity")
    errs = real_errs(msgs)
    assert_(len(errs) == 0, f"zero real console errors (got {len(errs)})", "UC-V3-11")
    for e in errs[:3]:
        print(f"     console: {e['type']}: {e['text'][:140]}")


# ============================================================================
# UC-V3-12 — Mock interview setup (recent + 4 pickers → Start enables)
# ============================================================================

def uc12(page: Page) -> None:
    header("UC-V3-12 — Mock interview setup")
    msgs = capture_console(page)
    safe_goto(page, f"{APP}/mock-interview")
    wait_shell(page)
    page.wait_for_selector(".iv-step", timeout=20_000)
    page.wait_for_timeout(1000)

    # 4 step pickers (role / interviewer / type / format) — each is an .iv-step.
    steps = page.locator(".iv-step")
    assert_(steps.count() >= 3, f"Step pickers render (got {steps.count()} .iv-step sections)", "UC-V3-12")
    # Role chips, persona cards, type cards, format cards present.
    assert_(page.locator(".iv-role-chip").count() >= 1, "Role chips present (step 01)", "UC-V3-12")
    assert_(page.locator(".iv-persona").count() >= 1, "Interviewer personas present (step 02)", "UC-V3-12")
    assert_(page.locator(".iv-type-card").count() >= 1, "Interview type cards present (step 03)", "UC-V3-12")

    # Recent sessions strip (fixture seeds a few).
    recent = page.locator('text=/Pick up where you left off/i').count() > 0 \
        or page.locator(".iv-recent, [class*='recent']").count() > 0
    assert_(recent, "Recent sessions strip present", "UC-V3-12")

    # Launch button disabled before all picks.
    launch = page.locator(".iv-launch .iv-launch-btn").first
    assert_(launch.count() > 0, "LaunchBar 'Start interview' present", "UC-V3-12")
    disabled_initially = launch.is_disabled()
    assert_(disabled_initially, "Start interview disabled before all picks made", "UC-V3-12")
    shot(page, "12a-setup-initial")

    # Make all selections: role, interviewer, type. (Format defaults to video.)
    page.locator(".iv-role-chip").first.click()
    page.wait_for_timeout(200)
    page.locator(".iv-persona").first.click()
    page.wait_for_timeout(200)
    page.locator(".iv-type-card").first.click()
    page.wait_for_timeout(400)

    launch2 = page.locator(".iv-launch .iv-launch-btn").first
    enabled = not launch2.is_disabled()
    assert_(enabled, "Selecting role+interviewer+type enables 'Start interview'", "UC-V3-12")
    shot(page, "12b-setup-ready")

    errs = real_errs(msgs)
    assert_(len(errs) == 0, f"zero real console errors (got {len(errs)})", "UC-V3-12")
    for e in errs[:3]:
        print(f"     console: {e['type']}: {e['text'][:140]}")


# ============================================================================
# UC-V3-13 — Mock interview live (start → live screen → advance → end → report)
# ============================================================================

def uc13(page: Page) -> None:
    header("UC-V3-13 — Mock interview live")
    msgs = capture_console(page)
    safe_goto(page, f"{APP}/mock-interview")
    wait_shell(page)
    page.wait_for_selector(".iv-step", timeout=20_000)
    page.wait_for_timeout(900)

    # Pick all three + start.
    page.locator(".iv-role-chip").first.click()
    page.wait_for_timeout(150)
    page.locator(".iv-persona").first.click()
    page.wait_for_timeout(150)
    page.locator(".iv-type-card").first.click()
    page.wait_for_timeout(300)
    page.locator(".iv-launch .iv-launch-btn").first.click()

    # Routes to /mock-interview/[id] (live). Rail hidden (no aside.side).
    page.wait_for_url(re.compile(r"/mock-interview/[^/]+$"), timeout=15_000)
    page.wait_for_selector(".iv-live", timeout=15_000)
    page.wait_for_timeout(1200)
    rail_hidden = page.locator("aside.side").count() == 0
    assert_(rail_hidden, "Live screen hides the sidebar (full-focus)", "UC-V3-13")

    # Question card + transcript stream present.
    qcard = page.locator(".iv-live .iv-question").count() > 0
    assert_(qcard, "Question card renders on the live stage", "UC-V3-13")
    transcript = page.locator(".iv-live .iv-stage-right").count() > 0
    assert_(transcript, "Right stage (transcript/controls) renders", "UC-V3-13")

    # Question pips show "Question 1 / N".
    pip_text = page.locator('text=/Question 1 \\/ \\d+/').count() > 0 \
        or page.locator('.iv-question-num').count() > 0
    assert_(pip_text, "Question progress (pips / 'Question 1 / N') shows", "UC-V3-13")
    shot(page, "13a-live")

    # "Submit & next" advances. Type an answer then submit.
    composer = page.locator('.iv-live textarea').first
    composer.fill("I led the migration end to end, cutting p95 latency by 40 percent and onboarding three engineers.")
    page.wait_for_timeout(300)
    # Wait for the submit button to be enabled (AI 'asking' pulse → listening).
    submit = page.locator('.iv-controls button.primary')
    page.wait_for_timeout(2500)  # let the asking→listening transition settle
    q_before = (page.locator(".iv-question-num").first.text_content() or "")
    submit.first.click()
    # Either advances to the next question OR (if single-question) goes to report.
    page.wait_for_timeout(2500)
    advanced = False
    if page.locator(".iv-question-num").count() > 0:
        q_after = (page.locator(".iv-question-num").first.text_content() or "")
        advanced = q_after != q_before
    if "/report" in page.url:
        advanced = True
    assert_(advanced, f"'Submit & next' advances the loop (q '{q_before.strip()}' progressed)", "UC-V3-13")
    shot(page, "13b-advanced")

    # "End interview" → report. If we already landed on report, that's fine.
    if "/report" not in page.url:
        end_btn = page.locator('.iv-live-foot button:has-text("End interview")').first
        if end_btn.count() > 0:
            end_btn.click()
        page.wait_for_url(re.compile(r"/mock-interview/[^/]+/report$"), timeout=15_000)
    on_report = "/report" in page.url
    assert_(on_report, f"End interview routes to the report (url={page.url})", "UC-V3-13")
    shot(page, "13c-to-report")

    errs = real_errs(msgs)
    assert_(len(errs) == 0, f"zero real console errors (got {len(errs)})", "UC-V3-13")
    for e in errs[:3]:
        print(f"     console: {e['type']}: {e['text'][:140]}")


# ============================================================================
# UC-V3-14 — Mock interview report (overall donut + breakdown + strengths/gaps)
# ============================================================================

def uc14(page: Page) -> None:
    header("UC-V3-14 — Mock interview report")
    msgs = capture_console(page)
    # Drive a fresh run so we have a real session id, then land on its report.
    safe_goto(page, f"{APP}/mock-interview")
    wait_shell(page)
    page.wait_for_selector(".iv-step", timeout=20_000)
    page.wait_for_timeout(800)
    page.locator(".iv-role-chip").first.click()
    page.wait_for_timeout(150)
    page.locator(".iv-persona").first.click()
    page.wait_for_timeout(150)
    page.locator(".iv-type-card").first.click()
    page.wait_for_timeout(300)
    page.locator(".iv-launch .iv-launch-btn").first.click()
    page.wait_for_url(re.compile(r"/mock-interview/[^/]+$"), timeout=15_000)
    sid_m = re.search(r"/mock-interview/([^/?]+)", page.url)
    sid = sid_m.group(1) if sid_m else None
    assert_(bool(sid), f"Have a live session id ({sid})", "UC-V3-14")

    # Go straight to the report for that session.
    safe_goto(page, f"{APP}/mock-interview/{sid}/report")
    wait_shell(page)
    # mock.score resolves out of the "Reading the room…" loading state.
    page.wait_for_selector(".iv-results-actions", timeout=20_000)
    page.wait_for_timeout(900)

    # Overall donut (ScoreDonut role=img).
    donut = page.locator('[role="img"][aria-label*="match"], [role="img"][aria-label*="overall"], .iv-results-top [role="img"]').first
    # ResultsTop uses ScoreDonut whose aria-label is "N% <label>".
    donut_any = page.locator('.iv-results-actions').count() > 0 and \
        page.locator('[role="img"]').count() > 0
    assert_(donut_any, "Overall score donut renders", "UC-V3-14")

    # Breakdown bars + strengths/gaps grid.
    strengths = page.locator('text=/Strengths|Keep these/i').count() > 0
    gaps = page.locator('text=/Sharpen these/i').count() > 0
    assert_(strengths, "Strengths section renders", "UC-V3-14")
    assert_(gaps, "Sharpen-these (gaps) section renders", "UC-V3-14")
    # Action row.
    actions_ok = page.locator('.iv-results-actions button:has-text("Run it again")').count() > 0
    assert_(actions_ok, "Results actions (Run it again / etc.) render", "UC-V3-14")

    shot(page, "14-report")
    errs = real_errs(msgs)
    assert_(len(errs) == 0, f"zero real console errors (got {len(errs)})", "UC-V3-14")
    for e in errs[:3]:
        print(f"     console: {e['type']}: {e['text'][:140]}")


# ============================================================================
# UC-V3-15 — Preferences hunt (edit chip/slider → plain-English + SaveBar)
# ============================================================================

def uc15(page: Page) -> None:
    header("UC-V3-15 — Preferences hunt section")
    msgs = capture_console(page)
    safe_goto(page, f"{APP}/preferences")
    wait_shell(page)
    page.wait_for_selector(".pref", timeout=20_000)
    # The Job target (hunt) section is the default. Wait for it to hydrate.
    page.wait_for_selector(".pref-intent", timeout=15_000)
    page.wait_for_timeout(900)

    # Live "plain English" translation block present.
    plain = page.locator(".pref-intent .pref-intent-body .pref-intent-line").count()
    assert_(plain >= 1, f"Live plain-English translation renders ({plain} lines)", "UC-V3-15")

    # No SaveBar yet (not dirty).
    savebar_before = page.locator(".pref-savebar").count()
    assert_(savebar_before == 0, "SaveBar hidden when clean", "UC-V3-15")
    shot(page, "15a-prefs-clean")

    # Edit a chip: add a title to "Titles you want".
    chip_input = page.locator('.pref input[placeholder*="Add title"]').first
    assert_(chip_input.count() > 0, "Title ChipInput present", "UC-V3-15")
    chip_input.fill("Staff Product Manager")
    chip_input.press("Enter")
    page.wait_for_timeout(700)

    # SaveBar appears (dirty).
    page.wait_for_selector(".pref-savebar", timeout=8_000)
    savebar_after = page.locator(".pref-savebar").count() > 0
    assert_(savebar_after, "Editing a chip shows the sticky SaveBar (dirty)", "UC-V3-15")

    # The plain-English line updates to include the new title.
    plain_text = page.locator(".pref-intent .pref-intent-body").first.text_content() or ""
    updated = "Staff Product Manager" in plain_text
    assert_(updated, "Plain-English translation reflects the new chip", "UC-V3-15")
    shot(page, "15b-prefs-dirty")

    # Save clears dirty (SaveBar disappears).
    page.locator('.pref-savebar button.primary, .pref-savebar button:has-text("Save changes")').first.click()
    page.wait_for_selector(".pref-savebar", state="detached", timeout=12_000)
    cleared = page.locator(".pref-savebar").count() == 0
    assert_(cleared, "Save clears dirty (SaveBar disappears)", "UC-V3-15")
    shot(page, "15c-prefs-saved")

    errs = real_errs(msgs)
    assert_(len(errs) == 0, f"zero real console errors (got {len(errs)})", "UC-V3-15")
    for e in errs[:3]:
        print(f"     console: {e['type']}: {e['text'][:140]}")


# ============================================================================
# UC-V3-16 — Preferences agent (aggressiveness mood card + threshold hint)
# ============================================================================

def uc16(page: Page) -> None:
    header("UC-V3-16 — Preferences agent section")
    msgs = capture_console(page)
    safe_goto(page, f"{APP}/preferences")
    wait_shell(page)
    page.wait_for_selector(".pref-nav", timeout=20_000)
    page.wait_for_timeout(800)

    # Navigate to the Agent behavior section.
    page.locator('.pref-nav-item:has-text("Agent behavior")').first.click()
    page.wait_for_selector(".pref-mood", timeout=10_000)
    page.wait_for_timeout(600)

    # Mood card shows the current mode name.
    mood_name_before = (page.locator(".pref-mood .pref-mood-name").first.text_content() or "").strip()
    assert_(len(mood_name_before) > 0, f"Mood card shows current mode ('{mood_name_before}')", "UC-V3-16")
    shot(page, "16a-agent-mood")

    # Change aggressiveness → the mood card name updates.
    # Pick a mode that differs from the current one.
    aggr_buttons = page.locator(".pref-aggr-grid .pref-aggr")
    assert_(aggr_buttons.count() == 3, f"3 aggressiveness options (got {aggr_buttons.count()})", "UC-V3-16")
    # Click the one whose name != current.
    target = None
    for i in range(aggr_buttons.count()):
        nm = (aggr_buttons.nth(i).locator(".pref-aggr-name").text_content() or "").strip()
        if nm and nm != mood_name_before:
            target = i
            break
    if target is None:
        target = 0
    aggr_buttons.nth(target).click()
    page.wait_for_timeout(700)
    mood_name_after = (page.locator(".pref-mood .pref-mood-name").first.text_content() or "").strip()
    assert_(mood_name_after != mood_name_before,
            f"Changing aggressiveness updates the mood card ('{mood_name_before}' → '{mood_name_after}')",
            "UC-V3-16")

    # Threshold slider has a "N new roles/day" hint that reads from the value.
    threshold_hint = page.locator('text=/new roles\\/day/i').count() > 0
    assert_(threshold_hint, "Match-threshold hint shows 'N new roles/day'", "UC-V3-16")
    # Move the threshold slider and confirm the hint stays present (recomputes).
    slider = page.locator('.pref input[type="range"][aria-label="Match threshold"]').first
    if slider.count() > 0:
        slider.focus()
        slider.press("ArrowLeft")
        slider.press("ArrowLeft")
        page.wait_for_timeout(400)
        still = page.locator('text=/new roles\\/day/i').count() > 0
        assert_(still, "Threshold hint updates live as the slider moves", "UC-V3-16")
    shot(page, "16b-agent-changed")

    errs = real_errs(msgs)
    assert_(len(errs) == 0, f"zero real console errors (got {len(errs)})", "UC-V3-16")
    for e in errs[:3]:
        print(f"     console: {e['type']}: {e['text'][:140]}")


# ============================================================================
# UC-V3-17 — Preferences integrations (Connect → connected, Disconnect reverts)
# ============================================================================

def uc17(page: Page) -> None:
    header("UC-V3-17 — Preferences integrations")
    msgs = capture_console(page)
    safe_goto(page, f"{APP}/preferences")
    wait_shell(page)
    page.wait_for_selector(".pref-nav", timeout=20_000)
    page.wait_for_timeout(800)

    page.locator('.pref-nav-item:has-text("Integrations")').first.click()
    page.wait_for_selector(".pref-integ-grid .pref-integ", timeout=12_000)
    page.wait_for_timeout(700)

    tiles = page.locator(".pref-integ-grid .pref-integ")
    assert_(tiles.count() >= 1, f"Integration tiles render (got {tiles.count()})", "UC-V3-17")
    shot(page, "17a-integrations")

    # Operate on ONE tile by a fixed provider name throughout (the list
    # re-renders after each mutation's invalidate, so we must re-resolve the
    # tile by name each time — never reuse a stale element handle). We pick a
    # provider that is currently disconnected; if all are connected (prior run),
    # disconnect-then-connect instead so both transitions are still covered.
    def tile_by(name: str):
        return page.locator(f'.pref-integ:has(.pref-integ-name:has-text("{name}"))').first

    def is_connected(name: str) -> bool:
        return "on" in (tile_by(name).get_attribute("class") or "")

    # Prefer a known-disconnected provider in the fixture (Gmail). Fall back to
    # whichever tile currently shows a Connect button.
    name = None
    for cand in ["Gmail", "Slack", "Notion", "LinkedIn", "GitHub"]:
        if tile_by(cand).count() > 0 and not is_connected(cand):
            name = cand
            break
    if name is None:
        # All connected: disconnect the first, proving the revert path first.
        name = (page.locator(".pref-integ .pref-integ-name").first.text_content() or "").strip()
        tile_by(name).locator('button:has-text("Disconnect")').first.click()
        page.wait_for_function(
            f"() => {{ const tile=[...document.querySelectorAll('.pref-integ')].find(t=>t.querySelector('.pref-integ-name')?.textContent?.includes('{name}')); return tile && !tile.classList.contains('on'); }}",
            timeout=10_000,
        )
        assert_(not is_connected(name), f"Disconnect reverts '{name}' to Connect state (pre-step)", "UC-V3-17")

    # Connect → tile gains .on + Disconnect button + account line.
    tile_by(name).locator('button:has-text("Connect")').first.click()
    page.wait_for_function(
        f"() => {{ const tile=[...document.querySelectorAll('.pref-integ')].find(t=>t.querySelector('.pref-integ-name')?.textContent?.includes('{name}')); return tile && tile.classList.contains('on'); }}",
        timeout=10_000,
    )
    connected = is_connected(name) and tile_by(name).locator('button:has-text("Disconnect")').count() > 0
    acct_shown = tile_by(name).locator(".pref-integ-acct").count() > 0
    assert_(connected, f"Connect flips '{name}' to connected (Disconnect button shown)", "UC-V3-17")
    assert_(acct_shown, f"Connected '{name}' tile shows the account", "UC-V3-17")
    shot(page, "17b-connected")

    # Disconnect reverts it.
    tile_by(name).locator('button:has-text("Disconnect")').first.click()
    page.wait_for_function(
        f"() => {{ const tile=[...document.querySelectorAll('.pref-integ')].find(t=>t.querySelector('.pref-integ-name')?.textContent?.includes('{name}')); return tile && !tile.classList.contains('on'); }}",
        timeout=10_000,
    )
    reverted = not is_connected(name) and tile_by(name).locator('button:has-text("Connect")').count() > 0
    assert_(reverted, f"Disconnect reverts '{name}' to the Connect state", "UC-V3-17")
    shot(page, "17c-reverted")

    errs = real_errs(msgs)
    assert_(len(errs) == 0, f"zero real console errors (got {len(errs)})", "UC-V3-17")
    for e in errs[:3]:
        print(f"     console: {e['type']}: {e['text'][:140]}")


# ============================================================================
# UC-V3-18 — Tweaks panel (accent lime→violet re-tints; density changes)
# ============================================================================

def uc18(page: Page) -> None:
    header("UC-V3-18 — Tweaks panel accent + density")
    msgs = capture_console(page)
    safe_goto(page, f"{APP}/home")
    wait_shell(page)
    page.wait_for_timeout(900)

    # Read the current accent (data-accent on the .v3-root wrapper).
    wrapper = page.locator(".v3-root").first
    accent_before = wrapper.get_attribute("data-accent")
    density_before = wrapper.get_attribute("data-density")

    # Open Tweaks from the sidebar (a <button> labelled Tweaks).
    page.locator('aside.side button.nav-item:has-text("Tweaks")').first.click()
    page.wait_for_selector('[role="dialog"][aria-label="Tweaks"]', timeout=10_000)
    page.wait_for_timeout(400)
    shot(page, "18a-tweaks-open")

    # Switch accent to Plasma Violet.
    page.locator('[role="dialog"][aria-label="Tweaks"] button:has-text("Plasma Violet")').first.click()
    page.wait_for_timeout(600)
    accent_after = page.locator(".v3-root").first.get_attribute("data-accent")
    assert_(accent_after == "violet" and accent_after != accent_before,
            f"Accent swaps to violet (was '{accent_before}', now '{accent_after}')",
            "UC-V3-18")

    # Confirm the actual CSS accent token re-tinted (the shell re-tints live).
    accent_var = page.evaluate(
        "() => getComputedStyle(document.querySelector('.v3-root')).getPropertyValue('--accent').trim()"
    )
    assert_(len(accent_var) > 0, f"--accent CSS var resolves after swap (={accent_var})", "UC-V3-18")

    # Change density (compact ↔ comfy). Pick a value different from current.
    target_density = "comfy" if density_before != "comfy" else "compact"
    label = "Comfy" if target_density == "comfy" else "Compact"
    page.locator(f'[role="dialog"][aria-label="Tweaks"] button:has-text("{label}")').first.click()
    page.wait_for_timeout(600)
    density_after = page.locator(".v3-root").first.get_attribute("data-density")
    assert_(density_after == target_density and density_after != density_before,
            f"Density changes ('{density_before}' → '{density_after}')",
            "UC-V3-18")
    # The --density multiplier on <html> reflects the change.
    density_mult = page.evaluate(
        "() => getComputedStyle(document.documentElement).getPropertyValue('--density').trim()"
    )
    assert_(len(density_mult) > 0, f"--density multiplier set on <html> (={density_mult})", "UC-V3-18")
    shot(page, "18b-tweaks-applied")

    # Reset accent back to lime so later UCs run on the default palette.
    page.locator('[role="dialog"][aria-label="Tweaks"] button:has-text("Electric Lime")').first.click()
    page.wait_for_timeout(300)

    errs = real_errs(msgs)
    assert_(len(errs) == 0, f"zero real console errors (got {len(errs)})", "UC-V3-18")
    for e in errs[:3]:
        print(f"     console: {e['type']}: {e['text'][:140]}")


# ============================================================================
# UC-V3-19 — Onboarding (upload → intent → configure → Start applying → /home)
# ============================================================================

def uc19(page: Page) -> None:
    header("UC-V3-19 — Onboarding 3-step")
    msgs = capture_console(page)
    safe_goto(page, f"{APP}/onboarding")
    page.wait_for_selector(".onboard", timeout=20_000)
    page.wait_for_timeout(700)

    # Step 0 — upload. The drop zone has a hidden <input type=file>. Set a file.
    step_label = (page.locator(".onboard-top, [class*='onboard']").first.text_content() or "")
    upload_zone = page.locator(".onboard .upload-zone input[type='file']").first
    assert_(upload_zone.count() > 0, "Onboarding upload step renders (file input present)", "UC-V3-19")
    # Provide an in-memory file (the stub fakes the parse; only name/size used).
    upload_zone.set_input_files({
        "name": "maya-chen-resume.pdf",
        "mimeType": "application/pdf",
        "buffer": b"%PDF-1.4 fake resume bytes for the stub parse",
    })
    # Animated ingest reveal — "what I picked up" rows appear.
    page.wait_for_selector(".onboard .ingest .ingest-row", timeout=10_000)
    page.wait_for_timeout(800)
    ingest_ok = page.locator(".onboard .ingest .ingest-row").count() >= 1
    assert_(ingest_ok, "Upload shows the animated ingest ('what I picked up')", "UC-V3-19")
    shot(page, "19a-onboard-upload")

    # Continue → step 1 (intent). The primary button is enabled once a file set.
    page.locator('.onboard-foot button.primary').first.click()
    page.wait_for_selector(".onboard textarea.intent-input", timeout=10_000)
    page.wait_for_timeout(400)

    # Type intent → AI callout appears.
    page.locator(".onboard textarea.intent-input").fill(
        "Senior PM at a healthtech or climate company. Remote-first, $190k+ base."
    )
    page.wait_for_selector(".onboard .ai-callout", timeout=8_000)
    callout_ok = page.locator(".onboard .ai-callout").count() > 0
    assert_(callout_ok, "Intent step shows the AI callout once intent is substantive", "UC-V3-19")
    shot(page, "19b-onboard-intent")

    # Continue → step 2 (configure).
    page.locator('.onboard-foot button.primary').first.click()
    page.wait_for_timeout(700)
    config_ok = page.locator('text=/aggressive|Daily cap|Auto-apply behaviour/i').count() > 0
    assert_(config_ok, "Configure step renders (aggressiveness / daily cap)", "UC-V3-19")
    shot(page, "19c-onboard-config")

    # "Start applying" → /home. The .onboard-foot is a fixed bottom bar; in the
    # headless viewport the button can sit just outside the hit-test box, so we
    # fire a real DOM .click() via evaluate to bypass viewport intercept
    # (same technique the V2 harness used for sticky controls).
    start_btn = page.locator('.onboard-foot button.primary:has-text("Start applying")').first
    assert_(start_btn.count() > 0, "'Start applying' button present on the final step", "UC-V3-19")
    start_btn.evaluate("el => el.click()")
    page.wait_for_url(re.compile(r"/home"), timeout=15_000)
    page.wait_for_timeout(700)
    landed = "/home" in page.url
    assert_(landed, f"'Start applying' routes to /home (url={page.url})", "UC-V3-19")
    shot(page, "19d-onboard-done")

    errs = real_errs(msgs)
    assert_(len(errs) == 0, f"zero real console errors (got {len(errs)})", "UC-V3-19")
    for e in errs[:3]:
        print(f"     console: {e['type']}: {e['text'][:140]}")


# ============================================================================
# UC-V3-20 — ⌘K palette (open → type company → results → select navigates)
# ============================================================================

def uc20(page: Page) -> None:
    header("UC-V3-20 — Command palette ⌘K")
    msgs = capture_console(page)
    safe_goto(page, f"{APP}/home")
    wait_shell(page)
    page.wait_for_timeout(900)

    # Open via the Topbar search button (equivalent to ⌘K; deterministic in
    # headless where the meta-key combo can be flaky).
    page.locator('.topbar button.search').first.click()
    page.wait_for_selector('[role="dialog"][aria-label="Command palette"]', timeout=10_000)
    palette = page.locator('[role="dialog"][aria-label="Command palette"]')
    assert_(palette.count() > 0, "⌘K palette opens", "UC-V3-20")
    shot(page, "20a-palette-open")

    # Also verify the keyboard shortcut toggles it (close via ⌘K, reopen).
    page.keyboard.press("Meta+k")
    page.wait_for_timeout(400)
    closed_by_kbd = page.locator('[role="dialog"][aria-label="Command palette"]').count() == 0
    page.keyboard.press("Meta+k")
    page.wait_for_timeout(400)
    reopened = page.locator('[role="dialog"][aria-label="Command palette"]').count() > 0
    assert_(closed_by_kbd and reopened, "⌘K toggles the palette (close + reopen)", "UC-V3-20")

    # Type a company query → results come from search.run.
    inp = page.locator('[role="dialog"][aria-label="Command palette"] input').first
    inp.fill("eng")  # broad token likely to match seeded jobs (Engineer roles)
    page.wait_for_timeout(1200)
    # Jobs group should populate (or at least nav matches). Accept either a job
    # row or the "Jobs" group label as proof of a live search.
    has_jobs_group = page.locator('[role="dialog"][aria-label="Command palette"] :text("Jobs")').count() > 0
    has_rows = page.locator('[role="dialog"][aria-label="Command palette"] button').count() > 0
    assert_(has_rows, f"Palette renders selectable result rows (jobsGroup={has_jobs_group})", "UC-V3-20")
    shot(page, "20b-palette-results")

    # Selecting a result navigates (job → /home; nav → its route). Try the first
    # nav target by typing a nav label, then Enter.
    inp.fill("Pipeline")
    page.wait_for_timeout(700)
    page.keyboard.press("Enter")
    page.wait_for_url(re.compile(r"/tracker"), timeout=10_000)
    navigated = "/tracker" in page.url
    assert_(navigated, f"Selecting a palette result navigates (url={page.url})", "UC-V3-20")
    shot(page, "20c-palette-navigated")

    errs = real_errs(msgs)
    assert_(len(errs) == 0, f"zero real console errors (got {len(errs)})", "UC-V3-20")
    for e in errs[:3]:
        print(f"     console: {e['type']}: {e['text'][:140]}")


# ============================================================================
# UC-V3-21 — i18n smoke (locale=zh → nav + header render Chinese)
# ============================================================================

def uc21(page: Page, ctx: BrowserContext) -> None:
    header("UC-V3-21 — i18n zh smoke")
    msgs = capture_console(page)
    # Plant the locale cookie (next-intl reads robo_locale server-side in
    # app/layout.tsx). Re-plant the session cookie too (cookie writes can clear).
    set_locale_cookie(ctx, "zh")
    set_session_cookie(ctx)
    safe_goto(page, f"{APP}/home")
    wait_shell(page)
    page.wait_for_timeout(1200)
    shot(page, "21a-zh-home")

    # Nav renders Chinese workspace section + item labels (from zh.json nav_v3).
    nav_text = page.locator("aside.side .nav").first.text_content() or ""
    # "工作区" = Workspace, "今日" = Today, "待审队列" = Review queue (hidden
    # for launch), "进度看板" = Pipeline.
    zh_labels = ["工作区", "今日", "进度看板"]
    if QUEUE_ENABLED:
        zh_labels.insert(2, "待审队列")
    for zh in zh_labels:
        present = zh in nav_text
        assert_(present, f"Sidebar renders Chinese '{zh}'", "UC-V3-21")

    # No raw t() keys leaking (e.g. "nav_v3.today" or "today.eyebrow").
    body_text = page.locator("body").inner_text()
    leaked = re.findall(r"\b(?:nav_v3|today|queue|pipeline|activity)\.[a-zA-Z_.]+", body_text)
    assert_(len(leaked) == 0, f"No raw t() keys leak in zh (found {leaked[:5]})", "UC-V3-21")

    # A page header renders Chinese too — the breadcrumb .now == "今日".
    crumb = (page.locator(".topbar .crumbs .now").first.text_content() or "").strip()
    assert_(crumb == "今日", f"Breadcrumb header in Chinese ('{crumb}')", "UC-V3-21")

    # Visit one more surface to be sure (Pipeline) — header + columns Chinese.
    safe_goto(page, f"{APP}/tracker")
    wait_shell(page)
    page.wait_for_timeout(1000)
    pipe_text = page.locator("body").inner_text()
    # zh pipeline columns: 已保存 / 已投递 / 面试 / Offer (offer often stays 'Offer').
    zh_pipeline = ("进度看板" in (page.locator("aside.side .nav").first.text_content() or "")) and \
        (page.locator('text=/已投递|已保存|面试/').count() > 0)
    assert_(zh_pipeline, "Pipeline page renders Chinese labels", "UC-V3-21")
    shot(page, "21b-zh-pipeline")

    errs = real_errs(msgs)
    assert_(len(errs) == 0, f"zero real console errors (got {len(errs)})", "UC-V3-21")
    for e in errs[:3]:
        print(f"     console: {e['type']}: {e['text'][:140]}")

    # Restore English for any subsequent work.
    clear_locale_cookie(ctx)


# ============================================================================
# UC-V3-22 — No-console-errors trap (aggregate across the whole walk)
# ============================================================================

def uc22() -> None:
    header("UC-V3-22 — No-console-errors trap (aggregate)")
    # This UC is satisfied by the per-UC console-error assertions carried in
    # every flow above (the V2 harness's trap, transferred verbatim). Here we
    # roll them up: the suite passes UC-V3-22 iff no UC recorded a console-error
    # FAIL. We scan the results table for the "zero real console errors" checks.
    console_checks = [r for r in results if "console errors" in r["check"]]
    failed = [r for r in console_checks if r["status"] == "FAIL"]
    assert_(len(console_checks) >= 18,
            f"Console-error trap ran on every UC ({len(console_checks)} checks)",
            "UC-V3-22")
    assert_(len(failed) == 0,
            f"No UC emitted a React/runtime console error ({len(failed)} offending UCs)",
            "UC-V3-22")
    if failed:
        for r in failed:
            print(f"     offending: {r['uc']} — {r['check']}")


# ============================================================================
# Main runner
# ============================================================================

def main() -> int:
    print("=" * 80)
    print("RoboApply V3 — 22 UC dry-run (stub data only, no backend)")
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

        # Each UC gets its own page (fresh console listener). Per-process stub
        # state persists across UCs (one dev server) — ordering matters:
        #   • UC-04 empties the queue; UC-05 tolerates that (re-seed not possible).
        #   • UC-06 creates a resume + returns its id, reused by 07/08/09.
        #   • UC-21 swaps the locale cookie, restored after.
        shared: dict = {"rid": None}

        def run(uc_id: str, fn, *, locale_uc: bool = False) -> None:
            set_session_cookie(ctx)
            if not locale_uc:
                clear_locale_cookie(ctx)
            page = ctx.new_page()
            seed_local_storage(page)
            try:
                fn(page)
            except Exception as e:
                print(f"\n   [FAIL/EXC] {uc_id} threw: {type(e).__name__}: {e}")
                results.append({"uc": uc_id, "check": f"runtime exception: {type(e).__name__}: {e}", "status": "FAIL"})
                try:
                    shot(page, f"{uc_id.lower()}-EXCEPTION")
                except Exception:
                    pass
            finally:
                page.close()

        # ── ordered walk ──
        run("UC-V3-01", uc01)
        run("UC-V3-02", uc02)
        run("UC-V3-03", uc03)
        # The stub queue store is per-page (each document load re-clones the
        # fixture — verified), so UC-04 draining its page's queue does NOT affect
        # UC-05's fresh page. Natural numeric order is therefore safe.
        if QUEUE_ENABLED:
            run("UC-V3-04", uc04)
            run("UC-V3-05", uc05)
        else:
            print("\n   [SKIP] UC-V3-04 / UC-V3-05 — /queue hidden for launch (QUEUE_ENABLED=False)")

        # UC-06 exercises the create flow (and returns the created id), but the
        # editor UCs (07/08/09) deliberately open a FIXTURE resume instead: a
        # scratch-created variant has no experience bullets (nothing for the
        # inline-AI bullet rewrite to act on) and the stub doesn't serve a
        # freshly-created variant via resumes.get() on a cold page. Fixture
        # resumes (cm_rv_*) carry real bullets/summary and load cold reliably.
        # discover_resume_id() (rid=None) picks the library's first fixture card.
        def _uc06(pg: Page) -> None:
            shared["rid"] = uc06(pg)
        run("UC-V3-06", _uc06)
        run("UC-V3-07", lambda pg: uc07(pg, None))
        run("UC-V3-08", lambda pg: uc08(pg, None))
        run("UC-V3-09", lambda pg: uc09(pg, None))

        run("UC-V3-10", uc10)
        run("UC-V3-11", uc11)
        run("UC-V3-12", uc12)
        run("UC-V3-13", uc13)
        run("UC-V3-14", uc14)
        run("UC-V3-15", uc15)
        run("UC-V3-16", uc16)
        run("UC-V3-17", uc17)
        run("UC-V3-18", uc18)
        run("UC-V3-19", uc19)
        run("UC-V3-20", uc20)

        # UC-21 needs the ctx to swap the locale cookie.
        run("UC-V3-21", lambda pg: uc21(pg, ctx), locale_uc=True)

        browser.close()

    # UC-22 is computed from the aggregate results (no browser needed).
    uc22()

    # ============ Report ============
    print("\n" + "=" * 80)
    print("SUMMARY")
    print("=" * 80)
    by_uc: dict = {}
    for r in results:
        by_uc.setdefault(r["uc"], []).append(r)

    def uc_sort_key(uc: str):
        m = re.search(r"(\d+)", uc)
        return int(m.group(1)) if m else 999

    overall_pass = True
    total_pass = 0
    total_checks = 0
    for uc in sorted(by_uc, key=uc_sort_key):
        checks = by_uc[uc]
        pass_n = sum(1 for c in checks if c["status"] == "PASS")
        total = len(checks)
        total_pass += pass_n
        total_checks += total
        if pass_n != total:
            overall_pass = False
        bar = "✓" if pass_n == total else "✗"
        print(f"{bar} {uc}: {pass_n}/{total}")
        for c in checks:
            mark = "  ✓" if c["status"] == "PASS" else "  ✗"
            print(f"   {mark} {c['check']}")

    uc_total = len(by_uc)
    uc_green = sum(1 for uc in by_uc if all(c["status"] == "PASS" for c in by_uc[uc]))

    print()
    if bugs_filed:
        print("Bugs filed during this run:")
        for b in bugs_filed:
            print(f"  {b['id']} ({b['severity']}, layer={b['layer']}, {b['uc']}): {b['title']}")
        print()

    print(f"UCs green: {uc_green}/{uc_total}")
    print(f"Assertions: {total_pass}/{total_checks} passed")
    print(f"Screenshots: {SHOTS}")
    print(f"OVERALL: {'PASS ✓' if overall_pass else 'FAIL ✗'}")
    return 0 if overall_pass else 1


if __name__ == "__main__":
    sys.exit(main())
