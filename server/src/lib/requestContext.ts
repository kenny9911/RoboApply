import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'node:crypto';
import type { BrandId } from '../platform/brand/registry.js';

export interface RequestStore {
  requestId: string;
  // Product brand of this unit of work (TASK_PLAN.md R-01). Set by the brand
  // middleware (platform/brand/brandContext.ts) for HTTP requests, and by
  // `runWithBrand` for crons, queue workers and webhooks.
  brandId?: BrandId;
  // Normalized request host (no port). Lets helpers that have no `req`
  // (e.g. buildCookieOptions) decide per host.
  host?: string;
  // Attached by the auth middleware once req.user is resolved. Every log
  // line emitted inside the same async context will auto-include this so
  // admins can filter server logs by user. Mutable because the request
  // starts before auth runs.
  userId?: string;
  // Display name (or email fallback) for the authenticated user. Surfaced
  // alongside userId in the log line — `[user:abc12345 Kenny]` — so an
  // operator skimming the terminal can recognize who triggered an action
  // without having to look up the id.
  userName?: string;
  // BYOK (bring-your-own-key). Sticky flag — set to true by LLMService /
  // ClaudeAgentService / GeminiAgentService when the call was actually
  // routed through the user's own provider key. Read by matchBilling /
  // AgentAlexQuotaService at commit time and by requestAudit when rolling
  // up the per-request log. See docs/prd-byok.md.
  byokInRequest?: boolean;
}

const requestContext = new AsyncLocalStorage<RequestStore>();

/**
 * Run `fn` inside a fresh request context. The string form (a bare request
 * id) is kept for existing callers (job-search/agent.ts); it keeps the
 * enclosing brand and host so a nested context never loses its brand. The
 * store form is what the brand middleware uses.
 */
export function withRequestContext<T>(requestIdOrStore: string | RequestStore, fn: () => T): T {
  let store: RequestStore;
  if (typeof requestIdOrStore === 'string') {
    const parent = requestContext.getStore();
    store = { requestId: requestIdOrStore };
    if (parent?.brandId) store.brandId = parent.brandId;
    if (parent?.host) store.host = parent.host;
  } else {
    store = { ...requestIdOrStore };
  }
  return requestContext.run(store, fn);
}

/**
 * Run `fn` as a unit of work for one brand: crons, queue workers, webhooks and
 * anything else that has no HTTP request. Starts a fresh store (the request id
 * is inherited when there is one; the user is NOT inherited, so a per-user
 * unit sets its own via setCurrentUserId).
 */
export function runWithBrand<T>(brandId: BrandId, fn: () => T): T {
  const parent = requestContext.getStore();
  return requestContext.run(
    { requestId: parent?.requestId ?? `brand-${randomUUID()}`, brandId },
    fn,
  );
}

export function getCurrentBrandId(): BrandId | undefined {
  return requestContext.getStore()?.brandId;
}

export function getCurrentRequestHost(): string | undefined {
  return requestContext.getStore()?.host;
}

export function getCurrentRequestId(): string | undefined {
  return requestContext.getStore()?.requestId;
}

export function getCurrentUserId(): string | undefined {
  return requestContext.getStore()?.userId;
}

export function getCurrentUserName(): string | undefined {
  return requestContext.getStore()?.userName;
}

/**
 * Attach the authenticated user's id to the current async context so
 * subsequent log emissions pick it up automatically. Safe to call multiple
 * times; idempotent for the same userId.
 */
export function setCurrentUserId(userId: string | null | undefined): void {
  const store = requestContext.getStore();
  if (!store) return;
  if (userId) {
    store.userId = userId;
  } else {
    delete store.userId;
  }
}

/**
 * Attach the authenticated user's display name to the current async context.
 * Pair with `setCurrentUserId` from the auth middleware so log lines render
 * `[user:<id8> <name>]` automatically.
 */
export function setCurrentUserName(userName: string | null | undefined): void {
  const store = requestContext.getStore();
  if (!store) return;
  if (userName) {
    store.userName = userName;
  } else {
    delete store.userName;
  }
}

/**
 * Mark this request as having had at least one BYOK-routed LLM call.
 * Sticky — once true, stays true. Called from LLMService.chat after a
 * successful BYOK provider call, and from Agent Alex services likewise.
 * Read at commit time by matchBilling / AgentAlexQuotaService to decide
 * whether to skip plan-counter increments, and by requestAudit when
 * rolling up the per-request `ApiRequestLog.byok` flag + cost.
 */
export function setByokInRequest(): void {
  const store = requestContext.getStore();
  if (!store) return;
  store.byokInRequest = true;
}

/** True if any LLM call in the current request used a BYOK key. */
export function wasByokInRequest(): boolean {
  return requestContext.getStore()?.byokInRequest === true;
}
