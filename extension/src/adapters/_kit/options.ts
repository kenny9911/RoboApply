// extension/src/adapters/_kit/options.ts — pick the option that means what we want.

export function normalizeText(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[*：:?？!！.,，。()（）[\]"'’“”]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const YES = ['yes', 'y', 'true', '是', '是的', '有', 'oui', 'sí', 'si', 'ja', 'sim', 'はい', '예'];
const NO = ['no', 'n', 'false', '否', '不是', '没有', '沒有', 'non', 'nein', 'não', 'nao', 'いいえ', '아니요'];

function polarity(s: string): 'yes' | 'no' | null {
  const n = normalizeText(s);
  const first = n.split(' ')[0] ?? '';
  if (YES.includes(n) || YES.includes(first)) return 'yes';
  if (NO.includes(n) || NO.includes(first)) return 'no';
  return null;
}

/**
 * Index of the option matching `wanted`, or -1. Order: exact (normalized),
 * yes/no polarity, option starts with / equals the wanted text, wanted text
 * contained in exactly one option. Ambiguity returns -1 (the user picks).
 */
export function matchOption(options: readonly string[], wanted: string): number {
  const w = normalizeText(wanted);
  if (!w) return -1;
  const norm = options.map(normalizeText);
  const exact = norm.indexOf(w);
  if (exact !== -1) return exact;
  const pol = polarity(wanted);
  if (pol) {
    const hits = norm.map((o, i) => (polarity(o) === pol ? i : -1)).filter((i) => i !== -1);
    if (hits.length === 1) return hits[0];
  }
  const starts = norm.map((o, i) => (o.startsWith(w) || (w.startsWith(o) && o.length >= 3) ? i : -1)).filter((i) => i !== -1);
  if (starts.length === 1) return starts[0];
  const contains = norm.map((o, i) => (o.includes(w) ? i : -1)).filter((i) => i !== -1);
  if (contains.length === 1) return contains[0];
  return -1;
}

/** Placeholder options ("Select…", "--", "请选择") are not answers. */
export function isPlaceholderOption(label: string, value: string): boolean {
  const n = normalizeText(label);
  return value === '' || n === '' || /^(select|choose|please select|--+|请选择|請選擇)\b/.test(n);
}
