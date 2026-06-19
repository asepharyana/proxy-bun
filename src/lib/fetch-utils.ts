/**
 * Shared fetch utilities for the relay proxy.
 *
 * Consolidates retry logic, proxy rotation, SSE line buffering,
 * error sanitization, and graceful shutdown tracking — all in one place.
 */

import type { ProxyPool, SessionProxyPool } from "./proxy-pool";
import type { IPv6SourcePool } from "./ipv6-pool";

// ─── Constants ─────────────────────────────────────────────────────────

/** Default relay timeout (30 seconds). Used for curl IPv6 source requests. */
const DEFAULT_TIMEOUT_MS = 30_000;

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
 * to `false` (production-safe).  Set `NODE_ENV=development` to enable.
 */
export function isDevMode(): boolean {
  const env = (process.env.NODE_ENV ?? process.env.BUN_ENV ?? "").toLowerCase();
  if (env === "development" || env === "dev") return true;
  return false;
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

  /**
   * Feed a chunk of decoded text and return complete lines.
   * Lines ending with `\n` are considered complete.
   */
  add(chunk: string): string[] {
    this.buffer += chunk;
    
    if (this.buffer.length > this.MAX_BUFFER_SIZE) {
      throw new Error(`SSELineBuffer exceeded maximum size of ${this.MAX_BUFFER_SIZE} bytes. Stream may be malicious or corrupted.`);
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

// ─── Fetch via curl (for IPv6 source binding) ────────────────────────────

/**
 * Execute an HTTP request via curl with a specific source IPv6 address.
 * Uses `Bun.spawn` to run curl with `--interface` to bind to the given address.
 *
 * This is used when outbound IPv6 source rotation is needed, since
 * Bun's built-in fetch() does not support specifying a local address.
 *
 * @param url - Target URL
 * @param init - Request init (method, headers, body)
 * @param ipv6Source - IPv6 source address to bind to
 * @param timeoutMs - Request timeout in milliseconds
 */
export async function fetchViaCurl(
	url: string,
	init: RequestInit,
	ipv6Source: string,
	timeoutMs: number,
): Promise<Response> {
	const method = (init.method ?? "GET").toUpperCase();
	const args = [
		"curl",
		"-6",
		"--interface", ipv6Source,
		"-X", method,
		"-s",           // silent mode
		"--compressed", // auto-decompress gzip/brotli
		"-o", "-",      // output body to stdout
		"-w", "\n%{http_code}", // append status code on new line after body
		"--max-time", String(Math.ceil(timeoutMs / 1000)),
		"--connect-timeout", "10",
	];

	// Add headers
	if (init.headers) {
		const headers = init.headers instanceof Headers
			? Object.fromEntries(init.headers.entries())
			: init.headers;
		for (const [key, value] of Object.entries(headers)) {
			if (key.toLowerCase() === "host") continue; // curl sets Host automatically
			args.push("-H", `${key}: ${value}`);
		}
	}

	// Add body for non-GET/HEAD methods
	if (init.body && method !== "GET" && method !== "HEAD") {
		if (typeof init.body === "string") {
			args.push("-d", init.body);
		} else if (init.body instanceof ArrayBuffer) {
			args.push("--data-binary", "@-");
		}
		// Note: streaming bodies not supported via curl path
	}

	args.push(url);

	logProxy("fetchViaCurl", `${args.slice(0, 6).join(" ")}...`, { ipv6Source, url });

	const proc = Bun.spawn(args, {
		stdout: "pipe",
		stderr: "pipe",
		stdin: "pipe",
	});

	// Collect output with timeout
	const timeout = setTimeout(() => {
		proc.kill();
	}, timeoutMs + 5000);

	try {
		const [stdout, stderr] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);

		clearTimeout(timeout);

		// Parse: curl -w "\n%{http_code}" appends status code on a new line after body
		const lastNewline = stdout.lastIndexOf("\n");
		const rawCode = parseInt(stdout.slice(lastNewline + 1), 10);
		const statusCode = rawCode > 0 ? rawCode : 502;
		const body = lastNewline >= 0 ? stdout.slice(0, lastNewline) : stdout;

		logProxy("fetchViaCurl", `response status=${statusCode}`, { ipv6Source, url });

		return new Response(body, {
			status: statusCode,
			statusText: statusCode === 200 ? "OK" : "Error",
			headers: { "Content-Type": "text/plain" },
		});
	} catch (err) {
		clearTimeout(timeout);
		proc.kill();
		throw err;
	}
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
 *
 * @param ipv6Source - Optional IPv6 source address for outbound binding.
 *                     When provided, uses curl instead of fetch() to bind
 *                     to the specified source address.
 */
export async function fetchWithRetry(
	url: string,
	init: RequestInit & { proxy?: string },
	proxyPool?: ProxyPool,
	context?: string,
	ipv6Source?: string,
): Promise<FetchWithRetryResult> {
  let response: Response | undefined;
  let lastError: unknown;
  let usedProxy = false;

  // Strategy: direct first, then proxies as fallback.
  // maxAttempts = 1 direct + pool.size proxies, min 3 (all direct if no pool).
  const poolSize = proxyPool?.size ?? 0;
  const maxAttempts = poolSize > 0 ? poolSize + 1 : 3;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
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
			// Use curl for IPv6 source binding (only for direct connections)
			if (ipv6Source && !init.proxy) {
				response = await fetchViaCurl(url, init, ipv6Source, DEFAULT_TIMEOUT_MS);
				// If curl failed with connection error (502, empty body), fallback to regular fetch
				if (response.status === 502) {
					const cloned = response.clone();
					const bodyText = await cloned.text();
					if (!bodyText) {
						logProxy("fetchWithRetry", `IPv6 connection failed, falling back to regular fetch`, { ipv6Source, url });
						response = await fetch(url, init);
					}
				}
			} else {
				response = await fetch(url, init);
			}
      if (response.ok) {
        if (usedProxy && proxyPool && proxyPool.size > 0) {
          proxyPool.markSuccess();
        }
        logProxy("fetchWithRetry", `success attempt=${attempt + 1} status=${response.status}`, { context });
        return { response };
      }

      // Non-2xx — mark proxy as failed and rotate for next attempt
      lastError = new Error(`Upstream returned ${response.status}`);
      logProxy("fetchWithRetry", `non-2xx attempt=${attempt + 1} status=${response.status}`, { context });
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
 *
 * @param ipv6Source - Optional IPv6 source address for outbound binding.
 */
export async function fetchWithSessionRetry(
  url: string,
  init: RequestInit & { proxy?: string },
  sessionPool: SessionProxyPool | undefined,
  sessionId: string,
  context?: string,
  maxRetries?: number,
  ipv6Source?: string,
): Promise<FetchWithRetryResult> {
  // Fallback when no session pool is available
  if (!sessionPool) {
    logProxy("fetchWithSessionRetry", "no session pool — direct fetch", { context, sessionId: sessionId.slice(0, 8) });
    try {
      let response: Response;
      if (ipv6Source) {
        response = await fetchViaCurl(url, init, ipv6Source, DEFAULT_TIMEOUT_MS);
      } else {
        response = await fetch(url, init);
      }
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
    // Determine proxy for this attempt
    if (attempt === 0) {
      // First attempt — direct (no proxy)
      init.proxy = undefined;
    } else if (sessionPool.size > 0) {
      // Fallback — use session-sticky proxy
      const proxyUrl = attempt === 1
        ? sessionPool.acquire(sessionId)
        : sessionPool.getProxyUrl(sessionId);
      if (proxyUrl) {
        init.proxy = proxyUrl;
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
      // Use curl for IPv6 source binding (only for direct connections)
      let response: Response;
      if (ipv6Source && !init.proxy) {
        response = await fetchViaCurl(url, init, ipv6Source, DEFAULT_TIMEOUT_MS);
      } else {
        response = await fetch(url, init);
      }

      if (response.ok) {
        sessionPool.markSuccess(sessionId);
        logProxy("fetchWithSessionRetry", `success attempt=${attempt + 1} status=${response.status}`, {
          context,
          sessionId: sessionId.slice(0, 8),
          proxy: proxyShort,
        });
        return { response };
      }

      // Non-2xx — rotate proxy immediately for the next attempt
      lastError = new Error(`Upstream returned ${response.status}`);
      lastResponse = response;
      const model = extractModel(context);
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
