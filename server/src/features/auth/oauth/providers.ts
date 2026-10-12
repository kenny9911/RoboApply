// server/src/features/auth/oauth/providers.ts
//
// Google (OIDC) and LINE Login v2.1 clients for SEEKER sign-in (WP-10;
// CN_TW_LAUNCH_PLAN.md WP-AUTH-CORE). Never the recruiter
// `AuthService.oauthLogin`, which enforces a business-email gate.
//
// Both use the authorization-code flow with PKCE (S256), a `state` that is an
// `RAAuthToken(oauth_state)` and an OIDC `nonce`. The ID token is verified
// here: Google with its published JWKS (RS256), LINE with the channel secret
// (HS256, LINE's web-login signing method). No provider access or refresh
// token is ever stored.
//
// Credentials (R-03: vendor keys, unprefixed): GOOGLE_OAUTH_CLIENT_ID /
// GOOGLE_OAUTH_CLIENT_SECRET, LINE_LOGIN_CHANNEL_ID / LINE_LOGIN_CHANNEL_SECRET.
// When they are absent the capability (`auth.google` / `auth.line`) is off and
// the routes answer 404 feature_disabled before reaching this file.

import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { EnvSource } from '../../../platform/brand/brandEnv.js';

export type OAuthProviderId = 'google' | 'line';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface VerifiedIdentity {
  provider: OAuthProviderId;
  subject: string;
  email: string | null;
  /** True only when the provider vouches for the email (Google `email_verified`; LINE email is verified by LINE). */
  emailVerified: boolean;
  name: string | null;
  avatarUrl: string | null;
}

export class OAuthProviderError extends Error {
  readonly reason: string;
  constructor(reason: string, message?: string) {
    super(message ?? reason);
    this.name = 'OAuthProviderError';
    this.reason = reason;
  }
}

// ── PKCE / nonce ───────────────────────────────────────────────────────────

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function newNonce(): string {
  return crypto.randomBytes(16).toString('base64url');
}

// ── Provider definitions ───────────────────────────────────────────────────

interface ProviderConfig {
  authorizeUrl: string;
  tokenUrl: string;
  scope: string;
  clientIdEnv: string;
  clientSecretEnv: string;
}

export const PROVIDERS: Record<OAuthProviderId, ProviderConfig> = {
  google: {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'openid email profile',
    clientIdEnv: 'GOOGLE_OAUTH_CLIENT_ID',
    clientSecretEnv: 'GOOGLE_OAUTH_CLIENT_SECRET',
  },
  line: {
    authorizeUrl: 'https://access.line.me/oauth2/v2.1/authorize',
    tokenUrl: 'https://api.line.me/oauth2/v2.1/token',
    scope: 'openid profile email',
    clientIdEnv: 'LINE_LOGIN_CHANNEL_ID',
    clientSecretEnv: 'LINE_LOGIN_CHANNEL_SECRET',
  },
};

export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS: [string, string] = ['https://accounts.google.com', 'accounts.google.com'];
const LINE_ISSUER = 'https://access.line.me';

function credentials(provider: OAuthProviderId, env: EnvSource): { clientId: string; clientSecret: string } {
  const cfg = PROVIDERS[provider];
  const clientId = env[cfg.clientIdEnv]?.trim();
  const clientSecret = env[cfg.clientSecretEnv]?.trim();
  if (!clientId || !clientSecret) throw new OAuthProviderError('not_configured');
  return { clientId, clientSecret };
}

export function authorizeUrl(
  provider: OAuthProviderId,
  input: { redirectUri: string; state: string; challenge: string; nonce: string; locale?: string | null },
  env: EnvSource = process.env,
): string {
  const cfg = PROVIDERS[provider];
  const { clientId } = credentials(provider, env);
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: input.redirectUri,
    scope: cfg.scope,
    state: input.state,
    nonce: input.nonce,
    code_challenge: input.challenge,
    code_challenge_method: 'S256',
  });
  if (provider === 'google') params.set('prompt', 'select_account');
  if (provider === 'line' && input.locale) params.set('ui_locales', input.locale);
  return `${cfg.authorizeUrl}?${params.toString()}`;
}

