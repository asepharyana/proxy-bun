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

export class ProxyPool {
	private proxies: ProxyEntry[] = [];
	private currentIndex = 0;
	private failureThreshold = 3;
	/** host:port -> consecutive failure count */
	private failures = new Map<string, number>();

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

		if (this.proxies.length > 0) {
			console.log(
				`[proxy-pool] Loaded ${this.proxies.length} proxies from ${filePath}`,
			);
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
		return this.formatProxyUrl(entry);
	}

	/** Build a `http://user:pass@host:port` URL from an entry. */
	private formatProxyUrl(entry: ProxyEntry): string {
		const auth = entry.username
			? `${encodeURIComponent(entry.username)}:${encodeURIComponent(entry.password)}@`
			: "";
		return `http://${auth}${entry.host}:${entry.port}`;
	}

	// -- Rotation ----------------------------------------------------------------

	/**
	 * Advance to the next proxy (round-robin, wraps around).
	 * Returns the new current proxy or `null` if the pool is empty.
	 */
	rotate(): ProxyEntry | null {
		if (this.proxies.length === 0) return null;
		this.currentIndex = (this.currentIndex + 1) % this.proxies.length;
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
		return (this.failures.get(key) ?? 0) >= (threshold ?? this.failureThreshold);
	}

	/** Reset the failure counter for the current proxy. */
	markSuccess(): void {
		const entry = this.getCurrent();
		if (!entry) return;
		this.failures.delete(`${entry.host}:${entry.port}`);
	}

	/** Set the failure count that triggers a permanent skip. */
	setFailureThreshold(n: number): void {
		this.failureThreshold = n;
	}
}
