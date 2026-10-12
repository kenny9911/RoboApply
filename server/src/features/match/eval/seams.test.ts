// @vitest-environment node
// MKT-1D — seams: an existing export is returned, a missing module or export
// throws SeamMissing with its path, and the fit functions are bound to
// in-memory fakes or reported as missing. No network, no database.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EVAL_DIR, REPO_ROOT, SEAMS, SeamMissing, fitKind, isSeamMissing, loadFitApi, loadSeam, optionalSeam, seamExists, setFitModuleForTests, toSeamFit } from './seams.js';
import { createWorld, freshAiRow } from './world.js';

afterEach(() => setFitModuleForTests(null));

describe('loadSeam', () => {
  it('returns an existing export of an existing module', async () => {
    const matchTitle = await loadSeam<(title: string, o?: { limit?: number }) => Array<{ id: string }>>(SEAMS.matchTitle);
    expect(typeof matchTitle).toBe('function');
    expect(matchTitle('Backend Engineer', { limit: 1 })[0]?.id).toBe('backend_engineer');
  });

  it('gives the same module instance as a static import', async () => {
    const viaSeam = await loadSeam<{ great: number }>('server/src/features/match/contract.ts#DEFAULT_MATCH_TIERS');
    const { DEFAULT_MATCH_TIERS } = await import('../contract.js');
    expect(viaSeam).toBe(DEFAULT_MATCH_TIERS);
  });

  it('throws SeamMissing with the path for a module that does not exist', async () => {
    const spec = 'server/src/features/match/doesNotExist.ts#anything';
    const err = await loadSeam(spec).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(SeamMissing);
    expect((err as SeamMissing).seam).toBe(spec);
    expect((err as Error).message).toBe(`SeamMissing: ${spec}`);
    expect(isSeamMissing(err)).toBe(true);
  });

  it('throws SeamMissing with the path for an export that does not exist', async () => {
    const spec = 'server/src/features/match/contract.ts#noSuchExport';
    await expect(loadSeam(spec)).rejects.toThrow(`SeamMissing: ${spec}`);
  });

  it('refuses a spec without an export name', async () => {
    await expect(loadSeam('server/src/features/match/contract.ts')).rejects.toThrow(/seam spec must be/);
  });

  it('reads from another root, and rethrows a module that fails to load', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'eval-seams-'));
    writeFileSync(path.join(dir, 'ok.mjs'), 'export const answer = 42;\n');
    writeFileSync(path.join(dir, 'broken.mjs'), "throw new Error('boom at import');\n");
    expect(await loadSeam<number>('ok.mjs#answer', dir)).toBe(42);
    await expect(loadSeam('ok.mjs#other', dir)).rejects.toBeInstanceOf(SeamMissing);
    const err = await loadSeam('broken.mjs#x', dir).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(isSeamMissing(err)).toBe(false);
    expect(String((err as Error).message)).toContain('boom at import');
  });

  it('optionalSeam answers null for a missing seam; seamExists says so', async () => {
    expect(await optionalSeam('server/src/features/match/doesNotExist.ts#x')).toBeNull();
    expect(await seamExists('server/src/features/match/doesNotExist.ts#x')).toBe(false);
    expect(await seamExists(SEAMS.matchTitle)).toBe(true);
  });

  it('knows where the repository is', () => {
    expect(path.relative(REPO_ROOT, EVAL_DIR)).toBe(path.join('server', 'src', 'features', 'match', 'eval'));
  });
});

describe('the fit seam', () => {
  it('normalises the kind and the three compared fields', () => {
    expect(fitKind('ai')).toBe('ai');
    expect(fitKind('pre')).toBe('estimate');
    expect(fitKind('estimate')).toBe('estimate');
    expect(fitKind(undefined)).toBe('unknown');
    expect(toSeamFit({ score: 71, tier: 'good', kind: 'pre' })).toEqual({ score: 71, tier: 'good', kind: 'estimate' });
    expect(toSeamFit(null)).toEqual({ score: null, tier: null, kind: 'unknown' });
  });

  it('binds a factory exported by the fit module to the in-memory fakes', async () => {
    setFitModuleForTests(path.join(EVAL_DIR, 'testdata', 'fitShim.ts'));
    const world = createWorld();
    const api = await world.fit();
    expect(api.boundBy).toContain('#createFitService');
    const fits = await api.getFits('u1', ['job1']);
    expect(fits).toBeInstanceOf(Map);
    expect(fits.get('job1')?.jobId).toBe('job1');
    expect(typeof fits.get('job1')?.score).toBe('number');
    expect(fitKind(fits.get('job1')?.kind)).toBe('estimate');
    expect((await api.getFit('u1', 'job1')).score).toBe(fits.get('job1')?.score);
    expect(world.scorer.calls).toBe(0);
  });

  it('reads the stored AI row of the world when there is one', async () => {
    setFitModuleForTests(path.join(EVAL_DIR, 'testdata', 'fitShim.ts'));
    const world = createWorld({ scores: [freshAiRow()] });
    const fit = await (await world.fit()).getFit('u1', 'job1');
    expect(fitKind(fit.kind)).toBe('ai');
    expect(world.scorer.calls).toBe(0);
  });

  it('is missing while features/match/fit.ts does not export getFits', async () => {
    setFitModuleForTests(path.join(EVAL_DIR, 'testdata', 'noSuchFitModule.ts'));
    const err = await createWorld()
      .fit()
      .then(
        () => null,
        (e) => e,
      );
    expect(isSeamMissing(err)).toBe(true);
    expect((err as SeamMissing).seam).toBe(SEAMS.getFits);
  });

  it('is missing, by name, when the functions cannot be bound to in-memory fakes', async () => {
    setFitModuleForTests(path.join(EVAL_DIR, 'testdata', 'fitUnbound.ts'));
    const err = await loadFitApi(createWorld().deps).then(
      () => null,
      (e) => e,
    );
    expect(isSeamMissing(err)).toBe(true);
    expect((err as SeamMissing).seam).toBe('server/src/features/match/fit.ts#createFitService');
    expect((err as Error).message).toContain('cannot be bound to in-memory fakes');
  });
});
