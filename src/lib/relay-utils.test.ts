import { test, expect, describe } from "bun:test";
import {
	normalizeTargetUrl,
	filterHeaders,
	shouldSendBody,
	isAllowedTarget,
} from "./relay-utils";

describe("relay-utils", () => {
	describe("normalizeTargetUrl", () => {
		test("should combine target and path", () => {
			expect(normalizeTargetUrl("https://example.com", "/api/v1")).toBe("https://example.com/api/v1");
		});

		test("should handle trailing slash in target", () => {
			expect(normalizeTargetUrl("https://example.com/", "/api/v1")).toBe("https://example.com/api/v1");
		});

		test("should return null if target is missing", () => {
			expect(normalizeTargetUrl(null, "/api/v1")).toBe(null);
		});
	});

	describe("filterHeaders", () => {
		test("should remove blocked headers", () => {
			const headers = new Headers({
				"content-type": "application/json",
				"cookie": "secret=123",
				"x-vercel-id": "123",
				"cf-ray": "123",
				"host": "localhost",
				"x-relay-target": "test",
			});
			const filtered = filterHeaders(headers);
			expect(filtered.has("content-type")).toBe(true);
			expect(filtered.has("cookie")).toBe(false);
			expect(filtered.has("x-vercel-id")).toBe(false);
			expect(filtered.has("cf-ray")).toBe(false);
			expect(filtered.has("host")).toBe(false);
			expect(filtered.has("x-relay-target")).toBe(false);
		});

		test("should remove headers starting with blocked prefixes", () => {
			const headers = new Headers({
				"x-vercel-custom": "val",
				"cf-custom": "val",
				"x-forwarded-for": "1.1.1.1",
			});
			const filtered = filterHeaders(headers);
			expect(filtered.has("x-vercel-custom")).toBe(false);
			expect(filtered.has("cf-custom")).toBe(false);
			expect(filtered.has("x-forwarded-for")).toBe(false);
		});
	});

	describe("shouldSendBody", () => {
		test("should return false for GET and HEAD", () => {
			expect(shouldSendBody("GET")).toBe(false);
			expect(shouldSendBody("HEAD")).toBe(false);
		});

		test("should return true for POST, PUT, DELETE, PATCH", () => {
			expect(shouldSendBody("POST")).toBe(true);
			expect(shouldSendBody("PUT")).toBe(true);
			expect(shouldSendBody("DELETE")).toBe(true);
			expect(shouldSendBody("PATCH")).toBe(true);
		});
	});

	describe("isAllowedTarget", () => {
		test("should allow http and https", () => {
			expect(isAllowedTarget("https://example.com")).toBe(true);
			expect(isAllowedTarget("http://example.com")).toBe(true);
		});

		test("should reject other protocols", () => {
			expect(isAllowedTarget("ftp://example.com")).toBe(false);
			expect(isAllowedTarget("javascript:alert(1)")).toBe(false);
		});

		test("should reject invalid URLs", () => {
			expect(isAllowedTarget("not-a-url")).toBe(false);
		});
	});
});
