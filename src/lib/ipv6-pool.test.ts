import { test, expect, describe } from "bun:test";
import { IPv6SourcePool } from "./ipv6-pool";

describe("IPv6SourcePool", () => {
	test("should load addresses from comma-separated string", () => {
		const pool = new IPv6SourcePool();
		pool.loadFromString("2001:db8::1,2001:db8::2,2001:db8::3");

		expect(pool.size).toBe(3);
		expect(pool.configured).toBe(true);
	});

	test("should return null when empty", () => {
		const pool = new IPv6SourcePool();
		expect(pool.size).toBe(0);
		expect(pool.configured).toBe(false);
		expect(pool.getNext()).toBeNull();
	});

	test("should rotate through addresses round-robin", () => {
		const pool = new IPv6SourcePool();
		pool.loadFromString("2001:db8::1,2001:db8::2,2001:db8::3");

		expect(pool.getNext()).toBe("2001:db8::1");
		expect(pool.getNext()).toBe("2001:db8::2");
		expect(pool.getNext()).toBe("2001:db8::3");
		expect(pool.getNext()).toBe("2001:db8::1"); // wraps around
	});

	test("should skip failed sources", () => {
		const pool = new IPv6SourcePool();
		pool.loadFromString("2001:db8::1,2001:db8::2,2001:db8::3");
		pool.setFailureThreshold(1);

		pool.markFailed("2001:db8::2");

		const results = [pool.getNext(), pool.getNext(), pool.getNext(), pool.getNext()];
		// Should skip 2001:db8::2 (disabled after 1 failure with threshold=1)
		expect(results).not.toContain("2001:db8::2");
	});

	test("should reset after all sources fail", () => {
		const pool = new IPv6SourcePool();
		pool.loadFromString("2001:db8::1,2001:db8::2");

		// Mark all as failed
		pool.markFailed("2001:db8::1");
		pool.markFailed("2001:db8::1");
		pool.markFailed("2001:db8::1");
		pool.markFailed("2001:db8::2");
		pool.markFailed("2001:db8::2");
		pool.markFailed("2001:db8::2");

		// Should auto-reset and return first
		const addr = pool.getNext();
		expect(addr).toBe("2001:db8::1");
	});

	test("should reset failure count on success", () => {
		const pool = new IPv6SourcePool();
		pool.loadFromString("2001:db8::1,2001:db8::2");

		pool.markFailed("2001:db8::1");
		pool.markFailed("2001:db8::1");
		pool.markSuccess("2001:db8::1");

		// Should not be disabled after success
		const addr = pool.getNext();
		expect(addr).toBe("2001:db8::1");
	});

	test("should get address by index", () => {
		const pool = new IPv6SourcePool();
		pool.loadFromString("2001:db8::1,2001:db8::2");

		expect(pool.getAtIndex(0)).toBe("2001:db8::1");
		expect(pool.getAtIndex(1)).toBe("2001:db8::2");
		expect(pool.getAtIndex(2)).toBeNull();
	});

	test("should handle whitespace in input", () => {
		const pool = new IPv6SourcePool();
		pool.loadFromString("  2001:db8::1 , 2001:db8::2  ");

		expect(pool.size).toBe(2);
		expect(pool.getNext()).toBe("2001:db8::1");
	});

	test("should handle empty input", () => {
		const pool = new IPv6SourcePool();
		pool.loadFromString("");
		expect(pool.size).toBe(0);
	});

	test("should reset all sources", () => {
		const pool = new IPv6SourcePool();
		pool.loadFromString("2001:db8::1,2001:db8::2");

		pool.markFailed("2001:db8::1");
		pool.markFailed("2001:db8::1");
		pool.markFailed("2001:db8::1");
		pool.reset();

		expect(pool.getNext()).toBe("2001:db8::1");
	});

	test("should change failure threshold", () => {
		const pool = new IPv6SourcePool();
		pool.loadFromString("2001:db8::1");
		pool.setFailureThreshold(1);

		pool.markFailed("2001:db8::1");
		// With threshold 1, should be disabled after 1 failure
		// getNext should auto-reset since all failed
		const addr = pool.getNext();
		expect(addr).toBe("2001:db8::1");
	});
});
