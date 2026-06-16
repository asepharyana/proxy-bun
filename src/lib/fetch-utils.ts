/**
 * Shared fetch utilities for the relay proxy.
 *
 * Consolidates retry logic, proxy rotation, SSE line buffering,
 * error sanitization, and graceful shutdown tracking — all in one place.
 */

import type { ProxyPool, SessionProxyPool } from "./proxy-pool";

// ─── Active stream tracking (for graceful shutdown) ───────────────────────

/** Set of active ReadableStream readers that should be closed on shutdown. */
export const ACTIVE_READERS = new Set<ReadableStreamDefaultReader>();

/**
 * Close all tracked active readers (called during graceful shutdown).
 * Each reader's cancellation propagates to the upstream connection.
 */
export function closeAllActiveReaders(): void {
  for (const reader of ACTIVE_READERS) {
    try { reader.cancel(); } catch { /* already closed */ }
  }
  ACTIVE_READERS.clear();
}

// ─── Dev-mode guard ──────────────────────────────────────────────────────

/**
 * Returns `true` when development features (HMR, verbose console) should
 * be enabled.  Controlled by the `NODE_ENV` / `BUN_ENV` env var — defaults
 * to `true` for convenience during local development.
 *
 * Set `NODE_ENV=production` or `BUN_ENV=production` to disable.
 */
export function isDevMode(): boolean {
  const env = (process.env.NODE_ENV ?? process.env.BUN_ENV ?? "").toLowerCase();
  if (env === "production") return false;
  return true;
}

// ─── SSE line buffer (fixes chunk-boundary corruption) ───────────────────

/**
 * Accumulates partial lines across stream chunks so that lines split across
 * chunk boundaries are correctly reassembled before parsing.
 *
 * Usage:
 *   const buf = new SSELineBuffer();
 *   for each chunk:  const lines = buf.add(chunk);
 *   after stream:   const lastLines = buf.flush();
 */
export class SSELineBuffer {
  private buffer = "";

  /**
   * Feed a chunk of decoded text and return complete lines.
   * Lines ending with `\n` are considered complete.
   */
  add(chunk: string): string[] {
    this.buffer += chunk;
    if (!this.buffer.includes("\n")) return [];

    const parts = this.buffer.split("\n");
    // The last element is incomplete if the chunk does not end with '\n'
    this.buffer = parts.pop() ?? "";
    return parts;
  }

  /** Return any remaining text after the stream ended. */
  flush(): string {
    const remaining = this.buffer;
    this.buffer = "";
    return remaining;
  }
}

// ─── Error sanitization (prevent leaking upstream details) ──────────────

/**
 * Sanitize an error message for inclusion in a downstream response.
 * Generic messages only — no upstream URLs, paths, or stack traces.
 */
export function sanitizeErrorMessage(raw: string): string {
  if (
    raw.includes("ENOTFOUND") ||
    raw.includes("ECONNREFUSED") ||
    raw.includes("ECONNRESET") ||
    raw.includes("ECONNABORTED") ||
    raw.includes("ENETUNREACH") ||
    raw.includes("ETIMEDOUT") ||
    raw.includes("DNS") ||
    raw.includes("dns") ||
    raw.includes("resolve")
  ) {
    return "Upstream connection failed";
  }
  return "Upstream error";
}

// ─── Fetch with retry (direct → proxy fallback) ─────────────────────────

export interface FetchWithRetryResult {
  response?: Response;
  errorClassification?: { code: string; status: number; message: string };
}

/**
 * Execute an upstream `fetch` with automatic retry and proxy rotation.
 *
 * Strategy: proxy pool on every attempt (rotate each retry).
 * Falls back to direct when no pool is available.
 * Logs every failure to `console.warn` so the operator can diagnose without
 * the error body leaking to the downstream client.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit & { proxy?: string },
  proxyPool?: ProxyPool,
  context?: string,
): Promise<FetchWithRetryResult> {
  let response: Response | undefined;
  let lastError: unknown;
  let usedProxy = false;

  for (let attempt = 0; attempt < 3; attempt++) {
    if (proxyPool && proxyPool.size > 0) {
      // Proactive proxy usage on every attempt, rotating each time
      if (attempt === 0) {
        init.proxy = proxyPool.getProxyUrl()!;
        usedProxy = true;
      } else {
        const next = proxyPool.rotate();
        if (!next) break;
        init.proxy = proxyPool.getProxyUrl()!;
        usedProxy = true;
      }
    } else {
      // No proxy pool — direct only
      init.proxy = undefined;
      usedProxy = false;
    }

    try {
      response = await fetch(url, init);
      if (response.ok) {
        if (usedProxy && proxyPool && proxyPool.size > 0) {
          proxyPool.markSuccess();
        }
        return { response };
      }

      // Non-2xx — mark proxy as failed and retry
      lastError = new Error(`Upstream returned ${response.status}`);
      if (usedProxy && proxyPool && proxyPool.size > 0 && init.proxy) {
        proxyPool.markFailed();
        usedProxy = false;
      }
    } catch (err) {
      lastError = err;
      if (usedProxy && proxyPool && proxyPool.size > 0 && init.proxy) {
        proxyPool.markFailed();
        usedProxy = false;
      }

      // Log the actual error so operators can diagnose
      const ctx = context ? `[${context}] ` : "";
      const errMsg = err instanceof Error ? err.message : String(err);
      console.warn(`${ctx}fetch attempt ${attempt + 1}/3 failed: ${errMsg}`);
    }
  }

  // All attempts exhausted — classify the last error
  if (!response) {
    const err = lastError ?? new Error("All connection attempts failed");
    return { errorClassification: classifyFetchErrorSafe(err) };
  }

  // Non-2xx but we have a response — pass it along (caller handles it)
  return { response };
}

/**
 * Simplified error classification that does NOT expose raw error text
 * to downstream clients.
 */
