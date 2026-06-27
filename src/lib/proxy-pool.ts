/**
 * Auto-rotating proxy pool.
 *
 * Reads proxies from a text file (format: host:port:username:password),
 * rotates through them round-robin, and tracks failures so unhealthy
 * proxies are skipped.
 */

import { readFileSync, existsSync } from "node:fs";

// --- Types -------------------------------------------------------------------

export interface ProxyEntry {
	host: string;
	port: number;
	username: string;
	password: string;
}

// --- ProxyPool ---------------------------------------------------------------

const POOL_PREFIX = "[proxy-pool]";

function logPool(msg: string, extra?: Record<string, unknown>): void {
	const ts = new Date().toISOString().slice(11, 23);
	const parts = [`${POOL_PREFIX} ${ts}`, msg];
	if (extra) {
		for (const [k, v] of Object.entries(extra)) {
			parts.push(`${k}=${v ?? "null"}`);
		}
	}
	console.log(parts.join(" "));
}

export class ProxyPool {
	private proxies: ProxyEntry[] = [];
	private currentIndex = 0;
	private failureThreshold = 3;
	/** host:port -> consecutive failure count */
	private failures = new Map<string, number>();
	/** host:port::model -> expiry epoch ms. Bounded by MAX_COOLDOWNS to prevent
	 *  unbounded growth when many unique (proxy, model) pairs receive 429s. */
	private cooldowns = new Map<string, number>();
	/** Cap on cooldown entries. Oldest (by insertion order) is evicted on overflow. */
	private readonly MAX_COOLDOWNS = 10_000;
	private cooldownDuration = 60000; // default 60s
	/** Periodic cleanup timer for expired cooldowns */
	private cleanupTimer: ReturnType<typeof setInterval> | null = null;

	// -- Load --------------------------------------------------------------------

	/**
	 * Load proxies from a file at `filePath`.
	 *
	 * Expected format -- one proxy per line:
	 *   host:port:username:password
	 *
	 * Lines starting with `#` are ignored as comments.
	 */
	load(filePath: string): void {
		if (!existsSync(filePath)) {
			console.warn(`[proxy-pool] File not found: ${filePath}`);
			return;
		}

		const text = readFileSync(filePath, "utf-8");
		this.parseProxies(text, filePath);
	}

	/**
	 * Async load proxies from a file at `filePath`.
	 * Uses Bun.file() when available, falls back to sync read.
	 */
	async loadAsync(filePath: string): Promise<void> {
		try {
			// Try Bun.file first (Bun runtime)
			if (typeof globalThis.Bun !== "undefined") {
				const file = (globalThis as any).Bun.file(filePath);
				const exists = await file.exists();
				if (!exists) {
					console.warn(`[proxy-pool] File not found: ${filePath}`);
					return;
				}
				const text = await file.text();
				this.parseProxies(text, filePath);
				return;
			}
		} catch {
			// Fall through to sync
		}
		// Fallback to sync read
		this.load(filePath);
	}

	/**
	 * Load proxies from a comma-separated string (for serverless envs).
	 * Format: "host1:port1:user1:pass1,host2:port2:user2:pass2"
	 */
	loadFromString(proxyList: string): void {
		if (!proxyList) return;
		const lines = proxyList.split(",").map((l) => l.trim()).filter(Boolean);
		this.parseProxies(lines.join("\n"), "env:PROXY_LIST");
	}

	private parseProxies(text: string, source: string): void {
		const lines = text
			.split("\n")
			.map((l: string) => l.trim())
			.filter(Boolean);

		const parsed: ProxyEntry[] = [];
		for (const line of lines) {
			if (line.startsWith("#")) continue;

			const parts = line.split(":");
			if (parts.length < 2) continue;

			const host = parts[0]!;
			const port = Number.parseInt(parts[1]!, 10);
			if (!Number.isFinite(port)) continue;

			parsed.push({
				host,
				port,
				username: parts[2] ?? "",
				password: parts.slice(3).join(":") ?? "",
			});
		}

		this.proxies = parsed;
		this.currentIndex = 0;
		this.failures.clear();

		// Start periodic cooldown cleanup (every 30s)
		this.startCooldownCleanup();

		logPool(`loaded ${this.proxies.length} proxies from ${source}`);
	}

