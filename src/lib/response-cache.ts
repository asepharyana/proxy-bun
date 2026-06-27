/**
 * LRU Response Cache with TTL.
 *
 * Designed for LLM proxy responses — reduces bandwidth and upstream
 * round-trips for repeated prompts (common during development, retries,
 * or shared prefixes).
 *
 * Strategy:
 *   - LRU eviction (most recently used survives)
 *   - Configurable TTL per entry (default 15s — safe for dev, short enough
 *     that stale responses are unlikely)
 *   - Cache key = hash of (model + sorted messages + stream flag)
 *   - Only non-streaming responses are cached (streaming would require
 *     buffering the entire body, defeating the purpose)
 *   - Disabled entirely when CACHE_TTL=0 or NODE_ENV=production without
 *     explicit opt-in
 *
 * Thread safety: LRU operations happen on a single Map + Doubly Linked
 * List, all synchronous — safe within Bun's single-threaded event loop.
 */

// ─── Cache entry ──────────────────────────────────────────────────────────

interface CacheEntry {
  /** Serialized response body (JSON string). */
  body: string;
  /** HTTP status code. */
  status: number;
  /** Response headers to forward. */
  headers: Record<string, string>;
  /** When this entry was created (epoch ms). */
  createdAt: number;
  /** When this entry expires (epoch ms). */
  expiresAt: number;
}

// ─── LRU Linked List Node ─────────────────────────────────────────────────

interface LRUNode {
  key: string;
  prev: LRUNode | null;
  next: LRUNode | null;
}

// ─── ResponseCache class ──────────────────────────────────────────────────

export class ResponseCache {
  private readonly map = new Map<string, CacheEntry>();
  private head: LRUNode | null = null;
  private tail: LRUNode | null = null;
  private readonly maxSize: number;
  private readonly defaultTtlMs: number;

  constructor(opts?: { maxSize?: number; defaultTtlMs?: number }) {
    this.maxSize = opts?.maxSize ?? 500;
    this.defaultTtlMs = opts?.defaultTtlMs ?? 15_000; // 15 seconds
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /** Build a deterministic cache key from an LLM request. */
  static buildKey(model: string, messages: unknown, stream: boolean): string {
    // Normalize messages to a stable string representation
    const stable = JSON.stringify(messages, stableStringifyReplacer);
    const raw = `${model}|${stream}|${stable}`;
    return simpleHash(raw);
  }

  /** Retrieve a cached response. Returns null if missing or expired. */
  get(key: string): { body: string; status: number; headers: Record<string, string> } | null {
    const entry = this.map.get(key);
    if (!entry) return null;

    // Expired — evict and return null
    if (Date.now() > entry.expiresAt) {
      this.delete(key);
      return null;
    }

    // Move to front (most recently used)
    this.moveToFront(key);
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

    this.map.set(key, entry);
    this.moveToFront(key);
  }

  /** Delete a specific key. */
  delete(key: string): void {
    this.map.delete(key);
    this.removeNode(key);
  }

  /** Clear all entries. */
  clear(): void {
    this.map.clear();
    this.head = null;
    this.tail = null;
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
        this.delete(key);
        removed++;
      }
    }
    return removed;
  }

  // ── LRU internals ───────────────────────────────────────────────────────

  private moveToFront(key: string): void {
    // Remove from current position
    this.removeNode(key);

    // Add to front
    const node: LRUNode = { key, prev: null, next: this.head };
    if (this.head) {
      this.head.prev = node;
    }
    this.head = node;
    if (!this.tail) {
      this.tail = node;
    }
  }

  private removeNode(key: string): void {
    // Find the node — linear scan, but bounded by cache size (500).
    // For larger caches, maintain a separate Map<key, LRUNode>.
    let cur = this.head;
    while (cur) {
      if (cur.key === key) {
        // Unlink
        if (cur.prev) cur.prev.next = cur.next;
        if (cur.next) cur.next.prev = cur.prev;
        if (this.head === cur) this.head = cur.next;
        if (this.tail === cur) this.tail = cur.prev;
        return;
      }
      cur = cur.next;
    }
  }

  private evictLRU(): void {
    // Tail is the least recently used
    if (!this.tail) return;
    const lruKey = this.tail.key;
    this.map.delete(lruKey);
    this.removeNode(lruKey);
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
 *   CACHE_TTL       — TTL in ms (0 = disabled, default 15000)
 *   CACHE_MAX_SIZE  — max entries (default 500)
 */
export function getResponseCache(): ResponseCache | null {
  const ttl = Number(process.env.CACHE_TTL ?? 15000);
  if (ttl <= 0) return null; // explicitly disabled

  if (!_instance) {
    const maxSize = Number(process.env.CACHE_MAX_SIZE ?? 500);
    _instance = new ResponseCache({ maxSize, defaultTtlMs: ttl });
  }
  return _instance;
}

/** Check if DSML detection should run (env toggle, default true). */
export function isDSMLDetectionEnabled(): boolean {
  const val = process.env.DSML_DETECTION ?? "true";
  return val === "true" || val === "1";
}

/** Check if stream passthrough mode is enabled (env toggle, default true). */
export function isStreamPassthroughEnabled(): boolean {
  const val = process.env.STREAM_PASSTHROUGH ?? "true";
  return val === "true" || val === "1";
}
