// The hub titles are built from translated fragments; the page used to put a
// space between them in every language (QA, zh-TW: "寫出 連你自己…", "還沒有 履歷").

import { describe, expect, it } from 'vitest';

import { joinPhrase } from './joinPhrase';
import { LOCALES, loadMessages } from '../../../lib/i18n';

describe('joinPhrase', () => {
  it('adds no space next to Han or kana, one space between spaced scripts, none twice', () => {
    expect(joinPhrase('寫出', '連你自己都想錄取')).toBe('寫出連你自己都想錄取');
    expect(joinPhrase('還沒有', '履歷')).toBe('還沒有履歷');
    expect(joinPhrase('採用したくなる', '履歴書')).toBe('採用したくなる履歴書');
    expect(joinPhrase('Write the resume ', 'you would hire', '.')).toBe('Write the resume you would hire.');
    expect(joinPhrase('No resumes', 'yet')).toBe('No resumes yet');
    expect(joinPhrase('채용하고 싶어지는', '이력서')).toBe('채용하고 싶어지는 이력서');
    expect(joinPhrase('', null, 'Only')).toBe('Only');
  });

  it('every locale\'s hub titles join without a doubled or stray space', () => {
    for (const locale of LOCALES) {
      const m = loadMessages(locale, 'roboapply').resume as Record<string, unknown> & { empty: Record<string, string> };
      const title = `${joinPhrase(m.title_lead as string, m.title_accent as string)}${m.title_after as string}`;
      const empty = joinPhrase(m.empty.title_lead, m.empty.title_accent);
      for (const text of [title, empty]) {
        expect(text, `${locale}: ${text}`).not.toMatch(/\s{2,}/);
        // No space between two Han / kana characters.
        expect(text, `${locale}: ${text}`).not.toMatch(/[぀-ヿ㐀-鿿]\s+[぀-ヿ㐀-鿿]/);
      }
    }
  });
});