	/** Periodically clean up expired cooldown entries to prevent memory leaks. */
	private startCooldownCleanup(): void {
		if (this.cleanupTimer) return;
		this.cleanupTimer = setInterval(() => {
			const now = Date.now();
			for (const [key, expiry] of this.cooldowns) {
				if (now > expiry) {
					this.cooldowns.delete(key);
				}
			}
		}, 30_000); // every 30s
		// Allow process to exit even if timer is active
		if (this.cleanupTimer && typeof this.cleanupTimer === "object" && "unref" in this.cleanupTimer) {
			this.cleanupTimer.unref();
		}
	}

	/**
	 * Evict oldest cooldown entries when over capacity. Insertion order in
	 * Map is preserved — the first key iterated is the oldest.
	 */
	private evictOldestCooldown(): void {
		const oldestKey = this.cooldowns.keys().next().value;
		if (oldestKey !== undefined) {
			this.cooldowns.delete(oldestKey);
		}
	}

	/**
	 * Convenience -- load from a path or skip.
	 * Returns `true` if proxies were loaded.
	 */
	tryLoad(filePath?: string): boolean {
		if (filePath) this.load(filePath);
		return this.proxies.length > 0;
	}

	/**
	 * Async convenience -- load from a path or skip.
	 */
	async tryLoadAsync(filePath?: string): Promise<boolean> {
		if (filePath) await this.loadAsync(filePath);
		return this.proxies.length > 0;
	}

	// -- Access ------------------------------------------------------------------

	/** Total number of proxies in the pool. */
	get size(): number {
		return this.proxies.length;
	}

	/**
	 * Return the current proxy entry.
	 * Returns `null` if pool is empty.
	 */
	getCurrent(): ProxyEntry | null {
		if (this.proxies.length === 0) return null;
		return this.proxies[this.currentIndex] ?? null;
	}

	/**
	 * Return the proxy URL string for `fetch()`'s `proxy` option.
	 *
	 * Format: `http://username:password@host:port`
	 * Returns `null` when the pool is empty.
	 */
	getProxyUrl(): string | null {
		const entry = this.getCurrent();
		if (!entry) return null;
		const url = this.formatProxyUrl(entry);
		logPool(`getProxyUrl -> ${entry.host}:${entry.port}`, { index: this.currentIndex });
		return url;
	}

	/** Build a `http://user:pass@host:port` URL from an entry. */
	private formatProxyUrl(entry: ProxyEntry): string {
		const auth = entry.username
			? `${encodeURIComponent(entry.username)}:${encodeURIComponent(entry.password)}@`
			: "";
		return `http://${auth}${entry.host}:${entry.port}`;
	}

	// -- Manual proxy management ------------------------------------------------

	/**
	 * Add a single proxy to the pool.
	 * Format: "host:port:username:password" (username:password optional)
	 */
	addProxy(proxyStr: string): void {
		const parts = proxyStr.trim().split(":");
		if (parts.length < 2) return;

		const host = parts[0]!;
		const port = Number.parseInt(parts[1]!, 10);
		if (!Number.isFinite(port)) return;

		this.proxies.push({
			host,
			port,
			username: parts[2] ?? "",
			password: parts.slice(3).join(":") ?? "",
		});

		logPool(`added proxy ${host}:${port} (total: ${this.proxies.length})`);
	}

	// -- Public accessors (for SessionProxyPool) --------------------------------

	/** Get the ProxyEntry at a given index. Returns null if out of bounds. */
	getEntryAtIndex(index: number): ProxyEntry | null {
		return this.proxies[index] ?? null;
	}

	/** Build proxy URL string by index. Returns null if out of bounds. */
	getProxyUrlAtIndex(index: number): string | null {
		const entry = this.getEntryAtIndex(index);
		if (!entry) return null;
		return this.formatProxyUrl(entry);
	}

	/** Get the current rotation index. */
	getCurrentIndex(): number {
		return this.currentIndex;
	}

