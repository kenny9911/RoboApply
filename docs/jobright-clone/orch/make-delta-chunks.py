#!/usr/bin/env python3
"""Per-locale translation gap -> translator chunks. Run AFTER `node scripts/i18n-merge-staging.mjs`.
usage: make-delta-chunks.py [--size 450]
For each bundle kind (web, email, extension) and each non-English locale it lists the English leaf
paths that the locale bundle lacks (i18n/staging/_pending-translation.json is cumulative and stale, so
it is not used) and writes .i18n-work/in/<kind>/<locale>/<nn>.json (nested English source). Translators
write .i18n-work/out/<kind>/<locale>/<nn>.json; apply with apply-translations.mjs. Older in/ and out/
folders are moved aside first. Prints the manifest summary and writes .i18n-work/manifest.json."""
import json, os, sys, collections, shutil, time
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
SIZE = int(sys.argv[sys.argv.index('--size') + 1]) if '--size' in sys.argv else 450
LOCALES = ['zh', 'zh-TW', 'ja', 'ko', 'es', 'fr', 'pt', 'de']
# Same scoping as scripts/check-copy.mjs: GoApply-only copy is required in en and zh only.
GOAPPLY_ONLY = ['authCn', 'billingCn', 'jobsCn', 'onboardingCn', 'practiceCn', 'notifyCn', 'campus', 'landing.cnHome']
ZH_ONLY = {'email': ['tracker.csvCn', 'tracker.inboxCn'], 'extension': ['extension-cn']}
BUNDLE = {'web': 'i18n/messages/{}.json', 'email': 'server/src/i18n/email/{}.json', 'extension': 'extension/src/i18n/{}.json'}
def under(path, prefixes): return any(path == p or path.startswith(p + '.') for p in prefixes)
def leaves(o, p=''):
    for k, v in o.items():
        q = f'{p}.{k}' if p else k
        if isinstance(v, dict): yield from leaves(v, q)
        else: yield q, v
def get(o, p):
    for k in p.split('.'):
        if not isinstance(o, dict) or k not in o: return None
        o = o[k]
    return o
def setp(d, path, v):
    ks = path.split('.'); o = d
    for k in ks[:-1]: o = o.setdefault(k, {})
    o[ks[-1]] = v
work = os.path.join(ROOT, '.i18n-work'); os.makedirs(work, exist_ok=True)
stamp = time.strftime('%Y%m%d-%H%M%S')
for d in ('in', 'out'):
    if os.path.isdir(os.path.join(work, d)): shutil.move(os.path.join(work, d), os.path.join(work, f'prev-{d}-{stamp}'))
manifest = []
for kind, pat in BUNDLE.items():
    en_path = os.path.join(ROOT, pat.format('en'))
    if not os.path.exists(en_path): continue
    en = json.load(open(en_path))
    for locale in LOCALES:
        lp = os.path.join(ROOT, pat.format(locale))
        loc = json.load(open(lp)) if os.path.exists(lp) else {}
        missing = []
        for path, val in leaves(en):
            if not isinstance(val, str): continue
            if kind == 'web' and under(path, GOAPPLY_ONLY) and locale != 'zh': continue
            if under(path, ZH_ONLY.get(kind, [])) and locale != 'zh': continue
            cur = get(loc, path)
            if not isinstance(cur, str) or not cur.strip(): missing.append((path, val))
        if not missing: continue
        groups = collections.OrderedDict()
        for path, val in sorted(missing): groups.setdefault(path.split('.')[0], []).append((path, val))
        chunks, cur = [], []
        for ns, items in groups.items():
            while items:
                room = SIZE - len(cur)
                if len(items) <= room or not cur:
                    take = items[:SIZE] if not cur else items[:room]
                    cur += take; items = items[len(take):]
                    if len(cur) >= SIZE: chunks.append(cur); cur = []
                else:
                    chunks.append(cur); cur = []
        if cur: chunks.append(cur)
        for i, ch in enumerate(chunks, 1):
            src = {}
            for path, val in ch: setp(src, path, val)
            rel_in = f'.i18n-work/in/{kind}/{locale}/{i:02d}.json'; rel_out = f'.i18n-work/out/{kind}/{locale}/{i:02d}.json'
            for rel in (rel_in, rel_out): os.makedirs(os.path.dirname(os.path.join(ROOT, rel)), exist_ok=True)
            json.dump(src, open(os.path.join(ROOT, rel_in), 'w'), ensure_ascii=False, indent=1)
            manifest.append({'l': locale, 't': kind, 'c': f'{i:02d}', 'count': len(ch), 'namespaces': sorted({p.split('.')[0] for p, _ in ch})})
json.dump(manifest, open(os.path.join(work, 'manifest.json'), 'w'), indent=1)
tot = collections.Counter(); n = collections.Counter()
for m in manifest: tot[(m['t'], m['l'])] += m['count']; n[(m['t'], m['l'])] += 1
for (t, l), c in sorted(tot.items()): print(f'{t}/{l}: {c} strings in {n[(t, l)]} chunk(s)')
print('total chunks', len(manifest), 'strings', sum(tot.values()))
