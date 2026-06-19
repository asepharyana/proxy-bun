/**
 * Relay utilities test suite.
 *
 * Covers URL normalisation, SSRF protection, header filtering,
 * request building, error classification, and response creation.
 */

import { test, expect, describe } from "bun:test";
import {
	normalizeTargetUrl,
	filterHeaders,
	filterRequestHeaders,
	filterResponseHeaders,
	shouldSendBody,
	isAllowedTarget,
	isPrivateIp,
	classifyFetchError,
	createErrorResponse,
	createCorsPreflightResponse,
	buildRelayRequest,
	createRelayResponse,
	RelayError,
} from "./relay-utils";

// ─── NormalizeTargetUrl ────────────────────────────────────────────────────

describe("normalizeTargetUrl", () => {
	test("should combine target and path — returns URL object", () => {
		const result = normalizeTargetUrl("https://example.com", "/api/v1");
		expect(result).toBeInstanceOf(URL);
		expect(result!.href).toBe("https://example.com/api/v1");
	});

	test("should handle trailing slash in target", () => {
		const result = normalizeTargetUrl("https://example.com/", "/api/v1");
		expect(result!.href).toBe("https://example.com/api/v1");
	});

	test("should handle trailing slashes in target", () => {
		const result = normalizeTargetUrl("https://example.com///", "/api/v1");
		expect(result!.href).toBe("https://example.com/api/v1");
	});

	test("should return null if target is missing", () => {
		expect(normalizeTargetUrl(null, "/api/v1")).toBe(null);
	});

	test("should return null if target is empty string", () => {
		expect(normalizeTargetUrl("", "/api/v1")).toBe(null);
	});

	test("should return null if target is whitespace-only", () => {
		expect(normalizeTargetUrl("   ", "/api/v1")).toBe(null);
	});

	test("should keep target without trailing slash", () => {
		const result = normalizeTargetUrl("https://httpbin.org", "/get");
		expect(result!.href).toBe("https://httpbin.org/get");
	});

	test("should append relay path without leading slash", () => {
		const result = normalizeTargetUrl("https://example.com", "api/users");
		expect(result!.href).toBe("https://example.com/api/users");
	});

	test("should handle nested paths", () => {
		const result = normalizeTargetUrl(
			"https://api.example.com",
			"/v1/users/123/profile",
		);
		expect(result!.href).toBe(
			"https://api.example.com/v1/users/123/profile",
		);
	});

	test("should merge query parameters from target URL", () => {
		const result = normalizeTargetUrl(
			"https://example.com?source=proxy",
			"/path",
		);
		expect(result!.href).toBe("https://example.com/path?source=proxy");
	});

	test("should merge query parameters from relay path", () => {
		const result = normalizeTargetUrl(
			"https://example.com",
			"/path?format=json",
		);
		expect(result!.href).toBe("https://example.com/path?format=json");
	});

	test("should merge query params from both target and relay path", () => {
		const result = normalizeTargetUrl(
			"https://example.com?source=proxy",
			"/path?format=json",
		);
		const href = result!.href;
		expect(href).toContain("source=proxy");
		expect(href).toContain("format=json");
	});

	test("should return null for invalid target URL", () => {
		expect(normalizeTargetUrl("not-a-valid-url", "/path")).toBe(null);
	});

	test("should handle target with existing path", () => {
		const result = normalizeTargetUrl("https://example.com/base", "/new");
		expect(result!.href).toBe("https://example.com/base/new");
	});

	test("should handle target with trailing path", () => {
		const result = normalizeTargetUrl(
			"https://api.example.com/v1/",
			"/users",
		);
		expect(result!.href).toBe("https://api.example.com/v1/users");
	});

	test("should preserve port in target", () => {
		const result = normalizeTargetUrl(
			"https://localhost:8443",
			"/api/test",
		);
		expect(result!.port).toBe("8443");
		expect(result!.href).toBe("https://localhost:8443/api/test");
	});
});

// ─── IsPrivateIp ───────────────────────────────────────────────────────────

