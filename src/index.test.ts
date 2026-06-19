/**
 * Integration tests for the relay proxy server handlers.
 *
 * Tests the exported route handler functions directly,
 * bypassing the HTTP server layer.
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";

// Import handler functions directly from index.ts
// Note: this will also start the Bun.serve() instance, which we allow.
import {
	handleHealth,
	handleDocs,
	handleIndex,
	getClientIP,
} from "./index";

describe("handleHealth", () => {
	test("should return 200 with JSON body", async () => {
		const response = handleHealth();
		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe("application/json");
	});

	test("should include status, uptime, and version fields", async () => {
		const response = handleHealth();
		const body = await response.json() as Record<string, unknown>;
		expect(body.status).toBe("ok");
		expect(typeof body.uptime).toBe("number");
		expect(body.version).toBe("1.0.0");
	});

	test("should include CORS header", () => {
		const response = handleHealth();
		expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
	});
});

describe("handleDocs", () => {
	test("should return 200 with HTML content", () => {
		const response = handleDocs();
		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toContain("text/html");
	});

	test("should include Edge Proxy Relay in the HTML", async () => {
		const response = handleDocs();
		const text = await response.text();
		expect(text).toContain("Edge Proxy Relay");
		expect(text).toContain("x-relay-target");
		expect(text).toContain("WebSocket");
	});

	test("should include CORS header", () => {
		const response = handleDocs();
		expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
	});
});

describe("handleIndex", () => {
	test("should return 200 with HTML content", () => {
		const response = handleIndex();
		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toContain("text/html");
	});

	test("should include Edge Proxy Relay title", async () => {
		const response = handleIndex();
		const text = await response.text();
		expect(text).toContain("Edge Proxy Relay");
		expect(text).toContain("Server is running");
	});
});

describe("getClientIP", () => {
	const mockIpGetter = (address: string) => ({
		requestIP(_req: Request) {
			return { address, family: "IPv4" as const, port: 12345 };
		},
	});

	const nullIpGetter = {
		requestIP(_req: Request) {
			return null;
		},
	};

	test("should return x-forwarded-for when present", () => {
		const req = new Request("http://localhost/test", {
			headers: { "x-forwarded-for": "198.51.100.1" },
		});
		const ip = getClientIP(req, nullIpGetter);
		expect(ip).toBe("198.51.100.1");
	});

	test("should use first IP from x-forwarded-for list", () => {
		const req = new Request("http://localhost/test", {
			headers: {
				"x-forwarded-for": "198.51.100.1, 203.0.113.5, 192.0.2.10",
			},
		});
		const ip = getClientIP(req, nullIpGetter);
		expect(ip).toBe("198.51.100.1");
	});

	test("should fall back to cf-connecting-ip", () => {
		const req = new Request("http://localhost/test", {
			headers: { "cf-connecting-ip": "203.0.113.50" },
		});
		const ip = getClientIP(req, nullIpGetter);
		expect(ip).toBe("203.0.113.50");
	});

	test("should prefer x-forwarded-for over cf-connecting-ip", () => {
		const req = new Request("http://localhost/test", {
			headers: {
				"x-forwarded-for": "198.51.100.1",
				"cf-connecting-ip": "203.0.113.50",
			},
		});
		const ip = getClientIP(req, nullIpGetter);
		expect(ip).toBe("198.51.100.1");
	});

	test("should fall back to server.requestIP when no headers present", () => {
		const req = new Request("http://localhost/test");
		const ip = getClientIP(req, mockIpGetter("10.0.0.42"));
		expect(ip).toBe("10.0.0.42");
	});

	test("should return unknown when nothing is available", () => {
		const req = new Request("http://localhost/test");
		const ip = getClientIP(req, nullIpGetter);
		expect(ip).toBe("unknown");
	});
});
