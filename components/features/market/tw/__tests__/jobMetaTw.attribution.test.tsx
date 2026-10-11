// MKT-3E (JT-2): the open-data licence attribution on the job card and the
// job page. The sentence is the server's data (hook set `tw_sources`); the web
// renders it as a link to the licence text wherever the row is shown, and
// nothing when the meta is missing or malformed. No network.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderWithBrand } from '../../../../../__tests__/shell/helpers';
import { MarketJobMeta } from '../..';
import { JobMetaTw } from '../JobMetaTw';
import { readTwSourcesMeta } from '../meta';

const SENTENCE = '資料來源：勞動部勞動力發展署 2026「台灣就業通網站職缺清單」，依政府資料開放授權條款第1版公開釋出';
const LICENCE = 'https://data.gov.tw/license';

/** What the server's cardMeta sends for a 台灣就業通 row with stated pay: only the attribution has something to add. */
const OPEN_DATA = {
  ats_public: { country: 'TW', pay: { text: null, posted: null, disclosed: true, negotiable: false }, permitTags: [], source: { name: '台灣就業通', url: 'https://job.taiwanjobs.gov.tw/Internet/jobwanted/JobDetail.aspx?EMPLOYER_ID=1&HIRE_ID=2', board: null } },
  tw_sources: { attribution: { text: SENTENCE, url: LICENCE } },
};

/** The same source, a row whose pay is the dataset's no-figure wording. */
const OPEN_DATA_NEGOTIABLE = {
  ...OPEN_DATA,
  ats_public: { ...OPEN_DATA.ats_public, pay: { text: '依學經歷、證照核薪', posted: '依學經歷、證照核薪(每月經常性薪資達4萬元以上)', disclosed: false, negotiable: true } },
};

/** A Greenhouse row in Taiwan: no open-data source, so no attribution. */
const GREENHOUSE = {
  ats_public: { country: 'TW', pay: { text: '待遇面議', posted: '待遇面議', disclosed: false, negotiable: true }, permitTags: [], source: { name: 'Formosa Robotics · Greenhouse', url: 'https://boards.greenhouse.io/formosarobotics/jobs/1', board: 'greenhouse' } },
};

describe('readTwSourcesMeta', () => {
  it('reads the sentence and the licence link', () => {
    expect(readTwSourcesMeta(OPEN_DATA)).toEqual({ attribution: { text: SENTENCE, url: LICENCE } });
  });

  it('is null for missing or malformed meta, and never throws', () => {
    for (const meta of [
      null,
      undefined,
      {},
      GREENHOUSE,
      { tw_sources: {} },
      { tw_sources: { attribution: null } },
      { tw_sources: { attribution: 'text' } },
      { tw_sources: { attribution: [SENTENCE] } },
      { tw_sources: { attribution: { text: '', url: LICENCE } } },
      { tw_sources: { attribution: { text: '   ', url: LICENCE } } },
      { tw_sources: { attribution: { text: 42, url: LICENCE } } },
      { tw_sources: { attribution: { url: LICENCE } } },
      { tw_sources: { attribution: { text: 'x'.repeat(301), url: LICENCE } } },
      { tw_sources: 'attribution' },
    ]) {
      expect(readTwSourcesMeta(meta as never), JSON.stringify(meta)).toBeNull();
    }
  });

  it('keeps the sentence and drops a link that is not http(s)', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,x', '/license', '', null, 7]) {
      expect(readTwSourcesMeta({ tw_sources: { attribution: { text: SENTENCE, url } } } as never), String(url)).toEqual({ attribution: { text: SENTENCE, url: null } });
    }
  });
});

