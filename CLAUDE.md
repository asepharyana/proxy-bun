# Edge Proxy Relay

A pure Bun HTTP and WebSocket relay proxy using `Bun.serve()`. No Next.js, no Express, no React, no Vercel Edge Runtime. Single entry point at `src/index.ts` -- deploys as a standalone Bun process.

Key architecture facts:
- Entry point: `src/index.ts` (was `src/app/route.ts` in the previous Next.js version)
- Middleware stack: rate limiter, body limiter, structured logger, SSRF protection
- WebSocket relay: bidirectional relay via `x-relay-target` header with `ws://` or `wss://`
- Error classification: DNS errors -> 502, timeouts -> 504, SSRF blocks -> 403, rate limits -> 429
- IPv6 support: dual-stack listen + outbound source rotation via `Bun.spawn` + `curl --interface`
- The old Next.js `src/app/route.ts` still exists as a legacy file but is no longer the active entry point

## IPv6 Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `HOST` | `::` | Bind address. Use `::` for dual-stack (IPv4+IPv6) |
| `IPV6_SOURCES` | _(empty)_ | Comma-separated IPv6 source addresses for outbound rotation |

### Setup

1. Add IPv6 addresses to your interface:
```bash
ip -6 addr add 2001:df4:c140:1f::d6/128 dev eth0
ip -6 addr add 2001:df4:c140:1f:ffff:ffff:ffff:ffff/128 dev eth0
```

2. Configure the proxy with IPv6 source rotation:
```bash
IPV6_SOURCES=2001:df4:c140:1f::d6,2001:df4:c140:1f:ffff:ffff:ffff:ffff bun run src/index.ts
```

### How It Works

- **Listen**: Server binds to `::` (all IPv6 interfaces) with `ipv6Only: false` (dual-stack)
- **Outbound**: When `IPV6_SOURCES` is configured, each outbound request rotates through the source addresses using `curl --interface <ipv6>`
- **Failover**: Failed source addresses are automatically disabled after 3 consecutive failures

### Source: `src/lib/ipv6-pool.ts`

```typescript
import { IPv6SourcePool } from "./lib/ipv6-pool";

const pool = new IPv6SourcePool();
pool.loadFromEnv(); // reads IPV6_SOURCES

const source = pool.getNext(); // round-robin
pool.markSuccess(source);      // reset failure count
pool.markFailed(source);       // increment failure count
```

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.

<!-- code-review-graph MCP tools -->
## MCP Tools: code-review-graph

**IMPORTANT: This project has a knowledge graph. ALWAYS use the
code-review-graph MCP tools BEFORE using Grep/Glob/Read to explore
the codebase.** The graph is faster, cheaper (fewer tokens), and gives
you structural context (callers, dependents, test coverage) that file
scanning cannot.

### When to use graph tools FIRST

- **Exploring code**: `semantic_search_nodes` or `query_graph` instead of Grep
- **Understanding impact**: `get_impact_radius` instead of manually tracing imports
- **Code review**: `detect_changes` + `get_review_context` instead of reading entire files
- **Finding relationships**: `query_graph` with callers_of/callees_of/imports_of/tests_for
- **Architecture questions**: `get_architecture_overview` + `list_communities`

Fall back to Grep/Glob/Read **only** when the graph doesn't cover what you need.

### Key Tools

| Tool | Use when |
|------|----------|
| `detect_changes` | Reviewing code changes — gives risk-scored analysis |
| `get_review_context` | Need source snippets for review — token-efficient |
| `get_impact_radius` | Understanding blast radius of a change |
| `get_affected_flows` | Finding which execution paths are impacted |
| `query_graph` | Tracing callers, callees, imports, tests, dependencies |
| `semantic_search_nodes` | Finding functions/classes by name or keyword |
| `get_architecture_overview` | Understanding high-level codebase structure |
| `refactor_tool` | Planning renames, finding dead code |

### Workflow

1. The graph auto-updates on file changes (via hooks).
2. Use `detect_changes` for code review.
3. Use `get_affected_flows` to understand impact.
4. Use `query_graph` pattern="tests_for" to check coverage.
