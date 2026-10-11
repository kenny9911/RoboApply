// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../../../services/LoggerService.js', () => ({ logger }));

import { EmbeddingsError, type EmbedOptions, type EmbedResult } from '../../../platform/embeddings/index.js';
import { CANDIDATE_ROLES, MAX_NEIGHBOUR_CANDIDATES } from './candidates.js';
import { ROLE_VECTOR_RETRY_MS, createRoleNeighbours } from './roleNeighbours.js';

const MODEL = 'test-embed@1024';
/** A small tree: enough to tell near from far. */
const ROLES = [
  { id: 'backend_engineer', en: 'Backend engineer', zh: '后端工程师' },
  { id: 'data_engineer', en: 'Data engineer', zh: '数据工程师' },
  { id: 'site_reliability_engineer', en: 'Site reliability engineer', zh: '站点可靠性工程师' },
  { id: 'nurse', en: 'Registered nurse', zh: '护士' },
  { id: 'chef', en: 'Chef', zh: '厨师' },
];

/** Four axes: software, data, care, kitchen. A text is placed by the words it holds. */
function place(text: string): number[] {
  const t = text.toLowerCase();
  const software = (/backend|reliability|platform|后端|可靠/.test(t) ? 1 : 0) + (/engineer|工程师/.test(t) ? 0.3 : 0);
  const data = /data|pipeline|数据/.test(t) ? 1 : 0;
  const care = /nurse|护士/.test(t) ? 1 : 0;
  const kitchen = /chef|厨师/.test(t) ? 1 : 0;
  return [software + 0.01, data + 0.01, care + 0.01, kitchen + 0.01];
}

function fakeEmbed(options: { answer?: (texts: readonly string[]) => Promise<EmbedResult>; model?: () => string } = {}) {
  const calls: Array<{ brand: string; texts: string[]; options: EmbedOptions }> = [];
  const embed = async (brand: string, texts: readonly string[], embedOptions: EmbedOptions): Promise<EmbedResult> => {
    calls.push({ brand, texts: [...texts], options: embedOptions });
    if (options.answer) return options.answer(texts);
    return { vectors: texts.map(place), model: options.model?.() ?? MODEL, tokens: texts.length };
  };
  return { embed, calls };
}

const CTX = { brand: 'roboapply' as const, requestId: 'job-enrich-1' };

