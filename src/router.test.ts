/**
 * Tests for consolidated router handlers + relay pipeline.
 *
 * Covers requireAuth, getClientIP, handleHealth, handleIndex,
 * validateRelayTarget, handleRelayPlan, CORS, and error responses.
 */

import { test, expect, describe, afterEach } from "bun:test";
import {
	handleHealth,
	handleIndex,
	requireAuth,
	getClientIP,
	getClientIPFromServer,
} from "./lib/router";

// =============================================================================
// requireAuth
// =============================================================================

describe("requireAuth", () => {
	const originalEnvKey = process.env.API_KEY;

	afterEach(() => {
		delete process.env.API_KEY;
		if (originalEnvKey) process.env.API_KEY = originalEnvKey;
	});

	test("returns null when no API_KEY is configured (auth disabled)", () => {
		delete process.env.API_KEY;
		const req = new Request("http://test.com");
		expect(requireAuth(req)).toBeNull();
	});

	test("returns null when Authorization header matches process.env.API_KEY", () => {
		process.env.API_KEY = "sk-test-key";
		const req = new Request("http://test.com", {
			headers: { authorization: "Bearer sk-test-key" },
		});
		expect(requireAuth(req)).toBeNull();
	});

	test("returns 401 when Authorization header does not match", async () => {
		process.env.API_KEY = "sk-real-key";
		const req = new Request("http://test.com", {
			headers: { authorization: "Bearer sk-wrong-key" },
		});
		const res = requireAuth(req);
		expect(res).toBeInstanceOf(Response);
		expect(res!.status).toBe(401);
		const body = await res!.json();
		expect(body.error.message).toBe("Unauthorized");
	});

	test("accepts x-api-key header as alternative", () => {
		process.env.API_KEY = "sk-key-123";
		const req = new Request("http://test.com", {
			headers: { "x-api-key": "sk-key-123" },
		});
		expect(requireAuth(req)).toBeNull();
	});

	test("returns 401 when x-api-key does not match", () => {
		process.env.API_KEY = "sk-key-123";
		const req = new Request("http://test.com", {
			headers: { "x-api-key": "sk-wrong" },
		});
		expect(requireAuth(req)!.status).toBe(401);
	});

	test("strips Bearer prefix case-insensitively", () => {
		process.env.API_KEY = "sk-key";
		const req = new Request("http://test.com", {
			headers: { authorization: "BEARER sk-key" },
		});
		expect(requireAuth(req)).toBeNull();
	});

	test("requires auth when env bag has API_KEY", () => {
		delete process.env.API_KEY;
		const req = new Request("http://test.com", {
			headers: { authorization: "Bearer env-key" },
		});
		expect(requireAuth(req, { API_KEY: "env-key" })).toBeNull();
		expect(requireAuth(req, { API_KEY: "other-key" })!.status).toBe(401);
	});

	test("returns CORS headers on 401 response", () => {
		process.env.API_KEY = "sk-key";
		const req = new Request("http://test.com", {
			headers: { authorization: "Bearer wrong" },
		});
		const res = requireAuth(req);
		expect(res!.headers.get("Access-Control-Allow-Origin")).toBe("*");
	});
});

// =============================================================================
// getClientIP
// =============================================================================

describe("getClientIP", () => {
	test("returns x-forwarded-for when present", () => {
		const req = new Request("http://test.com", {
			headers: { "x-forwarded-for": "198.51.100.1" },
		});
		expect(getClientIP(req)).toBe("198.51.100.1");
	});

	test("takes first IP from x-forwarded-for list", () => {
		const req = new Request("http://test.com", {
			headers: { "x-forwarded-for": "203.0.113.1, 198.51.100.2" },
		});
		expect(getClientIP(req)).toBe("203.0.113.1");
	});

	test("falls back to cf-connecting-ip", () => {
		const req = new Request("http://test.com", {
			headers: { "cf-connecting-ip": "10.0.0.1" },
		});
		expect(getClientIP(req)).toBe("10.0.0.1");
	});

	test("prefers x-forwarded-for over cf-connecting-ip", () => {
		const req = new Request("http://test.com", {
			headers: {
				"x-forwarded-for": "198.51.100.1",
				"cf-connecting-ip": "10.0.0.1",
			},
		});
		expect(getClientIP(req)).toBe("198.51.100.1");
	});

	test("returns unknown when no headers are present", () => {
		const req = new Request("http://test.com");
		expect(getClientIP(req)).toBe("unknown");
	});
});

