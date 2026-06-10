/**
 * Request body size limiter.
 *
 * Checks the Content-Length header against a configurable maximum.
 * Returns a 413 Payload Too Large response when the body exceeds the limit.
 *
 * For streaming requests (no Content-Length), a TransformStream-based
 * enforcer is available that counts bytes and aborts when the limit is exceeded.
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
	const header = request.headers.get("content-length");
	if (header === null) {
		// Cannot determine size upfront -- pass through (streaming body).
		return null;
	}

	const contentLength = Number.parseInt(header, 10);

	if (Number.isNaN(contentLength) || contentLength < 0) {
		// Malformed Content-Length -- pass through and let the server handle it.
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
 * Wrap a ReadableStream so it enforces a byte limit on the total data
 * read.  If the limit is exceeded the stream errors with a `BodyTooLarge`
 * error and enqueues a 413-style JSON error object.
 *
 * This catches oversized streaming bodies that have no `Content-Length`
 * header and would otherwise bypass the Content-Length check.
 */
export function createStreamBodyLimiter(
	stream: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
	let totalBytes = 0;

	const transformer = new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			totalBytes += chunk.byteLength;
			if (totalBytes > maxBodySize) {
				const errBody = JSON.stringify({
					error: "Payload Too Large",
					message: `Streaming body exceeded maximum allowed size of ${maxBodySize} bytes`,
					maxSizeBytes: maxBodySize,
				});
				controller.enqueue(
					new TextEncoder().encode(
						`data: ${errBody}\n\nevent: error\ndata: {}\n\n`,
					),
				);
				controller.error(
					new Error(`Body exceeded ${maxBodySize} byte limit`),
				);
				return;
			}
			controller.enqueue(chunk);
		},
	});

	return stream.pipeThrough(transformer);
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
