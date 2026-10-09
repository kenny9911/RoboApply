// server/src/platform/brand/persona.ts
//
// One helper for every LLM persona line that names the product
// (ARCHITECTURE.md §1.7). Server code never hard-codes "RoboApply" in a
// prompt; it asks for the persona of the current brand.
//
//   brandPersona(BRANDS.goapply, 'resume tailor') → "You are GoApply's resume tailor"
//
// The wording is deliberately identical to the lines it replaced
// ("You are RoboApply's …"), so RoboApply prompts are byte-for-byte unchanged.

import type { ProductBrand } from './registry.js';
import { getCurrentBrandOrDefault } from './brandContext.js';

export function brandPersona(brand: ProductBrand, role: string): string {
  return `You are ${brand.name}'s ${role}`;
}

/**
 * Persona for the brand of the current unit of work. Agents run inside
 * requests, crons and tests, so this never throws: without a brand context it
 * uses the default brand.
 */
export function currentBrandPersona(role: string): string {
  return brandPersona(getCurrentBrandOrDefault(), role);
}
