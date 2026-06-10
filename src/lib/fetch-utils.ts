/**
 * Shared fetch utilities for the relay proxy.
 *
 * Consolidates retry logic, proxy rotation, SSE line buffering,
 * error sanitization, and graceful shutdown tracking — all in one place.
 */

import type { ProxyPool } from "./proxy-pool";

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
 * Execute an upstream `fetch` with automatic retry and proxy fallback.
 *
 * Strategy: direct first → proxy-1 on failure → rotate proxy on failure.
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
    if (attempt === 0) {
      init.proxy = undefined; // direct
    } else if (attempt === 1 && proxyPool && proxyPool.size > 0) {
      usedProxy = true;
      init.proxy = proxyPool.getProxyUrl()!;
    } else if (attempt === 2 && proxyPool && proxyPool.size > 0) {
      const next = proxyPool.rotate();
      if (!next) break;
      usedProxy = true;
      init.proxy = proxyPool.getProxyUrl()!;
    } else {
      break;
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
