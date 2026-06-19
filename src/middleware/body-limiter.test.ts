/**
 * Body limiter test suite.
 *
 * Covers default size limit, custom configuration,
 * Content-Length checks, and edge cases.
 */

import { test, expect, describe, beforeEach } from "bun:test";
import {
	checkBodySize,
	getMaxBodySize,
	setMaxBodySize,
} from "./body-limiter";

describe("body-limiter", () => {
	beforeEach(() => {
		// Reset to default before each test
		setMaxBodySize(1_048_576); // 1 MB
	});

	describe("getMaxBodySize / setMaxBodySize", () => {
		test("should default to 1MB", () => {
			expect(getMaxBodySize()).toBe(1_048_576);
		});

		test("should allow setting a custom max size", () => {
			setMaxBodySize(512);
			expect(getMaxBodySize()).toBe(512);
		});

		test("should allow setting zero", () => {
			setMaxBodySize(0);
			expect(getMaxBodySize()).toBe(0);
		});

		test("should throw for negative values", () => {
			expect(() => setMaxBodySize(-1)).toThrow(
				"maxBodySize must be a non-negative number",
			);
		});

		test("should allow setting a very large size", () => {
			setMaxBodySize(100_000_000);
			expect(getMaxBodySize()).toBe(100_000_000);
		});
	});

	describe("checkBodySize", () => {
		test("should return null when Content-Length is under the default limit", () => {
			const request = new Request("http://localhost/test", {
				method: "POST",
				headers: { "Content-Length": "500" },
			});
			expect(checkBodySize(request)).toBeNull();
		});

		test("should return null when Content-Length is exactly at the default limit", () => {
			const request = new Request("http://localhost/test", {
				method: "POST",
				headers: { "Content-Length": "1048576" },
			});
			expect(checkBodySize(request)).toBeNull();
		});

		test("should return 413 Response when Content-Length exceeds the default limit", () => {
			const request = new Request("http://localhost/test", {
				method: "POST",
				headers: { "Content-Length": "1048577" },
			});
			const result = checkBodySize(request);
			expect(result).toBeInstanceOf(Response);
			expect(result!.status).toBe(413);
			expect(result!.headers.get("Content-Type")).toBe("application/json");
		});

		test("413 response should include error details as JSON", async () => {
			setMaxBodySize(100);
			const request = new Request("http://localhost/test", {
				method: "POST",
				headers: { "Content-Length": "200" },
			});
			const result = checkBodySize(request);
			const body = await result!.json() as Record<string, unknown>;
			expect(body.error).toBe("Payload Too Large");
			expect(body.maxSizeBytes).toBe(100);
		});

		test("should return null when no Content-Length header is present", () => {
			const request = new Request("http://localhost/test", {
				method: "POST",
			});
			expect(checkBodySize(request)).toBeNull();
		});

		test("should return null for malformed Content-Length", () => {
			const request = new Request("http://localhost/test", {
				method: "POST",
				headers: { "Content-Length": "not-a-number" },
			});
			expect(checkBodySize(request)).toBeNull();
		});

		test("should return null for negative Content-Length", () => {
			const request = new Request("http://localhost/test", {
				method: "POST",
				headers: { "Content-Length": "-100" },
			});
			expect(checkBodySize(request)).toBeNull();
		});

		test("should use custom max body size when set", () => {
			setMaxBodySize(500);
			const underLimit = new Request("http://localhost/test", {
				method: "POST",
				headers: { "Content-Length": "499" },
			});
			expect(checkBodySize(underLimit)).toBeNull();

			const overLimit = new Request("http://localhost/test", {
				method: "POST",
				headers: { "Content-Length": "501" },
			});
			expect(checkBodySize(overLimit)!.status).toBe(413);
		});

		test("should handle GET requests with Content-Length", () => {
			const request = new Request("http://localhost/test", {
				method: "GET",
				headers: { "Content-Length": "10" },
			});
			expect(checkBodySize(request)).toBeNull();
		});

		test("should handle zero Content-Length", () => {
			const request = new Request("http://localhost/test", {
				method: "POST",
				headers: { "Content-Length": "0" },
			});
			expect(checkBodySize(request)).toBeNull();
		});
	});
});
