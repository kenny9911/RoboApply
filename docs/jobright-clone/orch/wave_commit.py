#!/usr/bin/env python3
"""Commit each work item's worktree on its wp/<id> branch after an ownership check, then merge
into feat/jobright-clone.
usage: wave_commit.py [--items <json>] [--dry-run] [--no-merge] [--allow ID:path ...] ID...
Refuses an item with unowned changes unless every unowned path is passed via --allow ID:path."""
import json, subprocess, sys, os, re
HERE = os.path.dirname(os.path.abspath(__file__))
CLONE = '/Users/kenny/code/RoboApply/.claude/worktrees/jobright-clone'
WTROOT = '/Users/kenny/code/RoboApply/.claude/worktrees'
NOISE = re.compile(r'^(node_modules$|interview-agent/node_modules$|extension/node_modules$|next-env\.d\.ts$|tsconfig\.tsbuildinfo$|server/src/generated/|\.next/|coverage/|extension/dist/|extension/\.output/|extension/test-results/|extension/playwright-report/)')
args = sys.argv[1:]
dry = '--dry-run' in args; nomerge = '--no-merge' in args
items_path = os.path.join(HERE, 'int-bundles.json')
allow = {}; ids = []; i = 0
while i < len(args):
    a = args[i]
    if a == '--allow':
        wid, path = args[i+1].split(':', 1); allow.setdefault(wid, set()).add(path); i += 2; continue
    if a == '--items':
        items_path = args[i+1]; i += 2; continue
    if not a.startswith('--'): ids.append(a)
    i += 1
raw = json.load(open(items_path))
ITEMS = {w['id']: w for w in (raw['bundles'] if isinstance(raw, dict) else raw)}
def git(*a, cwd=None, check=True):
    r = subprocess.run(['git', *a], cwd=cwd, capture_output=True, text=True)
    if check and r.returncode:
        print(f'!! git {a[:3]} FAILED in {cwd}: {r.stderr.strip()}')
        raise SystemExit(3)
    return r.stdout
def namespaces(w):
    return [n.strip() for n in re.split(r'[,\s]+', re.sub(r'\(.*?\)', '', w.get('namespace') or '')) if n.strip()]
def owned(path, w):
    for o in w['owns']:
        if path == o or (o.endswith('/') and path.startswith(o)): return True
    for ns in namespaces(w):
        if re.fullmatch(rf'i18n/staging/{re.escape(ns)}(\.[\w-]+)?\.(en|zh)\.json', path): return True
    return False
exit_code = 0
for wid in ids:
    w = ITEMS[wid]; wt = f'{WTROOT}/wp-{wid}'
    if not os.path.isdir(wt): print(f'!! {wid}: no worktree'); exit_code = 1; continue
    out = git('status', '--porcelain=v1', '-uall', '-z', cwd=wt)
    entries = [e for e in out.split('\0') if e]; paths = []; skip = False
    for e in entries:
        if skip: skip = False; continue
        if e[0] == 'R': skip = True
        paths.append(e[3:])
    paths = [p for p in paths if not NOISE.match(p)]
    own = [p for p in paths if owned(p, w) or p in allow.get(wid, set())]
    bad = [p for p in paths if p not in own]
    print(f'== {wid} ({w["title"][:60]}): {len(own)} owned changes, {len(bad)} unowned')
    for p in bad: print(f'   UNOWNED: {p}')
    if bad: exit_code = 1; continue
    if not own: print('   (nothing to commit)'); continue
    if dry: continue
    # every change is owned/allowed (checked above), so stage the whole tree; naming paths
    # fails for deletions an agent already staged with `git rm`.
    git('add', '-A', '--', '.', cwd=wt)   # next-env.d.ts is gitignored; naming an ignored path makes git add fail
    msg = f'feat(int): {w["title"]} ({wid})\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n'
    subprocess.run(['git', 'commit', '-q', '-F', '-'], input=msg, text=True, cwd=wt, check=True)
    print('   committed', git('log', '--oneline', '-1', cwd=wt).strip())
    if not nomerge:
        r = subprocess.run(['git', 'merge', '--no-ff', '-q', '-m', f'Merge {wid}: {w["title"]}', f'wp/{wid}'], cwd=CLONE, capture_output=True, text=True)
        if r.returncode:
            print(f'   MERGE CONFLICT for {wid}:\n{r.stdout}{r.stderr}'); exit_code = 2; break
        print('   merged into feat/jobright-clone')
sys.exit(exit_code)
