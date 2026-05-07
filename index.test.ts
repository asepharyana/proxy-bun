import { test, expect, describe } from "bun:test";
import {
  normalizeTargetUrl,
  stripRelayHeaders,
  shouldSendBody,
  buildRelayRequest,
  createRelayResponse,
} from "./relay-utils";

describe("normalizeTargetUrl", () => {
  test("returns null when target is null", () => {
    expect(normalizeTargetUrl(null, "/")).toBeNull();
  });

  test("returns null when target is empty string", () => {
    expect(normalizeTargetUrl("", "/")).toBeNull();
  });

  test("removes trailing slash from target", () => {
    expect(normalizeTargetUrl("https://httpbin.org/", "/get")).toBe("https://httpbin.org/get");
  });

  test("keeps target without trailing slash", () => {
    expect(normalizeTargetUrl("https://httpbin.org", "/get")).toBe("https://httpbin.org/get");
  });

  test("appends relay path", () => {
    expect(normalizeTargetUrl("https://example.com", "/api/users")).toBe("https://example.com/api/users");
  });

  test("handles nested paths", () => {
    expect(normalizeTargetUrl("https://api.example.com", "/v1/users/123/profile")).toBe(
      "https://api.example.com/v1/users/123/profile"
    );
  });
});

describe("stripRelayHeaders", () => {
  test("removes x-relay-target header", () => {
    const headers = new Headers({ "x-relay-target": "https://test.com" });
    const stripped = stripRelayHeaders(headers);
    expect(stripped.get("x-relay-target")).toBeNull();
  });

  test("removes x-relay-path header", () => {
    const headers = new Headers({ "x-relay-path": "/test" });
    const stripped = stripRelayHeaders(headers);
    expect(stripped.get("x-relay-path")).toBeNull();
  });

  test("removes host header", () => {
    const headers = new Headers({ host: "localhost:3000" });
    const stripped = stripRelayHeaders(headers);
    expect(stripped.get("host")).toBeNull();
  });

  test("preserves other headers", () => {
    const headers = new Headers({
      "x-relay-target": "https://test.com",
      "x-custom-header": "value",
      authorization: "Bearer token",
    });
    const stripped = stripRelayHeaders(headers);
    expect(stripped.get("x-custom-header")).toBe("value");
    expect(stripped.get("authorization")).toBe("Bearer token");
  });

  test("handles multiple relay headers", () => {
    const headers = new Headers({
      "x-relay-target": "https://test.com",
      "x-relay-path": "/path",
      host: "test.com",
      "content-type": "application/json",
    });
    const stripped = stripRelayHeaders(headers);
    expect(stripped.get("content-type")).toBe("application/json");
    expect(stripped.get("x-relay-target")).toBeNull();
    expect(stripped.get("x-relay-path")).toBeNull();
    expect(stripped.get("host")).toBeNull();
  });
});

describe("shouldSendBody", () => {
  test("returns false for GET", () => {
    expect(shouldSendBody("GET")).toBe(false);
  });

  test("returns false for HEAD", () => {
    expect(shouldSendBody("HEAD")).toBe(false);
  });

  test("returns true for POST", () => {
    expect(shouldSendBody("POST")).toBe(true);
  });

  test("returns true for PUT", () => {
    expect(shouldSendBody("PUT")).toBe(true);
  });

  test("returns true for PATCH", () => {
    expect(shouldSendBody("PATCH")).toBe(true);
  });

  test("returns true for DELETE", () => {
    expect(shouldSendBody("DELETE")).toBe(true);
  });

  test("is case-sensitive", () => {
    expect(shouldSendBody("get")).toBe(true);
    expect(shouldSendBody("post")).toBe(true);
  });
});