function classifyFetchErrorSafe(error: unknown): {
  code: string;
  status: number;
  message: string;
} {
  if (
    error instanceof DOMException &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  ) {
    return { code: "TIMEOUT", status: 504, message: "Upstream timed out" };
  }

  if (error instanceof TypeError) {
    const msg = error.message.toLowerCase();
    if (
      msg.includes("dns") || msg.includes("resolve") ||
      msg.includes("hostname") || msg.includes("enotfound")
    ) {
      return { code: "DNS_FAILURE", status: 502, message: "DNS resolution failed" };
    }
    if (msg.includes("refused") || msg.includes("econnrefused")) {
      return { code: "CONNECTION_REFUSED", status: 502, message: "Connection refused" };
    }
    return { code: "NETWORK_ERROR", status: 502, message: "Network error" };
  }

  return { code: "NETWORK_ERROR", status: 502, message: "Upstream unreachable" };
}

// ─── Fetch with session-based proxy retry ────────────────────────────────

/**
 * Execute an upstream `fetch` using a session-sticky proxy with retry.
 *
 * Strategy: acquire() on attempt 0 (least-loaded assignment), then
 * getProxyUrl() on subsequent attempts (reads the existing or rotated proxy).
 * On persistent failure the session's proxy is marked failed — which
 * auto-rotates if the failure threshold is exceeded — and the request
 * retries with the new proxy.
 *
 * SSE streams: the initial request is retried normally. Once the response body
 * starts streaming, mid-stream errors are **not** retried; the session is
 * released and the error is returned to the caller.
 */
export async function fetchWithSessionRetry(
  url: string,
  init: RequestInit & { proxy?: string },
  sessionPool: SessionProxyPool | undefined,
  sessionId: string,
  context?: string,
  maxRetries = 3,
): Promise<FetchWithRetryResult> {
  // Fallback when no session pool is available
  if (!sessionPool) {
    try {
      const response = await fetch(url, init);
      return { response };
    } catch (err) {
      return { errorClassification: classifyFetchErrorSafe(err) };
    }
  }

  let lastError: unknown;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    // First attempt: acquire() assigns a proxy to this session (least-loaded
    // distribution so many concurrent users spread across different IPs).
    // Subsequent attempts: getProxyUrl() reads the existing (or rotated) proxy.
    const proxyUrl = attempt === 0
      ? sessionPool.acquire(sessionId)
      : sessionPool.getProxyUrl(sessionId);
    if (proxyUrl) {
      init.proxy = proxyUrl;
    }

    try {
      const response = await fetch(url, init);

      if (response.ok) {
        sessionPool.markSuccess(sessionId);
        return { response };
      }

      // Non-2xx — mark session failed and retry
      lastError = new Error(`Upstream returned ${response.status}`);
      const rotated = sessionPool.markFailed(sessionId);

      const ctx = context ? `[${context}] ` : "";
      console.warn(
        `${ctx}fetchWithSessionRetry attempt ${attempt + 1}/${maxRetries} ` +
          `failed with ${response.status}${rotated ? " (rotated proxy)" : ""}`,
      );
    } catch (err) {
      lastError = err;
      const rotated = sessionPool.markFailed(sessionId);

      const ctx = context ? `[${context}] ` : "";
      const errMsg = err instanceof Error ? err.message : String(err);
      console.warn(
        `${ctx}fetchWithSessionRetry attempt ${attempt + 1}/${maxRetries} ` +
          `failed: ${errMsg}${rotated ? " (rotated proxy)" : ""}`,
      );
    }
  }

  // All attempts exhausted — release session and classify last error
  sessionPool.release(sessionId);
  const err = lastError ?? new Error("All session proxy attempts failed");
  return { errorClassification: classifyFetchErrorSafe(err) };
}
