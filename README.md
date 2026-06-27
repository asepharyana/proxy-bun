# Edge Proxy Relay — Pure Bun HTTP + WebSocket + AI Proxy

[![Bun](https://img.shields.io/badge/Bun-1.0+-000?logo=bun&logoColor=fff)](https://bun.sh)
[![Tests](https://img.shields.io/badge/tests-274%20pass-brightgreen)](#testing)
[![Zero Deps](https://img.shields.io/badge/runtime%20deps-0-blue)](#)

A high-performance **HTTP relay**, **WebSocket relay**, and **multi-provider AI proxy** built entirely with Bun's standard library. Zero framework dependencies — no Next.js, no Express, no React, no Vercel Edge Runtime.

Three roles in one Bun process:

1. **HTTP / WebSocket relay** — forwards requests using the `x-relay-target` header
2. **AI proxy (OpenAI format)** — accepts `/v1/chat/completions`, routes to configured backends
3. **AI proxy (Anthropic format)** — accepts `/v1/messages`, translates to backend format, returns Anthropic-shaped responses

---

## Quick Start

```bash
bun install
bun run dev       # development with HMR
bun start         # production
```

The server starts on `http://localhost:3000` by default.

| Provider | Endpoint |
|----------|----------|
| **Primary (Vercel)** | `https://proxy-bun.vercel.app` |
| **Secondary (CF Workers)** | `https://cfproxy.asepharyana.my.id/` |
| **Interactive Docs / Test UI** | `https://proxy-bun.vercel.app/docs` |

---

## Endpoints

| Path | Method | Description |
|------|--------|-------------|
| `/` | GET | Status page (HTML) |
| `/health` | GET | Health check JSON: `{ "status": "ok", "uptime": ..., "version": "1.0.0" }` |
| `/docs`, `/test` | GET | Interactive test UI (HTML) — OpenAI + Anthropic playgrounds |
| `/v1/chat/completions` | POST | **OpenAI-compatible chat completions** (routed by `model` field) |
| `/v1/messages` | POST | **Anthropic-compatible messages** (translated to backend format) |
| `/v1/models` | GET | List all available model names (JSON) |
| `/*` | Any | **HTTP relay** (requires `x-relay-target` header) |
| `/*` | GET (Upgrade) | **WebSocket relay** (requires `x-relay-target` with `ws://`/`wss://`) |

### CORS Preflight

Any `OPTIONS` request to any path returns `204 No Content` with permissive CORS headers (`Access-Control-Allow-Origin: *`). Set `CORS_ORIGIN` to restrict.

---

## AI Proxy — Available Models

The proxy routes requests to multiple backends based on the `model` field. All backends are OpenAI-compatible except where noted.

| Model | Backend | Notes |
|-------|---------|-------|
| `deepseek-v4-flash-free` | opencode.ai | Free tier, OpenAI-compatible |
| `minimax-m3` | llm.kimchi.dev (CastAI) | Default Kimchi model |
| `minimax-m2.7` | llm.kimchi.dev (CastAI) | |
| `kimi-k2.7` | llm.kimchi.dev (CastAI) | |
| `kimi-k2.6` | llm.kimchi.dev (CastAI) | |
| `nemotron-3-ultra-fp4` | llm.kimchi.dev (CastAI) | |

Both `/v1/chat/completions` and `/v1/messages` accept any of these model names. The Anthropic handler translates the request into the backend's OpenAI format, then translates the response back to Anthropic format (tool_use blocks, content_block_delta events, usage metadata, etc.).

### Streaming (SSE)

Both endpoints support `stream: true`. Streaming responses are passed through to the client without buffering (default), preserving the upstream's event timing. Set `STREAM_PASSTHROUGH=false` to fall back to per-chunk transformation.

### DeepSeek Tool Calls (DSML)

DeepSeek models return tool calls embedded as markup (`<tool_calls><invoke name="...">...`). The proxy detects this markup and converts it into standard `tool_calls` (OpenAI format) or `tool_use` content blocks (Anthropic format). DSML detection is **enabled by default** for `deepseek,*` and `codestral,*` models only — for all other models the per-chunk scanning is skipped.

### Response Cache

Non-streaming responses are cached for 5 minutes (default) to reduce upstream bandwidth and latency on repeated identical requests. Cache keys are hash-derived from `(model, sorted messages, stream flag)`. Cache is process-local (in-memory Map with LRU eviction).

---

## HTTP Relay

Include the `x-relay-target` header to specify the upstream URL. Method, body, headers, and query parameters are forwarded transparently.

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

`GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS`. Response streaming (SSE, large payloads) is supported natively.

---

## WebSocket Relay

Set `x-relay-target` to a `ws://` or `wss://` URL and the server upgrades the connection and relays bidirectionally.

```ts
const ws = new WebSocket("wss://your-proxy.example/relay", {
  headers: { "x-relay-target": "wss://echo-websocket.example" },
});

ws.onopen = () => ws.send("Hello via relay!");
ws.onmessage = (e) => console.log("Got:", e.data);
```

The relay handles text frames, binary frames (`Buffer`, `Uint8Array`, `ArrayBuffer`, `Blob`), and forwards close events with status codes. Client backpressure is monitored via `drain()` — when buffered bytes exceed 512 KB, upstream forwarding is paused until the consumer drains back below 64 KB.

---

## Environment Variables

### Server

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server listen port |
| `HOST` | `0.0.0.0` | Bind address |
| `NODE_ENV` / `BUN_ENV` | — | Set to `development` to enable HMR + verbose console |

### Request Limits

| Variable | Default | Description |
|----------|---------|-------------|
| `BODY_MAX_BYTES` | `1048576` | Max request body size in bytes (1 MB) |
| `RATE_LIMIT_MAX` | `100` | Max requests per sliding window per client IP |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Sliding window duration in ms (1 minute) |

### Relay Behavior

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_RETRIES` | `1` | Max retry attempts (direct first, then proxy fallback if pool loaded) |
| `PROXY_FILE` / `PROXY_LIST` | `./proxy.txt` | Proxy pool source — file path or comma-separated `host:port:user:pass` list |
| `SSRF_DNS_CHECK` | `false` | When `true`, resolve target DNS at relay time to block rebinding attacks (adds latency) |
| `CORS_ORIGIN` | `*` | Restrict CORS to this origin |

### AI Proxy

| Variable | Default | Description |
|----------|---------|-------------|
| `API_KEY` | _(empty)_ | If set, all requests must include matching `Authorization: Bearer <key>` or `x-api-key: <key>` header |
| `CACHE_TTL` | `300000` | Response cache TTL in ms (set `0` to disable cache) |
| `CACHE_MAX_SIZE` | `500` | Max entries in the LRU cache before eviction |
| `CACHE_MODELS` | _(all)_ | Comma-separated model prefixes to cache (e.g. `deepseek,minimax,kimi`) |
| `DSML_DETECTION` | `true` | Global toggle for DeepSeek markup detection on streaming chunks |
| `DSML_MODELS` | `deepseek,codestral` | Comma-separated model prefixes that emit DSML markup |
| `STREAM_PASSTHROUGH` | `true` | Pass SSE streams through unchanged (vs per-chunk transform) |

---

## Architecture

```text
src/
├── index.ts                  # Entry point: Bun.serve() with routing, WS relay,
│                             #   graceful shutdown, proxy pool loading
├── lib/
│   ├── router.ts             # Consolidated route dispatcher — health, docs,
│   │                         #   AI proxy, generic relay, auth, IP detection
│   ├── relay-utils.ts        # URL normalization, SSRF protection, header
│   │                         #   filtering, error classification, CORS
│   ├── ai-proxy.ts           # OpenAI /v1/chat/completions handler + MODEL_ROUTES
│   ├── anthropic-proxy.ts    # Anthropic /v1/messages handler + translation layer
│   ├── dsml-parser.ts        # DeepSeek markup → tool_calls/tool_use converter
│   ├── response-cache.ts     # LRU response cache + cache-key builder
│   ├── fetch-utils.ts        # Retry, SSE line buffer, error sanitization,
│   │                         #   stream cleanup wrapper, shared encoder
│   ├── proxy-pool.ts         # Auto-rotating proxy pool + session-sticky allocation
│   └── mimo-auth.ts          # JWT acquisition/invalidation for mimo-free backend
└── middleware/
    ├── index.ts              # Barrel exports
    ├── rate-limiter.ts       # In-memory sliding window rate limiter (per IP)
    ├── logger.ts             # Structured JSON logging with TTY colorization
    └── body-limiter.ts       # Content-Length validation against configurable max
```

### Request Flow — AI Proxy (OpenAI)

```
Client → POST /v1/chat/completions { model, messages, stream? }
  │
  ├─→ Auth check (if API_KEY set) → 401 if missing/invalid
  ├─→ Rate limit (per-IP sliding window) → 429 if exceeded
  ├─→ Body size check → 413 if exceeded
  ├─→ Validate request shape → 400 if invalid
  ├─→ Resolve model in MODEL_ROUTES → 400 if unknown
  ├─→ Cache lookup (if non-streaming + model on allowlist) → hit returns immediately
  ├─→ Build backend request (inject JWT for mimo-free, API key for castai)
  ├─→ Fetch with session/proxy retry (MAX_RETRIES, exponential backoff 50→500ms)
  │     ├─ Direct connection
  │     └─ Proxy fallback (if pool loaded) with least-loaded assignment
  ├─→ Handle error responses → classify (401, 429, 502, 504)
  ├─→ If streaming + native SSE content-type:
  │     ├─ STREAM_PASSTHROUGH=true  → byte-passthrough (zero transform overhead)
  │     └─ STREAM_PASSTHROUGH=false → transformStream (per-chunk SSE rewrite)
  │         └─ For DSML models only: parse text deltas for tool markup
  ├─→ If non-streaming:
  │     ├─ adaptResponse for backend-specific unwrapping (opencode.ai double-nesting)
  │     └─ Store in cache
  └─→ Return JSON (or SSE stream) to client
```

### Request Flow — Anthropic ↔ OpenAI Translation

```
Client → POST /v1/messages { model, messages, max_tokens, system, tools? }
  │
  ├─→ Same auth + rate limit + body checks
  ├─→ Anthropic → backend translation:
  │     ├─ Convert Anthropic content blocks → OpenAI messages
  │     ├─ Preserve cache_control hints on text blocks
  │     ├─ Convert tool_use blocks → OpenAI tool_calls
  │     └─ Convert tool_result blocks → OpenAI tool role messages
  ├─→ Fetch backend (same retry + proxy logic)
  ├─→ Backend response → Anthropic translation:
  │     ├─ JSON path: backendToAnthropicResponse (content blocks, usage, stop_reason)
  │     └─ SSE path: transformAnthropicStream (per-chunk event mapping)
  │         ├─ OpenAI chunk → content_block_start/delta/stop events
  │         ├─ Detect reasoning_content → emit as thinking blocks
  │         ├─ For DSML models only: accumulate text, parse, emit tool_use
  │         └─ Emit message_start/message_delta/message_stop lifecycle events
  └─→ Return Anthropic-shaped response (or SSE stream) to client
```

### Request Flow — Generic HTTP/WS Relay

```
Client → /* with x-relay-target header
  │
  ├─→ Same auth + rate limit + body checks
  ├─→ Normalize target URL (validate scheme, host)
  ├─→ SSRF validation (block private/loopback/link-local ranges)
  │     └─ If SSRF_DNS_CHECK=true: resolve DNS at relay time
  ├─→ Filter request headers (strip relay control, hop-by-hop, platform metadata)
  ├─→ Fetch upstream (timeout via AbortSignal.timeout(RELAY_TIMEOUT_MS))
  ├─→ Filter response headers, attach CORS
  └─→ Return response
```

WebSocket relay follows the same SSRF + header rules, with bidirectional pipe between client and upstream WebSocket plus backpressure monitoring.

---

## Error Codes

| Status | Code | Meaning |
|--------|------|---------|
| 204 | — | CORS preflight success (OPTIONS request) |
| 400 | `INVALID_TARGET` | Missing or malformed `x-relay-target` header |
| 400 | `INVALID_REQUEST` | Malformed AI proxy request body |
| 401 | `UNAUTHORIZED` | Missing or invalid API key (when `API_KEY` is configured) |
| 403 | `SSRF_BLOCKED` | Target resolves to a private or internal IP range |
| 413 | `BODY_TOO_LARGE` | Request body `Content-Length` exceeds `BODY_MAX_BYTES` |
| 429 | `RATE_LIMITED` | Client IP has exceeded the rate limit |
| 429 | `UPSTREAM_RATE_LIMITED` | Backend returned 429 (proxy rotated, marked cooldown) |
| 502 | `DNS_FAILURE` | DNS resolution failed for the target hostname |
| 502 | `CONNECTION_REFUSED` | Upstream actively refused the connection |
| 502 | `NETWORK_ERROR` | Generic network error (connection reset, unreachable, etc.) |
| 504 | `TIMEOUT` | Upstream did not respond within the configured timeout |

All error responses return JSON with `error`, `code`, and `message` fields, plus CORS headers.

---

## Security

### SSRF Protection

The proxy blocks requests to private and internal network ranges:

- IPv4 loopback (`127.x.x.x`), private ranges (`10.x.x.x`, `172.16-31.x.x`, `192.168.x.x`), link-local (`169.254.x.x`)
- IPv6 loopback (`::1`), link-local (`fe80::`), unique local (`fc00::`/`fd00::`)
- Common internal hostnames (`localhost`, `*.local`, `*.internal`, cloud metadata endpoints)

When `SSRF_DNS_CHECK=true`, the proxy resolves the target hostname at relay time and verifies the resolved IP is not in a blocked range (prevents DNS rebinding attacks — adds latency proportional to upstream DNS).

### Header Filtering

Before forwarding requests upstream, the proxy strips:

- Relay control headers (`x-relay-target`, `x-relay-path`, `host`)
- Hop-by-hop headers (`connection`, `transfer-encoding`, etc.)
- Platform metadata headers (Vercel `x-vercel-*`, Cloudflare `cf-*`, `x-forwarded-*`)
- Sensitive headers (`cookie`, `set-cookie`, `via`)

### Auth (API_KEY)

When `API_KEY` is set, every request must include a matching `Authorization: Bearer <key>` or `x-api-key: <key>` header. Missing or mismatched keys return `401 UNAUTHORIZED`.

### Rate Limiting

In-memory sliding window rate limiter keyed by client IP (default: 100 requests per minute). The `Retry-After` header is set on 429 responses. A periodic cleanup routine prunes expired entries; when the keyspace exceeds 10k entries, the oldest is evicted.

### Body Size Limiting

Requests with a `Content-Length` exceeding `BODY_MAX_BYTES` (default 1 MB) are rejected with a 413 response. Requests without `Content-Length` (streaming) are passed through.

### Graceful Shutdown

The server listens for `SIGTERM` and `SIGINT`. On shutdown it cancels all tracked active stream readers (awaiting upstream cancellation), then calls `server.stop()` and exits cleanly.

---

## Performance Notes

The codebase includes two rounds of performance optimization on top of the architectural baseline:

1. **5-bottleneck pass** (PR #5): response cache (LRU O(1), 5-min TTL), reduced retry default (1 vs `pool.size+1`), generic stream passthrough (trust `content-type` not provider name), DSML detection toggle (skip per-chunk scan for non-DeepSeek models).
2. **7-hot-path pass** (PR #6): cache key short-circuit via `shouldCacheModel()` check + WeakMap memoization for stable JSON stringify, manual `indexOf` instead of regex greedy in SSE text extraction, bounded cooldowns LRU (`MAX_COOLDOWNS=10k`), single `JSON.stringify` (cache + Response), shared `TextEncoder` singleton, branch DSML early in `transformAnthropicStream`, idempotent `safeReleaseReader` guard.

Cumulative estimated savings: ~5–15 ms per non-cached request + ~30–150 ms per streaming response + bounded memory under high 429 churn.

---

## Deployment

Deploy as a standalone Bun process. No framework adapter required.

```bash
# Production
bun src/index.ts

# With environment overrides
PORT=8080 CACHE_TTL=600000 bun src/index.ts
```

### Deployment Targets

- **Any VPS / VM**: Run as a systemd service or under a process manager (`pm2`, `supervisord`)
- **Railway / Fly.io / Render / Koyeb**: Build command `bun install`, start command `bun src/index.ts`
- **Docker**:

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
# Install dependencies (Bun auto-loads .env, no dotenv needed)
bun install

# Start dev server with HMR
bun run dev

# Run tests
bun test

# Watch tests
bun run test:watch

# Type check
bun run typecheck

# Production build (single binary)
bun run build
```

### Testing

`bun test` runs 274 tests across 9 files (AI proxy, DSML parser, rate limiter, body limiter, logger, relay utils, router, Anthropic proxy, integration). Tests cover SSRF blocking, header filtering, DSML parsing, retry logic, cache eviction, rate limit windowing, proxy rotation, and WebSocket handshake.

---

## License

MIT