async function exchangeCode(
  provider: OAuthProviderId,
  input: { code: string; redirectUri: string; verifier: string },
  env: EnvSource,
  fetchImpl: FetchLike,
): Promise<string> {
  const cfg = PROVIDERS[provider];
  const { clientId, clientSecret } = credentials(provider, env);
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
    code_verifier: input.verifier,
  });
  let res: Response;
  try {
    res = await fetchImpl(cfg.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch {
    throw new OAuthProviderError('token_exchange_unreachable');
  }
  if (!res.ok) throw new OAuthProviderError('token_exchange_failed', `token endpoint answered ${res.status}`);
  const json = (await res.json().catch(() => null)) as { id_token?: unknown } | null;
  if (!json || typeof json.id_token !== 'string') throw new OAuthProviderError('no_id_token');
  return json.id_token;
}

// ── Google JWKS (cached) ───────────────────────────────────────────────────

interface Jwk {
  kid?: string;
  kty: string;
  n?: string;
  e?: string;
  alg?: string;
}

let jwksCache: { keys: Jwk[]; fetchedAt: number } | null = null;
const JWKS_TTL_MS = 60 * 60 * 1000;

/** Tests only. */
export function resetJwksCacheForTests(): void {
  jwksCache = null;
}

async function googleKey(kid: string | undefined, fetchImpl: FetchLike, now: number): Promise<crypto.KeyObject> {
  const find = (keys: Jwk[]) => keys.find((k) => k.kid === kid && k.kty === 'RSA');
  let key = jwksCache && now - jwksCache.fetchedAt < JWKS_TTL_MS ? find(jwksCache.keys) : undefined;
  if (!key) {
    // Refetch on a cache miss: Google rotates keys.
    let res: Response;
    try {
      res = await fetchImpl(GOOGLE_JWKS_URL);
    } catch {
      throw new OAuthProviderError('jwks_unreachable');
    }
    if (!res.ok) throw new OAuthProviderError('jwks_unreachable');
    const json = (await res.json().catch(() => null)) as { keys?: Jwk[] } | null;
    jwksCache = { keys: Array.isArray(json?.keys) ? json!.keys : [], fetchedAt: now };
    key = find(jwksCache.keys);
  }
  if (!key) throw new OAuthProviderError('unknown_signing_key');
  return crypto.createPublicKey({ key: key as crypto.JsonWebKey, format: 'jwk' });
}

function decodeHeader(idToken: string): { kid?: string; alg?: string } {
  const decoded = jwt.decode(idToken, { complete: true });
  if (!decoded || typeof decoded === 'string') throw new OAuthProviderError('malformed_id_token');
  return decoded.header as { kid?: string; alg?: string };
}

function verifyJwt(
  idToken: string,
  key: crypto.KeyObject | string,
  options: { algorithm: 'RS256' | 'HS256'; audience: string; issuer: string | [string, string] },
): jwt.JwtPayload {
  try {
    const payload = jwt.verify(idToken, key, {
      algorithms: [options.algorithm],
      audience: options.audience,
      issuer: options.issuer,
      clockTolerance: 30,
    });
    if (!payload || typeof payload === 'string') throw new OAuthProviderError('malformed_id_token');
    return payload;
  } catch (err) {
    if (err instanceof OAuthProviderError) throw err;
    throw new OAuthProviderError('id_token_invalid', err instanceof Error ? err.message : String(err));
  }
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

export interface FinishInput {
  code: string;
  redirectUri: string;
  verifier: string;
  nonce: string;
}

export interface OAuthClientDeps {
  env?: EnvSource;
  fetch?: FetchLike;
  now?: () => number;
}

/** Exchange the code and verify the ID token; returns the provider identity. */
export async function finishOAuth(provider: OAuthProviderId, input: FinishInput, deps: OAuthClientDeps = {}): Promise<VerifiedIdentity> {
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetch ?? ((url, init) => fetch(url, init));
  const now = deps.now ?? Date.now;
  const { clientId, clientSecret } = credentials(provider, env);
  const idToken = await exchangeCode(provider, input, env, fetchImpl);

  let claims: jwt.JwtPayload;
  if (provider === 'google') {
    const header = decodeHeader(idToken);
    if (header.alg !== 'RS256') throw new OAuthProviderError('unexpected_alg');
    const key = await googleKey(header.kid, fetchImpl, now());
    claims = verifyJwt(idToken, key, { algorithm: 'RS256', audience: clientId, issuer: GOOGLE_ISSUERS });
  } else {
    claims = verifyJwt(idToken, clientSecret, { algorithm: 'HS256', audience: clientId, issuer: LINE_ISSUER });
  }
  if (claims.nonce !== input.nonce) throw new OAuthProviderError('nonce_mismatch');
  const subject = str(claims.sub);
  if (!subject) throw new OAuthProviderError('no_subject');
  const email = str(claims.email)?.toLowerCase() ?? null;
  const emailVerified =
    provider === 'google' ? email !== null && (claims.email_verified === true || claims.email_verified === 'true') : email !== null;
  return {
    provider,
    subject,
    email,
    emailVerified,
    name: str(claims.name),
    avatarUrl: str(claims.picture),
  };
}
