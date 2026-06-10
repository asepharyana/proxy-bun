/**
 * Structured logger for relay proxy events.
 *
 * Logs events as JSON lines for machine parsing and provides
 * optional TTY colorization for local development.
 */

export interface RelayLogEvent {
	method: string;
	url: string;
	status: number;
	durationMs: number;
	error?: string;
	targetUrl?: string;
	ip?: string;
}

type LogLevel = "info" | "warn" | "error";

/** Determine log level from HTTP status code. */
function levelFromStatus(status: number): LogLevel {
	if (status >= 500) return "error";
	if (status >= 400) return "warn";
	return "info";
}

/** ANSI color codes for TTY output. */
const TTY_COLORS: Record<LogLevel, string> = {
	info: "[32m", // green
	warn: "[33m", // yellow
	error: "[31m", // red
};
const TTY_RESET = "[0m";
const TTY_DIM = "[2m";

/** Check if stdout is a TTY (for colorization). */
function isTTY(): boolean {
	return process.stdout?.isTTY === true;
}

/**
 * Log a structured relay event to stdout.
 *
 * When writing to a TTY the output includes ANSI colors for readability.
 * When writing to a pipe/file it produces clean JSON lines.
 */
export function logRelayEvent(event: RelayLogEvent): void {
	const { method, url, status, durationMs, error, targetUrl, ip } = event;
	const level = levelFromStatus(status);
	const timestamp = new Date().toISOString();
	const durationFormatted = `${durationMs}ms`;

	const tty = isTTY();
	const color = tty ? (TTY_COLORS[level] ?? "") : "";
	const reset = tty ? TTY_RESET : "";
	const dim = tty ? TTY_DIM : "";

	if (tty) {
		const statusColor =
			status >= 500 ? TTY_COLORS.error : status >= 400 ? TTY_COLORS.warn : "";
		const parts: string[] = [
			`${dim}${timestamp}${reset}`,
			`${color}[${level.toUpperCase()}]${reset}`,
			`${method}`,
			`${statusColor}${status}${reset}`,
			`${dim}${durationFormatted}${reset}`,
			url,
		];
		if (targetUrl) parts.push(`${dim}-> ${targetUrl}${reset}`);
		if (ip) parts.push(`${dim}(${ip})${reset}`);
		if (error) parts.push(`${color}${error}${reset}`);

		console.log(parts.join(" "));
	} else {
		const logEntry: Record<string, unknown> = {
			timestamp,
			level,
			method,
			url,
			status,
			durationMs: durationFormatted,
		};
		if (error) logEntry.error = error;
		if (targetUrl) logEntry.targetUrl = targetUrl;
		if (ip) logEntry.ip = ip;

		console.log(JSON.stringify(logEntry));
	}
}

/**
 * Create a middleware-compatible request logger.
 *
 * Example usage in a Bun.serve() handler:
 *
 *   const requestLogger = createRequestLogger();
 *   const start = performance.now();
 *   // ... handle request ...
 *   requestLogger(req, res, start, { targetUrl });
 */
export function createRequestLogger(): (
	req: Request,
	res: Response,
	startTime: number,
	extra?: Partial<RelayLogEvent>,
) => void {
	return (req, res, startTime, extra) => {
		const durationMs = Math.round(performance.now() - startTime);

		logRelayEvent({
			method: req.method,
			url: req.url,
			status: res.status,
			durationMs,
			error: extra?.error,
			targetUrl: extra?.targetUrl,
			ip: extra?.ip,
		});
	};
}