describe("isPrivateIp", () => {
	test("should return true for IPv4 loopback", () => {
		expect(isPrivateIp("127.0.0.1")).toBe(true);
		expect(isPrivateIp("127.255.255.255")).toBe(true);
	});

	test("should return true for 10.x.x.x (private class A)", () => {
		expect(isPrivateIp("10.0.0.1")).toBe(true);
		expect(isPrivateIp("10.255.255.255")).toBe(true);
	});

	test("should return true for 192.168.x.x (private class C)", () => {
		expect(isPrivateIp("192.168.0.1")).toBe(true);
		expect(isPrivateIp("192.168.255.255")).toBe(true);
	});

	test("should return true for 172.16-31.x.x (private class B)", () => {
		expect(isPrivateIp("172.16.0.1")).toBe(true);
		expect(isPrivateIp("172.31.255.255")).toBe(true);
	});

	test("should return false for 172.15.x.x (outside private range)", () => {
		expect(isPrivateIp("172.15.0.1")).toBe(false);
	});

	test("should return false for 172.32.x.x (outside private range)", () => {
		expect(isPrivateIp("172.32.0.1")).toBe(false);
	});

	test("should return true for link-local 169.254.x.x", () => {
		expect(isPrivateIp("169.254.1.1")).toBe(true);
	});

	test("should return true for IPv6 loopback", () => {
		expect(isPrivateIp("::1")).toBe(true);
	});

	test("should return true for IPv6 unspecified", () => {
		expect(isPrivateIp("::")).toBe(true);
	});

	test("should return true for IPv6 link-local", () => {
		expect(isPrivateIp("fe80::1")).toBe(true);
		expect(isPrivateIp("FE80::")).toBe(true);
	});

	test("should return true for IPv6 unique local", () => {
		expect(isPrivateIp("fd00::1")).toBe(true);
		expect(isPrivateIp("fc00::1")).toBe(true);
	});

	test("should return false for public IPs", () => {
		expect(isPrivateIp("8.8.8.8")).toBe(false);
		expect(isPrivateIp("1.1.1.1")).toBe(false);
		expect(isPrivateIp("93.184.216.34")).toBe(false);
	});

	test("should return false for public hostnames", () => {
		expect(isPrivateIp("example.com")).toBe(false);
		expect(isPrivateIp("google.com")).toBe(false);
	});

	test("should return true for localhost", () => {
		expect(isPrivateIp("localhost")).toBe(true);
		expect(isPrivateIp("LOCALHOST")).toBe(true);
	});

	test("should return true for metadata endpoints", () => {
		expect(isPrivateIp("169.254.169.254")).toBe(true);
		expect(isPrivateIp("metadata.google.internal")).toBe(true);
		expect(isPrivateIp("metadata.internal")).toBe(true);
	});

	test("should return true for .local and .internal hostnames", () => {
		expect(isPrivateIp("myhost.local")).toBe(true);
		expect(isPrivateIp("service.internal")).toBe(true);
	});

	test("should return true for 0.0.0.0", () => {
		expect(isPrivateIp("0.0.0.0")).toBe(true);
	});

	test("should handle empty string", () => {
		expect(isPrivateIp("")).toBe(false);
	});
});

// ─── IsAllowedTarget ───────────────────────────────────────────────────────

describe("isAllowedTarget", () => {
	test("should allow https and http URLs", () => {
		expect(isAllowedTarget(new URL("https://example.com"))).toBe(true);
		expect(isAllowedTarget(new URL("http://example.com"))).toBe(true);
	});

	test("should reject other protocols", () => {
		expect(isAllowedTarget(new URL("ftp://example.com"))).toBe(false);
		expect(isAllowedTarget(new URL("javascript:alert(1)"))).toBe(false);
		expect(isAllowedTarget(new URL("file:///etc/passwd"))).toBe(false);
	});

	test("should reject private IPs", () => {
		expect(isAllowedTarget(new URL("http://127.0.0.1:8080/api"))).toBe(
			false,
		);
		expect(isAllowedTarget(new URL("http://192.168.1.1"))).toBe(false);
		expect(isAllowedTarget(new URL("http://10.0.0.1"))).toBe(false);
	});

	test("should reject localhost", () => {
		expect(isAllowedTarget(new URL("http://localhost:3000"))).toBe(false);
	});

	test("should reject metadata endpoints", () => {
		expect(
			isAllowedTarget(new URL("http://169.254.169.254/latest/meta-data/")),
		).toBe(false);
	});

	test("should allow public hosts on standard ports", () => {
		expect(isAllowedTarget(new URL("https://api.github.com"))).toBe(true);
		expect(isAllowedTarget(new URL("https://httpbin.org/get"))).toBe(true);
	});
});

