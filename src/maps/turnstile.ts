// Cloudflare Turnstile siteverify — bot defense in front of the upload
// pipeline, rejected before any file is touched.
//
// Feature-flagged: enforcement turns on when TURNSTILE_SECRET_KEY is set (and
// the dashboard renders the widget when TURNSTILE_SITE_KEY is set). Until the
// widget exists in the Cloudflare dash, dev and prod both run open.
const SECRET = process.env.TURNSTILE_SECRET_KEY ?? ''

export const TURNSTILE_SITE_KEY = process.env.TURNSTILE_SITE_KEY ?? ''
export const turnstileEnabled = (): boolean => SECRET.length > 0

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

// True when the token passes (or enforcement is off). Fails closed: if
// Cloudflare is unreachable, the upload is rejected, not waved through.
export async function verifyTurnstile(token: string, remoteIp?: string): Promise<boolean> {
  if (!turnstileEnabled()) return true
  if (!token) return false
  try {
    const body = new URLSearchParams({ secret: SECRET, response: token })
    if (remoteIp) body.set('remoteip', remoteIp)
    const res = await fetch(VERIFY_URL, { method: 'POST', body })
    if (!res.ok) return false
    const data = (await res.json()) as { success?: boolean; 'error-codes'?: string[] }
    if (!data.success) {
      console.warn('[turnstile] verification failed:', data['error-codes'] ?? [])
      return false
    }
    return true
  } catch (e) {
    console.error('[turnstile] siteverify unreachable:', e)
    return false
  }
}
