// backend/src/interview-engine/prompt/spokenText.ts
//
// toSpokenText() — the deterministic guard between LLM-authored interview text
// and the text-to-speech engine.
//
// The interview BLUEPRINT is authored by an LLM as structured JSON, and for a
// technical interview it reaches for code: backticks around a type literal,
// bold on a key term, a bulleted list of constraints. That is correct in the
// master brief (markdown, read by a human) and in the report. It is wrong in
// the two places this module guards:
//
//   1. composeOpeningLine() splices the blueprint's FIRST question into a line
//      the LiveKit worker speaks VERBATIM through session.say(). Markup there
//      is synthesized as sound, and it is echoed into the live transcript —
//      where an inline-code span still mid-stream surfaces in the question card
//      as a stray literal backtick.
//   2. The seed questions embedded in the voice system prompt. That prompt
//      tells the model "no markdown, no code, no special symbols" and then
//      shows it eight code-laden examples of what to ask. The examples win.
//
// The authoring rule in InterviewBlueprintAgent asks for speakable prose; this
// is the backstop for when the model writes markup anyway.
//
// Scope discipline: this strips MARKUP, not meaning. `mergeHistory(snapshot,
// deltas)` survives as words — only the decoration around it is removed. Making
// a type literal genuinely speakable is the authoring rule's job, not a
// regex's. Nothing here touches the master brief or the report, which are
// markdown by design.

/** Emoji, pictographs, dingbats and variation selectors. The voice rules ban
 *  them outright; TTS either drops them or reads a literal name. */
const EMOJI_RE =
  /[\u{1F000}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{200D}]/gu;

/**
 * Reduce LLM-authored text to a single line of plain prose safe to hand to TTS.
 * Returns '' for a non-string so callers can use the `||` fallback they already
 * have for an empty question.
 */
export function toSpokenText(value: string | null | undefined): string {
  if (typeof value !== 'string') return '';

  let out = value;

  // Fenced code blocks: drop the fence, keep the code as words.
  out = out.replace(/(?:```|~~~)[a-zA-Z0-9+#-]*\n?/g, ' ');

  // Images before links — both keep the visible text and drop the URL, which is
  // unspeakable and, in the opening line, unverifiable.
  out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  out = out.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');

  // Line-leading block markup: headings, blockquotes, bullets, ordered markers.
  // `#{1,6}` requires trailing space, so "#1 priority" is left alone.
  out = out.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '');
  out = out.replace(/^[ \t]{0,3}>[ \t]?/gm, '');
  out = out.replace(/^[ \t]{0,3}[-*+][ \t]+/gm, '');
  out = out.replace(/^[ \t]{0,3}\d{1,2}[.)][ \t]+/gm, '');

  // Inline code: a backtick has no meaning when spoken, balanced or not.
  out = out.replace(/`+/g, '');

  // Emphasis. An asterisk is only markup when it hugs a word, so a standalone
  // " * " (multiplication in a quant or finance question) survives; underscores
  // live inside identifiers (snake_case), so only a doubled __ is emphasis.
  out = out.replace(/\*{1,3}(?=\S)|(?<=\S)\*{1,3}/g, '');
  out = out.replace(/__/g, '');

  out = out.replace(EMOJI_RE, ' ');

  // One spoken line: newlines and runs of whitespace become single spaces.
  out = out.replace(/\s+/g, ' ').trim();

  // Punctuation left stranded by the removals ("word , next") reads as an
  // unnatural pause.
  out = out.replace(/\s+([,.;:!?，。；：！？])/g, '$1');

  return out.trim();
}