// ─── FilterRequestHeaders ──────────────────────────────────────────────────

describe("filterRequestHeaders", () => {
	test("should keep allowed headers and remove blocked ones", () => {
		const headers = new Headers({
			"content-type": "application/json",
			cookie: "secret=123",
			"x-vercel-id": "abc123",
			"cf-ray": "def456",
			host: "localhost",
			"x-relay-target": "test",
		});
		const filtered = filterRequestHeaders(headers);
		expect(filtered.get("content-type")).toBe("application/json");
		expect(filtered.has("cookie")).toBe(false);
		expect(filtered.has("x-vercel-id")).toBe(false);
		expect(filtered.has("cf-ray")).toBe(false);
		expect(filtered.has("host")).toBe(false);
		expect(filtered.has("x-relay-target")).toBe(false);
	});

	test("should remove headers with blocked prefixes", () => {
		const headers = new Headers({
			"x-vercel-custom": "val",
			"cf-custom": "val",
			"x-forwarded-for": "1.1.1.1",
			"x-forwarded-host": "example.com",
			"x-forwarded-proto": "https",
		});
		const filtered = filterRequestHeaders(headers);
		expect(filtered.has("x-vercel-custom")).toBe(false);
		expect(filtered.has("cf-custom")).toBe(false);
		expect(filtered.has("x-forwarded-for")).toBe(false);
		expect(filtered.has("x-forwarded-host")).toBe(false);
		expect(filtered.has("x-forwarded-proto")).toBe(false);
	});

	test("should preserve non-blocked headers", () => {
		const headers = new Headers({
			authorization: "Bearer token-123",
			"x-custom": "custom-value",
			"x-request-id": "req-abc",
		});
		const filtered = filterRequestHeaders(headers);
		expect(filtered.get("authorization")).toBe("Bearer token-123");
		expect(filtered.get("x-custom")).toBe("custom-value");
		expect(filtered.get("x-request-id")).toBe("req-abc");
	});

	test("should handle case-insensitive header matching", () => {
		const headers = new Headers({
			Host: "example.com",
			"X-Vercel-Id": "abc123",
			"CF-Ray": "def456",
		});
		const filtered = filterRequestHeaders(headers);
		expect(filtered.has("Host")).toBe(false);
		expect(filtered.has("X-Vercel-Id")).toBe(false);
		expect(filtered.has("CF-Ray")).toBe(false);
	});

	test("should not mutate the original headers", () => {
		const headers = new Headers({ cookie: "secret", "x-custom": "val" });
		const filtered = filterRequestHeaders(headers);
		expect(headers.has("cookie")).toBe(true);
		expect(filtered.has("cookie")).toBe(false);
	});

	test("should not add any new headers", () => {
		const headers = new Headers({ "x-custom": "val" });
		const filtered = filterRequestHeaders(headers);
		expect(filtered.get("x-custom")).toBe("val");
		expect(Array.from(filtered).length).toBe(1);
	});

	test("should block hop-by-hop headers", () => {
		const headers = new Headers({
			connection: "close",
			"transfer-encoding": "chunked",
			"proxy-authorization": "basic xyz",
		});
		const filtered = filterRequestHeaders(headers);
		expect(filtered.has("connection")).toBe(false);
		expect(filtered.has("transfer-encoding")).toBe(false);
		expect(filtered.has("proxy-authorization")).toBe(false);
	});

	test("should block x-real-ip and forwarded and via", () => {
		const headers = new Headers({
			"x-real-ip": "10.0.0.1",
			forwarded: "for=192.0.2.60",
			via: "1.1 proxy",
		});
		const filtered = filterRequestHeaders(headers);
		expect(filtered.has("x-real-ip")).toBe(false);
		expect(filtered.has("forwarded")).toBe(false);
		expect(filtered.has("via")).toBe(false);
	});
});

// ─── filterHeaders (backward compatibility alias) ──────────────────────────

