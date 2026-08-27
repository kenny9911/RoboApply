// Leaf module (no imports, no side effects) holding the provider-routing
// prefixes a model id may carry. LLMService uses them to strip the routing hint
// before calling upstream; tooling that has to predict which id a selector will
// actually be BILLED under needs the same knowledge, and importing LLMService
// for it would drag in the whole provider stack and the log-file initialiser.

/** Prefixes accepted as a `<provider>/<model>` routing hint. */
export const DIRECT_PROVIDER_PREFIXES = new Set([
  'openai',
  'google',
  'kimi',
  'moonshot',
  'deepseek',
  'openrouter',
  'anthropic',
  'minimax',
  'ollama',
  'newapi',
]);

// Provider-prefix aliases: the model-id prefix a caller may use differs from the
// internal provider key. Google's native SDK is Gemini-branded, so `gemini/…` is
// accepted as a synonym for the `google` provider (e.g. `gemini/gemini-3-flash-preview`
// → Google direct). Normalized in resolveDirectModel before the prefix is matched.
export const PROVIDER_PREFIX_ALIASES: Record<string, string> = {
  gemini: 'google',
};