	/** Set the rotation index (for session pool's direct manipulation). */
	setCurrentIndex(index: number): void {
		this.currentIndex = index;
	}

	// -- Rotation ----------------------------------------------------------------

	/**
	 * Advance to the next proxy (round-robin, wraps around).
	 * Skips proxies that have exceeded the failure threshold or are in
	 * cooldown for the given model.
	 * Returns the new current proxy or `null` if the pool is empty or
	 * all proxies are failed.
	 */
	rotate(model?: string): ProxyEntry | null {
		if (this.proxies.length === 0) return null;
		const oldIndex = this.currentIndex;
		const startIndex = this.currentIndex;

		// Keep advancing until we find a non-failed, non-cooldown proxy or loop back
		let checked = 0;
		do {
			this.currentIndex = (this.currentIndex + 1) % this.proxies.length;
			checked++;
			if (!this.isFailed() && !this.isCurrentInCooldown(model)) {
				const entry = this.proxies[this.currentIndex] ?? null;
				logPool(`rotate ${oldIndex} -> ${this.currentIndex} (skipped ${checked - 1} failed/in-cooldown)`);
				return entry;
			}
		} while (this.currentIndex !== startIndex && checked <= this.proxies.length);

		// All proxies failed or in cooldown — stay on current but log it
		logPool(`rotate ${oldIndex} -> ${this.currentIndex} (all proxies failed or in cooldown)`);
		return this.proxies[this.currentIndex] ?? null;
	}

	/**
	 * Mark the **current** proxy as failed.  Increments the failure count;
	 * when the count reaches the threshold a warning is logged.
	 *
	 * NOTE: This no longer calls `rotate()` automatically -- the caller is
	 * responsible for deciding when to rotate.  Previously this was conflated
	 * and caused double-rotation bugs in retry loops.
	 */
	markFailed(threshold?: number): void {
		const entry = this.getCurrent();
		if (!entry) return;

		const key = `${entry.host}:${entry.port}`;
		const count = (this.failures.get(key) ?? 0) + 1;
		this.failures.set(key, count);

		const th = threshold ?? this.failureThreshold;
		logPool(`markFailed ${key} (${count}/${th})`);
		if (count >= th) {
			console.warn(
				`[proxy-pool] Proxy ${key} failed ${count}/${th} times -- skipping`,
			);
		}
	}

	/** Check if the current proxy has exceeded the failure threshold. */
	isFailed(threshold?: number): boolean {
		const entry = this.getCurrent();
		if (!entry) return true;
		const key = `${entry.host}:${entry.port}`;
		const failed = (this.failures.get(key) ?? 0) >= (threshold ?? this.failureThreshold);
		if (failed) logPool(`isFailed true for ${key}`);
		return failed;
	}

	/** Reset the failure counter for the current proxy. */
	markSuccess(): void {
		const entry = this.getCurrent();
		if (!entry) return;
		this.failures.delete(`${entry.host}:${entry.port}`);
		logPool(`markSuccess ${entry.host}:${entry.port}`);
	}

	/** Set the failure count that triggers a permanent skip. */
	setFailureThreshold(n: number): void {
		this.failureThreshold = n;
	}

	// -- Cooldown (per-model rate-limit) -----------------------------------------

	/**
	 * Set the cooldown duration in milliseconds (default 60000).
	 * When a proxy gets rate-limited (429) for a specific model, it will
	 * be skipped for that model for this duration.
	 */
	setCooldownDuration(ms: number): void {
		this.cooldownDuration = ms;
	}

	/** Internal cooldown key format: host:port::model */
	private cooldownKey(host: string, port: number, model: string): string {
		return `${host}:${port}::${model}`;
	}

