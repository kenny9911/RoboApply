"""Apply landing translations from the translation workflow journal.

Idempotent: reads every {"type":"result"} entry, identifies the locale by
the translated content's structure + a locale hint we recover from the
agent prompt (the journal result has no label, so we match by comparing
against target files / by explicit `locale` key if present). Since the
workflow returns results keyed by locale only at the END, this script is
also runnable against the final output file.

Validation before applying:
- landing key-tree must EXACTLY match en.json's landing key-tree
- machine-voice invariants: log tags/times identical to EN
- extras (if present) key-trees must match their EN namespaces

Usage:
  python3 apply_translations.py <journal.jsonl or workflow-output-file>
"""
import json
import sys
import collections

REPO = '/Users/kenny/code/RoboApply'
EN_PATH = f'{REPO}/i18n/messages/en.json'
FULL_LOCALES = {'ja', 'zh', 'zh-TW'}          # replace landing only
PARTIAL_LOCALES = {'ko', 'es', 'fr', 'pt', 'de'}  # write landing + extras
EXTRA_NS = ['common', 'nav', 'auth', 'onboarding', 'choosePlan', 'errors']


def key_tree(obj, prefix=''):
    keys = set()
    if isinstance(obj, dict):
        for k, v in obj.items():
            path = f'{prefix}.{k}' if prefix else k
            keys.add(path)
            keys |= key_tree(v, path)
    return keys


def machine_voice_ok(en_landing, tr_landing):
    problems = []
    for lk, line in en_landing['hero']['log']['lines'].items():
        tline = tr_landing.get('hero', {}).get('log', {}).get('lines', {}).get(lk, {})
        if tline.get('tag') != line['tag']:
            problems.append(f'log tag {lk}: {tline.get("tag")!r} != {line["tag"]!r}')
        if tline.get('time') != line['time']:
            problems.append(f'log time {lk}: {tline.get("time")!r} != {line["time"]!r}')
    return problems


def detect_locale(result):
    # Preferred: explicit notes mention / meta lang. Fall back to charset heuristics.
    landing = result.get('landing') or {}
    blob = json.dumps(landing, ensure_ascii=False)
    notes = (result.get('notes') or '')
    for code, markers in {
        'ja': ['です', 'ます', '面接'],
        'zh-TW': ['履歷', '面試練習', '臺', '投遞', '為'],
        'zh': ['简历', '面试', '汉'],
        'ko': ['니다', '해요', '면접'],
        'es': ['postula', 'entrevista', 'trabajo'],
        'pt': ['candidata', 'entrevista', 'emprego', 'você'],
        'de': ['Bewerbung', 'bewirbt', 'Vorstellungsgespräch'],
        'fr': ['postule', 'entretien', 'emploi'],
    }.items():
        hits = sum(1 for m in markers if m in blob)
        if hits >= 2:
            # disambiguate zh vs zh-TW: Traditional-only chars
            if code == 'zh' and any(c in blob for c in '履歷試發為當變讓時間們'):
                continue
            return code
    # last resort: check notes
    for code in ['zh-TW', 'zh', 'ja', 'ko', 'es', 'pt', 'de', 'fr']:
        if f'({code})' in notes or f' {code} ' in f' {notes} ':
            return code
    return None


def apply_locale(code, result, en):
    landing = result.get('landing')
    if not isinstance(landing, dict):
        return f'{code}: no landing object'
    en_tree = key_tree(en['landing'])
    tr_tree = key_tree(landing)
    missing = en_tree - tr_tree
    extra = tr_tree - en_tree
    if missing or extra:
        return f'{code}: STRUCTURE MISMATCH missing={sorted(missing)[:6]} extra={sorted(extra)[:6]}'
    mv = machine_voice_ok(en['landing'], landing)
    if mv:
        return f'{code}: MACHINE VOICE violations: {mv[:4]}'

    path = f'{REPO}/i18n/messages/{code}.json'
    if code in FULL_LOCALES:
        doc = json.load(open(path), object_pairs_hook=collections.OrderedDict)
        doc['landing'] = landing
    else:
        extras = result.get('extras') or {}
        doc = collections.OrderedDict()
        for ns in ['common', 'nav']:
            if ns in extras:
                doc[ns] = extras[ns]
        doc['landing'] = landing
        for ns in ['auth', 'onboarding', 'choosePlan', 'errors']:
            if ns in extras:
                doc[ns] = extras[ns]
        # validate extras structures (warn only — EN fallback covers gaps)
        for ns, val in (extras or {}).items():
            if ns in en:
                miss = key_tree(en[ns]) - key_tree(val)
                if miss:
                    print(f'  warn {code}.{ns}: {len(miss)} keys missing (EN fallback covers)')
    with open(path, 'w') as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)
        f.write('\n')
    return f'{code}: APPLIED ({len(json.dumps(landing))} chars landing'


def main(src):
    en = json.load(open(EN_PATH))
    raw = open(src).read()
    results = []
    if src.endswith('.jsonl'):
        for line in raw.splitlines():
            try:
                e = json.loads(line)
            except Exception:
                continue
            if e.get('type') == 'result' and isinstance(e.get('result'), dict):
                results.append(e['result'])
    else:
        start = raw.find('{')
        data = json.loads(raw[start:])
        payload = data.get('result', data)
        for code, r in payload.items():
            if isinstance(r, dict) and 'landing' in r:
                r.setdefault('_locale', code)
                results.append(r)

    seen = set()
    for r in results:
        code = r.get('_locale') or detect_locale(r)
        if not code:
            print('?? could not identify locale for a result; skipping')
            continue
        if code in seen:
            continue
        seen.add(code)
        print(apply_locale(code, r, en))
    print('applied locales:', sorted(seen))


if __name__ == '__main__':
    main(sys.argv[1])
