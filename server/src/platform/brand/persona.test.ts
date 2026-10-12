// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { brandPersona, currentBrandPersona } from './persona.js';
import { BRANDS } from './registry.js';
import { runWithBrand } from '../../lib/requestContext.js';

describe('brandPersona', () => {
  it('keeps the RoboApply wording byte-for-byte', () => {
    expect(brandPersona(BRANDS.roboapply, 'match scorer')).toBe("You are RoboApply's match scorer");
  });
  it('names GoApply on GoApply', () => {
    expect(brandPersona(BRANDS.goapply, 'resume tailor')).toBe("You are GoApply's resume tailor");
    expect(runWithBrand('goapply', () => currentBrandPersona('intent parser'))).toBe("You are GoApply's intent parser");
  });
  it('falls back to the default brand without a context', () => {
    expect(currentBrandPersona('morning briefer')).toBe("You are RoboApply's morning briefer");
  });
});
