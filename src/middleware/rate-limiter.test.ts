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
		test("should allow requests up to the default limit", () => {
			const limiter = createRateLimiter({ maxRequests: 5, windowMs: 60_000 });
			for (let i = 0; i < 5; i++) {
				const result = limiter.check("test-key");
				expect(result.allowed).toBe(true);
			}
		});

		test("should block requests exceeding the limit", () => {
			const limiter = createRateLimiter({ maxRequests: 3, windowMs: 60_000 });
			for (let i = 0; i < 3; i++) {
				expect(limiter.check("block-key").allowed).toBe(true);
			}
			const blocked = limiter.check("block-key");
			expect(blocked.allowed).toBe(false);
			expect(blocked.retryAfterMs).toBeDefined();
			expect(typeof blocked.retryAfterMs).toBe("number");
		});

		test("should return retryAfterMs when blocked", () => {
			const limiter = createRateLimiter({
				maxRequests: 1,
				windowMs: 60_000,
			});
			limiter.check("retry-key");
			const blocked = limiter.check("retry-key");
			expect(blocked.allowed).toBe(false);
			expect(blocked.retryAfterMs).toBeGreaterThan(0);
			expect(blocked.retryAfterMs).toBeLessThanOrEqual(60_000);
		});

		test("reset() should clear the counter", () => {
			const limiter = createRateLimiter({ maxRequests: 2, windowMs: 60_000 });
			limiter.check("reset-key");
			limiter.check("reset-key");
			// would be blocked, but...
			limiter.reset("reset-key");
			// ...should be allowed again
			expect(limiter.check("reset-key").allowed).toBe(true);
		});

		test("should isolate keys from each other", () => {
			const limiter = createRateLimiter({ maxRequests: 2, windowMs: 60_000 });
			expect(limiter.check("key-a").allowed).toBe(true);
			expect(limiter.check("key-a").allowed).toBe(true);
			expect(limiter.check("key-b").allowed).toBe(true); // key-b unaffected
			expect(limiter.check("key-a").allowed).toBe(false); // key-a blocked
		});

		test("should create with default options", () => {
			const limiter = createRateLimiter();
			expect(limiter.check).toBeDefined();
			expect(limiter.reset).toBeDefined();
		});

		test("should handle rapid sequential calls", () => {
			const limiter = createRateLimiter({ maxRequests: 100, windowMs: 60_000 });
			for (let i = 0; i < 100; i++) {
				expect(limiter.check("rapid-key").allowed).toBe(true);
			}
			expect(limiter.check("rapid-key").allowed).toBe(false);
		});

		test("should allow requests after reset", () => {
			const limiter = createRateLimiter({ maxRequests: 1, windowMs: 60_000 });
			limiter.check("after-reset-key");
			const blocked = limiter.check("after-reset-key");
			expect(blocked.allowed).toBe(false);
			limiter.reset("after-reset-key");
			expect(limiter.check("after-reset-key").allowed).toBe(true);
		});
	});
});
