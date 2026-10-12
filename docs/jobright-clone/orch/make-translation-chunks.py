#!/usr/bin/env python3
"""Split i18n/staging/_pending-translation.json into per-locale translator chunks.
usage: make-translation-chunks.py [--size 600]
Writes .i18n-work/in/<target>/<locale>/<nn>.json (nested EN source) and a manifest
.i18n-work/manifest.json listing {locale,target,chunk,in,out,count,namespaces}."""
import json, os, sys, collections
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
SIZE = int(sys.argv[sys.argv.index('--size') + 1]) if '--size' in sys.argv else 600
LOCALES = ['zh', 'zh-TW', 'ja', 'ko', 'es', 'fr', 'pt', 'de']
GOAPPLY_LOCALES = ['en', 'zh']
GOAPPLY_ONLY = ['authCn', 'billingCn', 'jobsCn', 'onboardingCn', 'practiceCn', 'notifyCn', 'campus', 'landing.cnHome']
ZH_ONLY = {'email': ['tracker.csvCn', 'tracker.inboxCn'], 'extension': ['extension-cn']}
def under(path, prefixes): return any(path == p or path.startswith(p + '.') for p in prefixes)
def setp(d, path, v):
    ks = path.split('.'); o = d
    for k in ks[:-1]: o = o.setdefault(k, {})
    o[ks[-1]] = v
pending = json.load(open(os.path.join(ROOT, 'i18n/staging/_pending-translation.json')))
work = os.path.join(ROOT, '.i18n-work'); manifest = []
for locale in LOCALES:
    by = collections.defaultdict(list)
    for e in pending:
        t, p = e['bundle'], e['path']
        if locale in (e.get('provided') or []): continue
        if t == 'web' and under(p, GOAPPLY_ONLY) and locale not in GOAPPLY_LOCALES: continue
        if under(p, ZH_ONLY.get(t, [])) and locale != 'zh': continue
        by[t].append((p, e['en']))
    for t, entries in by.items():
        # keep namespaces together; pack greedily
        groups = collections.OrderedDict()
        for p, en in sorted(entries):
            groups.setdefault(p.split('.')[0], []).append((p, en))
        chunks, cur = [], []
        for ns, items in groups.items():
            while items:
                room = SIZE - len(cur)
                if len(items) <= room or not cur:
                    take = items[:max(room, SIZE) if not cur else room]
                    cur += take; items = items[len(take):]
                    if len(cur) >= SIZE: chunks.append(cur); cur = []
                else:
                    chunks.append(cur); cur = []
        if cur: chunks.append(cur)
        for i, ch in enumerate(chunks, 1):
            src = {}
            for p, en in ch: setp(src, p, en)
            rel_in = f'.i18n-work/in/{t}/{locale}/{i:02d}.json'; rel_out = f'.i18n-work/out/{t}/{locale}/{i:02d}.json'
            os.makedirs(os.path.dirname(os.path.join(ROOT, rel_in)), exist_ok=True)
            os.makedirs(os.path.dirname(os.path.join(ROOT, rel_out)), exist_ok=True)
            json.dump(src, open(os.path.join(ROOT, rel_in), 'w'), ensure_ascii=False, indent=1)
            manifest.append({'locale': locale, 'target': t, 'chunk': f'{i:02d}', 'in': rel_in, 'out': rel_out, 'count': len(ch), 'namespaces': sorted({p.split('.')[0] for p, _ in ch})})
json.dump(manifest, open(os.path.join(work, 'manifest.json'), 'w'), indent=1)
tot = collections.Counter(); n = collections.Counter()
for m in manifest: tot[m['locale']] += m['count']; n[m['locale']] += 1
for l in LOCALES: print(f'{l}: {tot[l]} strings in {n[l]} chunks')
print('total chunks', len(manifest), 'strings', sum(tot.values()))
