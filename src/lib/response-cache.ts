/**
 * LRU Response Cache with TTL.
 *
 * Designed for LLM proxy responses — reduces bandwidth and upstream
 * round-trips for repeated prompts (common during development, retries,
 * or shared prefixes).
 *
 * Strategy:
 *   - LRU eviction via Map insertion order (O(1) reorder on access)
 *   - Configurable TTL per entry (default 300s — balances freshness vs hit rate)
 *   - Cache key = hash of (model + sorted messages + stream flag)
 *   - Non-streaming responses are cached; streaming not cached (would need
 *     full body buffering)
 *   - Model allowlist via CACHE_MODELS envvar (comma-separated prefixes)
 *   - Basic hit/miss stats exported for observability
 *
 * Performance: Uses Map.delete+set instead of a hand-rolled linked list,
 * giving O(1) reorder on access vs O(n) scan in the previous implementation.
 */

// ─── Cache entry ──────────────────────────────────────────────────────────

interface CacheEntry {
  body: string;
  status: number;
  headers: Record<string, string>;
  createdAt: number;
  expiresAt: number;
}

// ─── Cache stats ──────────────────────────────────────────────────────────

export interface CacheStats {
  hits: number;
  misses: number;
  size: number;
  maxSize: number;
  hitRate: number;
}

// ─── ResponseCache class ──────────────────────────────────────────────────

export class ResponseCache {
  /** Map preserves insertion order — used as LRU ordering */
  private readonly map = new Map<string, CacheEntry>();
  private readonly maxSize: number;
  private readonly defaultTtlMs: number;
  private readonly modelAllowlist: RegExp[];
  private hits = 0;
  private misses = 0;

  constructor(opts?: {
    maxSize?: number;
    defaultTtlMs?: number;
    modelAllowlist?: RegExp[];
  }) {
    this.maxSize = opts?.maxSize ?? 500;
    this.defaultTtlMs = opts?.defaultTtlMs ?? 300_000; // 300 seconds (5 min)
    this.modelAllowlist = opts?.modelAllowlist ?? [];
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /** Build a deterministic cache key from an LLM request. */
  static buildKey(model: string, messages: unknown, stream: boolean): string {
    const stable = JSON.stringify(messages, stableStringifyReplacer);
    const raw = `${model}|${stream}|${stable}`;
    return simpleHash(raw);
  }

  /** Check if this model should be cached. */
  shouldCacheModel(model: string): boolean {
    if (this.modelAllowlist.length === 0) return true;
    return this.modelAllowlist.some((re) => re.test(model));
  }

  /** Retrieve a cached response. Returns null if missing or expired. */
  get(
    key: string,
  ): { body: string; status: number; headers: Record<string, string> } | null {
    if (!this.map.has(key)) {
      this.misses++;
      return null;
    }

    const entry = this.map.get(key)!;

    // Expired — evict and return null
    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      this.misses++;
      return null;
    }

    // Move to end (most recently used) — O(1) in Map
    this.map.delete(key);
    this.map.set(key, entry);
    this.hits++;
    return { body: entry.body, status: entry.status, headers: entry.headers };
  }

  /** Store a response in the cache. */
  set(
    key: string,
    body: string,
    status: number,
    headers: Record<string, string>,
    ttlMs?: number,
  ): void {
    // Enforce max size before inserting
    if (this.map.size >= this.maxSize) {
      this.evictLRU();
    }

    const now = Date.now();
    const ttl = ttlMs ?? this.defaultTtlMs;

    const entry: CacheEntry = {
      body,
      status,
      headers,
      createdAt: now,
      expiresAt: now + ttl,
    };

    // Set as most recently used (last in iteration order)
    this.map.delete(key);
    this.map.set(key, entry);
  }

  /** Delete a specific key. */
  delete(key: string): void {
    this.map.delete(key);
  }

  /** Clear all entries. */
  clear(): void {
    this.map.clear();
    this.hits = 0;
    this.misses = 0;
  }

  /** Current number of entries. */
  get size(): number {
    return this.map.size;
  }