describe('nearest roles by title embedding (SM-2; MATCH 4.5 point 3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('answers the three roles whose label is nearest to the title, best first', async () => {
    const { embed, calls } = fakeEmbed();
    const nearest = createRoleNeighbours({ embed, roles: ROLES });
    expect(await nearest('Platform Data Pipeline Engineer', CTX)).toEqual(['data_engineer', 'backend_engineer', 'site_reliability_engineer']);
    expect(MAX_NEIGHBOUR_CANDIDATES).toBe(3);
    // The title, then every label once: the English and the Chinese label of each role, as vocabulary text.
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({ brand: 'roboapply', texts: ['Platform Data Pipeline Engineer'], options: { purpose: 'skill', carriesUserData: false, requestId: 'job-enrich-1' } });
    expect(calls[1]!.texts).toHaveLength(ROLES.length * 2);
    expect(calls[1]!.texts).toEqual(expect.arrayContaining(['Backend engineer', '后端工程师', 'Registered nurse', '护士']));
    expect(calls[1]!.options).toEqual({ purpose: 'skill', carriesUserData: false });
  });

  it('ACCEPT: the role vectors are requested once for many jobs, also when the jobs run in parallel', async () => {
    const { embed, calls } = fakeEmbed();
    const nearest = createRoleNeighbours({ embed, roles: ROLES });
    await Promise.all(Array.from({ length: 10 }, (_, i) => nearest(`Data Pipeline Lead ${i}`, CTX)));
    for (let i = 0; i < 5; i++) await nearest(`Reliability Lead ${i}`, CTX);
    const labelRequests = calls.filter((c) => c.texts.length > 1);
    expect(labelRequests).toHaveLength(1);
    // One request per title.
    expect(calls.filter((c) => c.texts.length === 1)).toHaveLength(15);
  });

  it('keeps one set of label vectors per brand (a brand has its own embedding model)', async () => {
    const { embed, calls } = fakeEmbed();
    const nearest = createRoleNeighbours({ embed, roles: ROLES });
    await nearest('数据工程师', { brand: 'goapply' });
    await nearest('Data Lead', { brand: 'roboapply' });
    await nearest('数据平台负责人', { brand: 'goapply' });
    expect(calls.filter((c) => c.texts.length > 1).map((c) => c.brand)).toEqual(['goapply', 'roboapply']);
  });

  it('a Chinese title is compared with the Chinese labels (the better of a role\'s two labels counts)', async () => {
    const { embed } = fakeEmbed();
    expect((await createRoleNeighbours({ embed, roles: ROLES })('护士长', CTX))[0]).toBe('nurse');
  });

  it('the embeddings client unavailable: no neighbours, silently, and nothing is kept', async () => {
    for (const unavailable of ['no_key', 'policy', 'budget'] as const) {
      const { embed, calls } = fakeEmbed({ answer: async () => ({ unavailable }) });
      const nearest = createRoleNeighbours({ embed, roles: ROLES });
      expect(await nearest('Data Pipeline Lead', CTX)).toEqual([]);
      // Only the title was asked: the labels are not embedded for a client that is off.
      expect(calls).toHaveLength(1);
    }
    expect(logger.warn).not.toHaveBeenCalled();
    // The labels answer unavailable (a budget spent between the two requests): nothing is cached, the next job asks again.
    let labelAnswers = 0;
    const { embed, calls } = fakeEmbed({
      answer: async (texts) => {
        if (texts.length === 1) return { vectors: texts.map(place), model: MODEL, tokens: 1 };
        labelAnswers += 1;
        return labelAnswers === 1 ? { unavailable: 'budget' } : { vectors: texts.map(place), model: MODEL, tokens: texts.length };
      },
    });
    const nearest = createRoleNeighbours({ embed, roles: ROLES });
    expect(await nearest('Data Pipeline Lead', CTX)).toEqual([]);
    expect((await nearest('Data Pipeline Lead', CTX))[0]).toBe('data_engineer');
    expect(calls.filter((c) => c.texts.length > 1)).toHaveLength(2);
  });

  it('a failed call never fails the enrichment: no neighbours, one warning, and the endpoint is left alone for a while', async () => {
    let now = 1_000_000;
    let fail = true;
    const { embed, calls } = fakeEmbed({
      answer: async (texts) => {
        if (fail) throw new EmbeddingsError('timeout', 'embeddings request timed out');
        return { vectors: texts.map(place), model: MODEL, tokens: texts.length };
      },
    });
    const nearest = createRoleNeighbours({ embed, roles: ROLES, now: () => now });
    for (let i = 0; i < 5; i++) expect(await nearest(`Data Lead ${i}`, CTX)).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    // After the pause it is tried again, and works.
    now += ROLE_VECTOR_RETRY_MS + 1;
    fail = false;
    expect((await nearest('Data Lead', CTX))[0]).toBe('data_engineer');
  });

  it('vectors of two models are never compared: a changed model means new label vectors', async () => {
    let model = 'model-a@1024';
    const { embed, calls } = fakeEmbed({ model: () => model });
    const nearest = createRoleNeighbours({ embed, roles: ROLES });
    await nearest('Data Lead', CTX);
    model = 'model-b@1024';
    expect((await nearest('Data Lead', CTX))[0]).toBe('data_engineer');
    expect(calls.filter((c) => c.texts.length > 1)).toHaveLength(2);
  });

  it('an empty title, or an answer that is not a vector, gives nothing', async () => {
    const { embed, calls } = fakeEmbed({ answer: async (texts) => ({ vectors: texts.map(() => [0, 0, 0, 0]), model: MODEL, tokens: 1 }) });
    const nearest = createRoleNeighbours({ embed, roles: ROLES });
    expect(await nearest('   ', CTX)).toEqual([]);
    expect(calls).toHaveLength(0);
    expect(await nearest('Data Lead', CTX)).toEqual([]);
  });

  it('by default it covers every role a model may be offered, with both labels', () => {
    expect(CANDIDATE_ROLES.length).toBeGreaterThan(200);
    expect(CANDIDATE_ROLES.every((r) => r.id && r.en && r.zh)).toBe(true);
    expect(CANDIDATE_ROLES.find((r) => r.id === 'backend_engineer')).toMatchObject({ en: expect.stringMatching(/backend/i) });
  });
});
