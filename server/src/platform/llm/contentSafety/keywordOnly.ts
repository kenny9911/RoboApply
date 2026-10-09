// server/src/platform/llm/contentSafety/keywordOnly.ts
//
// The `keyword_only` provider (WP-24): matches the versioned keyword list
// (built-in + private) against the text. Any `block` entry blocks; otherwise
// any `review` entry gives `review` (logged, not stopped). Labels are
// `keyword:<category>`; rule ids are list ids, never the matched terms.

import { createKeywordSource, type KeywordSource } from './keywordList.js';
import type { ContentSafetyProvider, ContentSafetyResult, ContentSafetyStage } from './types.js';

export const KEYWORD_PROVIDER_ID = 'keyword_only';

export function createKeywordOnlyProvider(source: KeywordSource = createKeywordSource()): ContentSafetyProvider {
  const evaluate = async (text: string, stage: ContentSafetyStage): Promise<ContentSafetyResult> => {
    const list = await source.get();
    const hits = list.match(text, stage);
    if (!hits.length) {
      return { verdict: 'pass', labels: [], provider: KEYWORD_PROVIDER_ID, reason: 'clean', listVersion: list.version };
    }
    const blocking = hits.filter((h) => h.action === 'block');
    const deciding = blocking.length ? blocking : hits;
    return {
      verdict: blocking.length ? 'block' : 'review',
      labels: [...new Set(deciding.map((h) => `keyword:${h.category}`))],
      ruleIds: [...new Set(deciding.map((h) => h.id))],
      provider: KEYWORD_PROVIDER_ID,
      reason: 'keyword',
      listVersion: list.version,
      hitOffset: deciding[0].offset,
    };
  };
  const provider: ContentSafetyProvider = {
    id: KEYWORD_PROVIDER_ID,
    checkInput: (text) => evaluate(text, 'input'),
    checkOutput: (text) => evaluate(text, 'output'),
    get keywordProvider() {
      return provider;
    },
  };
  return provider;
}
