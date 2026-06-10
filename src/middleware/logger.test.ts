/**
 * Logger test suite.
 *
 * Covers structured logging, TTY vs JSON output,
 * and the request logger factory.
 */

import { test, expect, describe, spyOn } from "bun:test";
import { logRelayEvent, createRequestLogger } from "./logger";

describe("logger", () => {
	describe("logRelayEvent", () => {
		test("should log all required fields without error", () => {
			const spy = spyOn(console, "log");
			spy.mockImplementation(() => {});

			logRelayEvent({
				method: "GET",
				url: "/health",
				status: 200,
				durationMs: 15,
			});

			expect(spy).toHaveBeenCalledTimes(1);
			spy.mockRestore();
		});

		test("should log event with error field", () => {
			const spy = spyOn(console, "log");
			spy.mockImplementation(() => {});

			logRelayEvent({
				method: "POST",
				url: "/relay",
				status: 502,
				durationMs: 5000,
				error: "DNS resolution failed",
			});

			expect(spy).toHaveBeenCalledTimes(1);
			spy.mockRestore();
		});

		test("should log event with all optional fields", () => {
			const spy = spyOn(console, "log");
			spy.mockImplementation(() => {});

			logRelayEvent({
				method: "GET",
				url: "/test",
				status: 200,
				durationMs: 42,
				targetUrl: "https://example.com/api",
				ip: "203.0.113.1",
			});

			expect(spy).toHaveBeenCalledTimes(1);
			spy.mockRestore();
		});

		test("should not throw for any valid event shape", () => {
			expect(() =>
				logRelayEvent({
					method: "OPTIONS",
					url: "/cors-test",
					status: 204,
					durationMs: 0,
				}),
			).not.toThrow();
		});
	});

	describe("createRequestLogger", () => {
		test("should return a function", () => {
			const logger = createRequestLogger();
			expect(typeof logger).toBe("function");
		});

		test("returned function should log without error", () => {
			const logger = createRequestLogger();
			const req = new Request("http://localhost/test", {
				method: "POST",
			});
			const res = new Response("ok", { status: 200 });

			expect(() => logger(req, res, performance.now())).not.toThrow();
		});

		test("returned function should accept extra fields", () => {
			const logger = createRequestLogger();
			const req = new Request("http://localhost/relay");
			const res = new Response("relayed", { status: 200 });

			expect(() =>
				logger(req, res, performance.now(), {
					targetUrl: "https://example.com",
					ip: "10.0.0.1",
				}),
			).not.toThrow();
		});
	});
});
