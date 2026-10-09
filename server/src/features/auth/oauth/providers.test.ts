// @vitest-environment node
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { beforeEach, describe, expect, it } from 'vitest';
import { authorizeUrl, finishOAuth, GOOGLE_JWKS_URL, OAuthProviderError, PROVIDERS, resetJwksCacheForTests, type FetchLike } from './providers.js';

const ENV = {
  GOOGLE_OAUTH_CLIENT_ID: 'google-client',
  GOOGLE_OAUTH_CLIENT_SECRET: 'google-secret',
  LINE_LOGIN_CHANNEL_ID: 'line-channel',
  LINE_LOGIN_CHANNEL_SECRET: 'line-secret-value',
};

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...(publicKey.export({ format: 'jwk' }) as Record<string, string>), kid: 'k1', alg: 'RS256', use: 'sig' };

function googleToken(claims: Record<string, unknown>, kid = 'k1'): string {
  return jwt.sign(
    { iss: 'https://accounts.google.com', aud: 'google-client', sub: 'g-sub-1', nonce: 'n1', ...claims },
    privateKey,
    { algorithm: 'RS256', keyid: kid, expiresIn: 300 },
  );
}

function lineToken(claims: Record<string, unknown>, secret = 'line-secret-value'): string {
  return jwt.sign({ iss: 'https://access.line.me', aud: 'line-channel', sub: 'U123', nonce: 'n1', ...claims }, secret, {
    algorithm: 'HS256',
    expiresIn: 300,
  });
}

function fakeFetch(idToken: string, calls: Array<{ url: string; body?: string }> = []): FetchLike {
  return async (url, init) => {
    calls.push({ url, body: typeof init?.body === 'string' ? init.body : undefined });
    if (url === GOOGLE_JWKS_URL) return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
    return new Response(JSON.stringify({ id_token: idToken, access_token: 'never-stored' }), { status: 200 });
  };
}

const input = { code: 'c1', redirectUri: 'https://www.roboapply.io/auth/callback/google', verifier: 'v'.repeat(43), nonce: 'n1' };

beforeEach(() => resetJwksCacheForTests());

describe('authorizeUrl', () => {
  it('uses PKCE S256, state and nonce', () => {
    const url = new URL(authorizeUrl('google', { redirectUri: input.redirectUri, state: 's1', challenge: 'c', nonce: 'n1' }, ENV));
    expect(url.origin + url.pathname).toBe(PROVIDERS.google.authorizeUrl);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: 'google-client',
      response_type: 'code',
      state: 's1',
      nonce: 'n1',
      code_challenge: 'c',
      code_challenge_method: 'S256',
      scope: 'openid email profile',
    });
    expect(() => authorizeUrl('line', { redirectUri: 'x', state: 's', challenge: 'c', nonce: 'n' }, {})).toThrow(OAuthProviderError);
  });
});

describe('Google', () => {
  it('verifies the ID token with the JWKS and returns a verified email', async () => {
    const calls: Array<{ url: string; body?: string }> = [];
    const id = await finishOAuth('google', input, { env: ENV, fetch: fakeFetch(googleToken({ email: 'Ana@Example.test', email_verified: true, name: 'Ana' }), calls) });
    expect(id).toEqual({ provider: 'google', subject: 'g-sub-1', email: 'ana@example.test', emailVerified: true, name: 'Ana', avatarUrl: null });
    expect(calls[0]!.body).toContain('code_verifier=');
    expect(calls[0]!.body).toContain('grant_type=authorization_code');
  });

  it('treats an unverified Google email as unverified', async () => {
    const id = await finishOAuth('google', input, { env: ENV, fetch: fakeFetch(googleToken({ email: 'a@example.test', email_verified: false })) });
    expect(id.emailVerified).toBe(false);
  });

  it('rejects a wrong audience, a wrong nonce, an unknown key and a forged signature', async () => {
    await expect(finishOAuth('google', input, { env: ENV, fetch: fakeFetch(googleToken({ aud: 'other' })) })).rejects.toMatchObject({ reason: 'id_token_invalid' });
    await expect(finishOAuth('google', input, { env: ENV, fetch: fakeFetch(googleToken({ nonce: 'x' })) })).rejects.toMatchObject({ reason: 'nonce_mismatch' });
    await expect(finishOAuth('google', input, { env: ENV, fetch: fakeFetch(googleToken({}, 'k2')) })).rejects.toMatchObject({ reason: 'unknown_signing_key' });
    const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    const forged = jwt.sign({ iss: 'https://accounts.google.com', aud: 'google-client', sub: 's', nonce: 'n1' }, other, { algorithm: 'RS256', keyid: 'k1' });
    await expect(finishOAuth('google', input, { env: ENV, fetch: fakeFetch(forged) })).rejects.toMatchObject({ reason: 'id_token_invalid' });
  });

  it('fails cleanly when the token endpoint refuses', async () => {
    const refusing: FetchLike = async () => new Response('{}', { status: 400 });
    await expect(finishOAuth('google', input, { env: ENV, fetch: refusing })).rejects.toMatchObject({ reason: 'token_exchange_failed' });
  });
});

describe('LINE', () => {
  it('verifies HS256 with the channel secret; email may be absent', async () => {
    const withEmail = await finishOAuth('line', input, { env: ENV, fetch: fakeFetch(lineToken({ email: 'u@example.test', name: '林' })) });
    expect(withEmail).toMatchObject({ provider: 'line', subject: 'U123', email: 'u@example.test', emailVerified: true, name: '林' });
    const noEmail = await finishOAuth('line', input, { env: ENV, fetch: fakeFetch(lineToken({})) });
    expect(noEmail).toMatchObject({ email: null, emailVerified: false });
    await expect(finishOAuth('line', input, { env: ENV, fetch: fakeFetch(lineToken({}, 'wrong-secret')) })).rejects.toMatchObject({
      reason: 'id_token_invalid',
    });
  });
});
