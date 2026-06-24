/**
 * Consolidated router — single source of truth for all route handlers.
 *
 * Exports every shared handler that the 3 entry points (standalone Bun,
 * Vercel, Cloudflare Workers) need.
 *
 * Handles:
 *   - Health check  (GET /health)
 *   - Index page    (GET /)
 *   - API docs      (GET /docs)
 *   - Auth          (API_KEY check)
 *   - AI proxy      (OpenAI /v1/chat/completions, Anthropic /v1/messages, /v1/models)
 *   - Generic relay (x-relay-target)
 *   - WebSocket     (upgrade check)
 *   - SSRF DNS rebinding protection
 */

import {
	normalizeTargetUrl,
	isAllowedTarget,
	isAllowedTargetAsync,
	isSsrfDnsCheckEnabled,
	filterRequestHeaders,
	buildRelayRequest,
	createRelayResponse,
	classifyFetchError,
	createErrorResponse,
	createCorsPreflightResponse,
	getCorsHeaders,
} from "./relay-utils";

import { checkBodySize } from "../middleware/body-limiter";
import { createRateLimiter } from "../middleware/rate-limiter";
import { logRelayEvent } from "../middleware/logger";
import { ProxyPool, SessionProxyPool } from "./proxy-pool";
import { handleChatCompletion, listModels } from "./ai-proxy";
import { handleAnthropicMessages } from "./anthropic-proxy";
import { fetchWithRetry } from "./fetch-utils";

// --- Types -------------------------------------------------------------------

export interface RouterEnv {
	PORT?: string;
	RELAY_TIMEOUT_MS?: string;
	BODY_MAX_BYTES?: string;
	RATE_LIMIT_MAX?: string;
	RATE_LIMIT_WINDOW_MS?: string;
	CORS_ORIGIN?: string;
	NODE_ENV?: string;
	API_KEY?: string;
	PROXY_LIST?: string;
	KV?: {
		get(key: string): Promise<any>;
		put(key: string, value: any, options?: { expirationTtl?: number }): Promise<void>;
	};
}

// --- Globals (module-scoped singletons) --------------------------------------

let rateLimiter: ReturnType<typeof createRateLimiter> | null = null;
let proxyPool: ProxyPool | null = null;
let sessionPool: SessionProxyPool | null = null;

const SERVER_START_TIME = Date.now();
const RELAY_VERSION = "1.0.0";

// --- Helpers -----------------------------------------------------------------

function getNumericEnv(
	env: RouterEnv,
	key: keyof RouterEnv,
	fallback: number,
): number {
	const raw = env[key];
	const val =
		typeof raw === "string"
			? raw
			: typeof process !== "undefined"
				? process.env[key as string]
				: undefined;
	return Number.parseInt(val ?? String(fallback), 10);
}

function getEnv(
	env: RouterEnv,
	key: keyof RouterEnv,
	fallback: string,
): string {
	const raw = env[key];
	const fromEnv =
		typeof raw === "string"
			? raw
			: typeof process !== "undefined"
				? process.env[key as string]
				: undefined;
	return fromEnv ?? fallback;
}

/** Determine if an error is a JSON parse failure. */
function isJsonParseError(err: unknown): boolean {
	return err instanceof Error && (err.name === "SyntaxError" || err.message.includes("JSON"));
}

// --- Init --------------------------------------------------------------------

function initGlobals(env: RouterEnv) {
	if (!rateLimiter) {
		const kvAdapter = env.KV
			? {
					get: async (k: string) => {
						const val = await env.KV!.get(k);
						return val ? JSON.parse(val) : null;
					},
					set: async (k: string, v: number[], ttl?: number) => {
						await env.KV!.put(k, JSON.stringify(v), { expirationTtl: ttl });
					},
				}
			: undefined;

		rateLimiter = createRateLimiter({
			maxRequests: getNumericEnv(env, "RATE_LIMIT_MAX", 100),
			windowMs: getNumericEnv(env, "RATE_LIMIT_WINDOW_MS", 60000),
			kv: kvAdapter,
		});
	}

	if (!proxyPool) {
		proxyPool = new ProxyPool();
		const proxies = getEnv(env, "PROXY_LIST", "");
		if (proxies) {
			for (const p of proxies.split(",")) {
				const pt = p.trim();
				if (pt) proxyPool.addProxy(pt);
			}
		}
		sessionPool = new SessionProxyPool(proxyPool);
		sessionPool.setFailureThreshold(3);
	}
}

