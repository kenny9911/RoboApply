// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  EgressPolicyError,
  assertEgress,
  assertNoPiInPayload,
  checkEgress,
  goHireParseActive,
  goHireParseAllowedFor,
  goHireParseBrands,
  isMainlandStorageHost,
  isPrivateHost,
} from './egressPolicy.js';
import { deployRegion, isCn0, isCnMainland, residencyStage, unknownDeployRegion } from './deployRegion.js';

const MAINLAND = { DEPLOY_REGION: 'cn-mainland' };
const OFFSHORE = {};
/** The strict mainland posture is an explicit operator choice (CN_RESIDENCY_STRICT), never implied by the region. */
const STRICT = { CN_RESIDENCY_STRICT: 'true' };

function code(input: Parameters<typeof checkEgress>[0]) {
  const d = checkEgress(input);
  return d.allowed ? 'allowed' : d.code;
}

describe('deployRegion', () => {
  it('reads cn-mainland only; anything else is offshore, unknown values are flagged', () => {
    expect(deployRegion({})).toBe('offshore');
    expect(deployRegion({ DEPLOY_REGION: ' CN-Mainland ' })).toBe('cn-mainland');
    expect(isCnMainland({ DEPLOY_REGION: 'cn_mainland' })).toBe(false);
    expect(unknownDeployRegion({ DEPLOY_REGION: 'cn_mainland' })).toBe('cn_mainland');
    expect(unknownDeployRegion({ DEPLOY_REGION: 'cn-mainland' })).toBeNull();
    expect(unknownDeployRegion({})).toBeNull();
  });

  it('maps brand × region to a stage', () => {
    expect(residencyStage('roboapply', MAINLAND)).toBe('intl');
    expect(residencyStage('goapply', OFFSHORE)).toBe('cn0');
    expect(residencyStage('goapply', MAINLAND)).toBe('cn1');
    expect(isCn0('goapply', OFFSHORE)).toBe(true);
    expect(isCn0('roboapply', OFFSHORE)).toBe(false);
  });
});

describe('goHireParseActive (the parse service and the privacy summary share it)', () => {
  const ON = { GOHIRE_API_KEY: 'k' };
  it('is true only when the brand is opted in, enabled, keyed and the host passes egress', () => {
    expect(goHireParseActive('goapply', ON)).toBe(true);
    expect(goHireParseActive('roboapply', ON)).toBe(false);
    expect(goHireParseActive('roboapply', { ...ON, GOHIRE_PARSE_BRANDS: 'goapply,roboapply' })).toBe(true);
    expect(goHireParseActive('goapply', {})).toBe(false);
    expect(goHireParseActive('goapply', { ...ON, GOHIRE_PARSE_ENABLED: 'false' })).toBe(false);
    expect(goHireParseActive('goapply', { ...ON, GOHIRE_PARSE_BRANDS: 'none' })).toBe(false);
    // Another base URL: allowed by default (GoApply may send where RoboApply may), refused under the strict allowlist.
    expect(goHireParseActive('goapply', { ...ON, GOHIRE_API_BASE: 'https://parse.example.com' })).toBe(true);
    expect(goHireParseActive('goapply', { ...ON, ...STRICT, GOHIRE_API_BASE: 'https://parse.example.com' })).toBe(false);
    expect(goHireParseActive('goapply', { ...ON, ...STRICT })).toBe(true);
  });
});

describe('GOHIRE_PARSE_BRANDS', () => {
  it('defaults to goapply only', () => {
    expect(goHireParseBrands({})).toEqual(['goapply']);
    expect(goHireParseBrands({ GOHIRE_PARSE_BRANDS: '  ' })).toEqual(['goapply']);
    expect(goHireParseAllowedFor('roboapply', {})).toBe(false);
  });

  it('accepts brand ids and market aliases; none/off disables', () => {
    expect(goHireParseBrands({ GOHIRE_PARSE_BRANDS: 'cn,intl' })).toEqual(['goapply', 'roboapply']);
    expect(goHireParseBrands({ GOHIRE_PARSE_BRANDS: 'none' })).toEqual([]);
    expect(goHireParseBrands({ GOHIRE_PARSE_BRANDS: 'bogus' })).toEqual([]);
  });
});

