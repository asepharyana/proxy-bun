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
}

export interface RateLimiter {
	check(key: string): { allowed: boolean; retryAfterMs?: number };
	reset(key: string): void;
}

const DEFAULT_MAX_REQUESTS = 100;
const DEFAULT_WINDOW_MS = 60_000; // 1 minute
const CLEANUP_INTERVAL_DIVISOR = 10;

export function createRateLimiter(options?: RateLimiterOptions): RateLimiter {
	const maxRequests = options?.maxRequests ?? DEFAULT_MAX_REQUESTS;
	const windowMs = options?.windowMs ?? DEFAULT_WINDOW_MS;

	// Map of key -> sorted array of timestamps (ascending)
	const store = new Map<string, number[]>();

	// ── helpers ──────────────────────────────────────────────────────

	/** Remove timestamps outside the sliding window. Returns the pruned slice. */
	function prune(key: string, now: number): number[] {
		const timestamps = store.get(key);
		if (!timestamps) return [];

		const cutoff = now - windowMs;
		const result: number[] = [];
		for (let i = 0; i < timestamps.length; i++) {
			if (timestamps[i] >= cutoff) {
				result.push(timestamps[i]);
			}
		}

		if (result.length === 0) {
			store.delete(key);
		} else {
			store.set(key, result);
		}
		return result;
	}

	/** Periodically sweep the entire store to free memory. */
	function periodicCleanup(): void {
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
	}

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

	// ── public API ───────────────────────────────────────────────────

	return {
		check(key: string): { allowed: boolean; retryAfterMs?: number } {
			const now = Date.now();
			const timestamps = prune(key, now);
			timestamps.push(now);
			store.set(key, timestamps);

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

		reset(key: string): void {
			store.delete(key);
		},
	};
}