// --- Auth --------------------------------------------------------------------

function requireAuth(req: Request, env?: RouterEnv): Response | null {
	const API_KEY = env
		? getEnv(env, "API_KEY", "")
		: (process.env.API_KEY ?? "");
	if (!API_KEY) return null; // auth disabled

	const header =
		req.headers.get("authorization") ??
		req.headers.get("x-api-key") ??
		"";
	const key = header.replace(/^Bearer\s+/i, "").trim();
	if (key === API_KEY) return null;

	return new Response(
		JSON.stringify({ error: { message: "Unauthorized", type: "auth_error" } }),
		{
			status: 401,
			headers: { "Content-Type": "application/json", ...getCorsHeaders() },
		},
	);
}

// --- IP Detection ------------------------------------------------------------

function getClientIP(req: Request): string {
	const forwarded = req.headers.get("x-forwarded-for");
	if (forwarded) {
		const first = forwarded.split(",")[0]?.trim();
		if (first) return first;
	}
	const cfIp = req.headers.get("cf-connecting-ip");
	if (cfIp) return cfIp;
	return "unknown";
}

function getClientIPFromServer(
	req: Request,
	ipGetter: { requestIP(req: Request): { address: string } | null },
): string {
	const forwarded = req.headers.get("x-forwarded-for");
	if (forwarded) {
		const first = forwarded.split(",")[0]?.trim();
		if (first) return first;
	}
	const cfIp = req.headers.get("cf-connecting-ip");
	if (cfIp) return cfIp;
	const remote = ipGetter.requestIP(req);
	if (remote) return remote.address;
	return "unknown";
}

// --- Static Handlers ---------------------------------------------------------

function handleHealth(): Response {
	return new Response(
		JSON.stringify({
			status: "ok",
			uptime: Date.now() - SERVER_START_TIME,
			version: RELAY_VERSION,
		}),
		{
			status: 200,
			headers: { "Content-Type": "application/json", ...getCorsHeaders() },
		},
	);
}