describe("filterHeaders (deprecated alias)", () => {
	test("should be the same function as filterRequestHeaders", () => {
		expect(filterHeaders).toBe(filterRequestHeaders);
	});

	test("should work identically to filterRequestHeaders", () => {
		const headers = new Headers({
			"content-type": "application/json",
			cookie: "secret",
		});
		expect(filterHeaders(headers).get("content-type")).toBe(
			"application/json",
		);
		expect(filterHeaders(headers).has("cookie")).toBe(false);
	});
});

// ─── FilterResponseHeaders ─────────────────────────────────────────────────

describe("filterResponseHeaders", () => {
	test("should remove blocked response headers", () => {
		const headers = new Headers({
			"content-type": "application/json",
			"set-cookie": "session=abc",
			"transfer-encoding": "chunked",
			"keep-alive": "timeout=5",
			connection: "keep-alive",
		});
		const filtered = filterResponseHeaders(headers);
		expect(filtered.get("content-type")).toBe("application/json");
		expect(filtered.has("set-cookie")).toBe(false);
		expect(filtered.has("transfer-encoding")).toBe(false);
		expect(filtered.has("keep-alive")).toBe(false);
		expect(filtered.has("connection")).toBe(false);
	});

	test("should add CORS headers", () => {
		const headers = new Headers();
		const filtered = filterResponseHeaders(headers);
		expect(filtered.get("Access-Control-Allow-Origin")).toBe("*");
		expect(filtered.get("Access-Control-Allow-Methods")).toBeTruthy();
		expect(filtered.get("Access-Control-Allow-Headers")).toBe("*");
	});
});

// ─── ShouldSendBody ────────────────────────────────────────────────────────

describe("shouldSendBody", () => {
	test("should return false for GET", () => {
		expect(shouldSendBody("GET")).toBe(false);
	});

	test("should return false for HEAD", () => {
		expect(shouldSendBody("HEAD")).toBe(false);
	});

	test("should return false for CONNECT", () => {
		expect(shouldSendBody("CONNECT")).toBe(false);
	});

	test("should return true for POST", () => {
		expect(shouldSendBody("POST")).toBe(true);
	});

	test("should return true for PUT", () => {
		expect(shouldSendBody("PUT")).toBe(true);
	});

	test("should return true for PATCH", () => {
		expect(shouldSendBody("PATCH")).toBe(true);
	});

	test("should return true for DELETE", () => {
		expect(shouldSendBody("DELETE")).toBe(true);
	});

	test("should return true for OPTIONS", () => {
		expect(shouldSendBody("OPTIONS")).toBe(true);
	});

	test("should handle lowercase methods", () => {
		expect(shouldSendBody("get")).toBe(false);
		expect(shouldSendBody("head")).toBe(false);
		expect(shouldSendBody("connect")).toBe(false);
		expect(shouldSendBody("post")).toBe(true);
		expect(shouldSendBody("put")).toBe(true);
		expect(shouldSendBody("patch")).toBe(true);
		expect(shouldSendBody("delete")).toBe(true);
	});
});

// ─── BuildRelayRequest ─────────────────────────────────────────────────────