	/**
	 * Mark the **current** proxy as rate-limited for a specific model.
	 * The proxy enters a cooldown period during which it will be skipped
	 * for this model but remains available for other models.
	 *
	 * Bounded: when cooldowns exceeds MAX_COOLDOWNS, the oldest entry is
	 * evicted (insertion-order LRU) to prevent memory growth across
	 * many unique (proxy, model) pairs.
	 */
	markRateLimited(model: string): void {
		const entry = this.getCurrent();
		if (!entry) return;
		const key = this.cooldownKey(entry.host, entry.port, model);
		const expiry = Date.now() + this.cooldownDuration;

		// If at capacity and this is a new key, evict oldest first.
		if (!this.cooldowns.has(key) && this.cooldowns.size >= this.MAX_COOLDOWNS) {
			this.evictOldestCooldown();
		}
		this.cooldowns.set(key, expiry);
		logPool(`markRateLimited key=${key} expiry=${expiry} duration=${this.cooldownDuration}ms`);
	}

	/**
	 * Check if a specific proxy (host:port) is in cooldown for a model.
	 * Returns true if the proxy is cooling down for that model.
	 */
	isProxyInCooldown(host: string, port: number, model: string): boolean {
		const key = this.cooldownKey(host, port, model);
		const expiry = this.cooldowns.get(key);
		if (!expiry) return false;
		if (Date.now() > expiry) {
			this.cooldowns.delete(key); // lazy cleanup
			return false;
		}
		return true;
	}

	/**
	 * Check if a proxy at a given pool index is in cooldown for a model.
	 * Returns true if the proxy doesn't exist or is in cooldown.
	 */
	isIndexInCooldown(index: number, model: string): boolean {
		const entry = this.proxies[index];
		if (!entry) return true;
		return this.isProxyInCooldown(entry.host, entry.port, model);
	}

	/** Check if the current proxy is in cooldown for the given model. */
	private isCurrentInCooldown(model?: string): boolean {
		if (!model) return false;
		const entry = this.getCurrent();
		if (!entry) return true;
		return this.isProxyInCooldown(entry.host, entry.port, model);
	}
}

// --- SessionProxyPool ---------------------------------------------------------

interface SessionInfo {
	proxyIndex: number;
	failures: number;
}

/**
 * Session-based sticky proxy allocation on top of ProxyPool.
 *
 * Each session gets one sticky proxy until:
 * - The session is released (cleanup)
 * - The proxy exceeds the failure threshold (auto-rotate to next avail)
 * - The session explicitly calls release()
 *
 * New sessions are assigned to the least-loaded proxy (fewest active sessions).
 */
export class SessionProxyPool {
	private pool: ProxyPool;
	private sessions = new Map<string, SessionInfo>();
	/** proxyIndex -> set of session IDs currently using it */
	private proxyUsage = new Map<number, Set<string>>();
	private failureThreshold: number;

	/**
	 * @param poolOrPath Existing ProxyPool or file path to load from.
	 */
	constructor(poolOrPath?: ProxyPool | string) {
		if (poolOrPath instanceof ProxyPool) {
			this.pool = poolOrPath;
		} else {
			this.pool = new ProxyPool();
			if (poolOrPath) this.pool.load(poolOrPath);
		}
		this.failureThreshold = 3;
		logPool(`SessionProxyPool created, poolSize=${this.pool.size}`);
	}

	/** Number of available proxies in the underlying pool. */
	get size(): number {
		return this.pool.size;
	}

	/** Number of active sessions. */
	get activeSessions(): number {
		return this.sessions.size;
	}

	// -- Session management -------------------------------------------------------

	/**
	 * Assign a sticky proxy to a session. Returns the proxy URL, or null if empty.
	 *
	 * If the session already has a proxy, returns the same one (resume).
	 * Otherwise picks the least-loaded proxy.
	 */
	acquire(sessionId: string, model?: string): string | null {
		if (this.pool.size === 0) return null;

		const existing = this.sessions.get(sessionId);
		if (existing !== undefined) {
			logPool(`acquire existing session=${sessionId.slice(0, 8)} proxyIndex=${existing.proxyIndex}`);
			return this.pool.getProxyUrlAtIndex(existing.proxyIndex);
		}

		const index = this.pickLeastUsedIndex(model);
		if (index === -1) return null;

		this.sessions.set(sessionId, { proxyIndex: index, failures: 0 });

		let usedBy = this.proxyUsage.get(index);
		if (!usedBy) {
			usedBy = new Set();
			this.proxyUsage.set(index, usedBy);
		}
		usedBy.add(sessionId);

		const entry = this.pool.getEntryAtIndex(index);
		logPool(`acquire session=${sessionId.slice(0, 8)} -> proxyIndex=${index} host=${entry?.host} activeSessions=${this.activeSessions}`);
		return this.pool.getProxyUrlAtIndex(index);
	}