  /** Sweep expired entries. Call periodically if desired. */
  sweep(): number {
    const now = Date.now();
    let removed = 0;
    for (const [key, entry] of this.map) {
      if (now > entry.expiresAt) {
        this.map.delete(key);
        removed++;
      }
    }
    return removed;
  }

  /** Return hit/miss stats and reset counters. */
  stats(): CacheStats {
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      size: this.map.size,
      maxSize: this.maxSize,
      hitRate: total > 0 ? this.hits / total : 0,
    };
  }

  /** Reset hit/miss counters. */
  resetStats(): void {
    this.hits = 0;
    this.misses = 0;
  }

  // ── Internals ───────────────────────────────────────────────────────────

  /** Evict the least recently used entry (first in insertion order). */
  private evictLRU(): void {
    const lruKey = this.map.keys().next().value;
    if (lruKey !== undefined) {
      this.map.delete(lruKey);
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * JSON.stringify replacer that sorts object keys for stable hashing.
 */
function stableStringifyReplacer(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) {
      sorted[k] = (value as Record<string, unknown>)[k];
    }
    return sorted;
  }
  return value;
}

/**
 * Simple, fast non-cryptographic hash (djb2 variant).
 * Collisions are theoretically possible but extremely unlikely for
 * cache-key use — a collision would serve a wrong cached response,
 * which is bounded by TTL.
 */
function simpleHash(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) & 0xffffffff;
  }
  return hash.toString(36);
}

// ─── Module-level singleton (lazy) ────────────────────────────────────────

let _instance: ResponseCache | null = null;

/**
 * Get or create the shared ResponseCache instance.
 * Configured via environment variables:
 *   CACHE_TTL       — TTL in ms (0 = disabled, default 300000 = 5 min)
 *   CACHE_MAX_SIZE  — max entries (default 500)
 *   CACHE_MODELS    — comma-separated model prefixes to cache
 *                     (e.g. "deepseek,minimax,kimi" — empty = cache all)
 */
export function getResponseCache(): ResponseCache | null {
  const ttl = Number(process.env.CACHE_TTL ?? 300000);
  if (ttl <= 0) return null; // explicitly disabled

  if (!_instance) {
    const maxSize = Number(process.env.CACHE_MAX_SIZE ?? 500);
    const allowlistRaw = (process.env.CACHE_MODELS ?? "").trim();
    const allowlist: RegExp[] = allowlistRaw
      ? allowlistRaw.split(",").map((s) => new RegExp(s.trim()))
      : [];
    _instance = new ResponseCache({
      maxSize,
      defaultTtlMs: ttl,
      modelAllowlist: allowlist,
    });
  }
  return _instance;
}

// ─── DSML model guard ────────────────────────────────────────────────────

/** Comma-separated model prefixes that can produce DSML. */
const DSML_MODELS_DEFAULT = "deepseek,codestral";

/** Parse DSML_MODELS from env, cached after first call. */
let _dsmlPatterns: RegExp[] | null = null;

function getDSMLPatterns(): RegExp[] {
  if (!_dsmlPatterns) {
    const raw = (process.env.DSML_MODELS ?? DSML_MODELS_DEFAULT).trim();
    _dsmlPatterns = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => new RegExp(s, "i"));
  }
  return _dsmlPatterns;
}

/**
 * Check if DSML detection is globally enabled AND if this model is known
 * to produce DSML output.
 *
 * DSML is a DeepSeek-specific markup format. For all other models (OpenAI,
 * Anthropic, CastAI, etc.) there is no need to scan every SSE chunk.
 *
 * Configured via:
 *   DSML_DETECTION — global on/off (default "true")
 *   DSML_MODELS    — comma-separated model prefixes (default "deepseek,codestral")
 */
export function isDSMLDetectionEnabled(model?: string): boolean {
  const globalEnabled = process.env.DSML_DETECTION ?? "true";
  if (globalEnabled !== "true" && globalEnabled !== "1") return false;
  if (!model) return true; // backward compat for non-model callers

  return getDSMLPatterns().some((re) => re.test(model));
}

/** Check if stream passthrough mode is enabled (env toggle, default true). */
export function isStreamPassthroughEnabled(): boolean {
  const val = process.env.STREAM_PASSTHROUGH ?? "true";
  return val === "true" || val === "1";
}
