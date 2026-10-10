// components/v3/resumes/joinPhrase.ts — put two translated fragments of one
// heading together ("Write the resume " + "you would hire").
//
// Whether a space belongs between them depends on the language, so the page
// must not add one by itself: with a hard-coded space the Chinese titles read
// "寫出 連你自己都想錄取的履歷" and "還沒有 履歷". A space is added only when
// neither fragment brings its own and both sides of the join are scripts that
// separate words with spaces (Latin, Hangul…), never next to Han or kana.

const NO_SPACE_SCRIPT = /[　-〿぀-ヿ㐀-鿿豈-﫿＀-￯]/;

export function joinPhrase(...parts: Array<string | null | undefined>): string {
  let out = '';
  for (const part of parts) {
    if (!part) continue;
    if (!out) {
      out = part;
      continue;
    }
    const before = out.slice(-1);
    const after = part.slice(0, 1);
    const spaced = /\s/.test(before) || /\s/.test(after);
    const punctuation = /^[.,;:!?。，；：！？、)）\]】]/.test(part);
    const glue = spaced || punctuation || NO_SPACE_SCRIPT.test(before) || NO_SPACE_SCRIPT.test(after) ? '' : ' ';
    out += glue + part;
  }
  return out;
}
