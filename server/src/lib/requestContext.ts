import { AsyncLocalStorage } from 'async_hooks';

interface RequestStore {
  requestId: string;
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

export function withRequestContext<T>(requestId: string, fn: () => T): T {
  return requestContext.run({ requestId }, fn);
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