describe("buildRelayRequest", () => {
	test("should set correct method", () => {
		const req = new Request("http://test.com", { method: "POST" });
		const headers = new Headers();
		const result = buildRelayRequest(req, headers);
		expect(result.method).toBe("POST");
	});

	test("should set provided headers", () => {
		const req = new Request("http://test.com");
		const headers = new Headers({ "x-custom": "value" });
		const result = buildRelayRequest(req, headers);
		expect(result.headers).toBe(headers);
	});

	test("should omit body for GET", () => {
		const req = new Request("http://test.com", { method: "GET" });
		const headers = new Headers();
		const result = buildRelayRequest(req, headers);
		expect(result.body).toBeUndefined();
	});

	test("should omit body for HEAD", () => {
		const req = new Request("http://test.com", { method: "HEAD" });
		const headers = new Headers();
		const result = buildRelayRequest(req, headers);
		expect(result.body).toBeUndefined();
	});

	test("should omit body for CONNECT", () => {
		const req = new Request("http://test.com", { method: "CONNECT" });
		const headers = new Headers();
		const result = buildRelayRequest(req, headers);
		expect(result.body).toBeUndefined();
	});

	test("should include body and duplex for POST", () => {
		const body = JSON.stringify({ test: true });
		const req = new Request("http://test.com", {
			method: "POST",
			body,
		});
		const headers = new Headers();
		const result = buildRelayRequest(req, headers) as RequestInit & {
			duplex?: string;
		};
		expect(result.body).toBeDefined();
		expect(result.duplex).toBe("half");
	});

	test("should include body for PUT", () => {
		const body = JSON.stringify({ update: true });
		const req = new Request("http://test.com", { method: "PUT", body });
		const headers = new Headers();
		const result = buildRelayRequest(req, headers);
		expect(result.body).toBeDefined();
	});

	test("should include body for PATCH", () => {
		const body = JSON.stringify({ patch: true });
		const req = new Request("http://test.com", { method: "PATCH", body });
		const headers = new Headers();
		const result = buildRelayRequest(req, headers);
		expect(result.body).toBeDefined();
	});

	test("should include body for DELETE", () => {
		const body = JSON.stringify({ delete: true });
		const req = new Request("http://test.com", { method: "DELETE", body });
		const headers = new Headers();
		const result = buildRelayRequest(req, headers);
		expect(result.body).toBeDefined();
	});

	test("should include AbortSignal with default timeout", () => {
		const req = new Request("http://test.com", { method: "GET" });
		const headers = new Headers();
		const result = buildRelayRequest(req, headers);
		expect(result.signal).toBeDefined();
		expect(result.signal).toBeInstanceOf(AbortSignal);
	});

	test("should use provided timeout", () => {
		const req = new Request("http://test.com", { method: "GET" });
		const headers = new Headers();
		const result = buildRelayRequest(req, headers, 5000);
		expect(result.signal).toBeDefined();
	});

	test("should handle lowercase method correctly", () => {
		const req = new Request("http://test.com", { method: "post", body: "data" });
		const headers = new Headers();
		const result = buildRelayRequest(req, headers) as RequestInit & {
			duplex?: string;
		};
		expect(result.method).toBe("POST");
		expect(result.body).toBeDefined();
		expect(result.duplex).toBe("half");
	});
});

// ─── ClassifyFetchError ────────────────────────────────────────────────────