function handleIndex(): Response {
	const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Edge Proxy Relay</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, sans-serif; line-height: 1.6; color: #e1e4e8; background: #0d1117; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    main { text-align: center; }
    h1 { font-size: 2rem; color: #58a6ff; margin-bottom: 0.5rem; }
    p { color: #8b949e; }
    a { color: #58a6ff; }
    .status { color: #3fb950; }
  </style>
</head>
<body>
<main>
  <h1>Edge Proxy Relay</h1>
  <p class="status">Server is running</p>
  <p><a href="/health">/health</a> &middot; <a href="/docs">/docs</a></p>
</main>
</body>
</html>`;

	return new Response(html, {
		status: 200,
		headers: { "Content-Type": "text/html; charset=utf-8" },
	});
}

function handleDocs(_isWebSocketSupported: boolean): Response {
	const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Edge Proxy — API Test</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #0d1117; color: #e1e4e8; padding: 1.5rem; }
    main { max-width: 960px; margin: 0 auto; }
    h1 { font-size: 1.5rem; color: #58a6ff; margin-bottom: 0.25rem; }
    .sub { color: #8b949e; margin-bottom: 1.5rem; font-size: 0.9rem; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; margin-bottom: 1rem; overflow: hidden; }
    .card-header { padding: 0.75rem 1rem; background: #1c2128; border-bottom: 1px solid #30363d; font-weight: 600; cursor: pointer; display: flex; align-items: center; gap: 0.5rem; user-select: none; }
    .card-header:hover { background: #21262d; }
    .card-header .method { font-size: 0.7rem; padding: 1px 6px; border-radius: 3px; font-weight: 600; text-transform: uppercase; }
    .get { background: #1f6feb33; color: #58a6ff; }
    .post { background: #23863633; color: #3fb950; }
    .card-body { padding: 1rem; display: none; }
    .card.open .card-body { display: block; }
    .card-header .arrow { margin-left: auto; transition: transform .15s; }
    .card.open .arrow { transform: rotate(90deg); }
    label { display: block; font-size: 0.8rem; color: #8b949e; margin-bottom: 0.25rem; }
    input, textarea, select { width: 100%; background: #0d1117; border: 1px solid #30363d; border-radius: 4px; color: #e1e4e8; padding: 0.5rem 0.75rem; font-family: inherit; font-size: 0.9rem; margin-bottom: 0.75rem; }
    input:focus, textarea:focus { border-color: #58a6ff; outline: none; }
    textarea { min-height: 60px; resize: vertical; font-family: 'SF Mono', 'Cascadia Code', monospace; font-size: 0.8rem; }
    textarea.code { min-height: 120px; }
    .row { display: flex; gap: 0.75rem; }
    .row > * { flex: 1; }
    .btn { background: #238636; color: #fff; border: none; border-radius: 6px; padding: 0.5rem 1.25rem; font-size: 0.85rem; cursor: pointer; font-weight: 500; }
    .btn:hover { background: #2ea043; }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .output { background: #0d1117; border: 1px solid #30363d; border-radius: 4px; padding: 0.75rem; margin-top: 0.5rem; }
    .output pre { font-family: 'SF Mono', 'Cascadia Code', monospace; font-size: 0.78rem; white-space: pre-wrap; word-break: break-all; max-height: 300px; overflow: auto; color: #c9d1d9; }
    .output .meta { font-size: 0.75rem; color: #8b949e; margin-bottom: 0.5rem; }
    .output .meta .status.ok { color: #3fb950; }
    .output .meta .status.err { color: #f85149; }
    .toast { position: fixed; bottom: 1.5rem; right: 1.5rem; background: #1c2128; border: 1px solid #30363d; border-radius: 6px; padding: 0.75rem 1rem; font-size: 0.85rem; display: none; z-index: 100; }
  </style>
</head>
<body>
<main>
  <h1>Edge Proxy Relay — Interactive Test</h1>
  <p class="sub">Test all endpoints from the browser. Open a card, fill in the fields, and run.</p>

  <div class="card open">
    <div class="card-header">
      <span class="method get">AUTH</span> API Key
      <span class="arrow">▶</span>
    </div>
    <div class="card-body">
      <label>API Key</label>
      <div class="row">
        <input type="text" id="apiKey" value="" />
        <input type="text" id="baseUrl" value="" placeholder="(same origin)" />
      </div>
    </div>
  </div>

  <div class="card open">
    <div class="card-header" onclick="toggleCard(this)">
      <span class="method get">GET</span> /health
      <span class="arrow">▶</span>
    </div>
    <div class="card-body">
      <button class="btn" onclick="callHealth()">Ping Health</button>
      <div id="output-health" class="output" style="display:none"><pre></pre></div>
    </div>
  </div>

  <div class="card open">
    <div class="card-header" onclick="toggleCard(this)">
      <span class="method get">GET</span> /v1/models
      <span class="arrow">▶</span>
    </div>
    <div class="card-body">
      <button class="btn" onclick="callModels()">List Models</button>
      <div id="output-models" class="output" style="display:none"><pre></pre></div>
    </div>
  </div>

  <div class="card">
    <div class="card-header" onclick="toggleCard(this)">
      <span class="method post">POST</span> /v1/chat/completions
      <span class="arrow">▶</span>
    </div>
    <div class="card-body">
      <div class="row">
        <div><label>Model</label><input type="text" id="chatModel" value="deepseek-v4-flash-free" /></div>
        <div><label>Max Tokens</label><input type="number" id="chatMaxTokens" value="128" /></div>
      </div>
      <label>Messages (JSON array)</label>
      <textarea id="chatMessages" class="code">[{"role":"user","content":"Say hello in one word"}]</textarea>
      <label><input type="checkbox" id="chatStream" /> Stream (SSE)</label>
      <div style="margin-top:0.5rem"><button class="btn" onclick="callChat()">Send</button></div>
      <div id="output-chat" class="output" style="display:none"><pre></pre></div>
    </div>
  </div>

  <div class="card">
    <div class="card-header" onclick="toggleCard(this)">
      <span class="method post">POST</span> /v1/messages (Anthropic)
      <span class="arrow">▶</span>
    </div>
    <div class="card-body">
      <div class="row">
        <div><label>Model</label><input type="text" id="anthModel" value="deepseek-v4-flash-free" /></div>
        <div><label>Max Tokens</label><input type="number" id="anthMaxTokens" value="256" /></div>
      </div>
      <label>System Prompt (optional, with cache_control)</label>
      <textarea id="anthSystem" class="code" placeholder='[{"type":"text","text":"You are helpful.","cache_control":{"type":"ephemeral"}}]'></textarea>
      <label>Messages (JSON)</label>
      <textarea id="anthMessages" class="code">[{"role":"user","content":[{"type":"text","text":"Say hello in one word","cache_control":{"type":"ephemeral"}}]}]</textarea>
      <label><input type="checkbox" id="anthStream" /> Stream (SSE)</label>
      <div style="margin-top:0.5rem"><button class="btn" onclick="callAnthropic()">Send</button></div>
      <div id="output-anth" class="output" style="display:none"><pre></pre></div>
    </div>
  </div>

  <div class="card">
    <div class="card-header" onclick="toggleCard(this)">
      <span class="method post">RELAY</span> Generic HTTP Relay
      <span class="arrow">▶</span>
    </div>
    <div class="card-body">
      <label>Relay Target URL</label>
      <input type="text" id="relayTarget" value="https://api.ipify.org/?format=json" />
      <div class="row">
        <div><label>Relay Path</label><input type="text" id="relayPath" value="/" /></div>
        <div><label>Method</label><select id="relayMethod"><option>GET</option><option>POST</option></select></div>
      </div>
      <label>Body (JSON, optional)</label>
      <textarea id="relayBody" class="code" placeholder='{"test":true}'></textarea>
      <div style="margin-top:0.5rem"><button class="btn" onclick="callRelay()">Send</button></div>
      <div id="output-relay" class="output" style="display:none"><pre></pre></div>
    </div>
  </div>

  <div id="toast" class="toast"></div>
</main>

<script>
function apiBase() { return document.getElementById('baseUrl').value || ''; }
function authHeaders() {
  const k = document.getElementById('apiKey').value;
  if (!k) return { 'Content-Type': 'application/json' };
  return { 'Authorization': 'Bearer ' + k, 'Content-Type': 'application/json' };
}
function toggleCard(h) { h.parentElement.classList.toggle('open'); }
let toastTimer;
function showToast(msg, ok) {
  const el = document.getElementById('toast');
  el.textContent = (ok ? '✓ ' : '✗ ') + msg;
  el.style.display = 'block';
  el.style.borderColor = ok ? '#3fb950' : '#f85149';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.style.display = 'none', 3000);
}
async function apiFetch(method, path, body) {
  const resp = await fetch((apiBase() || '') + path, { method, headers: authHeaders(), body: body ? JSON.stringify(body) : undefined });
  const text = await resp.text();
  try { var data = JSON.parse(text); } catch { data = text; }
  return { resp, data };
}
function showOutput(id, resp, data) {
  const el = document.getElementById('output-' + id);
  el.style.display = 'block';
  const ok = resp.status >= 200 && resp.status < 300;
  el.innerHTML = '<div class="meta"><span class="status ' + (ok ? 'ok' : 'err') + '">' + resp.status + ' ' + resp.statusText + '</span></div><pre>' + esc(typeof data === 'string' ? data : JSON.stringify(data, null, 2)).slice(0, 10000) + '</pre>';
  showToast(resp.status + ' ' + resp.statusText, ok);
}
function streamOutput(id, chunk) {
  const el = document.getElementById('output-' + id);
  el.style.display = 'block';
  let pre = el.querySelector('pre');
  if (!pre) { el.innerHTML = '<div class="meta">streaming…</div><pre></pre>'; pre = el.querySelector('pre'); }
  pre.textContent += chunk;
  pre.scrollTop = pre.scrollHeight;
}
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

async function callHealth() { try { var r = await apiFetch('GET','/health'); showOutput('health',r.resp,r.data); } catch(e) { showOutput('health',{status:0,statusText:'Error'},e.message); showToast(e.message,0); } }
async function callModels() { try { var r = await apiFetch('GET','/v1/models'); showOutput('models',r.resp,r.data); } catch(e) { showOutput('models',{status:0,statusText:'Error'},e.message); showToast(e.message,0); } }
async function callChat() {
  const stream = document.getElementById('chatStream').checked;
  try { var messages = JSON.parse(document.getElementById('chatMessages').value); } catch { showToast('Invalid messages JSON',0); return; }
  const body = { model: document.getElementById('chatModel').value || 'deepseek-v4-flash-free', messages, stream, max_tokens: parseInt(document.getElementById('chatMaxTokens').value) || 128 };
  try {
    if (stream) { var el = document.getElementById('output-chat'); el.style.display = 'block'; el.innerHTML = '<div class="meta">streaming…</div><pre></pre>';
      var resp = await fetch((apiBase()||'') + '/v1/chat/completions', { method: 'POST', headers: authHeaders(), body: JSON.stringify(body) });
      if (!resp.ok) { showOutput('chat',resp,await resp.text()); return; }
      var reader = resp.body.getReader(), decoder = new TextDecoder(), done;
      while (!done) { var v = await reader.read(); done = v.done; if (v.value) streamOutput('chat', decoder.decode(v.value)); }
      showToast('stream complete',1);
    } else { var r = await apiFetch('POST','/v1/chat/completions', body); showOutput('chat',r.resp,r.data); }
  } catch(e) { showOutput('chat',{status:0,statusText:'Error'},e.message); showToast(e.message,0); }
}
async function callAnthropic() {
  const stream = document.getElementById('anthStream').checked;
  try { var messages = JSON.parse(document.getElementById('anthMessages').value); } catch { showToast('Invalid messages JSON',0); return; }
  const body = { model: document.getElementById('anthModel').value || 'deepseek-v4-flash-free', max_tokens: parseInt(document.getElementById('anthMaxTokens').value) || 256, messages, stream };
  const sys = document.getElementById('anthSystem').value.trim();
  if (sys) { try { body.system = JSON.parse(sys); } catch { body.system = sys; } }
  try {
    if (stream) { var el = document.getElementById('output-anth'); el.style.display = 'block'; el.innerHTML = '<div class="meta">streaming…</div><pre></pre>';
      var resp = await fetch((apiBase()||'') + '/v1/messages', { method: 'POST', headers: authHeaders(), body: JSON.stringify(body) });
      if (!resp.ok) { showOutput('anth',resp,await resp.text()); return; }
      var reader = resp.body.getReader(), decoder = new TextDecoder(), done;
      while (!done) { var v = await reader.read(); done = v.done; if (v.value) streamOutput('anth', decoder.decode(v.value)); }
      showToast('stream complete',1);
    } else { var r = await apiFetch('POST','/v1/messages', body); showOutput('anth',r.resp,r.data); }
  } catch(e) { showOutput('anth',{status:0,statusText:'Error'},e.message); showToast(e.message,0); }
}
async function callRelay() {
  const target = document.getElementById('relayTarget').value;
  const path = document.getElementById('relayPath').value || '/';
  const method = document.getElementById('relayMethod').value;
  const rawBody = document.getElementById('relayBody').value;
  try {
    var resp = await fetch((apiBase()||'') + '/', { method, headers: { 'x-relay-target': target, 'x-relay-path': path, ...(rawBody ? {'Content-Type':'application/json'} : {}) }, body: rawBody || undefined });
    var text = await resp.text();
    try { var data = JSON.parse(text); } catch { data = text; }
    showOutput('relay', resp, data);
  } catch(e) { showOutput('relay',{status:0,statusText:'Error'},e.message); showToast(e.message,0); }
}
</script>
</body>
</html>`;

	return new Response(html, {
		status: 200,
		headers: { "Content-Type": "text/html; charset=utf-8", ...getCorsHeaders() },
	});
}

// --- Middleware pipeline helpers ---------------------------------------------

/**
 * Validate and normalize the relay target from headers.
 * Returns the target URL on success, or an error Response.
 */
async function validateRelayTarget(
	target: string | null,
	relayPath: string,
	method: string,
	requestUrl: string,
	clientIP: string,
	startTime: number,
): Promise<{ ok: true; targetUrl: string } | Response> {
	const targetUrl = normalizeTargetUrl(target, relayPath);
	if (!targetUrl) {
		logRelayEvent({ method, url: requestUrl, status: 400, durationMs: Math.round(performance.now() - startTime), error: "missing_target_header", ip: clientIP });
		return createErrorResponse({ code: "INVALID_TARGET", status: 400, message: "Missing or invalid x-relay-target header" });
	}
	if (!isAllowedTarget(targetUrl)) {
		logRelayEvent({ method, url: requestUrl, status: 403, durationMs: Math.round(performance.now() - startTime), error: "target_not_allowed", ip: clientIP });
		return createErrorResponse({ code: "SSRF_BLOCKED", status: 403, message: "Target domain not allowed" });
	}

	if (isSsrfDnsCheckEnabled()) {
		const asyncAllowed = await isAllowedTargetAsync(targetUrl);
		if (!asyncAllowed) {
			logRelayEvent({ method, url: requestUrl, status: 403, durationMs: Math.round(performance.now() - startTime), error: "ssrf_dns_rebinding", ip: clientIP });
			return createErrorResponse({ code: "SSRF_BLOCKED", status: 403, message: "Target resolves to private/internal IP" });
		}
	}

	return { ok: true, targetUrl: targetUrl.toString() };
}

/** Log and return a relay result. */
function finalizeRelay(
	response: Response,
	method: string,
	requestUrl: string,
	startTime: number,
	targetUrlString: string,
	clientIP: string,
): Response {
	logRelayEvent({ method, url: requestUrl, status: response.status, durationMs: Math.round(performance.now() - startTime), targetUrl: targetUrlString, ip: clientIP });
	return response;
}

/** Build a JSON error Response for invalid request body. Returns both OpenAI and Anthropic formats. */
function createJsonErrorResponse(err: unknown): Response {
	const isJsonError = isJsonParseError(err);
	if (isJsonError) {
		return new Response(
			JSON.stringify({ error: { message: "Invalid JSON body", type: "invalid_request_error" } }),
			{ status: 400, headers: { "Content-Type": "application/json", ...getCorsHeaders() } },
		);
	}
	return new Response(
		JSON.stringify({ error: { message: err instanceof Error ? err.message : "Internal Server Error", type: "server_error" } }),
		{ status: 500, headers: { "Content-Type": "application/json", ...getCorsHeaders() } },
	);
}

function createAnthropicJsonErrorResponse(err: unknown): Response {
	const isJsonError = isJsonParseError(err);
	if (isJsonError) {
		return new Response(
			JSON.stringify({ type: "error", error: { message: "Invalid JSON body", type: "invalid_request_error" } }),
			{ status: 400, headers: { "Content-Type": "application/json", ...getCorsHeaders() } },
		);
	}
	return new Response(
		JSON.stringify({ type: "error", error: { message: err instanceof Error ? err.message : "Internal Server Error", type: "server_error" } }),
		{ status: 500, headers: { "Content-Type": "application/json", ...getCorsHeaders() } },
	);
}

// --- Generic HTTP Relay (with proxy pool) ------------------------------------

async function handleRelay(
	req: Request,
	env: RouterEnv,
	clientIP: string,
	extra?: { ipv6Source?: string; skipProxyPool?: boolean },
): Promise<Response> {
	const startTime = performance.now();
	const method = req.method;
	const requestUrl = req.url;

	const RELAY_TIMEOUT_MS = getNumericEnv(env, "RELAY_TIMEOUT_MS", 30000);

	if (method === "OPTIONS") return createCorsPreflightResponse();

	// Body size check
	const bodyError = checkBodySize(req);
	if (bodyError) {
		return finalizeRelay(bodyError, method, requestUrl, startTime, "", clientIP);
	}

	// Rate limiting
	const rateCheck = await rateLimiter!.checkAsync(clientIP);
	if (!rateCheck.allowed) {
		return finalizeRelay(
			new Response(
				JSON.stringify({ error: true, code: "RATE_LIMITED", message: "Too many requests", retryAfterMs: rateCheck.retryAfterMs }),
				{
					status: 429,
					headers: { "Content-Type": "application/json", ...getCorsHeaders(), "Retry-After": String(Math.ceil((rateCheck.retryAfterMs ?? 60_000) / 1000)) },
				},
			),
			method, requestUrl, startTime, "", clientIP,
		);
	}

	// Target validation
	const target = req.headers.get("x-relay-target");
	const relayPath = req.headers.get("x-relay-path") ?? "/";
	const validated = await validateRelayTarget(target, relayPath, method, requestUrl, clientIP, startTime);
	if (validated instanceof Response) return validated;
	const targetUrlString = validated.targetUrl;

	// Build and execute
	const filteredHeaders = filterRequestHeaders(req.headers);
	const fetchOptions = buildRelayRequest(req, filteredHeaders, RELAY_TIMEOUT_MS) as RequestInit & { proxy?: string };

	const result = await fetchWithRetry(
		targetUrlString, fetchOptions,
		extra?.skipProxyPool ? undefined : proxyPool!,
		"relay", extra?.ipv6Source,
	);

	if (result.errorClassification) {
		return finalizeRelay(
			createErrorResponse(result.errorClassification),
			method, requestUrl, startTime, targetUrlString, clientIP,
		);
	}

	return finalizeRelay(
		createRelayResponse(result.response!),
		method, requestUrl, startTime, targetUrlString, clientIP,
	);
}

// --- Generic HTTP Relay (plain fetch) ----------------------------------------

async function handleRelayPlain(
	req: Request,
	env: RouterEnv,
	clientIP: string,
): Promise<Response> {
	const startTime = performance.now();
	const method = req.method;
	const requestUrl = req.url;
	const RELAY_TIMEOUT_MS = getNumericEnv(env, "RELAY_TIMEOUT_MS", 30000);

	if (method === "OPTIONS") return createCorsPreflightResponse();

	const bodyError = checkBodySize(req);
	if (bodyError) return finalizeRelay(bodyError, method, requestUrl, startTime, "", clientIP);

	const rateCheck = await rateLimiter!.checkAsync(clientIP);
	if (!rateCheck.allowed) {
		return finalizeRelay(
			new Response(
				JSON.stringify({ error: true, code: "RATE_LIMITED", message: "Too many requests", retryAfterMs: rateCheck.retryAfterMs }),
				{ status: 429, headers: { "Content-Type": "application/json", ...getCorsHeaders(), "Retry-After": String(Math.ceil((rateCheck.retryAfterMs ?? 60_000) / 1000)) } },
			),
			method, requestUrl, startTime, "", clientIP,
		);
	}

	const target = req.headers.get("x-relay-target");
	const relayPath = req.headers.get("x-relay-path") ?? "/";
	const validated = await validateRelayTarget(target, relayPath, method, requestUrl, clientIP, startTime);
	if (validated instanceof Response) return validated;
	const targetUrlString = validated.targetUrl;

	const filteredHeaders = filterRequestHeaders(req.headers);
	const fetchOptions = buildRelayRequest(req, filteredHeaders, RELAY_TIMEOUT_MS);

	let response: Response;
	try {
		response = await fetch(targetUrlString, fetchOptions);
	} catch (err) {
		return finalizeRelay(
			createErrorResponse(classifyFetchError(err)),
			method, requestUrl, startTime, targetUrlString, clientIP,
		);
	}

	return finalizeRelay(
		createRelayResponse(response),
		method, requestUrl, startTime, targetUrlString, clientIP,
	);
}

// --- Main Router -------------------------------------------------------------

export interface RouterOptions {
	isWebSocketSupported?: boolean;
	getTestApiHtml?: () => string | Promise<string>;
	skipProxyPool?: boolean;
	ipv6Source?: string;
}

async function handleRequest(
	req: Request,
	env: RouterEnv,
	clientIP: string,
	options: RouterOptions = {},
): Promise<Response | undefined> {
	initGlobals(env);
	const url = new URL(req.url);

	// Static routes
	if (url.pathname === "/health") return handleHealth();
	if (url.pathname === "/docs") return handleDocs(options.isWebSocketSupported ?? false);
	if (url.pathname === "/test" && options.getTestApiHtml) {
		const html = await options.getTestApiHtml();
		return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
	}
	if (url.pathname === "/" && req.method === "GET" && !req.headers.get("x-relay-target")) return handleIndex();

	// AI proxy — OpenAI-compatible
	if (url.pathname === "/v1/chat/completions") {
		if (req.method === "OPTIONS") return createCorsPreflightResponse();
		if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
		const authErr = requireAuth(req, env);
		if (authErr) return authErr;
		try {
			const body = await req.json();
			return await handleChatCompletion(body, proxyPool ?? undefined, sessionPool ?? undefined, crypto.randomUUID(), options.ipv6Source);
		} catch (err) {
			return createJsonErrorResponse(err);
		}
	}

	// AI proxy — Anthropic-compatible
	if (url.pathname === "/v1/messages") {
		if (req.method === "OPTIONS") return createCorsPreflightResponse();
		if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
		const authErr = requireAuth(req, env);
		if (authErr) return authErr;
		try {
			const body = await req.json();
			const anthropicVersion = req.headers.get("anthropic-version") ?? undefined;
			return await handleAnthropicMessages(body, proxyPool ?? undefined, sessionPool ?? undefined, crypto.randomUUID(), options.ipv6Source, anthropicVersion);
		} catch (err) {
			return createAnthropicJsonErrorResponse(err);
		}
	}

	// Model list
	if (url.pathname === "/v1/models" && req.method === "GET") {
		const authErr = requireAuth(req, env);
		if (authErr) return authErr;
		const models = listModels().map((id) => ({
			id, object: "model", created: Math.floor(Date.now() / 1000),
			owned_by: "edge-proxy", features: ["prompt_caching"],
		}));
		return new Response(JSON.stringify({ object: "list", data: models }), {
			status: 200,
			headers: { "Content-Type": "application/json", ...getCorsHeaders() },
		});
	}

	// WebSocket upgrade check
	if (req.method === "GET" && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
		if (!options.isWebSocketSupported) {
			return new Response(
				JSON.stringify({ error: true, code: "UNSUPPORTED", message: "WebSocket relay is not supported on this deployment" }),
				{ status: 400, headers: { "Content-Type": "application/json", ...getCorsHeaders() } },
			);
		}
		return undefined;
	}

	// Generic HTTP relay
	return handleRelay(req, env, clientIP, {
		ipv6Source: options.ipv6Source,
		skipProxyPool: options.skipProxyPool,
	});
}

// --- Proxy pool accessor -----------------------------------------------------

function getSharedProxyPool(): ProxyPool {
	if (!proxyPool) {
		proxyPool = new ProxyPool();
		sessionPool = new SessionProxyPool(proxyPool);
		sessionPool.setFailureThreshold(3);
	}
	return proxyPool;
}

// --- Exports -----------------------------------------------------------------

export {
	handleHealth,
	handleIndex,
	handleRelay,
	handleRelayPlain,
	handleRequest,
	requireAuth,
	getClientIP,
	getClientIPFromServer,
	getSharedProxyPool,
};