	/** Return the current proxy URL for a session (no rotation), or null. */
	getProxyUrl(sessionId: string): string | null {
		const info = this.sessions.get(sessionId);
		if (!info) return null;
		const entry = this.pool.getEntryAtIndex(info.proxyIndex);
		logPool(`getProxyUrl session=${sessionId.slice(0, 8)} proxyIndex=${info.proxyIndex} host=${entry?.host}`);
		return this.pool.getProxyUrlAtIndex(info.proxyIndex);
	}

	/** Remove a session from all tracking. */
	release(sessionId: string): void {
		const info = this.sessions.get(sessionId);
		if (!info) return;

		const usedBy = this.proxyUsage.get(info.proxyIndex);
		if (usedBy) {
			usedBy.delete(sessionId);
			if (usedBy.size === 0) this.proxyUsage.delete(info.proxyIndex);
		}

		this.sessions.delete(sessionId);
		const entry = this.pool.getEntryAtIndex(info.proxyIndex);
		logPool(`release session=${sessionId.slice(0, 8)} proxyIndex=${info.proxyIndex} host=${entry?.host} activeSessions=${this.activeSessions}`);
	}

	/**
	 * Increment failure count for this session's proxy.
	 *
	 * If failures >= threshold, auto-rotate to a different proxy.
	 * Also marks the old proxy as failed in the underlying ProxyPool.
	 *
	 * @returns true if the session was rotated to a new proxy.
	 */
	markFailed(sessionId: string): boolean {
		const info = this.sessions.get(sessionId);
		if (!info) return false;

		info.failures += 1;
		logPool(`markFailed session=${sessionId.slice(0, 8)} proxyIndex=${info.proxyIndex} failures=${info.failures}/${this.failureThreshold}`);

		if (info.failures < this.failureThreshold) return false;

		const oldIndex = info.proxyIndex;
		const oldEntry = this.pool.getEntryAtIndex(oldIndex);

		// Mark in underlying pool using public API
		const savedIdx = this.pool.getCurrentIndex();
		this.pool.setCurrentIndex(oldIndex);
		this.pool.markFailed(this.failureThreshold);
		this.pool.setCurrentIndex(savedIdx);

		// Remove session from old proxy usage tracking
		const usedBy = this.proxyUsage.get(oldIndex);
		if (usedBy) {
			usedBy.delete(sessionId);
			if (usedBy.size === 0) this.proxyUsage.delete(oldIndex);
		}

		// Pick next available proxy
		const newIndex = this.pickLeastUsedIndex();
		if (newIndex === -1 || newIndex === oldIndex) {
			// Single-proxy pool or none available — reset failures, stay put
			this.sessions.set(sessionId, { proxyIndex: oldIndex, failures: 0 });
			logPool(`markFailed no alternative, staying on oldIndex=${oldIndex} host=${oldEntry?.host}`);
			return false;
		}

		this.sessions.set(sessionId, { proxyIndex: newIndex, failures: 0 });

		let newUsedBy = this.proxyUsage.get(newIndex);
		if (!newUsedBy) {
			newUsedBy = new Set();
			this.proxyUsage.set(newIndex, newUsedBy);
		}
		newUsedBy.add(sessionId);

		const newEntry = this.pool.getEntryAtIndex(newIndex);
		logPool(`markFailed rotated session=${sessionId.slice(0, 8)} ${oldEntry?.host} -> ${newEntry?.host}`);
		return true;
	}

