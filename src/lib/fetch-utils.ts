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
 * Track a reader for graceful shutdown. Returns a wrapped reader that
 * auto-removes itself from ACTIVE_READERS when cancelled.
 *
 * IMPORTANT: When the stream finishes normally (done=true), the caller
 * MUST call `releaseReader(reader)` to remove it from the tracking set.
 */
export function trackReader<T extends ReadableStreamDefaultReader<any>>(reader: T): T {
  ACTIVE_READERS.add(reader as any);
  // Auto-remove on cancellation
  const origCancel = reader.cancel.bind(reader);
  (reader as any).cancel = async (...args: any[]) => {
    ACTIVE_READERS.delete(reader as any);
    return origCancel(...args);
  };
  return reader;
}

/**
 * Release a reader from the active tracking set.
 * Call this when a stream finishes normally (reader.read() returns done=true).
 */
export function releaseReader(reader: ReadableStreamDefaultReader<any>): void {
  ACTIVE_READERS.delete(reader as any);
}

/**
 * Close all tracked active readers (called during graceful shutdown).
 * Awaits each cancellation so upstream connections are properly closed.
 */
export async function closeAllActiveReaders(): Promise<void> {
  const readers = Array.from(ACTIVE_READERS);
  ACTIVE_READERS.clear();
  await Promise.allSettled(
    readers.map((reader) => reader.cancel().catch(() => {}))
  );
}

// ─── Dev-mode guard ──────────────────────────────────────────────────────

/**
 * Returns `true` when development features (HMR, verbose console) should
 * be enabled.  Controlled by the `NODE_ENV` / `BUN_ENV` env var — defaults
 * to `false` (production-safe).  Set `NODE_ENV=development` to enable.
 */
export function isDevMode(): boolean {
  const env = (process.env.NODE_ENV ?? process.env.BUN_ENV ?? "").toLowerCase();
  if (env === "development" || env === "dev") return true;
  return false;
}

// ─── Stream cleanup wrapper ─────────────────────────────────────────────

/**
 * Wraps a ReadableStream and calls `cleanup` when the stream ends,
 * errors, or is cancelled by the consumer.
 *
 * Use this to release proxy sessions, close connections, or free resources
 * when a streaming response finishes.
 */
export function wrapStreamWithCleanup(body: ReadableStream, cleanup: () => void): ReadableStream {
  const reader = body.getReader();

  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          cleanup();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        cleanup();
        controller.error(err);
      }
    },
    cancel(reason) {
      cleanup();
      reader.cancel(reason);
    },
  });
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
  private readonly MAX_BUFFER_SIZE = 1024 * 1024; // 1MB limit to prevent OOM
  private overflow = false;

  /**
   * Feed a chunk of decoded text and return complete lines.
   * Lines ending with `\n` are considered complete.
   * Returns empty array if buffer overflow detected (stream is poisoned).
   */
  add(chunk: string): string[] {
    if (this.overflow) return [];

    this.buffer += chunk;

    if (this.buffer.length > this.MAX_BUFFER_SIZE) {
      console.warn(`[SSELineBuffer] Buffer exceeded ${this.MAX_BUFFER_SIZE} bytes — discarding remaining stream data`);
      this.overflow = true;
      this.buffer = "";
      return [];
    }

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

// ─── Structured logging helper ─────────────────────────────────────────

const LOG_PREFIX = "[fetch-utils]";

function logProxy(method: string, msg: string, extra?: Record<string, unknown>): void {
  const ts = new Date().toISOString().slice(11, 23);
  const parts = [`${LOG_PREFIX} ${ts}`, `method=${method}`, msg];
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      parts.push(`${k}=${v ?? "null"}`);
    }
  }
  console.log(parts.join(" "));
}

// ─── Model extraction from context ───────────────────────────────────

/**
 * Extract model identifier from the context string.
 * Context format: "provider:modelname" (e.g. "openai:deepseek-v4-flash-free").
 * Returns undefined when no context given (backward-compatible).
 */
function extractModel(context?: string): string | undefined {
  return context || undefined;
}

// ─── Retry backoff helper ──────────────────────────────────────────────

/**
 * Calculate exponential backoff delay for retry attempts.
 * Returns 0 for attempt 0 (no delay on first try).
 * Pattern: 200ms, 400ms, 800ms, ... capped at 2000ms.
 */
function retryBackoffMs(attempt: number): number {
  if (attempt <= 0) return 0;
  return Math.min(200 * Math.pow(2, attempt - 1), 2000);
}