describe('Tavily / Firecrawl / RapidAPI never receive PI (both brands)', () => {
  const vendors = [
    'https://api.tavily.com/search',
    'https://api.firecrawl.dev/v1/scrape',
    'https://jsearch.p.rapidapi.com/search-v2',
    'linkedin-job-search-api.p.rapidapi.com',
  ];
  for (const target of vendors) {
    it(`${target}: PI refused, plain job queries allowed`, () => {
      for (const brand of ['roboapply', 'goapply'] as const) {
        // The same in both regions: the region no longer changes the answer (D5).
        for (const env of [OFFSHORE, MAINLAND]) {
          expect(code({ brand, target, carriesPi: true, env })).toBe('no_pi_vendor');
          expect(code({ brand, target, carriesPi: false, env })).toBe('allowed');
        }
      }
    });
  }

  it('are not called at all for GoApply under CN_RESIDENCY_STRICT, in either region', () => {
    for (const env of [STRICT, { ...STRICT, ...MAINLAND }]) {
      expect(code({ brand: 'goapply', target: 'https://api.tavily.com', carriesPi: false, env })).toBe('vendor_disabled_in_region');
      expect(code({ brand: 'goapply', target: 'https://jsearch.p.rapidapi.com/search-v2', carriesPi: false, env })).toBe('vendor_disabled_in_region');
      expect(code({ brand: 'roboapply', target: 'https://api.tavily.com', carriesPi: false, env })).toBe('allowed');
    }
  });

  it('assertNoPiInPayload refuses a query carrying an email, phone, ID or the user name', () => {
    const base = { brand: 'roboapply' as const, target: 'https://jsearch.p.rapidapi.com/search-v2', env: OFFSHORE };
    expect(assertNoPiInPayload({ ...base, payload: { query: 'senior backend engineer in Taipei', page: 1 } })).toBe(
      'jsearch.p.rapidapi.com',
    );
    for (const payload of [
      { query: 'jobs for jane.doe@example.com' },
      'engineer 0912-345-678',
      { q: ['backend', '11010519491231002X'] },
    ]) {
      expect(() => assertNoPiInPayload({ ...base, payload })).toThrow(EgressPolicyError);
    }
    expect(() => assertNoPiInPayload({ ...base, payload: 'resume of Jane Doe', knownValues: ['Jane Doe'] })).toThrow(/known_value/);
    try {
      assertNoPiInPayload({ ...base, payload: 'x@y.io' });
    } catch (err) {
      expect((err as EgressPolicyError).policyCode).toBe('pi_in_payload');
      expect((err as EgressPolicyError).code).toBe('egress_blocked');
    }
  });

  it('assertNoPiInPayload matches Latin-script known values as whole words only', () => {
    const base = { brand: 'roboapply' as const, target: 'https://jsearch.p.rapidapi.com/search', env: OFFSHORE };
    // Review probe: a user surnamed Li used to block every "Linux" query.
    expect(assertNoPiInPayload({ ...base, payload: { query: 'Linux engineer in Austin' }, knownValues: ['Li'] })).toBe(
      'jsearch.p.rapidapi.com',
    );
    expect(() => assertNoPiInPayload({ ...base, payload: { query: 'Li Wei Linux engineer' }, knownValues: ['Li'] })).toThrow(
      /known_value/,
    );
    expect(() => assertNoPiInPayload({ ...base, payload: 'resume of li wei', knownValues: ['Li Wei'] })).toThrow(/known_value/);
    // CJK values still match inside running text (no word spaces in CJK).
    expect(() =>
      assertNoPiInPayload({ brand: 'goapply', target: 'https://api.tavily.com/search', env: OFFSHORE, payload: '张三的简历', knownValues: ['张三'] }),
    ).toThrow(/known_value/);
  });

  it('assertNoPiInPayload refuses a passport number', () => {
    const base = { brand: 'roboapply' as const, target: 'https://api.tavily.com/search', env: OFFSHORE };
    expect(() => assertNoPiInPayload({ ...base, payload: 'Passport No: 123456789 visa jobs' })).toThrow(/gov_id/);
  });

  it('assertNoPiInPayload lets a GoApply company query through on the mainland by default and refuses it under the strict switch', () => {
    expect(assertNoPiInPayload({ brand: 'goapply', target: 'https://api.firecrawl.dev', payload: 'company page', env: MAINLAND })).toBe('api.firecrawl.dev');
    expect(() =>
      assertNoPiInPayload({ brand: 'goapply', target: 'https://api.firecrawl.dev', payload: 'company page', env: { ...MAINLAND, ...STRICT } }),
    ).toThrow(/CN_RESIDENCY_STRICT/);
  });
});