describe("classifyFetchError", () => {
	test("should classify AbortError as TIMEOUT / 504", () => {
		const error = new DOMException("The operation was aborted", "AbortError");
		const result = classifyFetchError(error);
		expect(result.code).toBe("TIMEOUT");
		expect(result.status).toBe(504);
		expect(result.message).toBe("Upstream timed out");
	});

	test("should classify TimeoutError as TIMEOUT / 504", () => {
		const error = new DOMException("Timeout", "TimeoutError");
		const result = classifyFetchError(error);
		expect(result.code).toBe("TIMEOUT");
		expect(result.status).toBe(504);
	});

	test("should classify DNS resolution failures", () => {
		const error = new TypeError(
			"fetch failed: DNS resolution failed for host",
		);
		const result = classifyFetchError(error);
		expect(result.code).toBe("DNS_FAILURE");
		expect(result.status).toBe(502);
	});

	test("should classify ENOTFOUND as DNS failure", () => {
		const error = new TypeError("getaddrinfo ENOTFOUND example.com");
		const result = classifyFetchError(error);
		expect(result.code).toBe("DNS_FAILURE");
	});

	test("should classify hostname resolution failures", () => {
		const error = new TypeError("fetch failed: hostname not found");
		const result = classifyFetchError(error);
		expect(result.code).toBe("DNS_FAILURE");
	});

	test("should classify connection refused", () => {
		const error = new TypeError("fetch failed: connection refused");
		const result = classifyFetchError(error);
		expect(result.code).toBe("CONNECTION_REFUSED");
		expect(result.status).toBe(502);
	});

	test("should classify ECONNREFUSED", () => {
		const error = new TypeError(
			"connect ECONNREFUSED 127.0.0.1:8080",
		);
		const result = classifyFetchError(error);
		expect(result.code).toBe("CONNECTION_REFUSED");
	});

	test("should classify generic network errors", () => {
		const error = new TypeError("fetch failed: network error");
		const result = classifyFetchError(error);
		expect(result.code).toBe("NETWORK_ERROR");
		expect(result.status).toBe(502);
	});

	test("should classify ECONNRESET as network error", () => {
		const error = new TypeError("read ECONNRESET");
		const result = classifyFetchError(error);
		expect(result.code).toBe("NETWORK_ERROR");
	});

	test("should classify ECONNABORTED as network error", () => {
		const error = new TypeError("write ECONNABORTED");
		const result = classifyFetchError(error);
		expect(result.code).toBe("NETWORK_ERROR");
	});

	test("should classify ENETUNREACH as network error", () => {
		const error = new TypeError("connect ENETUNREACH 10.0.0.1:80");
		const result = classifyFetchError(error);
		expect(result.code).toBe("NETWORK_ERROR");
	});

	test("should pass through RelayError unchanged", () => {
		const relayError = new RelayError(
			"SSRF_BLOCKED",
			403,
			"Target is not allowed",
		);
		const result = classifyFetchError(relayError);
		expect(result.code).toBe("SSRF_BLOCKED");
		expect(result.status).toBe(403);
		expect(result.message).toBe("Target is not allowed");
	});

	test("should handle RelayError with TIMEOUT code", () => {
		const relayError = new RelayError("TIMEOUT", 504, "Custom timeout");
		const result = classifyFetchError(relayError);
		expect(result.code).toBe("TIMEOUT");
		expect(result.status).toBe(504);
	});

	test("should handle unknown Error objects", () => {
		const error = new Error("Something completely unexpected");
		const result = classifyFetchError(error);
		expect(result.code).toBe("NETWORK_ERROR");
		expect(result.status).toBe(502);
		expect(result.message).toBe("Upstream unreachable");
	});

	test("should handle non-Error thrown values", () => {
		const result = classifyFetchError("just a string");
		expect(result.code).toBe("NETWORK_ERROR");
		expect(result.status).toBe(502);
	});

	test("should handle null thrown value", () => {
		const result = classifyFetchError(null);
		expect(result.code).toBe("NETWORK_ERROR");
		expect(result.status).toBe(502);
	});

	test("should handle undefined thrown value", () => {
		const result = classifyFetchError(undefined);
		expect(result.code).toBe("NETWORK_ERROR");
		expect(result.status).toBe(502);
	});

	test("should handle generic TypeError that doesn't match known patterns", () => {
		const error = new TypeError("some random type error");
		const result = classifyFetchError(error);
		expect(result.code).toBe("NETWORK_ERROR");
		expect(result.status).toBe(502);
	});
});

// ─── CreateErrorResponse ───────────────────────────────────────────────────

describe("createErrorResponse", () => {
	test("should return correct status and JSON body", async () => {
		const result = createErrorResponse({
			code: "TIMEOUT",
			status: 504,
			message: "Upstream timed out",
		});
		expect(result.status).toBe(504);
		expect(result.headers.get("Content-Type")).toBe("application/json");
		const body = await result.json() as Record<string, unknown>;
		expect(body.error).toBe(true);
		expect(body.code).toBe("TIMEOUT");
		expect(body.message).toBe("Upstream timed out");
	});

	test("should include CORS headers in error response", async () => {
		const result = createErrorResponse({
			code: "SSRF_BLOCKED",
			status: 403,
			message: "Blocked",
		});
		expect(result.headers.get("Access-Control-Allow-Origin")).toBe("*");
	});

	test("should handle different error types", async () => {
		const result = createErrorResponse({
			code: "DNS_FAILURE",
			status: 502,
			message: "DNS resolution failed",
		});
		expect(result.status).toBe(502);
		const body = await result.json() as Record<string, unknown>;
		expect(body.code).toBe("DNS_FAILURE");
	});
});

// ─── CreateCorsPreflightResponse ───────────────────────────────────────────

describe("createCorsPreflightResponse", () => {
	test("should return 204 with CORS headers", () => {
		const result = createCorsPreflightResponse();
		expect(result.status).toBe(204);
		expect(result.headers.get("Access-Control-Allow-Origin")).toBe("*");
		expect(result.headers.get("Access-Control-Allow-Methods")).toBe(
			"GET, POST, PUT, DELETE, PATCH, OPTIONS",
		);
		expect(result.headers.get("Access-Control-Allow-Headers")).toBe("*");
		expect(result.headers.get("Access-Control-Max-Age")).toBe("86400");
	});

	test("should have no body", async () => {
		const result = createCorsPreflightResponse();
		const text = await result.text();
		expect(text).toBe("");
	});
});