	/**
	 * Force-rotate this session to the least-loaded proxy immediately,
	 * regardless of failure count. Resets the session's failure counter.
	 *
	 * @returns true if the session was moved to a different proxy.
	 */
	rotateNow(sessionId: string, model?: string): boolean {
		const info = this.sessions.get(sessionId);
		if (!info) return false;

		const oldIndex = info.proxyIndex;
		const oldEntry = this.pool.getEntryAtIndex(oldIndex);

		// Remove from old proxy usage first
		const usedBy = this.proxyUsage.get(oldIndex);
		if (usedBy) {
			usedBy.delete(sessionId);
			if (usedBy.size === 0) this.proxyUsage.delete(oldIndex);
		}

		// Find the least-loaded proxy that is NOT the current one and NOT
		// in cooldown for this model. Start scanning from (oldIndex + 1)
		// so we don't immediately bounce back to index 0.
		let bestIndex = -1;
		let bestCount = Infinity;
		for (let step = 1; step <= this.pool.size; step++) {
			const i = (oldIndex + step) % this.pool.size;
			if (model && this.pool.isIndexInCooldown(i, model)) continue;
			const count = this.proxyUsage.get(i)?.size ?? 0;
			if (count < bestCount) {
				bestCount = count;
				bestIndex = i;
			}
		}

		if (bestIndex === -1) {
			// Single-proxy pool — reinstate and give up
			if (usedBy) usedBy.add(sessionId);
			return false;
		}

		this.sessions.set(sessionId, { proxyIndex: bestIndex, failures: 0 });

		let newUsedBy = this.proxyUsage.get(bestIndex);
		if (!newUsedBy) {
			newUsedBy = new Set();
			this.proxyUsage.set(bestIndex, newUsedBy);
		}
		newUsedBy.add(sessionId);

		const newEntry = this.pool.getEntryAtIndex(bestIndex);
		logPool(`rotateNow session=${sessionId.slice(0, 8)} ${oldEntry?.host} -> ${newEntry?.host}`);
		return true;
	}

	/** Reset failure count for this session's proxy. */
	markSuccess(sessionId: string): void {
		const info = this.sessions.get(sessionId);
		if (!info) return;
		info.failures = 0;
		logPool(`markSuccess session=${sessionId.slice(0, 8)} proxyIndex=${info.proxyIndex}`);
	}

	/**
	 * Mark this session's proxy as rate-limited for a specific model.
	 * Delegates to the underlying ProxyPool's cooldown so the proxy is
	 * skipped for this model on subsequent requests (different sessions).
	 */
	markRateLimited(sessionId: string, model: string): void {
		const info = this.sessions.get(sessionId);
		if (!info) return;
		const savedIdx = this.pool.getCurrentIndex();
		this.pool.setCurrentIndex(info.proxyIndex);
		this.pool.markRateLimited(model);
		this.pool.setCurrentIndex(savedIdx);
	}

	// -- Internals ----------------------------------------------------------------

	/** Get the ProxyEntry at a given index. Forward reference to local type. */
	private poolEntryAtIndex(index: number): ProxyEntry | null {
		return this.pool.getEntryAtIndex(index);
	}

	/** Build proxy URL string by index. */
	private formatProxyUrlAtIndex(index: number): string | null {
		return this.pool.getProxyUrlAtIndex(index);
	}

	/** Return the index of the proxy with the fewest active sessions, or -1. */
	private pickLeastUsedIndex(model?: string): number {
		if (this.pool.size === 0) return -1;

		let bestIndex = -1;
		let bestCount = Infinity;

		for (let i = 0; i < this.pool.size; i++) {
			if (model && this.pool.isIndexInCooldown(i, model)) continue;
			const count = this.proxyUsage.get(i)?.size ?? 0;
			logPool(`pickLeastUsed proxy[${i}] count=${count}`);
			if (count < bestCount) {
				bestCount = count;
				bestIndex = i;
			}
		}

		if (bestIndex === -1) {
			logPool(`pickLeastUsed all proxies in cooldown`);
			return 0; // fallback to first
		}

		logPool(`pickLeastUsed selected index=${bestIndex} count=${bestCount}`);
		return bestIndex;
	}

	/** Override the failure threshold (default 3). */
	setFailureThreshold(n: number): void {
		this.failureThreshold = n;
	}
}
