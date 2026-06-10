/**
 * Request body size limiter.
 *
 * Checks the Content-Length header against a configurable maximum.
 * Returns a 413 Payload Too Large response when the body exceeds the limit.
 * Requests without a Content-Length header are passed through since
 * the body size cannot be determined upfront with streaming.
 */

const DEFAULT_MAX_BODY_SIZE = 1_048_576; // 1 MB

let maxBodySize = DEFAULT_MAX_BODY_SIZE;

/**
 * Check whether the request body exceeds the configured size limit.
 *
 * Returns a 413 Response if the Content-Length header indicates the body
 * is too large. Returns `null` if the body is acceptable or if the size
 * cannot be determined (no Content-Length header).
 */
export function checkBodySize(request: Request): Response | null {
	const contentType = request.headers.get("content-length");
	if (contentType === null) {
		// Cannot determine size upfront — pass through (streaming body).
		return null;
	}

	const contentLength = Number.parseInt(contentType, 10);

	if (Number.isNaN(contentLength) || contentLength < 0) {
		// Malformed Content-Length — pass through and let the server handle it.
		return null;
	}

	if (contentLength > maxBodySize) {
		return new Response(
			JSON.stringify({
				error: "Payload Too Large",
				message: `Request body exceeds the maximum allowed size of ${maxBodySize} bytes`,
				maxSizeBytes: maxBodySize,
			}),
			{
				status: 413,
				headers: {
					"Content-Type": "application/json",
				},
			},
		);
	}

	return null;
}

/**
 * Update the maximum allowed body size.
 */
export function setMaxBodySize(bytes: number): void {
	if (bytes < 0) {
		throw new Error("maxBodySize must be a non-negative number");
	}
	maxBodySize = bytes;
}

/**
 * Get the current maximum allowed body size in bytes.
 */
export function getMaxBodySize(): number {
	return maxBodySize;
}
