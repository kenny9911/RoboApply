#!/usr/bin/env python3
"""One-shot: download the latin-subset woff2 for each font family used in
app/layout.tsx from the Google Fonts CSS2 API, so the build no longer fetches
fonts at build time. Emits a JSON manifest to wire into layout.tsx.

Run once (Google Fonts must be reachable); the woff2 files are then committed.
"""
import json, os, re, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")

# (slug, CSS2 family query) — query weights/styles match layout.tsx.
FAMILIES = [
    ("geist",            "Geist:wght@100..900"),
    ("geist-mono",       "Geist+Mono:wght@100..900"),
    ("inter",            "Inter:wght@100..900"),
    ("poppins",          "Poppins:wght@400;500;600;700"),
    ("roboto",           "Roboto:wght@400;500;700"),
    ("source-sans-3",    "Source+Sans+3:wght@200..900"),
    ("merriweather",     "Merriweather:wght@400;700"),
    ("lora",             "Lora:wght@400..700"),
    ("space-grotesk",    "Space+Grotesk:wght@400;500;600;700"),
    ("instrument-serif", "Instrument+Serif:ital@0;1"),
    ("jetbrains-mono",   "JetBrains+Mono:wght@400;500;600"),
]

FACE_RE = re.compile(r"@font-face\s*\{([^}]*)\}", re.S)

def fetch(url):
    # Use curl — this machine's Python lacks a configured CA bundle, but curl
    # verifies fine. -f fails on HTTP errors so we don't write garbage.
    return subprocess.run(
        ["curl", "-fsSL", "--max-time", "40", "-A", UA, url],
        check=True, capture_output=True,
    ).stdout

def field(block, name):
    m = re.search(rf"{name}\s*:\s*([^;]+);", block)
    return m.group(1).strip() if m else ""

manifest = {}
for slug, query in FAMILIES:
    css = fetch(f"https://fonts.googleapis.com/css2?family={query}&display=swap").decode("utf-8")
    src_entries = []
    seen = set()
    for block in FACE_RE.findall(css):
        urange = field(block, "unicode-range")
        # latin subset = the block whose range covers U+0000-00FF.
        if "U+0000-00FF" not in urange.replace(" ", "").upper().replace("U+0000-00FF", "U+0000-00FF"):
            if "0000-00ff" not in urange.lower():
                continue
        m = re.search(r"src\s*:\s*url\(([^)]+\.woff2)\)", block)
        if not m:
            continue
        woff2_url = m.group(1).strip().strip('"').strip("'")
        weight = field(block, "font-weight") or "400"
        style = field(block, "font-style") or "normal"
        key = (weight, style)
        if key in seen:
            continue
        seen.add(key)
        wlabel = weight.replace(" ", "-")
        fname = f"{slug}-{wlabel}{'-italic' if style == 'italic' else ''}.woff2"
        data = fetch(woff2_url)
        with open(os.path.join(HERE, fname), "wb") as fh:
            fh.write(data)
        src_entries.append({"file": fname, "weight": weight, "style": style, "bytes": len(data)})
    if not src_entries:
        print(f"!! {slug}: no latin face found", file=sys.stderr)
    manifest[slug] = src_entries

print(json.dumps(manifest, indent=2))
