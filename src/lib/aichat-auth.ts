/**
 * aichat.org — session & CSRF token manager.
 *
 * aichat.org uses Laravel-style session cookies (XSRF-TOKEN + ai_chat_session)
 * with a CSRF double-submit pattern.  The session expires after 2 hours.
 *
 * Flow:
 *   1. GET https://aichat.org/chat → extract CSRF from meta tag + capture cookies
 *   2. Cache cookies + CSRF for subsequent API requests
 *   3. On 401 → invalidate session, re-bootstrap, retry once
 */

const AICHAT_CHAT_URL = "https://aichat.org/chat";
const SESSION_REFRESH_MS = 3_600_000; // refresh every hour (session lasts 2h)
const BOOTSTRAP_MAX_RETRIES = 3;
const BOOTSTRAP_BASE_DELAY_MS = 1_000; // 1s, 2s, 4s

interface AichatSession {
  cookies: string;       // "XSRF-TOKEN=...; ai_chat_session=..."
  csrfToken: string;     // value of <meta name="csrf-token">
  fetchedAt: number;     // epoch ms
}

// --- Module-level cache ------------------------------------------------------

let session: AichatSession | null = null;

// --- Session bootstrap ------------------------------------------------------

/**
 * Fetch the chat page, parse the CSRF token, and capture session cookies.
 *
 * Retries up to BOOTSTRAP_MAX_RETRIES times with exponential backoff on
 * network errors or non-2xx responses. This prevents transient failures
 * (aichat.org temporarily down, network blip) from becoming user-visible errors.
 */
async function bootstrapSession(attempt = 1): Promise<AichatSession> {
  const resp = await fetch(AICHAT_CHAT_URL, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
    },
  });

  if (!resp.ok) {
    if (attempt < BOOTSTRAP_MAX_RETRIES) {
      const delay = BOOTSTRAP_BASE_DELAY_MS * Math.pow(2, attempt - 1);
      await new Promise((r) => setTimeout(r, delay));
      return bootstrapSession(attempt + 1);
    }
    throw new Error(`aichat.org session bootstrap failed (after ${BOOTSTRAP_MAX_RETRIES} attempts): ${resp.status}`);
  }

  const html = await resp.text();

  // Extract CSRF token from meta tag
  const csrfMatch = html.match(
    /<meta\s+name="csrf-token"\s+content="([^"]+)"/i,
  );
  if (!csrfMatch || !csrfMatch[1]) {
    if (attempt < BOOTSTRAP_MAX_RETRIES) {
      const delay = BOOTSTRAP_BASE_DELAY_MS * Math.pow(2, attempt - 1);
      await new Promise((r) => setTimeout(r, delay));
      return bootstrapSession(attempt + 1);
    }
    throw new Error(`aichat.org: CSRF token not found in bootstrap response (after ${BOOTSTRAP_MAX_RETRIES} attempts)`);
  }
  const csrfToken = csrfMatch[1];

  // Capture Set-Cookie headers
  const cookieParts: string[] = [];
  for (const [key, val] of resp.headers.entries()) {
    if (key.toLowerCase() === "set-cookie") {
      cookieParts.push(val.split(";")[0]!);
    }
  }

  if (
    cookieParts.length === 0 ||
    (!cookieParts.some((c) => c.startsWith("XSRF-TOKEN")) &&
      !cookieParts.some((c) => c.startsWith("ai_chat_session")))
  ) {
    cookieParts.push(`XSRF-TOKEN=${encodeURIComponent(csrfToken)}`);
  }

  session = {
    cookies: cookieParts.join("; "),
    csrfToken,
    fetchedAt: Date.now(),
  };

  return session;
}

// --- Public API --------------------------------------------------------------

/**
 * Get the current session's cookies + CSRF token.
 *
 * Automatically refreshes the session if it is stale (fetched > 1h ago).
 */
export async function getAichatSession(): Promise<{
  cookies: string;
  csrfToken: string;
}> {
  if (session && Date.now() - session.fetchedAt < SESSION_REFRESH_MS) {
    return { cookies: session.cookies, csrfToken: session.csrfToken };
  }
  const fresh = await bootstrapSession();
  return { cookies: fresh.cookies, csrfToken: fresh.csrfToken };
}

/**
 * Update the session from API response headers.
 *
 * aichat.org sends new Set-Cookie on every response — call this after
 * a successful API call so the cached session stays fresh.
 */
export function updateAichatSessionFromResponse(response: Response): void {
  if (!session) return;

  const cookieParts: string[] = [];
  for (const [key, val] of response.headers.entries()) {
    if (key.toLowerCase() === "set-cookie") {
      cookieParts.push(val.split(";")[0]!);
    }
  }

  if (cookieParts.length === 0) return;

  const newXsrf = cookieParts.find((c) => c.startsWith("XSRF-TOKEN="));
  const newSession = cookieParts.find((c) => c.startsWith("ai_chat_session="));

  if (newXsrf || newSession) {
    // Merge updated cookies — keep the other one if missing
    const oldParts = session.cookies.split("; ").filter(Boolean);
    const keepXsrf = !newXsrf ? oldParts.find((c) => c.startsWith("XSRF-TOKEN=")) : undefined;
    const keepSess = !newSession ? oldParts.find((c) => c.startsWith("ai_chat_session=")) : undefined;

    session.cookies = [newXsrf ?? keepXsrf, newSession ?? keepSess]
      .filter(Boolean)
      .join("; ");

    // XSRF-TOKEN in cookie is the encrypted value, CSRF meta is the raw.
    // These differ (Laravel encrypts the cookie). Only update CSRF from
    // bootstrap, not from response cookies — the meta tag value stays valid
    // as long as the session is alive.
    session.fetchedAt = Date.now();
  }
}

/**
 * Invalidate the cached session.
 *
 * Call after receiving a 401 from aichat.org so the next request
 * bootstraps a fresh session.
 */
export function invalidateAichatSession(): void {
  session = null;
}
