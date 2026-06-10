# Edge Proxy Relay -- Pure Bun HTTP + WebSocket Relay

[![Bun](https://img.shields.io/badge/Bun-0.8+-000?logo=bun&logoColor=fff)](https://bun.sh)

A high-performance HTTP and WebSocket relay proxy built entirely with Bun's standard library. Zero framework dependencies. No Next.js, no Express, no React.

Accepts requests with an `x-relay-target` header and forwards them to the upstream target. Supports both HTTP relay and WebSocket relay in a single `Bun.serve()` instance.

---

## Quick Start

```bash
bun install
bun run dev       # development with HMR
bun start         # production
```

The server starts on `http://localhost:3000` by default.

---

| Provider | Endpoint |
|----------|----------|
| **Primary (Vercel)** | `https://proxy-bun.vercel.app` |
| **Secondary (CF Workers)** | `https://opennext-app.superaseph.workers.dev` |
| **Leapcell** | `https://proxy-bun-mytheclipse8647-orfq73fe.apn.leapcell.dev` |
| **Interactive Docs** | `https://proxy-bun.vercel.app/docs` |
## Environment Variables

---

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server listen port |
| `RELAY_TIMEOUT_MS` | `30000` | Upstream fetch timeout in milliseconds |
| `BODY_MAX_BYTES` | `1048576` | Maximum accepted request body size in bytes (1 MB) |
| `RATE_LIMIT_MAX` | `100` | Maximum requests per sliding window per client IP |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Sliding window duration in milliseconds (1 minute) |

---

## Endpoints

| Path | Method | Description |
|------|--------|-------------|
| `/` | GET | Status page (HTML) |
| `/health` | GET | Health check (JSON): `{ "status": "ok", "uptime": ..., "version": "1.0.0" }` |
| `/docs` | GET | Interactive documentation page (HTML) |
| `/*` | Any | HTTP relay (requires `x-relay-target`) |
| `/*` | GET | WebSocket relay (requires `x-relay-target` with `ws://` or `wss://`, `Upgrade: websocket`) |

### CORS Preflight

Any `OPTIONS` request to any path returns a `204 No Content` response with permissive CORS headers (`Access-Control-Allow-Origin: *`).

---

## HTTP Relay

Include the `x-relay-target` header to specify the upstream URL. The request method, body, headers, and query parameters are forwarded transparently.

### Required Headers

| Header | Required | Description |
|--------|----------|-------------|
| `x-relay-target` | Yes | Base URL of the upstream target (e.g. `https://api.openai.com`) |
| `x-relay-path` | No | Path to append to the target URL (default: `/`) |

### Examples

**Simple GET relay:**

```bash
curl -H "x-relay-target: https://jsonplaceholder.typicode.com/posts/1" \
     http://localhost:3000/
```

**POST with body and authorization:**

```bash
curl -X POST \
     -H "x-relay-target: https://api.openai.com" \
     -H "x-relay-path: /v1/chat/completions" \
     -H "Authorization: Bearer sk-..." \
     -H "Content-Type: application/json" \
     -d '{"model": "gpt-4", "messages": [{"role": "user", "content": "Hello"}]}' \
     http://localhost:3000/
```

**Binary upload (streaming):**

```bash
curl -X PUT \
     -H "x-relay-target: https://storage.example.com" \
     -H "x-relay-path: /upload/image.png" \
     --data-binary "@/path/to/image.png" \
     http://localhost:3000/
```

### Supported Methods

`GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS`. Response streaming (Server-Sent Events, large payloads) is supported natively.

---

## WebSocket Relay

Set `x-relay-target` to a `ws://` or `wss://` URL and the server upgrades the connection and relays bidirectionally.

### Node.js Client

```ts
import { WebSocket } from "ws";

const ws = new WebSocket("wss://your-proxy.example/relay", {
  headers: { "x-relay-target": "wss://echo-websocket.example" },
});

ws.on("open", () => ws.send("Hello via relay!"));
ws.on("message", (data) => console.log("Received:", data.toString()));
ws.on("error", (err) => console.error("WebSocket error:", err));
```

### Browser Client

```js
const ws = new WebSocket("wss://your-proxy.example/relay", {
  headers: { "x-relay-target": "wss://echo-websocket.example" },
});

ws.onopen = () => ws.send("Hello via relay!");
ws.onmessage = (event) => console.log("Received:", event.data);
ws.onerror = (err) => console.error("WebSocket error:", err);
```

### With Bun's Built-in WebSocket

```ts
const ws = new WebSocket(
  "wss://your-proxy.example/relay",
  { headers: { "x-relay-target": "wss://echo-websocket.example" } },
);

ws.onopen = () => ws.send("Hello via relay!");
ws.onmessage = (e) => console.log("Got:", e.data);
```

The relay handles text frames, binary frames (`Buffer`, `Uint8Array`, `ArrayBuffer`, `Blob`), and forwards close events with status codes.

---

## Architecture

```text
src/
├── index.ts                # Entry point: Bun.serve() with routing, WS relay,
│                           #   graceful shutdown, middleware orchestration
├── lib/
│   └── relay-utils.ts      # URL normalization, SSRF protection, header
│                           #   filtering, request/response building, error
│                           #   classification, CORS preflight
└── middleware/
    ├── index.ts            # Barrel exports
    ├── rate-limiter.ts     # In-memory sliding window rate limiter (per IP)
    ├── logger.ts           # Structured JSON logging with TTY colorization
    └── body-limiter.ts     # Content-Length validation against configurable max
```

### Request Flow

```
Client Request
    |
    v
Bun.serve() -- routes: /health, /docs, / --> static handlers
    |
    +--> OPTIONS? --> 204 CORS preflight response
    |
    +--> Upgrade: websocket + ws:// target? --> WebSocket relay (bidirectional)
    |
    +--> HTTP relay:
          1. Body size check (413 if exceeded)
          2. Rate limit check (429 if exceeded)
          3. Normalize target URL from x-relay-target header
          4. SSRF validation (403 if blocked)
          5. Filter request headers (strip relay, platform, hop-by-hop)
          6. Fetch upstream with timeout (504 on timeout, 502 on error)
          7. Filter response headers, attach CORS
          8. Return relayed response
```

### WebSocket Relay Flow

```
Client WebSocket              Bun.serve()            Upstream WebSocket
    |                              |                       |
    |-- upgrade req --------------->                       |
    |   (x-relay-target: wss://)    |                       |
    |                              |--- open upstream ---->|
    |                              |<-- onopen ------------|
    |<-- open (101 Switching) ------                       |
    |                              |                       |
    |-- send "hello" ------------->|                       |
    |                              |--- "hello" ---------->|
    |                              |<-- "echo" ------------|
    |<-- onmessage "echo" ---------                       |
    |                              |                       |
    |-- close -------------------->|                       |
    |                              |--- close upstream --->|
```

---

## Error Codes

| Status | Code | Meaning |
|--------|------|---------|
| 204 | -- | CORS preflight success (OPTIONS request) |
| 400 | `INVALID_TARGET` | Missing or malformed `x-relay-target` header |
| 403 | `SSRF_BLOCKED` | Target resolves to a private or internal IP range |
| 413 | `BODY_TOO_LARGE` | Request body `Content-Length` exceeds `BODY_MAX_BYTES` |
| 429 | `RATE_LIMITED` | Client IP has exceeded the rate limit |
| 502 | `DNS_FAILURE` | DNS resolution failed for the target hostname |
| 502 | `CONNECTION_REFUSED` | Upstream actively refused the connection |
| 502 | `NETWORK_ERROR` | Generic network error (connection reset, unreachable, etc.) |
| 504 | `TIMEOUT` | Upstream did not respond within `RELAY_TIMEOUT_MS` |

All error responses return JSON with `error`, `code`, and `message` fields, plus CORS headers.

---

## Security

### SSRF Protection

The proxy blocks requests to private and internal network ranges:

- IPv4 loopback (`127.x.x.x`), private ranges (`10.x.x.x`, `172.16-31.x.x`, `192.168.x.x`), link-local (`169.254.x.x`)
- IPv6 loopback (`::1`), link-local (`fe80::`), unique local (`fc00::`/`fd00::`)
- Common internal hostnames (`localhost`, `*.local`, `*.internal`, cloud metadata endpoints)

### Header Filtering

Before forwarding requests upstream, the proxy strips:

- Relay control headers (`x-relay-target`, `x-relay-path`, `host`)
- Hop-by-hop headers (`connection`, `transfer-encoding`, etc.)
- Platform metadata headers (Vercel `x-vercel-*`, Cloudflare `cf-*`, `x-forwarded-*`)
- Sensitive headers (`cookie`, `set-cookie`, `via`)

### Rate Limiting

In-memory sliding window rate limiter keyed by client IP (default: 100 requests per minute). The `Retry-After` header is set on 429 responses. A periodic cleanup routine prunes expired entries from memory.

### Body Size Limiting

Requests with a `Content-Length` exceeding `BODY_MAX_BYTES` (default 1 MB) are rejected with a 413 response. Requests without `Content-Length` (streaming) are passed through.

### Connection Timeout

All upstream fetches are bounded by `RELAY_TIMEOUT_MS` (default 30 seconds) using `AbortSignal.timeout()`. Timeouts are classified as 504 responses.

### Graceful Shutdown

The server listens for `SIGTERM` and `SIGINT`, stops accepting new connections, and exits cleanly.

---

## Deployment

Deploy as a standalone Bun process. No framework adapter required.

```bash
# Production
bun src/index.ts

# With environment overrides
PORT=8080 RELAY_TIMEOUT_MS=10000 bun src/index.ts
```

### Deployment Targets

- **Any VPS / VM**: Run as a systemd service or under a process manager (e.g., `pm2`, `supervisord`)
- **Railway / Fly.io / Render / Koyeb**: Set the build command to `bun install` and start command to `bun src/index.ts`
- **Docker**: Use the official `oven/bun` image

  ```dockerfile
  FROM oven/bun:latest
  WORKDIR /app
  COPY package.json bun.lock .
  RUN bun install
  COPY . .
  EXPOSE 3000
  CMD ["bun", "src/index.ts"]
  ```

---

## Development

```bash
# Install dependencies
bun install

# Start dev server with HMR
bun run dev

# Run tests
bun test

# Static analysis
bun run lint
```

---

## License

MIT
