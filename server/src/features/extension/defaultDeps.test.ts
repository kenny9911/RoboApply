// @vitest-environment node
//
// WP-55a: the production wiring's computed import path still points at the
// resume service (it is loaded by path so the web typecheck stays clean).

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RESUME_SERVICE_MODULE } from './defaultDeps.js';

describe('defaultExtensionDeps', () => {
  it('resolves the resume service module', () => {
    const ts = fileURLToPath(new URL(RESUME_SERVICE_MODULE.replace(/\.js$/, '.ts'), import.meta.url));
    expect(existsSync(ts)).toBe(true);
  });
});
