// components/v3/resume-editor/plainText.ts — the "Plain text" download.
//
// For pasting into web forms: no markdown syntax. The .txt used to be the raw
// markdown, byte for byte ("# Name", "**Frameworks:** pandas", "*a · b*").
// Words, numbers and line order are untouched; only markup is removed and
// headings become plain lines with a blank line before them. Pure.

function stripInline(s: string): string {
  return s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/(^|[\s(（])\*(?!\s)([^*\n]+?)\*(?=$|[\s).,;:，。；：）])/g, '$1$2')
    .replace(/(^|[\s(（])_(?!\s)([^_\n]+?)_(?=$|[\s).,;:，。；：）])/g, '$1$2')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\*\*/g, '');
}

/** Resume markdown as plain text. */
export function resumePlainText(markdown: string): string {
  const out: string[] = [];
  const blank = () => {
    if (out.length && out[out.length - 1] !== '') out.push('');
  };
  for (const raw of (markdown ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line) {
      blank();
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) continue;
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const text = stripInline(heading[2]!).trim();
      if (!text) continue;
      if (heading[1]!.length <= 2) blank();
      // A section title in capitals reads as a title without any markup
      // (no effect on scripts that have no capitals).
      out.push(heading[1]!.length === 2 ? text.toLocaleUpperCase() : text);
      continue;
    }
    const bullet = /^[-*•]\s+(.*)$/.exec(line);
    if (bullet) {
      const text = stripInline(bullet[1]!).trim();
      if (text) out.push(`- ${text}`);
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    const text = stripInline(quote ? quote[1]! : line).trim();
    if (text) out.push(text);
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
}
