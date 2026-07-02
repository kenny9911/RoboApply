#!/usr/bin/env python3
"""RoboApply — Tweaks → Accent picker verification.

Opens the Tweaks slide-over, clicks each of the four accents
(Lime / Violet / Cyan / Pink), and asserts that:

  1. the `data-accent` attribute on the `.dark-canvas` wrapper flips to
     the chosen accent id, and
  2. the resolved `--dc-accent` CSS variable (read via a probe element)
     matches the expected swatch colour for that accent.

A screenshot of the app under each accent is captured to
/tmp/accent-shots/<accent>.png.

Run (server must already be up on :3611):
  python3 roboapply/e2e/verify-accent-picker.py
"""

import json
import os
import sys
import urllib.request
import urllib.error
from pathlib import Path

from playwright.sync_api import sync_playwright, Page

APP = "http://localhost:3611"
BACKEND = os.environ.get("RA_V2_BACKEND", "http://localhost:4607")
DEMO_EMAIL = os.environ.get("RA_V2_DEMO_EMAIL", "demo@robohire.io")
DEMO_PASSWORD = os.environ.get("RA_V2_DEMO_PASSWORD", "demo1234")
SHOTS = Path("/tmp/accent-shots")
SHOTS.mkdir(exist_ok=True)

# accent id → (button label in TweaksPanel, expected --dc-accent as rgb)
ACCENTS = [
    ("lime",   "Electric Lime", "rgb(198, 255, 58)"),
    ("violet", "Plasma Violet", "rgb(182, 145, 255)"),
    ("cyan",   "Liquid Cyan",   "rgb(103, 232, 249)"),
    ("pink",   "Hot Pink",      "rgb(255, 122, 217)"),
]

results: list[tuple[bool, str]] = []


def check(cond: bool, msg: str) -> None:
    results.append((cond, msg))
    print(f"   [{'PASS' if cond else 'FAIL'}] {msg}")


def login_token() -> str | None:
    body = json.dumps({"email": DEMO_EMAIL, "password": DEMO_PASSWORD}).encode()
    req = urllib.request.Request(
        f"{BACKEND}/api/auth/login",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return (json.load(resp) or {}).get("data", {}).get("token")
    except Exception as e:
        print(f"   (login failed, falling back to presence cookie: {type(e).__name__})")
        return None


def probe_accent_rgb(page: Page) -> str:
    """Inject a span coloured `var(--dc-accent)` inside .dark-canvas and read
    back its resolved rgb. Robust against custom-property substitution quirks."""
    return page.evaluate(
        """() => {
            const root = document.querySelector('.dark-canvas');
            if (!root) return 'NO_ROOT';
            const probe = document.createElement('span');
            probe.style.color = 'var(--dc-accent)';
            probe.style.position = 'absolute';
            probe.style.opacity = '0';
            root.appendChild(probe);
            const rgb = getComputedStyle(probe).color;
            probe.remove();
            return rgb;
        }"""
    )


def main() -> int:
    print("=" * 70)
    print("RoboApply — Accent picker verification")
    print("=" * 70)

    token = login_token() or "stub-dry-run-no-backend"

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(viewport={"width": 1440, "height": 900})
        ctx.add_cookies([{
            "name": "session_token", "value": token,
            "domain": "localhost", "path": "/",
            "httpOnly": False, "secure": False, "sameSite": "Lax",
        }])
        page = ctx.new_page()
        page.add_init_script(
            f"try {{ window.localStorage.setItem('auth_token', '{token}'); }} catch (e) {{}}"
        )

        page.goto(f"{APP}/home", wait_until="domcontentloaded", timeout=30_000)
        # Wait for the dark-canvas shell (carries data-accent).
        page.wait_for_selector('.dark-canvas', timeout=20_000)
        page.wait_for_timeout(1500)

        open_btn = page.get_by_role("button", name="Open tweaks")
        check(open_btn.count() > 0, "Tweaks button present in LeftRail")

        for accent_id, label, expected_rgb in ACCENTS:
            print(f"\n-- accent: {accent_id} ({label}) --")
            # Open the panel
            open_btn.first.click()
            page.wait_for_selector('aside:has-text("Make it")', timeout=6_000)
            page.wait_for_timeout(300)

            # Click the accent button
            accent_btn = page.get_by_role("button", name=label)
            if accent_btn.count() == 0:
                check(False, f"accent button '{label}' present")
                page.locator('aside button[aria-label="Close"]').first.click()
                continue
            accent_btn.first.click()
            page.wait_for_timeout(500)

            # Read state WHILE the panel is open — the `.dark-canvas` wrapper
            # underneath the overlay already carries the updated attribute, and
            # reading via get_attribute/evaluate doesn't require a click on the
            # (skeleton-intercepted) main content.
            # 1. data-accent attribute flipped
            data_accent = page.get_attribute('.dark-canvas', 'data-accent')
            check(data_accent == accent_id,
                  f"data-accent == '{accent_id}' (got '{data_accent}')")

            # 2. resolved --dc-accent colour matches the swatch
            rgb = probe_accent_rgb(page)
            check(rgb == expected_rgb,
                  f"--dc-accent resolves to {expected_rgb} (got '{rgb}')")

            # Close the panel via the header X (scoped to the aside so it isn't
            # the full-screen backdrop button). Then screenshot the themed app.
            page.locator('aside button[aria-label="Close"]').first.click()
            page.wait_for_timeout(700)
            page.screenshot(path=str(SHOTS / f"{accent_id}.png"), full_page=False)

        browser.close()

    print("\n" + "=" * 70)
    passed = sum(1 for ok, _ in results if ok)
    total = len(results)
    print(f"RESULT: {passed}/{total} checks passed")
    print(f"Screenshots: {SHOTS}")
    ok = passed == total
    print(f"OVERALL: {'PASS ✓' if ok else 'FAIL ✗'}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
