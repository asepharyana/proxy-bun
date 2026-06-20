/**
 * Mimo Free API — JWT bootstrap & auth cache.
 *
 * Mimo Free does not use a static API key.  Instead, authentication is done
 * via a JWT obtained by sending a device fingerprint to the bootstrap endpoint.
 * The JWT is cached in-memory and auto-refreshed before expiry.
 *
 * Flow:
 *   1. generateDeviceFingerprint() → sha256(hostname|platform|arch|cpu|username)
 *   2. bootstrapJwt() → POST /api/free-ai/bootstrap with {client: fingerprint}
 *   3. getJwt() → return cached JWT, auto-refresh if near expiry (5 min buffer)
 *   4. invalidateJwt() → clear cache (called on 401/403)
 */

import * as os from "node:os";

// --- Module-level cache ------------------------------------------------------

let cachedJwt: string | null = null;
let jwtExpiry = 0; // epoch ms
let pendingRefresh: Promise<string> | null = null; // dedup concurrent refreshes

const MIMO_BOOTSTRAP_URL = "https://api.xiaomimimo.com/api/free-ai/bootstrap";
const EXPIRY_BUFFER_MS = 300_000; // 5 minutes

// --- Device fingerprint ------------------------------------------------------

/**
 * Generate a SHA-256 device fingerprint from OS-level attributes.
 *
 * Format: `sha256(hostname|platform|arch|cpu|username)`
 * This matches the 9Router reference implementation.
 *
 * Uses Web Crypto API (available in Bun, Workers, and Node.js 20+).
 */
async function generateDeviceFingerprint(): Promise<string> {
  const hostname = os.hostname();
  const platform = process.platform;
  const arch = process.arch;
  const cpus = os.cpus();
  const cpuModel = cpus.length > 0 ? (cpus[0]?.model ?? "unknown") : "unknown";
  const username = process.env.USER ?? process.env.USERNAME ?? "unknown";

  const raw = `${hostname}|${platform}|${arch}|${cpuModel}|${username}`;
  const encoder = new TextEncoder();
  const data = encoder.encode(raw);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// --- JWT bootstrap -----------------------------------------------------------

/**
 * Request a fresh JWT from the Mimo bootstrap endpoint.
 *
 * Sends the device fingerprint and stores the returned JWT along with its
 * expiry time (parsed from the `exp` claim in the JWT payload).
 *
 * @throws If the bootstrap request fails or returns an unexpected response.
 */
async function bootstrapJwt(): Promise<string> {
  const fingerprint = await generateDeviceFingerprint();

  const resp = await fetch(MIMO_BOOTSTRAP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client: fingerprint }),
  });

  if (!resp.ok) {
    throw new Error(`Mimo bootstrap failed: ${resp.status} ${resp.statusText}`);
  }

  const data = (await resp.json()) as { jwt: string };
  if (!data.jwt || typeof data.jwt !== "string") {
    throw new Error("Mimo bootstrap response missing jwt field");
  }

  cachedJwt = data.jwt;

  // Decode the JWT payload (second dot-separated segment) to extract `exp`.
  try {
    const payloadBase64 = data.jwt.split(".")[1]!;
    const payloadJson = Buffer.from(payloadBase64, "base64url").toString("utf-8");
    const payload = JSON.parse(payloadJson) as { exp?: number };
    if (payload.exp && typeof payload.exp === "number") {
      jwtExpiry = payload.exp * 1000; // JWT exp is in seconds
    } else {
      // No exp claim — set a conservative 10-minute TTL
      jwtExpiry = Date.now() + 600_000;
    }
  } catch {
    // Payload decode failed — set a conservative 10-minute TTL
    jwtExpiry = Date.now() + 600_000;
  }

  return cachedJwt;
}

// --- Public API --------------------------------------------------------------

/**
 * Get a valid JWT for Mimo API requests.
 *
 * Returns the cached JWT if it is still valid (expiry > now + 5 min buffer).
 * Otherwise bootstraps a fresh JWT.
 *
 * @throws If bootstrap fails.
 */
export async function getJwt(): Promise<string> {
  const now = Date.now();
  if (cachedJwt && jwtExpiry > now + EXPIRY_BUFFER_MS) {
    return cachedJwt;
  }
  // Dedup concurrent refresh — all callers share the same Promise
  if (!pendingRefresh) {
    pendingRefresh = bootstrapJwt().finally(() => {
      pendingRefresh = null;
    });
  }
  return pendingRefresh;
}

/**
 * Invalidate the cached JWT.
 *
 * Call this after receiving a 401 or 403 from the Mimo API so the next
 * request bootstraps a fresh token.
 */
export function invalidateJwt(): void {
  cachedJwt = null;
  jwtExpiry = 0;
  pendingRefresh = null;
}
