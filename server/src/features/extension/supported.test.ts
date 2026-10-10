// @vitest-environment node
//
// WP-55a: supported ATS types are per market. GoApply's build has no
// Greenhouse / Lever / Ashby adapter, so only RoboApply's list reaches the
// brand-agnostic job-detail registry, and the web mirror agrees.

import { describe, expect, it, vi } from 'vitest';

const registry = vi.hoisted(() => ({ registerExtensionAtsTypes: vi.fn() }));
vi.mock('../jobs/detail/index.js', () => registry);

import { EXTENSION_ATS_BY_BRAND } from '../../../../hooks/extension/bridge';
import { EXTENSION_ATS_TYPES_BY_MARKET } from './contract.js';
import { EXTENSION_ATS_TYPES, extensionAtsTypesFor, registerSupportedAtsTypes } from './supported.js';

describe('supported ATS types', () => {
  it('RoboApply fills Greenhouse, Lever and Ashby; GoApply none until WP-71', () => {
    expect(extensionAtsTypesFor('intl')).toEqual(['greenhouse', 'lever', 'ashby']);
    expect(extensionAtsTypesFor('cn')).toEqual([]);
    expect(EXTENSION_ATS_TYPES).toEqual(EXTENSION_ATS_TYPES_BY_MARKET.intl);
  });

  it('registers only the RoboApply list in the job-detail registry, once', () => {
    registerSupportedAtsTypes();
    registerSupportedAtsTypes();
    expect(registry.registerExtensionAtsTypes).toHaveBeenCalledTimes(1);
    expect([...registry.registerExtensionAtsTypes.mock.calls[0]![0]]).toEqual(['greenhouse', 'lever', 'ashby']);
  });

  it('the web mirror matches the server lists', () => {
    expect(EXTENSION_ATS_BY_BRAND.roboapply.map((a) => a.type)).toEqual([...EXTENSION_ATS_TYPES_BY_MARKET.intl]);
    expect(EXTENSION_ATS_BY_BRAND.goapply.map((a) => a.type)).toEqual([...EXTENSION_ATS_TYPES_BY_MARKET.cn]);
  });
});
