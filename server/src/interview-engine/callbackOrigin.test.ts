// Callback base URL resolution (C13): explicit env wins; production derives
// the public origin from the create request (allowlisted hosts only, since
// callbacks carry the worker secret); dev keeps the localhost default.
// Run: npx vitest run server/src/interview-engine/callbackOrigin.test.ts

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deriveRequestOrigin, getCallbackBaseUrl, resolveSessionCallbackBaseUrl } from './config.js';

const KEYS = [
  'INTERVIEW_ENGINE_CALLBACK_BASE_URL', 'BACKEND_PUBLIC_URL', 'PUBLIC_BACKEND_URL', 'PORT',
  'VERCEL', 'NODE_ENV', 'VERCEL_URL', 'VERCEL_BRANCH_URL', 'VERCEL_PROJECT_PRODUCTION_URL',
  'INTERVIEW_ENGINE_CALLBACK_ALLOWED_HOSTS',
] as const;

describe('callback origin', () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    for (const k of KEYS) delete process.env[k];
    process.env.NODE_ENV = 'test';
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  });

  it('keeps the localhost default in dev and never persists an origin', () => {
    process.env.PORT = '4611';
    expect(resolveSessionCallbackBaseUrl({ host: 'www.roboapply.io' })).toBeNull();
    expect(getCallbackBaseUrl()).toBe('http://localhost:4611');
  });

  it('derives the forwarded origin in production and uses it at dispatch', () => {
    process.env.VERCEL = '1';
    const origin = resolveSessionCallbackBaseUrl({
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'www.roboapply.io',
      host: 'roboapply-abc.vercel.app',
    });
    expect(origin).toBe('https://www.roboapply.io');
    expect(getCallbackBaseUrl(origin)).toBe('https://www.roboapply.io');
  });

  it('falls back to host, forces https in production and accepts brand subdomains', () => {
    process.env.NODE_ENV = 'production';
    expect(deriveRequestOrigin({ host: 'app.goapply.top', 'x-forwarded-proto': 'http' })).toBe('https://app.goapply.top');
    expect(deriveRequestOrigin({ host: 'robohire.io' })).toBe('https://robohire.io');
  });

  it('refuses hosts that are not on the allowlist', () => {
    process.env.VERCEL = '1';
    expect(deriveRequestOrigin({ 'x-forwarded-host': 'evil.example.com' })).toBeNull();
    expect(deriveRequestOrigin({ host: 'roboapply.io.evil.com' })).toBeNull();
    expect(deriveRequestOrigin({ host: 'bad host/with path' })).toBeNull();
    process.env.VERCEL_PROJECT_PRODUCTION_URL = 'www.roboapply.io';
    expect(resolveSessionCallbackBaseUrl({ host: 'evil.example.com' })).toBe('https://www.roboapply.io');
  });

  it('accepts Vercel system hosts and configured extra hosts', () => {
    process.env.VERCEL = '1';
    process.env.VERCEL_URL = 'roboapply-git-main-kens.vercel.app';
    process.env.INTERVIEW_ENGINE_CALLBACK_ALLOWED_HOSTS = 'staging.example.org';
    expect(deriveRequestOrigin({ host: 'roboapply-git-main-kens.vercel.app' })).toBe('https://roboapply-git-main-kens.vercel.app');
    expect(deriveRequestOrigin({ host: 'staging.example.org' })).toBe('https://staging.example.org');
    expect(deriveRequestOrigin({ host: 'other-project.vercel.app' })).toBeNull();
  });

  it('lets the explicit env win everywhere', () => {
    process.env.VERCEL = '1';
    process.env.INTERVIEW_ENGINE_CALLBACK_BASE_URL = 'https://api.roboapply.io/';
    expect(resolveSessionCallbackBaseUrl({ host: 'www.roboapply.io' })).toBeNull();
    expect(getCallbackBaseUrl('https://www.roboapply.io')).toBe('https://api.roboapply.io');
  });
});
