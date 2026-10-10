// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  StorageUnavailableError,
  applyResumeUploadPolicy,
  assertResumeUploadStorage,
  brandStorageConfigured,
  cnOwnStorageProblem,
  cnStorageMode,
  cnStorageModeProblem,
  isImageUpload,
  mayStoreOriginal,
  resumeUploadPolicy,
} from './uploadPolicy.js';
import { residencySummary } from './summary.js';

const PRC_ID = '11010519491231002X';
const CN_S3 = {
  CN_S3_ENDPOINT: 'https://oss-cn-shanghai.aliyuncs.com',
  CN_S3_BUCKET: 'b',
  CN_S3_ACCESS_KEY_ID: 'i',
  CN_S3_SECRET_ACCESS_KEY: 's',
};
const INTL_S3 = { S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com', S3_BUCKET: 'intl', S3_ACCESS_KEY_ID: 'i', S3_SECRET_ACCESS_KEY: 's' };

const STRICT = { CN_RESIDENCY_STRICT: 'true' };

describe('resumeUploadPolicy', () => {
  it('RoboApply keeps originals and redacts nothing', () => {
    const p = resumeUploadPolicy('roboapply', {});
    expect(p).toMatchObject({ stage: 'intl', originals: 'store', redactKinds: [], dropImages: false });
  });

  it('GoApply by default is the same as RoboApply: originals kept, images kept, nothing redacted, in either region (D5)', () => {
    for (const env of [{}, INTL_S3, { ...CN_S3, ...INTL_S3 }, { DEPLOY_REGION: 'cn-mainland' }, { DEPLOY_REGION: 'cn-mainland', ...INTL_S3 }]) {
      expect(resumeUploadPolicy('goapply', env)).toMatchObject({ originals: 'store', redactKinds: [], dropImages: false, markerLocale: 'zh' });
      expect(mayStoreOriginal('goapply', env)).toBe(true);
    }
    // The stage still says where the deployment runs; it no longer decides the rule.
    expect(resumeUploadPolicy('goapply', {}).stage).toBe('cn0');
    expect(resumeUploadPolicy('goapply', { DEPLOY_REGION: 'cn-mainland' }).stage).toBe('cn1');
  });

  it('brandStorageConfigured reads the storage group: the CN bucket when CN_S3_BUCKET starts one, else the shared one', () => {
    expect(brandStorageConfigured('roboapply', INTL_S3)).toBe(true);
    expect(brandStorageConfigured('roboapply', CN_S3)).toBe(false);
    // The shared store is GoApply's fallback.
    expect(brandStorageConfigured('goapply', INTL_S3)).toBe(true);
    expect(brandStorageConfigured('goapply', {})).toBe(false);
    expect(brandStorageConfigured('goapply', { ...INTL_S3, ...CN_S3 })).toBe(true);
    // A CN bucket that is started but incomplete is not configured, and the shared keys never complete it.
    expect(brandStorageConfigured('goapply', { ...INTL_S3, CN_S3_BUCKET: 'b' })).toBe(false);
    expect(brandStorageConfigured('goapply', { ...INTL_S3, ...CN_S3, CN_S3_SECRET_ACCESS_KEY: undefined })).toBe(false);
  });

  it('CN_STORAGE_MODE=redact removes IDs and health details from the text and still keeps the original and images', () => {
    const p = resumeUploadPolicy('goapply', { ...INTL_S3, CN_STORAGE_MODE: 'redact' });
    expect(p.originals).toBe('store');
    expect(p.dropImages).toBe(false);
    expect(p.redactKinds).toEqual(expect.arrayContaining(['prc_id', 'health']));
    expect(resumeUploadPolicy('roboapply', { CN_STORAGE_MODE: 'redact' }).redactKinds).toEqual([]);
  });

  it('CN_STORAGE_MODE=discard is the former CN-0 rule: no original, no image, redacted text', () => {
    for (const env of [{ CN_STORAGE_MODE: 'discard' }, { CN_STORAGE_MODE: ' Discard ', ...CN_S3, ...INTL_S3 }, { CN_STORAGE_MODE: 'discard', DEPLOY_REGION: 'cn-mainland' }]) {
      const p = resumeUploadPolicy('goapply', env);
      expect(p.originals).toBe('discard');
      expect(p.dropImages).toBe(true);
      expect(p.redactKinds).toEqual(expect.arrayContaining(['prc_id', 'health']));
      expect(mayStoreOriginal('goapply', env)).toBe(false);
    }
    // RoboApply never reads the switch.
    expect(resumeUploadPolicy('roboapply', { CN_STORAGE_MODE: 'discard' }).originals).toBe('store');
  });

  it('CN_STORAGE_MODE: store is the default; an unknown value is read as discard and reported', () => {
    expect(cnStorageMode({})).toBe('store');
    expect(cnStorageMode({ CN_STORAGE_MODE: '  ' })).toBe('store');
    expect(cnStorageMode({ CN_STORAGE_MODE: 'STORE' })).toBe('store');
    expect(cnStorageMode({ CN_STORAGE_MODE: 'redact' })).toBe('redact');
    expect(cnStorageModeProblem({})).toBeNull();
    for (const mode of ['store', 'redact', 'discard']) expect(cnStorageModeProblem({ CN_STORAGE_MODE: mode })).toBeNull();
    // A typo in a privacy switch must not quietly keep everything.
    expect(cnStorageMode({ CN_STORAGE_MODE: 'redcat' })).toBe('discard');
    expect(cnStorageModeProblem({ CN_STORAGE_MODE: ' redcat ' })).toBe('redcat');
    expect(resumeUploadPolicy('goapply', { CN_STORAGE_MODE: 'true' }).originals).toBe('discard');
  });

  it('`unavailable` only under CN_RESIDENCY_STRICT without a complete mainland bucket of its own', () => {
    // Strict + a complete mainland CN bucket: kept.
    expect(resumeUploadPolicy('goapply', { ...STRICT, ...CN_S3 }).originals).toBe('store');
    expect(cnOwnStorageProblem(CN_S3)).toBeNull();
    // Strict without one: refused, in either region; the shared bucket is not a fallback there.
    for (const env of [STRICT, { ...STRICT, ...INTL_S3 }, { ...STRICT, DEPLOY_REGION: 'cn-mainland', ...INTL_S3 }, { ...STRICT, ...CN_S3, CN_S3_ACCESS_KEY_ID: '' }]) {
      expect(resumeUploadPolicy('goapply', env).originals).toBe('unavailable');
      expect(cnOwnStorageProblem(env)).toBe('missing');
    }
    // Strict with a CN bucket that is not mainland object storage, or is the shared bucket's host.
    const aws = { ...STRICT, ...CN_S3, CN_S3_ENDPOINT: 'https://s3.us-east-1.amazonaws.com' };
    expect(cnOwnStorageProblem(aws)).toBe('offshore');
    expect(resumeUploadPolicy('goapply', aws).originals).toBe('unavailable');
    expect(cnOwnStorageProblem({ ...CN_S3, S3_ENDPOINT: CN_S3.CN_S3_ENDPOINT })).toBe('offshore');
    // The same facts without the strict switch refuse nothing.
    expect(resumeUploadPolicy('goapply', { ...CN_S3, CN_S3_ENDPOINT: 'https://s3.us-east-1.amazonaws.com' }).originals).toBe('store');
    // discard keeps nothing, so strict has nothing to refuse.
    expect(resumeUploadPolicy('goapply', { ...STRICT, CN_STORAGE_MODE: 'discard' }).originals).toBe('discard');
    // RoboApply is never affected.
    expect(resumeUploadPolicy('roboapply', STRICT).originals).toBe('store');
  });

  it('assertResumeUploadStorage throws 503 storage_unavailable only under the strict switch', () => {
    // The default: a mainland GoApply upload with only the shared bucket is accepted.
    expect(assertResumeUploadStorage('goapply', { DEPLOY_REGION: 'cn-mainland', ...INTL_S3 }).originals).toBe('store');
    expect(assertResumeUploadStorage('goapply', {}).originals).toBe('store');
    expect(() => assertResumeUploadStorage('goapply', { ...STRICT, DEPLOY_REGION: 'cn-mainland', ...INTL_S3 })).toThrow(StorageUnavailableError);
    try {
      assertResumeUploadStorage('goapply', { ...STRICT, DEPLOY_REGION: 'cn-mainland' });
      throw new Error('expected a throw');
    } catch (err) {
      expect((err as StorageUnavailableError).status).toBe(503);
      expect((err as StorageUnavailableError).code).toBe('storage_unavailable');
      expect((err as StorageUnavailableError).brand).toBe('goapply');
    }
    expect(assertResumeUploadStorage('goapply', { CN_STORAGE_MODE: 'discard' }).originals).toBe('discard');
    expect(assertResumeUploadStorage('roboapply', {}).originals).toBe('store');
  });
});

describe('applyResumeUploadPolicy', () => {
  const content = {
    rawText: `张三\n身份证号：${PRC_ID}\n电话：138 0013 8000\n健康状况：良好\n本人身体健康，无乙肝。负责推荐系统。`,
    markdown: `# 张三\n- 身份证 ${PRC_ID}\n- 怀孕期间远程办公`,
    summary: '后端工程师，五年经验。',
    parsed: {
      name: '张三',
      phone: '138 0013 8000',
      photo: 'data:image/png;base64,AAAA',
      avatarUrl: 'https://example.com/a.png',
      otherSections: { 健康状况: '良好', 籍贯: '浙江', 照片: '见附件' },
      experience: [{ description: '负责推荐系统', logo: 'data:image/jpeg;base64,BBBB' }],
    },
  };

  it('by default a GoApply resume with an ID number is stored verbatim, exactly like a RoboApply one (D5)', () => {
    for (const env of [{}, INTL_S3, { DEPLOY_REGION: 'cn-mainland', ...CN_S3 }]) {
      const cn = applyResumeUploadPolicy('goapply', content, env);
      expect(cn.rawText).toBe(content.rawText);
      expect(cn.markdown).toBe(content.markdown);
      expect(cn.parsed).toBe(content.parsed);
      expect(cn.redactions).toBeNull();
      expect(cn.imagesDropped).toBe(0);
      expect(cn.storeOriginal).toBe(true);
    }
    const intl = applyResumeUploadPolicy('roboapply', content, {});
    expect(intl.rawText).toBe(content.rawText);
    expect(intl.parsed).toBe(content.parsed);
    expect(intl.redactions).toBeNull();
    expect(intl.storeOriginal).toBe(true);
  });

  it('CN_STORAGE_MODE=redact: the stored text carries the marker instead of the ID and health details; photos and the original stay', () => {
    const out = applyResumeUploadPolicy('goapply', content, { CN_STORAGE_MODE: 'redact' });
    expect(out.storeOriginal).toBe(true);
    const stored = JSON.stringify([out.rawText, out.markdown, out.summary, out.parsed]);
    expect(stored).not.toContain(PRC_ID);
    expect(stored).not.toContain('乙肝');
    expect(stored).not.toContain('怀孕');
    expect(out.rawText).toContain('[已移除证件号]');
    expect(out.redactions).toMatchObject({ prc_id: 2 });
    // Photos are kept in this mode.
    expect(out.imagesDropped).toBe(0);
    expect(out.parsed).toHaveProperty('photo');
    // The input is not mutated.
    expect(content.rawText).toContain(PRC_ID);
  });

  it('CN_STORAGE_MODE=discard: stored text and fields carry no PRC ID, no health detail, no photo; no original', () => {
    const out = applyResumeUploadPolicy('goapply', content, { CN_STORAGE_MODE: 'discard' });
    expect(out.storeOriginal).toBe(false);
    const stored = JSON.stringify([out.rawText, out.markdown, out.summary, out.parsed]);
    expect(stored).not.toContain(PRC_ID);
    expect(stored).not.toContain('乙肝');
    expect(stored).not.toContain('怀孕');
    expect(stored).not.toContain('良好');
    expect(stored).not.toMatch(/data:image/);
    expect(out.parsed).not.toHaveProperty('photo');
    expect(out.parsed).not.toHaveProperty('avatarUrl');
    expect(out.parsed!.otherSections).not.toHaveProperty('照片');
    expect(out.imagesDropped).toBe(4);
    // Contact details and the rest of the resume stay.
    expect(out.rawText).toContain('138 0013 8000');
    expect(out.rawText).toContain('负责推荐系统');
    expect(out.parsed!.otherSections.籍贯).toBe('浙江');
    expect(out.redactions).toMatchObject({ prc_id: 2 });
    // The input is not mutated.
    expect(content.parsed.photo).toMatch(/^data:image/);
  });

  it('works with text only', () => {
    expect(applyResumeUploadPolicy('goapply', { rawText: `ID ${PRC_ID}` }, {}).rawText).toBe(`ID ${PRC_ID}`);
    const out = applyResumeUploadPolicy('goapply', { rawText: `ID ${PRC_ID}` }, { CN_STORAGE_MODE: 'redact' });
    expect(out.rawText).toBe('ID [已移除证件号]');
    expect(out.parsed).toBeUndefined();
  });
});

describe('helpers', () => {
  it('detects image uploads by MIME or extension', () => {
    expect(isImageUpload('image/jpeg')).toBe(true);
    expect(isImageUpload('application/octet-stream', 'scan.PNG')).toBe(true);
    expect(isImageUpload('application/pdf', 'cv.pdf')).toBe(false);
    expect(isImageUpload(null, null)).toBe(false);
  });

  it('residencySummary states what the deployment does, nothing more', () => {
    // GoApply on the shared stack: files kept on the shared store, nothing redacted or discarded.
    expect(residencySummary('goapply', { GOHIRE_API_KEY: 'k', ...INTL_S3 })).toMatchObject({
      region: 'offshore',
      stage: 'cn0',
      originalFiles: 'kept',
      storage: 'shared',
      storageHost: 'acct.r2.cloudflarestorage.com',
      resumeParsing: 'gohire_mainland',
      redactedBeforeStorage: [],
      imagesDiscarded: false,
    });
    expect(residencySummary('roboapply', INTL_S3)).toMatchObject({
      stage: 'intl',
      originalFiles: 'kept',
      storage: 'shared',
      storageHost: 'acct.r2.cloudflarestorage.com',
      resumeParsing: 'local',
      redactedBeforeStorage: [],
    });
    // Its own bucket: the host is the CN one even when the shared bucket is configured too.
    expect(residencySummary('goapply', { DEPLOY_REGION: 'cn-mainland', ...INTL_S3, ...CN_S3 })).toMatchObject({
      region: 'cn-mainland',
      originalFiles: 'kept',
      storage: 'own',
      storageHost: 'oss-cn-shanghai.aliyuncs.com',
    });
    // The opt-in modes are stated as they are.
    expect(residencySummary('goapply', { CN_STORAGE_MODE: 'discard' })).toMatchObject({ originalFiles: 'not_kept', storageHost: null, imagesDiscarded: true });
    expect(residencySummary('goapply', { CN_STORAGE_MODE: 'redact' }).redactedBeforeStorage).toEqual(expect.arrayContaining(['prc_id', 'health']));
    expect(residencySummary('goapply', { DEPLOY_REGION: 'cn-mainland', CN_RESIDENCY_STRICT: 'true' }).originalFiles).toBe('unavailable');
    expect(residencySummary('goapply', { DEPLOY_REGION: 'cn-mainland' }).originalFiles).toBe('kept');
  });

  it('residencySummary reports GoHire parsing only when the call is really made (enabled, keyed, opted in)', () => {
    // No key: the parse service makes no call, so the notice must not describe the transfer.
    expect(residencySummary('goapply', {}).resumeParsing).toBe('local');
    expect(residencySummary('goapply', { GOHIRE_API_KEY: 'k', GOHIRE_PARSE_ENABLED: 'false' }).resumeParsing).toBe('local');
    expect(residencySummary('goapply', { GOHIRE_API_KEY: 'k', GOHIRE_PARSE_BRANDS: 'none' }).resumeParsing).toBe('local');
    expect(residencySummary('roboapply', { GOHIRE_API_KEY: 'k' }).resumeParsing).toBe('local');
    expect(residencySummary('roboapply', { GOHIRE_API_KEY: 'k', GOHIRE_PARSE_BRANDS: 'goapply,roboapply' }).resumeParsing).toBe(
      'gohire_mainland',
    );
  });
});