/** Sleep for the specified milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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
 * Strategy: direct connection first, then fall back to proxies.
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

  // Strategy: direct first, then proxies as fallback.
  // maxAttempts = 1 direct + pool.size proxies, min 3 (all direct if no pool).
  const poolSize = proxyPool?.size ?? 0;
  const maxAttempts = poolSize > 0 ? poolSize + 1 : 3;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Exponential backoff between attempts (skip on first attempt)
    const backoff = retryBackoffMs(attempt);
    if (backoff > 0) {
      logProxy("fetchWithRetry", `backoff ${backoff}ms before attempt ${attempt + 1}`, { context });
      await sleep(backoff);
    }

    if (attempt === 0) {
      // First attempt — direct (no proxy)
      init.proxy = undefined;
      usedProxy = false;
    } else if (proxyPool && proxyPool.size > 0) {
      // Fallback — try a proxy from the pool
      if (attempt === 1) {
        // Second attempt — start with current proxy
        init.proxy = proxyPool.getProxyUrl()!;
        usedProxy = true;
      } else {
        // Later attempts — rotate to a different proxy
        const next = proxyPool.rotate(extractModel(context));
        if (!next) break;
        init.proxy = proxyPool.getProxyUrl()!;
        usedProxy = true;
      }
    } else {
      // No proxy pool, retry direct
      init.proxy = undefined;
      usedProxy = false;
    }

    const proxyShort = init.proxy ? init.proxy.replace(/https?:\/\//, "").replace(/@.*/, "@***") : "direct";
    logProxy("fetchWithRetry", `attempt=${attempt + 1}/${maxAttempts} proxy=${proxyShort}`, { context });

    try {
      response = await fetch(url, init);

      if (response.ok) {
        if (usedProxy && proxyPool && proxyPool.size > 0) {
          proxyPool.markSuccess();
        }
        logProxy("fetchWithRetry", `success attempt=${attempt + 1} status=${response.status}`, { context });
        return { response };
      }

      // Non-2xx — retry on transient errors (502, 504), fail on others
      lastError = new Error(`Upstream returned ${response.status}`);
      logProxy("fetchWithRetry", `non-2xx attempt=${attempt + 1} status=${response.status}`, { context });

      // Retry on transient server errors (502, 504) — don't return yet
      const isTransient = response.status === 502 || response.status === 504;
      if (isTransient && attempt < maxAttempts - 1) {
        logProxy("fetchWithRetry", `transient error ${response.status}, will retry`, { context });
        if (usedProxy && proxyPool && proxyPool.size > 0 && init.proxy) {
          proxyPool.markFailed();
          proxyPool.rotate(extractModel(context));
        }
        continue;
      }

      if (usedProxy && proxyPool && proxyPool.size > 0 && init.proxy) {
        const model = extractModel(context);
        // If rate-limited, put proxy in per-model cooldown
        if (response.status === 429 && model) {
          proxyPool.markRateLimited(model);
        }
        proxyPool.markFailed();
        proxyPool.rotate(model);
      }
    } catch (err) {
      lastError = err;
      if (usedProxy && proxyPool && proxyPool.size > 0 && init.proxy) {
        proxyPool.markFailed();
        proxyPool.rotate(extractModel(context));
      }

      // Log the actual error so operators can diagnose
      const ctx = context ? `[${context}] ` : "";
      const errMsg = err instanceof Error ? err.message : String(err);
      logProxy("fetchWithRetry", `failed attempt=${attempt + 1} err=${errMsg}`, { context });
      console.warn(`${ctx}fetch attempt ${attempt + 1}/${maxAttempts} failed: ${errMsg}`);
    }
  }

  // All attempts exhausted — tried every proxy + direct
  logProxy("fetchWithRetry", "exhausted all retries", { context, hadResponse: !!response });

  // If we got at least one HTTP response, return it as-is so the caller
  // can relay the proper status code (e.g. 429).
  if (response) {
    return { response };
  }

  const err = lastError ?? new Error("All connection attempts failed");
  return { errorClassification: classifyFetchErrorSafe(err) };
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
 * Strategy: direct connection first, then acquire() on attempt 1 (least-loaded
 * assignment), then getProxyUrl() on subsequent attempts (reads the existing or
 * rotated proxy). On persistent failure the session's proxy is marked failed — which
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
  maxRetries?: number,
): Promise<FetchWithRetryResult> {
  // Fallback when no session pool is available
  if (!sessionPool) {
    logProxy("fetchWithSessionRetry", "no session pool — direct fetch", { context, sessionId: sessionId.slice(0, 8) });
    try {
      const response = await fetch(url, init);
      return { response };
    } catch (err) {
      return { errorClassification: classifyFetchErrorSafe(err) };
    }
  }

  // Strategy: direct first, then session-sticky proxies as fallback.
  // totalAttempts = 1 direct + sessionPool.size proxies, min 3.
  const totalAttempts = maxRetries ?? Math.max(3, sessionPool.size + 1);
  let lastError: unknown;
  let lastResponse: Response | undefined;
  for (let attempt = 0; attempt < totalAttempts; attempt++) {
    // Exponential backoff between attempts (skip on first attempt)
    const backoff = retryBackoffMs(attempt);
    if (backoff > 0) {
      logProxy("fetchWithSessionRetry", `backoff ${backoff}ms before attempt ${attempt + 1}`, {
        context,
        sessionId: sessionId.slice(0, 8),
      });
      await sleep(backoff);
    }

    // Determine proxy for this attempt
    if (attempt === 0) {
      // First attempt — direct (no proxy)
      init.proxy = undefined;
    } else if (sessionPool.size > 0) {
      // Fallback — acquire on first proxy attempt, rotate to different proxy on retries
      if (attempt === 1) {
        const proxyUrl = sessionPool.acquire(sessionId);
        if (proxyUrl) {
          init.proxy = proxyUrl;
        }
      } else {
        // Force rotation to a different proxy before getting URL
        const model = extractModel(context);
        sessionPool.rotateNow(sessionId, model);
        const proxyUrl = sessionPool.getProxyUrl(sessionId);
        if (proxyUrl) {
          init.proxy = proxyUrl;
        }
      }
    } else {
      // No proxy pool, retry direct
      init.proxy = undefined;
    }

    const proxyShort = init.proxy
      ? init.proxy.replace(/https?:\/\//, "").replace(/@.*/, "@***")
      : "direct";
    logProxy("fetchWithSessionRetry", `attempt=${attempt + 1}/${totalAttempts} proxy=${proxyShort}`, {
      context,
      sessionId: sessionId.slice(0, 8),
    });

    try {
      const response = await fetch(url, init);

      if (response.ok) {
        sessionPool.markSuccess(sessionId);
        logProxy("fetchWithSessionRetry", `success attempt=${attempt + 1} status=${response.status}`, {
          context,
          sessionId: sessionId.slice(0, 8),
          proxy: proxyShort,
        });
        return { response };
      }

      // Non-2xx — retry on transient errors (502, 504), fail on others
      lastError = new Error(`Upstream returned ${response.status}`);
      lastResponse = response;
      const model = extractModel(context);

      // Retry on transient server errors — don't return yet
      const isTransient = response.status === 502 || response.status === 504;
      if (isTransient && attempt < totalAttempts - 1) {
        logProxy("fetchWithSessionRetry", `transient error ${response.status}, will retry`, {
          context,
          sessionId: sessionId.slice(0, 8),
        });
        sessionPool.rotateNow(sessionId, model);
        continue;
      }

      // If rate-limited, put proxy in per-model cooldown
      if (response.status === 429 && model) {
        sessionPool.markRateLimited(sessionId, model);
      }
      const rotated = sessionPool.rotateNow(sessionId, model);
      logProxy("fetchWithSessionRetry", `non-2xx attempt=${attempt + 1} status=${response.status} rotated=${rotated}`, {
        context,
        sessionId: sessionId.slice(0, 8),
        proxy: proxyShort,
      });

      const ctx = context ? `[${context}] ` : "";
      console.warn(
        `${ctx}fetchWithSessionRetry attempt ${attempt + 1}/${totalAttempts} ` +
          `failed with ${response.status}${rotated ? " (rotated proxy)" : ""}`,
      );
    } catch (err) {
      lastError = err;
      const rotated = sessionPool.rotateNow(sessionId, extractModel(context));
      const errMsg = err instanceof Error ? err.message : String(err);
      logProxy("fetchWithSessionRetry", `failed attempt=${attempt + 1} err=${errMsg} rotated=${rotated}`, {
        context,
        sessionId: sessionId.slice(0, 8),
        proxy: proxyShort,
      });

      const ctx = context ? `[${context}] ` : "";
      console.warn(
        `${ctx}fetchWithSessionRetry attempt ${attempt + 1}/${totalAttempts} ` +
          `failed: ${errMsg}${rotated ? " (rotated proxy)" : ""}`,
      );
    }
  }

  // All attempts exhausted — tried every proxy + direct
  logProxy("fetchWithSessionRetry", "exhausted all retries — tried all proxies + direct", {
    context,
    sessionId: sessionId.slice(0, 8),
    hadResponse: !!lastResponse,
  });
  sessionPool.release(sessionId);

  // If we got at least one HTTP response (e.g. 429), return it so the caller
  // can relay the proper status code.  Only classify as error on network
  // failures where there's no response at all.
  if (lastResponse) {
    return { response: lastResponse };
  }

  const err = lastError ?? new Error("All session proxy attempts failed");
  return { errorClassification: classifyFetchErrorSafe(err) };
}
