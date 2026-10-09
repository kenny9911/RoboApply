/**
 * The locale an LLM prompt asks the model to write in (WP-14).
 *
 * Callers pass the user's UI locale; when it is missing or not a locale the
 * brand serves, the brand's default applies: `zh` on GoApply (its primary
 * language), `en` on RoboApply. The result feeds
 * `getStrictOutputLanguageDirective(locale, 'content')` — the `content`
 * scope, not `analysis`, which silently ships English (memory note
 * llm-output-language-scopes).
 */

import { llmBrand, type LlmBrandArg } from './llmModels.js';

/** The brand's default prompt locale (`zh` for GoApply). */
export function defaultPromptLocale(brand?: LlmBrandArg): string {
  return llmBrand(brand).defaultLocale;
}

/** The caller's locale when the brand serves it (case-insensitive), else the brand default. */
export function resolvePromptLocale(locale?: string | null, brand?: LlmBrandArg): string {
  const b = llmBrand(brand);
  const wanted = (locale || '').trim().toLowerCase();
  if (wanted) {
    const match = b.locales.find((l) => l.toLowerCase() === wanted);
    if (match) return match;
  }
  return b.defaultLocale;
}
