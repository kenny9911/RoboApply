// components/features/marketing/brandEnv.ts — per-brand config the marketing
// pages read on the server (R-03: unprefixed = RoboApply, `CN_` = GoApply, no
// fallback across brands). Pure: callers pass the env (process.env on the
// server; a table in tests). Mirrors server/src/features/support/service.ts
// `supportAddress` so the page shows the same inbox the form sends to.

import type { ProductBrand } from '../../../lib/brand/registry.generated';

export type EnvTable = Record<string, string | undefined>;

function brandValue(brand: Pick<ProductBrand, 'market'>, name: string, env: EnvTable): string | null {
  const v = env[brand.market === 'cn' ? `CN_${name}` : name]?.trim();
  return v ? v : null;
}

/** `Name <a@b.c>` or `a@b.c` → `a@b.c`; anything else → null. */
function addressOf(value: string): string | null {
  const m = /<([^<>\s]+@[^<>\s]+)>/.exec(value);
  const addr = (m ? m[1] : value).trim();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr) ? addr : null;
}

/** The brand's support inbox: SUPPORT_EMAIL / CN_SUPPORT_EMAIL, else the registry address. */
export function supportEmailFor(brand: Pick<ProductBrand, 'market' | 'email'>, env: EnvTable): string {
  const configured = brandValue(brand, 'SUPPORT_EMAIL', env);
  return (configured && addressOf(configured)) || brand.email.replyTo;
}

/** The operating entity when ops configured it (LEGAL_ENTITY_NAME / CN_LEGAL_ENTITY_NAME), else null (D3). */
export function legalEntityFor(brand: Pick<ProductBrand, 'market' | 'legalEntity'>, env: EnvTable): string | null {
  return brandValue(brand, 'LEGAL_ENTITY_NAME', env) ?? (brand.legalEntity.trim() || null);
}
