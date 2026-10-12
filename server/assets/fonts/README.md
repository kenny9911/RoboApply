# Resume export fonts (WP-36b)

Bundled with the API function through `includeFiles: server/**`. Keep the
directory under 20 MB (today: about 19.1 MB). All files are subsets of fonts
under the SIL Open Font License 1.1 (`OFL.txt`).

`server/src/roboapply/v2/lib/resumeExport.ts` picks a font **per run of text**
by glyph coverage, never one font for the whole document:

1. the PDF standard face (Helvetica, or Times for the serif layout) for every
   character WinAnsi encodes (Latin-1 plus a few punctuation marks);
2. `NotoSans` for the rest of Latin, Greek and Cyrillic;
3. the Han / Hangul / kana faces, in an order set by the export locale
   (`zh` SC → TC → JP → KR, `zh-TW` TC → SC → JP → KR, `ja` JP → TC → SC → KR,
   `ko` KR → TC → SC → JP; with no locale, by the script the text uses).

A character no face has is drawn in an embedded face as a visible box, never
dropped. Emoji are not covered.

| File | Upstream (OFL) | Subset | Size each |
|---|---|---|---|
| `NotoSans-{Regular,Bold}.ttf` | Noto Sans 2.013 (static) | Basic Latin, Latin-1, Latin Extended-A/B and Additional, IPA, combining marks, Greek, Cyrillic (+ Supplement), Latin Extended-C/D, punctuation, currency, letterlike, arrows, math operators | 0.26 MB |
| `NotoSansSC-{Regular,Bold}.ttf` | Noto Sans SC 2.004 (static) | ASCII, Latin-1, punctuation, CJK symbols, full-width forms, bopomofo, all GB2312 characters | 2.4 MB |
| `HanSansTC-{Regular,Bold}.otf` | Source Han Sans TW 2.005 variable (`app/fonts/source-han-sans-tw-vf.woff2`), instanced at wght 400 / 700, CFF2 → CFF | ASCII, Latin-1, punctuation, CJK symbols, full-width forms, bopomofo, all Big5 characters | 3.9 MB |
| `NotoSansKR-{Regular,Bold}.ttf` | Noto Sans KR (Regular static; Bold instanced from the variable font at wght 700) | the 2,350 KS X 1001 Hangul syllables, compatibility jamo, CJK symbols | 0.45 MB |
| `NotoSansJP-{Regular,Bold}.ttf` | Noto Sans JP (Regular static; Bold instanced from the variable font at wght 700) | hiragana, katakana, all JIS X 0208 kanji, CJK symbols | 2.5 MB |

Notes:

- **Traditional Chinese.** Source Han Sans TW is the same design as Noto Sans
  CJK TC (Adobe and Google publish one family under two names). The OFL
  reserves the name "Source" for unmodified fonts, so the subset is renamed
  "Han Sans TC". If ops adds Google's `NotoSansTC-{Regular,Bold}.ttf` here,
  the code prefers them with no change; remove the `HanSansTC` files at the
  same time to stay under 20 MB.
- **Korean** covers KS X 1001 Hangul only (2,350 syllables, every common
  name and word). Hanja fall back to the TC/SC faces.
- `server/src/roboapply/lib/invoiceReceipt.ts` also reads the Noto Sans SC
  files (Simplified Chinese invoices).

Built with fontTools 4.63: `varLib.instancer` for the bold instances,
`cffLib.CFF2ToCFF` for the TC face, and
`pyftsubset --layout-features='*' --name-IDs='*' --notdef-outline --no-hinting`
with the code-point sets above (GB2312, Big5, KS X 1001 and JIS X 0208 lists
come from Python's `gb2312`, `big5`, `euc_kr` and `euc_jp` codecs). The WOFF2
source was unpacked with Node's built-in Brotli. pdfkit subsets again when it
embeds, so exported PDFs stay small.
