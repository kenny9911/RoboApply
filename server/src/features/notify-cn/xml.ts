// server/src/features/notify-cn/xml.ts — the small XML subset WeChat server messages use (WP-73).
//
// A WeChat message is one `<xml>` element of leaf fields (text or CDATA), and
// subscribe-message events add repeated `<List>` blocks of leaf fields. That
// is all this reads: no attributes, no entities, no DOCTYPE (refused, so no
// entity expansion can happen), no namespaces. No dependency.

export interface WechatXml {
  /** Leaf fields outside `<List>` blocks (first occurrence wins). */
  fields: Record<string, string>;
  /** Each `<List>` block's leaf fields, in document order. */
  lists: Array<Record<string, string>>;
}

/** Bodies larger than this are refused (a WeChat message is a few KB). */
export const MAX_XML_BYTES = 64 * 1024;

const LEAF = /<([A-Za-z_][\w.-]*)>\s*(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*?))\s*<\/\1>/g;
const LIST = /<List>([\s\S]*?)<\/List>/g;

function decodeText(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function leaves(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of src.matchAll(LEAF)) {
    const name = m[1]!;
    if (name in out) continue;
    out[name] = m[2] !== undefined ? m[2] : decodeText(m[3] ?? '');
  }
  return out;
}

/** Parse a WeChat message; null when it is not one (too big, DOCTYPE/ENTITY, no `<xml>` root). */
export function parseWechatXml(text: string): WechatXml | null {
  if (!text || text.length > MAX_XML_BYTES) return null;
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) return null;
  const root = /<xml>([\s\S]*)<\/xml>/.exec(text);
  if (!root) return null;
  const inner = root[1]!;
  const lists: Array<Record<string, string>> = [];
  const rest = inner.replace(LIST, (_all, block: string) => {
    lists.push(leaves(block));
    return '';
  });
  return { fields: leaves(rest), lists };
}
