/**
 * Rate limiter test suite.
 *
 * Covers default and custom options, window enforcement,
 * reset semantics, and edge cases.
 */

import { test, expect, describe } from "bun:test";
import { createRateLimiter } from "./rate-limiter";

describe("rate-limiter", () => {
	describe("createRateLimiter", () => {
		test("should allow requests up to the default limit", async () => {
			const limiter = createRateLimiter({ maxRequests: 5, windowMs: 60_000 });
			for (let i = 0; i < 5; i++) {
				const result = await limiter.checkAsync("test-key");
				expect(result.allowed).toBe(true);
			}
		});

		test("should block requests exceeding the limit", async () => {
			const limiter = createRateLimiter({ maxRequests: 3, windowMs: 60_000 });
			for (let i = 0; i < 3; i++) {
				expect((await limiter.checkAsync("block-key")).allowed).toBe(true);
			}
			const blocked = await limiter.checkAsync("block-key");
			expect(blocked.allowed).toBe(false);
			expect(blocked.retryAfterMs).toBeDefined();
			expect(typeof blocked.retryAfterMs).toBe("number");
		});

		test("should return retryAfterMs when blocked", async () => {
			const limiter = createRateLimiter({
				maxRequests: 1,
				windowMs: 60_000,
			});
			await limiter.checkAsync("retry-key");
			const blocked = await limiter.checkAsync("retry-key");
			expect(blocked.allowed).toBe(false);
			expect(blocked.retryAfterMs).toBeGreaterThan(0);
			expect(blocked.retryAfterMs).toBeLessThanOrEqual(60_000);
		});

		test("reset() should clear the counter", async () => {
			const limiter = createRateLimiter({ maxRequests: 2, windowMs: 60_000 });
			await limiter.checkAsync("reset-key");
			await limiter.checkAsync("reset-key");
			// would be blocked, but...
			await limiter.resetAsync("reset-key");
			// ...should be allowed again
			expect((await limiter.checkAsync("reset-key")).allowed).toBe(true);
		});

		test("should isolate keys from each other", async () => {
			const limiter = createRateLimiter({ maxRequests: 2, windowMs: 60_000 });
			expect((await limiter.checkAsync("key-a")).allowed).toBe(true);
			expect((await limiter.checkAsync("key-a")).allowed).toBe(true);
			expect((await limiter.checkAsync("key-b")).allowed).toBe(true); // key-b unaffected
			expect((await limiter.checkAsync("key-a")).allowed).toBe(false); // key-a blocked
		});

		test("should create with default options", () => {
			const limiter = createRateLimiter();
			expect(limiter.checkAsync).toBeDefined();
			expect(limiter.resetAsync).toBeDefined();
		});

		test("should handle rapid sequential calls", async () => {
			const limiter = createRateLimiter({ maxRequests: 100, windowMs: 60_000 });
			for (let i = 0; i < 100; i++) {
				expect((await limiter.checkAsync("rapid-key")).allowed).toBe(true);
			}
			expect((await limiter.checkAsync("rapid-key")).allowed).toBe(false);
		});

		test("should allow requests after reset", async () => {
			const limiter = createRateLimiter({ maxRequests: 1, windowMs: 60_000 });
			await limiter.checkAsync("after-reset-key");
			const blocked = await limiter.checkAsync("after-reset-key");
			expect(blocked.allowed).toBe(false);
			await limiter.resetAsync("after-reset-key");
			expect((await limiter.checkAsync("after-reset-key")).allowed).toBe(true);
		});
	});
});
