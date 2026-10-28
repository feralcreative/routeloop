// The rules of Routeloop's minimal OAuth 2.1 server, which exists for one client
// kind: a remote MCP connector (Claude, ChatGPT, the MCP Inspector) acting as a
// rider. PURE; service.ts is the only module here that touches a table.
//
// PUBLIC CLIENTS ONLY, PKCE S256 ALWAYS. A connector registers itself dynamically
// and holds no secret worth the name, so the code verifier is what proves the
// party redeeming a code is the party that asked for it. `plain` is refused.
import { createHash } from 'node:crypto'

export const CODE_TTL_MS = 10 * 60 * 1000
export const ACCESS_TTL_MS = 60 * 60 * 1000
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000
export const MAX_REDIRECT_URIS = 5

/**
 * Where a code may be sent. https anywhere, or http to this machine only, which
 * is what a desktop client and the Inspector listen on. Anything else (a custom
 * scheme, a fragment, embedded credentials) is refused, because a redirect URI is
 * where a rider's authorization lands.
 */
export function validRedirectUri(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length > 2000) return false
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  if (u.hash || u.username || u.password) return false
  if (u.protocol === 'https:') return true
  return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]')
}

/** base64url(SHA-256(verifier)), the S256 transform from RFC 7636. */
export const s256 = (verifier: string) => createHash('sha256').update(verifier).digest('base64url')

/** RFC 7636: 43 to 128 characters from the unreserved set. */
export const validVerifier = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9._~-]{43,128}$/.test(v)
export const validChallenge = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{43,128}$/.test(v)

/** The redirect back to the client, carrying either a code or an error. */
export function redirectWith(uri: string, params: Record<string, string | undefined>): string {
  const u = new URL(uri)
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v)
  return u.toString()
}