// ─── CreateRelayResponse ───────────────────────────────────────────────────

describe("createRelayResponse", () => {
	test("should preserve status", async () => {
		const mockResponse = new Response("body", { status: 418 });
		const result = createRelayResponse(mockResponse);
		expect(result.status).toBe(418);
	});

	test("should preserve allowed headers", async () => {
		const mockResponse = new Response("body", {
			headers: { "x-custom": "value" },
		});
		const result = createRelayResponse(mockResponse);
		expect(result.headers.get("x-custom")).toBe("value");
	});

	test("should preserve body", async () => {
		const mockResponse = new Response("test body content");
		const result = createRelayResponse(mockResponse);
		expect(await result.text()).toBe("test body content");
	});

	test("should handle different status codes", async () => {
		const mockResponse = new Response(null, { status: 404 });
		const result = createRelayResponse(mockResponse);
		expect(result.status).toBe(404);
	});

	test("should handle 500 status", async () => {
		const mockResponse = new Response("error", { status: 500 });
		const result = createRelayResponse(mockResponse);
		expect(result.status).toBe(500);
	});

	test("should add CORS headers to relayed response", () => {
		const mockResponse = new Response("ok");
		const result = createRelayResponse(mockResponse);
		expect(result.headers.get("Access-Control-Allow-Origin")).toBe("*");
	});

	test("should strip blocked response headers", () => {
		const mockResponse = new Response("ok", {
			headers: {
				"set-cookie": "session=secret",
				"transfer-encoding": "chunked",
			},
		});
		const result = createRelayResponse(mockResponse);
		expect(result.headers.has("set-cookie")).toBe(false);
		expect(result.headers.has("transfer-encoding")).toBe(false);
	});
});

// ─── Integration: Full relay flow with mocked components ───────────────────

describe("integration: full relay flow", () => {
	test("complete flow with target URL construction", () => {
		const target = "https://httpbin.org";
		const relayPath = "/get";
		const targetUrl = normalizeTargetUrl(target, relayPath);

		expect(targetUrl).toBeInstanceOf(URL);
		expect(targetUrl!.href).toBe("https://httpbin.org/get");
	});

	test("SSRF protection blocks private targets", () => {
		const targetUrl = normalizeTargetUrl("http://localhost:8080", "/admin");
		expect(targetUrl).toBeInstanceOf(URL);
		expect(isAllowedTarget(targetUrl!)).toBe(false);
	});

	test("request header filtering strips sensitive headers", () => {
		const originalHeaders = new Headers({
			"x-relay-target": "https://example.com",
			"x-relay-path": "/api",
			host: "localhost",
			"x-custom": "preserved",
		});

		const filteredHeaders = filterRequestHeaders(originalHeaders);
		expect(filteredHeaders.get("x-relay-target")).toBeNull();
		expect(filteredHeaders.get("x-relay-path")).toBeNull();
		expect(filteredHeaders.get("host")).toBeNull();
		expect(filteredHeaders.get("x-custom")).toBe("preserved");
	});

	test("buildRelayRequest produces correct options for POST", () => {
		const req = new Request("http://test.com", {
			method: "POST",
			body: JSON.stringify({ data: "test" }),
			headers: { "content-type": "application/json" },
		});

		const options = buildRelayRequest(req, new Headers());
		expect(options.method).toBe("POST");
		expect(options.body).toBeDefined();
	});

	test("error case: missing target returns null", () => {
		const result = normalizeTargetUrl(null, "/test");
		expect(result).toBeNull();
	});

	test("error case: classifyFetchError and createErrorResponse work together", async () => {
		const error = new DOMException("timeout", "TimeoutError");
		const classified = classifyFetchError(error);
		const response = createErrorResponse(classified);
		expect(response.status).toBe(504);
		const body = await response.json() as Record<string, unknown>;
		expect(body.code).toBe("TIMEOUT");
		expect(body.error).toBe(true);
	});
});