describe('JobMetaTw: the open-data attribution', () => {
  it.each(['card', 'detail'] as const)('%s: renders the sentence as a link to the licence text', (variant) => {
    const { container } = renderWithBrand(<JobMetaTw jobId="j1" meta={OPEN_DATA} variant={variant} />);
    const link = screen.getByRole('link', { name: SENTENCE });
    expect(link).toHaveAttribute('href', LICENCE);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    // The sentence is Traditional Chinese in every locale, and it is the only thing this row adds.
    expect(link.closest('[lang]')).toHaveAttribute('lang', 'zh-Hant');
    expect(container.textContent).toBe(SENTENCE);
    expect(container.querySelectorAll('[data-tw-attribution]')).toHaveLength(1);
    expect(container.querySelector('img')).toBeNull();
  });

  it('card: sits under the pay line of a row whose pay is the no-figure wording; the threshold never appears', () => {
    const { container } = renderWithBrand(<JobMetaTw jobId="j1" meta={OPEN_DATA_NEGOTIABLE} variant="card" />);
    expect(screen.getByText('Pay as posted: 依學經歷、證照核薪')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: SENTENCE })).toHaveAttribute('href', LICENCE);
    expect(container.textContent).not.toMatch(/4\s*[萬万]|40,?000|NT\$/);
  });

  it('detail: is part of the Taiwan block, after the source line', () => {
    renderWithBrand(<JobMetaTw jobId="j1" meta={OPEN_DATA_NEGOTIABLE} variant="detail" />);
    const region = screen.getByRole('region', { name: 'Pay and work permits' });
    expect(within(region).getByRole('link', { name: SENTENCE })).toHaveAttribute('href', LICENCE);
    expect(within(region).getByText('Source: 台灣就業通')).toBeInTheDocument();
  });

  it('a link the server did not send safely is shown as plain text: the attribution itself is never dropped', () => {
    renderWithBrand(<JobMetaTw jobId="j1" meta={{ tw_sources: { attribution: { text: SENTENCE, url: 'javascript:alert(1)' } } }} variant="card" />);
    expect(screen.getByText(SENTENCE)).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('renders nothing when the meta is missing or malformed', () => {
    for (const meta of [null, undefined, {}, { tw_sources: {} }, { tw_sources: { attribution: { text: '', url: LICENCE } } }, { tw_sources: { attribution: 'x' } }, { ats_public: { country: 'US' }, tw_sources: null }]) {
      for (const variant of ['card', 'detail'] as const) {
        const { container, unmount } = renderWithBrand(<JobMetaTw jobId="j1" meta={meta as never} variant={variant} />);
        expect(container.textContent, `${JSON.stringify(meta)} ${variant}`).toBe('');
        expect(container.querySelector('[data-tw-attribution]')).toBeNull();
        unmount();
      }
    }
  });

  it('a Greenhouse row in Taiwan carries no attribution', () => {
    const { container } = renderWithBrand(<JobMetaTw jobId="j1" meta={GREENHOUSE} variant="card" />);
    expect(screen.getByText('Pay as posted: 待遇面議')).toBeInTheDocument();
    expect(container.querySelector('[data-tw-attribution]')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('is reached through the market slot on RoboApply only', () => {
    const robo = renderWithBrand(<MarketJobMeta jobId="j1" meta={OPEN_DATA} variant="card" />, { brand: 'roboapply' });
    expect(robo.container.querySelectorAll('[data-tw-attribution]')).toHaveLength(1);
    robo.unmount();
    const go = renderWithBrand(<MarketJobMeta jobId="j1" meta={OPEN_DATA} variant="card" />, { brand: 'goapply' });
    expect(go.container.querySelector('[data-tw-attribution]')).toBeNull();
  });
});

describe('the Taiwan market folder', () => {
  it('references no 台灣就業通 logo (trademarks are outside the licence) and no image at all', () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), '..');
    const sources = readdirSync(dir).filter((name) => /\.(tsx?|css)$/.test(name));
    expect(sources.length).toBeGreaterThan(3);
    for (const name of sources) {
      const text = readFileSync(join(dir, name), 'utf8');
      expect(text, name).not.toMatch(/taiwanjobs[^'"\s]*\.(png|svg|jpe?g|gif|webp|ico)|<img\b|next\/image/i);
    }
  });
});
