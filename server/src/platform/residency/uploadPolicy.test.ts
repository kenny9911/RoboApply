// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  StorageUnavailableError,
  applyResumeUploadPolicy,
  assertResumeUploadStorage,
  brandStorageConfigured,
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

describe('resumeUploadPolicy', () => {
  it('RoboApply keeps originals and redacts nothing', () => {
    const p = resumeUploadPolicy('roboapply', {});
    expect(p).toMatchObject({ stage: 'intl', originals: 'store', redactKinds: [], dropImages: false });
  });

  it('GoApply offshore (CN-0) never keeps an original, drops images and redacts IDs and health', () => {
    const p = resumeUploadPolicy('goapply', { ...CN_S3, ...INTL_S3 });
    expect(p.stage).toBe('cn0');
    expect(p.originals).toBe('discard');
    expect(p.dropImages).toBe(true);
    expect(p.redactKinds).toEqual(expect.arrayContaining(['prc_id', 'health']));
    expect(mayStoreOriginal('goapply', {})).toBe(false);
  });

  it('GoApply on the mainland keeps originals only with CN_S3_* — the intl bucket never counts', () => {
    expect(resumeUploadPolicy('goapply', { DEPLOY_REGION: 'cn-mainland', ...CN_S3 }).originals).toBe('store');
    expect(resumeUploadPolicy('goapply', { DEPLOY_REGION: 'cn-mainland', ...INTL_S3 }).originals).toBe('unavailable');
    expect(brandStorageConfigured('goapply', INTL_S3)).toBe(false);
    expect(brandStorageConfigured('roboapply', INTL_S3)).toBe(true);
  });

  it('assertResumeUploadStorage throws 503 storage_unavailable for a mainland GoApply upload without CN_S3_*', () => {
    expect(() => assertResumeUploadStorage('goapply', { DEPLOY_REGION: 'cn-mainland', ...INTL_S3 })).toThrow(StorageUnavailableError);
    try {
      assertResumeUploadStorage('goapply', { DEPLOY_REGION: 'cn-mainland' });
    } catch (err) {
      expect((err as StorageUnavailableError).status).toBe(503);
      expect((err as StorageUnavailableError).code).toBe('storage_unavailable');
      expect((err as StorageUnavailableError).brand).toBe('goapply');
    }
    // CN-0 uploads are accepted (parsed in memory, nothing stored).
    expect(assertResumeUploadStorage('goapply', {}).originals).toBe('discard');
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

  it('CN-0 GoApply: stored text and fields carry no PRC ID, no health detail, no photo', () => {
    const out = applyResumeUploadPolicy('goapply', content, {});
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

  it('RoboApply and mainland GoApply content passes through unchanged', () => {
    const intl = applyResumeUploadPolicy('roboapply', content, {});
    expect(intl.rawText).toBe(content.rawText);
    expect(intl.parsed).toBe(content.parsed);
    expect(intl.redactions).toBeNull();
    expect(intl.storeOriginal).toBe(true);
    const cn1 = applyResumeUploadPolicy('goapply', content, { DEPLOY_REGION: 'cn-mainland', ...CN_S3 });
    expect(cn1.rawText).toBe(content.rawText);
    expect(cn1.storeOriginal).toBe(true);
  });

  it('works with text only', () => {
    const out = applyResumeUploadPolicy('goapply', { rawText: `ID ${PRC_ID}` }, {});
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
    expect(residencySummary('goapply', { GOHIRE_API_KEY: 'k' })).toMatchObject({
      region: 'offshore',
      stage: 'cn0',
      originalFiles: 'not_kept',
      storageHost: null,
      resumeParsing: 'gohire_mainland',
      imagesDiscarded: true,
    });
    expect(residencySummary('roboapply', INTL_S3)).toMatchObject({
      stage: 'intl',
      originalFiles: 'kept',
      storageHost: 'acct.r2.cloudflarestorage.com',
      resumeParsing: 'local',
      redactedBeforeStorage: [],
    });
    expect(residencySummary('goapply', { DEPLOY_REGION: 'cn-mainland', ...CN_S3 })).toMatchObject({
      region: 'cn-mainland',
      originalFiles: 'kept',
      storageHost: 'oss-cn-shanghai.aliyuncs.com',
    });
    expect(residencySummary('goapply', { DEPLOY_REGION: 'cn-mainland' }).originalFiles).toBe('unavailable');
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