describe("buildRelayRequest", () => {
  test("sets correct method", () => {
    const req = new Request("http://test.com", { method: "POST" });
    const headers = new Headers();
    const result = buildRelayRequest(req, "https://test.com", headers);
    expect(result.method).toBe("POST");
  });

  test("sets headers", () => {
    const req = new Request("http://test.com");
    const headers = new Headers({ "x-custom": "value" });
    const result = buildRelayRequest(req, "https://test.com", headers);
    expect(result.headers).toBe(headers);
  });

  test("omits body for GET", () => {
    const req = new Request("http://test.com", { method: "GET" });
    const headers = new Headers();
    const result = buildRelayRequest(req, "https://test.com", headers);
    expect(result.body).toBeUndefined();
  });

  test("omits body for HEAD", () => {
    const req = new Request("http://test.com", { method: "HEAD" });
    const headers = new Headers();
    const result = buildRelayRequest(req, "https://test.com", headers);
    expect(result.body).toBeUndefined();
  });

  test("includes body for POST", () => {
    const body = JSON.stringify({ test: true });
    const req = new Request("http://test.com", { method: "POST", body });
    const headers = new Headers();
    const result = buildRelayRequest(req, "https://test.com", headers);
    expect(result.body).toBeDefined();
    expect(result.duplex).toBe("half");
  });

  test("includes body for PUT", () => {
    const body = JSON.stringify({ update: true });
    const req = new Request("http://test.com", { method: "PUT", body });
    const headers = new Headers();
    const result = buildRelayRequest(req, "https://test.com", headers);
    expect(result.body).toBeDefined();
  });

  test("includes body for PATCH", () => {
    const body = JSON.stringify({ patch: true });
    const req = new Request("http://test.com", { method: "PATCH", body });
    const headers = new Headers();
    const result = buildRelayRequest(req, "https://test.com", headers);
    expect(result.body).toBeDefined();
  });

  test("includes body for DELETE", () => {
    const body = JSON.stringify({ delete: true });
    const req = new Request("http://test.com", { method: "DELETE", body });
    const headers = new Headers();
    const result = buildRelayRequest(req, "https://test.com", headers);
    expect(result.body).toBeDefined();
  });
});

describe("createRelayResponse", () => {
  test("preserves status", async () => {
    const mockResponse = new Response("body", { status: 418 });
    const result = createRelayResponse(mockResponse);
    expect(result.status).toBe(418);
  });

  test("preserves headers", async () => {
    const mockResponse = new Response("body", {
      headers: { "x-custom": "value" },
    });
    const result = createRelayResponse(mockResponse);
    expect(result.headers.get("x-custom")).toBe("value");
  });

  test("preserves body", async () => {
    const mockResponse = new Response("test body content");
    const result = createRelayResponse(mockResponse);
    expect(await result.text()).toBe("test body content");
  });

  test("handles different status codes", async () => {
    const mockResponse = new Response(null, { status: 404 });
    const result = createRelayResponse(mockResponse);
    expect(result.status).toBe(404);
  });

  test("handles 500 status", async () => {
    const mockResponse = new Response("error", { status: 500 });
    const result = createRelayResponse(mockResponse);
    expect(result.status).toBe(500);
  });
});

describe("integration: full relay flow", () => {
  test("complete flow with mocked fetch", async () => {
    const target = "https://httpbin.org";
    const relayPath = "/get";
    const targetUrl = normalizeTargetUrl(target, relayPath);

    expect(targetUrl).toBe("https://httpbin.org/get");

    const originalHeaders = new Headers({
      "x-relay-target": target,
      "x-relay-path": relayPath,
      host: "localhost",
      "x-custom": "preserved",
    });

    const strippedHeaders = stripRelayHeaders(originalHeaders);
    expect(strippedHeaders.get("x-relay-target")).toBeNull();
    expect(strippedHeaders.get("x-relay-path")).toBeNull();
    expect(strippedHeaders.get("host")).toBeNull();
    expect(strippedHeaders.get("x-custom")).toBe("preserved");
  });

  test("POST flow with body preservation", () => {
    const req = new Request("http://test.com", {
      method: "POST",
      body: JSON.stringify({ data: "test" }),
      headers: { "content-type": "application/json" },
    });

    const options = buildRelayRequest(req, "https://api.test.com/endpoint", new Headers());
    expect(options.method).toBe("POST");
    expect(options.body).toBeDefined();
  });

  test("error case: missing target", () => {
    const target = null;
    const relayPath = "/test";
    const result = normalizeTargetUrl(target, relayPath);
    expect(result).toBeNull();
  });
});
