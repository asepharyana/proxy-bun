/**
 * In-memory sliding window rate limiter for Bun relay proxy.
 *
 * Uses a Map<string, number[]> where each key maps to an array of
 * Unix-epoch millisecond timestamps. Older entries are purged on
 * every check() call and periodically via a background interval.
 *
 * Bun is single-threaded so no locking is required.
 */

export interface RateLimiterOptions {
	maxRequests?: number;
	windowMs?: number;
	/** Optional async KV store for distributed rate limiting */
	kv?: {
		get(key: string): Promise<number[] | null>;
		set(key: string, value: number[], expirationTtl?: number): Promise<void>;
	};
}

export interface RateLimiter {
	checkAsync(key: string): Promise<{ allowed: boolean; retryAfterMs?: number }>;
	resetAsync(key: string): Promise<void>;
}

const DEFAULT_MAX_REQUESTS = 100;
const DEFAULT_WINDOW_MS = 60_000; // 1 minute
const CLEANUP_INTERVAL_DIVISOR = 10;

export function createRateLimiter(options?: RateLimiterOptions): RateLimiter {
	const maxRequests = options?.maxRequests ?? DEFAULT_MAX_REQUESTS;
	const windowMs = options?.windowMs ?? DEFAULT_WINDOW_MS;
	const kv = options?.kv;

	// In-memory store fallback
	const store = new Map<string, number[]>();

	// Maximum number of unique keys to track (prevents unbounded memory growth)
	const MAX_STORE_KEYS = 10_000;

	// ── helpers ──────────────────────────────────────────────────────

	function pruneTimestamps(timestamps: number[], now: number): number[] {
		const cutoff = now - windowMs;
		const result: number[] = [];
		for (let i = 0; i < timestamps.length; i++) {
			if (timestamps[i] >= cutoff) {
				result.push(timestamps[i]);
			}
		}
		return result;
	}

	/** Periodically sweep the entire memory store to free memory. */
	function periodicCleanup(): void {
		if (kv) return; // Cleanup handled by TTL in KV
		const now = Date.now();
		const cutoff = now - windowMs;

		for (const [key, timestamps] of store) {
			const pruned: number[] = [];
			for (let i = 0; i < timestamps.length; i++) {
				if (timestamps[i] >= cutoff) {
					pruned.push(timestamps[i]);
				}
			}
			if (pruned.length === 0) {
				store.delete(key);
			} else {
				store.set(key, pruned);
			}
		}

		// If store still exceeds max keys after pruning, evict oldest entries
		if (store.size > MAX_STORE_KEYS) {
			// Sort by oldest timestamp, evict excess
			const entries = Array.from(store.entries())
				.sort((a, b) => {
					const aOldest = a[1][0] ?? 0;
					const bOldest = b[1][0] ?? 0;
					return aOldest - bOldest;
				});
			const toEvict = entries.length - MAX_STORE_KEYS;
			for (let i = 0; i < toEvict; i++) {
				store.delete(entries[i]![0]);
			}
			console.warn(`[rate-limiter] Evicted ${toEvict} keys from store (max ${MAX_STORE_KEYS})`);
		}
	}

	if (!kv) {
		// Schedule periodic cleanup (every windowMs / 10)
		const cleanupHandle = setInterval(
			periodicCleanup,
			windowMs / CLEANUP_INTERVAL_DIVISOR,
		);
		// Allow the process to exit even if the interval is still active
		if (
			cleanupHandle &&
			typeof cleanupHandle === "object" &&
			"unref" in cleanupHandle
		) {
			(cleanupHandle as NodeJS.Timeout).unref();
		}
	}

	// ── public API ───────────────────────────────────────────────────

	return {
		async checkAsync(key: string): Promise<{ allowed: boolean; retryAfterMs?: number }> {
			const now = Date.now();
			let timestamps: number[] = [];

			if (kv) {
				try {
					const val = await kv.get(key);
					if (val) timestamps = val;
				} catch {
					// Fallback to empty
				}
			} else {
				timestamps = store.get(key) ?? [];
			}

			timestamps = pruneTimestamps(timestamps, now);
			timestamps.push(now);

			if (kv) {
				// We set TTL slightly higher than windowMs so it cleans up automatically
				await kv.set(key, timestamps, Math.ceil(windowMs / 1000) + 10).catch(() => {});
			} else {
				store.set(key, timestamps);
			}

			if (timestamps.length <= maxRequests) {
				return { allowed: true };
			}

			// Not allowed — calculate retry-after from the oldest timestamp
			const oldest = timestamps[0];
			const retryAfterMs = oldest + windowMs - now;

			console.warn(
				`[rate-limiter] Rate limit exceeded for key="${key}": ${timestamps.length} requests in ${windowMs}ms (max ${maxRequests})`,
			);

			return { allowed: false, retryAfterMs };
		},

		async resetAsync(key: string): Promise<void> {
			if (kv) {
				await kv.set(key, [], 1).catch(() => {});
			} else {
				store.delete(key);
			}
		},
	};
}