describe('GoApply default (D5): the shared stack is its fallback, so PI may go where RoboApply may send it', () => {
  const env = { S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com' };

  it.each([
    ['https://openrouter.ai/api/v1'],
    ['https://api.openai.com'],
    ['https://api.resend.com/emails'],
    ['wss://project.livekit.cloud'],
    ['https://acct.r2.cloudflarestorage.com/goapply/key'],
    ['ep-cool-1.us-east-2.aws.neon.tech'],
    ['https://api.deepseek.com/v1/chat/completions'],
    ['https://api.gohire.top/api/v1/parse-resume'],
    ['https://oss-cn-shanghai.aliyuncs.com'],
    ['https://dysmsapi.aliyuncs.com'],
  ])('allows PI to %s in both regions', (target) => {
    expect(code({ brand: 'goapply', target, carriesPi: true, env })).toBe('allowed');
    expect(code({ brand: 'goapply', target, carriesPi: true, env: { ...env, ...MAINLAND } })).toBe('allowed');
  });

  it('Tavily without PI is allowed in both regions; with PI it is refused like for RoboApply', () => {
    for (const e of [env, { ...env, ...MAINLAND }]) {
      expect(code({ brand: 'goapply', target: 'https://api.tavily.com/search', carriesPi: false, env: e })).toBe('allowed');
      expect(code({ brand: 'goapply', target: 'https://api.tavily.com/search', carriesPi: true, env: e })).toBe('no_pi_vendor');
    }
  });
});

describe('GoApply allowlist (CN_RESIDENCY_STRICT=true only)', () => {
  const env = {
    ...STRICT,
    S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
    CN_S3_ENDPOINT: 'https://oss-cn-shanghai.aliyuncs.com',
    CN_LIVEKIT_URL: 'wss://rtc.goapply.example.cn',
  };

  it.each([
    ['https://api.deepseek.com/v1/chat/completions'],
    ['https://dashscope.aliyuncs.com/compatible-mode/v1'],
    ['https://api.gohire.top/api/v1/parse-resume'],
    ['https://oss-cn-shanghai.aliyuncs.com'],
    ['https://bucket.oss-cn-beijing.aliyuncs.com/key'],
    ['https://dysmsapi.aliyuncs.com'],
    ['https://dm.aliyuncs.com/'],
    ['https://green-cip.cn-shanghai.aliyuncs.com'],
    ['https://api.weixin.qq.com/sns/oauth2'],
    ['wss://rtc.goapply.example.cn'],
    ['http://10.0.3.4:5432'],
    ['http://localhost:4621'],
  ])('allows PI to %s', (target) => {
    expect(code({ brand: 'goapply', target, carriesPi: true, env })).toBe('allowed');
  });

  it('refuses offshore model vendors and the shared bucket', () => {
    expect(code({ brand: 'goapply', target: 'https://openrouter.ai/api/v1', carriesPi: true, env })).toBe(
      'host_not_allowlisted_for_cn',
    );
    expect(code({ brand: 'goapply', target: 'https://api.openai.com', carriesPi: true, env })).toBe('host_not_allowlisted_for_cn');
    expect(code({ brand: 'goapply', target: 'https://dashscope-intl.aliyuncs.com', carriesPi: true, env })).toBe(
      'host_not_allowlisted_for_cn',
    );
    expect(code({ brand: 'goapply', target: 'https://dm.ap-southeast-1.aliyuncs.com', carriesPi: true, env })).toBe(
      'host_not_allowlisted_for_cn',
    );
    expect(code({ brand: 'goapply', target: 'https://acct.r2.cloudflarestorage.com/x', carriesPi: true, env })).toBe(
      'intl_storage_for_cn',
    );
  });

  it('allows storage only on a mainland region host — naming a host in CN_S3_ENDPOINT is not enough', () => {
    const aws = { ...MAINLAND, ...STRICT, CN_S3_ENDPOINT: 'https://s3.us-east-1.amazonaws.com' };
    // Review probe: this used to pass because the host equalled CN_S3_ENDPOINT.
    expect(code({ brand: 'goapply', target: 'https://s3.us-east-1.amazonaws.com/goapply/key', carriesPi: true, env: aws })).toBe(
      'host_not_allowlisted_for_cn',
    );
    expect(isMainlandStorageHost('https://s3.us-east-1.amazonaws.com', aws)).toBe(false);
    expect(isMainlandStorageHost('https://oss-ap-southeast-1.aliyuncs.com', MAINLAND)).toBe(false);
    expect(isMainlandStorageHost('https://bucket.oss-cn-hangzhou-internal.aliyuncs.com', MAINLAND)).toBe(true);
    expect(isMainlandStorageHost('https://b-1250000000.cos.ap-shanghai.myqcloud.com', MAINLAND)).toBe(true);
    expect(isMainlandStorageHost('https://cos.ap-hongkong.myqcloud.com', MAINLAND)).toBe(false);
    // FIX-8: Aliyun's Hong Kong region carries the `oss-cn-` prefix and is not the mainland.
    expect(isMainlandStorageHost('https://oss-cn-hongkong.aliyuncs.com', MAINLAND)).toBe(false);
    expect(isMainlandStorageHost('https://bucket.oss-cn-hongkong-internal.aliyuncs.com', MAINLAND)).toBe(false);
    expect(isMainlandStorageHost('https://bucket.oss-cn-hongkong.aliyuncs.com', MAINLAND)).toBe(false);
    expect(isMainlandStorageHost('https://bucket.oss-cn-shenzhen.aliyuncs.com', MAINLAND)).toBe(true);
    expect(isMainlandStorageHost('https://obs.cn-north-4.myhuaweicloud.com', MAINLAND)).toBe(true);
    expect(isMainlandStorageHost('http://192.168.1.20:9000', MAINLAND)).toBe(true);
    expect(isMainlandStorageHost('https://minio.cn.example', { CN_ALLOWED_STORAGE_HOST_SUFFIXES: 'cn.example' })).toBe(true);
    // The intl bucket host is never mainland storage, whatever else matches.
    expect(
      isMainlandStorageHost('https://oss-cn-shanghai.aliyuncs.com', { S3_ENDPOINT: 'https://oss-cn-shanghai.aliyuncs.com' }),
    ).toBe(false);
    expect(isMainlandStorageHost(null, MAINLAND)).toBe(false);
  });

  it('has no exemption for offshore infrastructure: Neon, Resend and LiveKit Cloud are refused in either region', () => {
    const neon = 'ep-cool-1.us-east-2.aws.neon.tech';
    for (const e of [STRICT, { ...STRICT, ...MAINLAND }]) {
      expect(code({ brand: 'goapply', target: neon, carriesPi: true, env: e })).toBe('host_not_allowlisted_for_cn');
      expect(code({ brand: 'goapply', target: 'https://api.resend.com/emails', carriesPi: true, env: e })).toBe('host_not_allowlisted_for_cn');
      expect(code({ brand: 'goapply', target: 'wss://project.livekit.cloud', carriesPi: true, env: e })).toBe('host_not_allowlisted_for_cn');
    }
  });

  it('never changes a RoboApply decision', () => {
    for (const target of ['https://openrouter.ai/api/v1', 'https://api.resend.com/emails', 'https://acct.r2.cloudflarestorage.com']) {
      expect(code({ brand: 'roboapply', target, carriesPi: true, env })).toBe('allowed');
    }
    expect(code({ brand: 'roboapply', target: 'https://api.deepseek.com', carriesPi: true, env })).toBe('mainland_endpoint_for_intl');
  });

  it('honours CN_LLM_DOMESTIC_HOSTS for a self-hosted gateway', () => {
    expect(
      code({ brand: 'goapply', target: 'https://llm.internal.example.cn', carriesPi: true, env: { ...STRICT, CN_LLM_DOMESTIC_HOSTS: 'llm.internal.example.cn' } }),
    ).toBe('allowed');
    expect(code({ brand: 'goapply', target: 'https://llm.internal.example.cn', carriesPi: true, env: STRICT })).toBe('host_not_allowlisted_for_cn');
  });
});

describe('RoboApply denylist', () => {
  it('allows today’s offshore vendors', () => {
    for (const target of ['https://openrouter.ai/api/v1', 'https://api.resend.com/emails', 'https://acct.r2.cloudflarestorage.com']) {
      expect(code({ brand: 'roboapply', target, carriesPi: true, env: OFFSHORE })).toBe('allowed');
    }
  });

  it('never sends PI to a mainland model endpoint', () => {
    for (const target of ['https://api.deepseek.com', 'https://api.moonshot.cn/v1', 'https://open.bigmodel.cn', 'ark.cn-beijing.volces.com']) {
      expect(code({ brand: 'roboapply', target, carriesPi: true, env: OFFSHORE })).toBe('mainland_endpoint_for_intl');
    }
  });

  it('reaches GoHire parse only when opted in', () => {
    const target = 'https://api.gohire.top/api/v1/parse-resume';
    expect(code({ brand: 'roboapply', target, carriesPi: true, env: {} })).toBe('gohire_parse_not_opted_in');
    expect(code({ brand: 'roboapply', target, carriesPi: true, env: { GOHIRE_PARSE_BRANDS: 'goapply,roboapply' } })).toBe('allowed');
  });

  it('never sends PI to mainland-only services', () => {
    expect(code({ brand: 'roboapply', target: 'https://dysmsapi.aliyuncs.com', carriesPi: true, env: {} })).toBe('cn_service_for_intl');
    expect(code({ brand: 'roboapply', target: 'https://api.weixin.qq.com', carriesPi: true, env: {} })).toBe('cn_service_for_intl');
  });

  it('assertEgress throws a typed error and returns the host when allowed', () => {
    expect(assertEgress({ brand: 'roboapply', target: 'https://openrouter.ai/x', env: {} })).toBe('openrouter.ai');
    expect(() => assertEgress({ brand: 'roboapply', target: 'https://api.deepseek.com', env: {} })).toThrow(EgressPolicyError);
  });
});

describe('edges', () => {
  it('rejects an unreadable target', () => {
    expect(code({ brand: 'goapply', target: '', env: {} })).toBe('invalid_target');
  });

  it('classifies private hosts', () => {
    for (const h of ['localhost', '127.0.0.1', '10.1.2.3', '192.168.0.9', '172.20.1.1', 'api.localhost', '::1']) {
      expect(isPrivateHost(h)).toBe(true);
    }
    for (const h of ['172.32.0.1', '8.8.8.8', 'example.com']) expect(isPrivateHost(h)).toBe(false);
  });

  it('non-PI calls are allowed for both brands outside the vendor rules', () => {
    expect(code({ brand: 'goapply', target: 'https://openrouter.ai', carriesPi: false, env: {} })).toBe('allowed');
    expect(code({ brand: 'goapply', target: 'https://openrouter.ai', carriesPi: false, env: STRICT })).toBe('allowed');
  });
});
