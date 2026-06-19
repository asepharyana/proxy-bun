/**
 * IPv6 source address pool for outbound rotation.
 *
 * Loads multiple IPv6 source addresses and rotates through them
 * round-robin. Each outbound request can pick the next source IP
 * via getNext(), ensuring requests are distributed across addresses.
 *
 * --- Environment Variables ----------------------------------------------------
 * IPV6_SOURCES — Comma-separated list of IPv6 source addresses
 *                e.g. "2001:df4:c140:1f::d6,2001:df4:c140:1f:ffff:ffff:ffff:ffff"
 */

const POOL_PREFIX = "[ipv6-pool]";

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

// --- Types -------------------------------------------------------------------

export interface IPv6SourceEntry {
	address: string;
	/** Number of consecutive failures for this source */
	failures: number;
	/** Whether this source is temporarily disabled */
	disabled: boolean;
}

// --- IPv6SourcePool ----------------------------------------------------------

export class IPv6SourcePool {
	private sources: IPv6SourceEntry[] = [];
	private currentIndex = 0;
	private failureThreshold = 3;

	/**
	 * Load IPv6 source addresses from a comma-separated string.
	 *
	 * @param csv - Comma-separated IPv6 addresses (e.g. "addr1,addr2,addr3")
	 */
	loadFromString(csv: string): void {
		if (!csv) return;
		const addrs = csv
			.split(",")
			.map((a) => a.trim())
			.filter(Boolean);

		this.sources = addrs.map((addr) => ({
			address: addr,
			failures: 0,
			disabled: false,
		}));
		this.currentIndex = 0;

		logPool(`loaded ${this.sources.length} IPv6 source addresses`);
		for (const src of this.sources) {
			logPool(`  source: ${src.address}`);
		}
	}

	/**
	 * Load from environment variable IPV6_SOURCES.
	 */
	loadFromEnv(): void {
		const env = process.env.IPV6_SOURCES;
		if (env) {
			this.loadFromString(env);
		}
	}

	// -- Access ------------------------------------------------------------------

	/** Total number of source addresses. */
	get size(): number {
		return this.sources.length;
	}

	/** Whether any source addresses are configured. */
	get configured(): boolean {
		return this.sources.length > 0;
	}

	/**
	 * Get the next IPv6 source address (round-robin).
	 * Skips sources that have exceeded the failure threshold.
	 *
	 * @returns The next IPv6 address, or null if pool is empty or all failed.
	 */
	getNext(): string | null {
		if (this.sources.length === 0) return null;

		const startIndex = this.currentIndex;
		let checked = 0;

		do {
			const entry = this.sources[this.currentIndex];
			if (entry && !entry.disabled) {
				const addr = entry.address;
				// Advance index for next call
				this.currentIndex = (this.currentIndex + 1) % this.sources.length;
				logPool(`getNext -> ${addr} (index=${this.currentIndex})`);
				return addr;
			}
			this.currentIndex = (this.currentIndex + 1) % this.sources.length;
			checked++;
		} while (this.currentIndex !== startIndex && checked <= this.sources.length);

		// All sources failed — reset and return first
		logPool("all IPv6 sources failed, resetting");
		for (const src of this.sources) {
			src.failures = 0;
			src.disabled = false;
		}
		this.currentIndex = 0;
		return this.sources[0]?.address ?? null;
	}

	/**
	 * Get a specific source address by index.
	 * Returns null if out of bounds.
	 */
	getAtIndex(index: number): string | null {
		return this.sources[index]?.address ?? null;
	}

	// -- Failure tracking --------------------------------------------------------

	/**
	 * Mark a source address as failed.
	 * If failures exceed threshold, the source is disabled until reset.
	 *
	 * @param address - The IPv6 address that failed
	 */
	markFailed(address: string): void {
		const entry = this.sources.find((s) => s.address === address);
		if (!entry) return;

		entry.failures++;
		logPool(`markFailed ${address} (${entry.failures}/${this.failureThreshold})`);

		if (entry.failures >= this.failureThreshold) {
			entry.disabled = true;
			console.warn(
				`[ipv6-pool] Source ${address} failed ${entry.failures}/${this.failureThreshold} times — disabled`,
			);
		}
	}

	/**
	 * Mark a source address as successful (resets failure count).
	 *
	 * @param address - The IPv6 address that succeeded
	 */
	markSuccess(address: string): void {
		const entry = this.sources.find((s) => s.address === address);
		if (!entry) return;

		if (entry.failures > 0) {
			logPool(`markSuccess ${address} (was ${entry.failures} failures)`);
		}
		entry.failures = 0;
		entry.disabled = false;
	}

	/** Set the failure threshold (default 3). */
	setFailureThreshold(n: number): void {
		this.failureThreshold = n;
	}

	/** Reset all failure states. */
	reset(): void {
		for (const src of this.sources) {
			src.failures = 0;
			src.disabled = false;
		}
		this.currentIndex = 0;
		logPool("reset all sources");
	}
}
