export interface RelayOptions {
  stripHeaders?: string[];
}

export function normalizeTargetUrl(target: string | null, relayPath: string): string | null {
  if (!target) return null;
  return target.replace(/\/$/, "") + relayPath;
}

export function stripRelayHeaders(headers: Headers): Headers {
  const stripped = new Headers(headers);
  stripped.delete("x-relay-target");
  stripped.delete("x-relay-path");
  stripped.delete("host");
  return stripped;
}

export function shouldSendBody(method: string): boolean {
  return method !== "GET" && method !== "HEAD";
}

export function buildRelayRequest(
  req: Request,
  targetUrl: string,
  headers: Headers
): RequestInit {
  return {
    method: req.method,
    headers,
    body: shouldSendBody(req.method) ? req.body : undefined,
    duplex: "half" as const,
  };
}

export function createRelayResponse(response: Response): Response {
  return new Response(response.body, {
    status: response.status,
    headers: response.headers,
  });
}