// =============================================================================
// getClientIPFromServer
// =============================================================================

describe("getClientIPFromServer", () => {
	const mockIpGetter = {
		requestIP(_req: Request) {
			return { address: "10.0.0.42", family: "IPv4" as const, port: 54321 };
		},
	};
	const nullIpGetter = {
		requestIP(_req: Request) { return null; },
	};

	test("returns x-forwarded-for first", () => {
		const req = new Request("http://test.com", {
			headers: { "x-forwarded-for": "1.2.3.4" },
		});
		expect(getClientIPFromServer(req, nullIpGetter)).toBe("1.2.3.4");
	});

	test("falls back to server.requestIP()", () => {
		const req = new Request("http://test.com");
		expect(getClientIPFromServer(req, mockIpGetter)).toBe("10.0.0.42");
	});

	test("reports unknown when all sources fail", () => {
		const req = new Request("http://test.com");
		expect(getClientIPFromServer(req, nullIpGetter)).toBe("unknown");
	});
});

// =============================================================================
// handleHealth
// =============================================================================

describe("handleHealth", () => {
	test("returns 200 with Content-Type: application/json", () => {
		const res = handleHealth();
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("application/json");
	});

	test("body contains status, uptime, and version", async () => {
		const res = handleHealth();
		const body = await res.json() as Record<string, unknown>;
		expect(body.status).toBe("ok");
		expect(typeof body.uptime).toBe("number");
		expect(body.version).toBe("1.0.0");
	});

	test("includes CORS header", () => {
		expect(handleHealth().headers.get("Access-Control-Allow-Origin")).toBe("*");
	});
});

// =============================================================================
// handleIndex
// =============================================================================

describe("handleIndex", () => {
	test("returns 200 with text/html", () => {
		const res = handleIndex();
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toContain("text/html");
	});

	test("contains Edge Proxy Relay in body", async () => {
		const text = await handleIndex().text();
		expect(text).toContain("Edge Proxy Relay");
		expect(text).toContain("Server is running");
	});
});

// =============================================================================
// Integration: CORS preflight (from relay-utils)
// =============================================================================

import { createCorsPreflightResponse, createErrorResponse } from "./lib/relay-utils";

describe("createCorsPreflightResponse", () => {
	test("returns 204 with CORS headers", () => {
		const res = createCorsPreflightResponse();
		expect(res.status).toBe(204);
		expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
		expect(res.headers.get("Access-Control-Allow-Methods")).toContain("GET");
		expect(res.headers.get("Access-Control-Allow-Headers")).toBe("*");
		expect(res.headers.get("Access-Control-Max-Age")).toBe("86400");
	});

	test("has no body", async () => {
		expect(await createCorsPreflightResponse().text()).toBe("");
	});
});

// =============================================================================
// Integration: createErrorResponse
// =============================================================================

describe("createErrorResponse", () => {
	test("returns correct status and JSON with error, code, message", async () => {
		const res = createErrorResponse({ code: "TIMEOUT", status: 504, message: "Upstream timed out" });
		expect(res.status).toBe(504);
		expect(res.headers.get("Content-Type")).toBe("application/json");
		const body = await res.json() as Record<string, unknown>;
		expect(body.error).toBe(true);
		expect(body.code).toBe("TIMEOUT");
		expect(body.message).toBe("Upstream timed out");
	});

	test("includes CORS headers", () => {
		expect(
			createErrorResponse({ code: "SSRF_BLOCKED", status: 403, message: "Blocked" }).headers.get("Access-Control-Allow-Origin"),
		).toBe("*");
	});

	test("handles different error types", async () => {
		const res = createErrorResponse({ code: "DNS_FAILURE", status: 502, message: "DNS" });
		const body = await res.json() as Record<string, unknown>;
		expect(body.code).toBe("DNS_FAILURE");
	});
});
