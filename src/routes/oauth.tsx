// OAuth 2.1 for the MCP server: discovery, dynamic client registration, the
// consent page, and the token endpoint. Rules in src/oauth/policy.ts, storage in
// src/oauth/service.ts.
//
// SIGN-IN IS THE SITE'S OWN. The consent page reads the ordinary session, so a
// rider authorizes a connector with whatever got them into Routeloop (Google or
// the magic link) and nothing here ever sees a password. Sign-in has no return
// path yet, so a signed-out rider is sent to sign in in another tab and comes
// back to press Continue; that gap is recorded, not designed.
//
// CORS IS OPEN ON THE MACHINE ENDPOINTS AND ONLY THERE. Discovery, registration
// and the token exchange are called by clients that may run in a browser (the
// Inspector does), carry no cookie, and authenticate by what they post. The
// consent page is the one endpoint that reads a session, and it keeps the
// same-origin gate every other form has.
import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import { APP_ORIGIN } from '../config'
import { requireSameOrigin, type AuthEnv } from '../auth/middleware'
import { allow, clientIp } from '../auth/ratelimit'
import { page } from '../views/layout'
import { MAX_REDIRECT_URIS, redirectWith, validChallenge, validRedirectUri, validVerifier } from '../oauth/policy'
import { clientById, issueCode, pruneExpired, redeemCode, refresh, registerClient, revokeApp } from '../oauth/service'
import { currentUser, requireActive } from '../auth/middleware'

export const oauthRoutes = new Hono<AuthEnv>()

const open = cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'mcp-protocol-version'],
})

const resourceMetadata = () => ({
  resource: `${APP_ORIGIN}/mcp`,
  authorization_servers: [APP_ORIGIN],
  bearer_methods_supported: ['header'],
})

oauthRoutes.use('/.well-known/oauth-*', open)
oauthRoutes.use('/oauth/register', open)
oauthRoutes.use('/oauth/token', open)
oauthRoutes.use('/mcp', open)

// Both spellings: the bare document and the one suffixed with the resource path,
// which some clients ask for first.
oauthRoutes.get('/.well-known/oauth-protected-resource', (c) => c.json(resourceMetadata()))
oauthRoutes.get('/.well-known/oauth-protected-resource/mcp', (c) => c.json(resourceMetadata()))

oauthRoutes.get('/.well-known/oauth-authorization-server', (c) =>
  c.json({
    issuer: APP_ORIGIN,
    authorization_endpoint: `${APP_ORIGIN}/oauth/authorize`,
    token_endpoint: `${APP_ORIGIN}/oauth/token`,
    registration_endpoint: `${APP_ORIGIN}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
  }),
)

// DYNAMIC CLIENT REGISTRATION (RFC 7591), public clients only. Rate limited by
// address because it is the one unauthenticated write here.
oauthRoutes.post('/oauth/register', async (c) => {
  if (!allow('oauth-register', clientIp(c.req.raw.headers), { max: 20, windowMs: 60 * 60 * 1000 })) {
    return c.json({ error: 'slow_down' }, 429)
  }
  const body = (await c.req.json().catch(() => null)) as { client_name?: unknown; redirect_uris?: unknown } | null
  const uris = Array.isArray(body?.redirect_uris) ? body.redirect_uris : []
  if (uris.length === 0 || uris.length > MAX_REDIRECT_URIS || !uris.every(validRedirectUri)) {
    return c.json({ error: 'invalid_redirect_uri' }, 400)
  }
  const name =
    typeof body?.client_name === 'string' && body.client_name.trim() ? body.client_name.trim() : 'An MCP client'
  void pruneExpired().catch(() => {})
  const id = await registerClient(name, uris as string[])
  return c.json(
    {
      client_id: id,
      client_name: name,
      redirect_uris: uris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    },
    201,
  )
})

type AuthRequest = { clientId: string; redirectUri: string; challenge: string; state: string | undefined }

/** Validates an authorization request. An unknown client or a redirect URI it did
 *  not register gets an error PAGE, never a redirect: sending the rider to an
 *  unvalidated URI is the open redirect this check exists to close. */
async function readRequest(
  q: Record<string, string | undefined>,
): Promise<{ ok: true; req: AuthRequest; name: string } | { ok: false; why: string; back?: string }> {
  const client = q.client_id ? await clientById(q.client_id) : null
  if (!client) return { ok: false, why: 'That app is not registered with Routeloop.' }
  if (!q.redirect_uri || !client.redirectUris.includes(q.redirect_uri))
    return { ok: false, why: 'That app asked to return somewhere it did not register.' }
  const back = q.redirect_uri
  if (q.response_type !== 'code') return { ok: false, why: 'unsupported_response_type', back }
  if (q.code_challenge_method !== 'S256' || !validChallenge(q.code_challenge))
    return { ok: false, why: 'invalid_request', back }
  return {
    ok: true,
    name: client.name,
    req: { clientId: client.id, redirectUri: back, challenge: q.code_challenge, state: q.state },
  }
}

function errorPage(c: Context<AuthEnv>, message: string) {
  return c.html(
    page({
      title: 'Connect an app',
      user: c.get('user') ?? null,
      body: `<section class="narrow"><h1>Can’t connect that app</h1><p>${escapeHtml(message)}</p></section>`,
    }),
    400,
  )
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`)

oauthRoutes.get('/oauth/authorize', async (c) => {
  const q = c.req.query()
  const read = await readRequest(q)
  if (!read.ok) {
    if (read.back) return c.redirect(redirectWith(read.back, { error: read.why, state: q.state }), 302)
    return errorPage(c, read.why)
  }
  const user = c.get('user')
  const self = c.req.url
  if (!user) {
    return c.html(
      page({
        title: 'Connect an app',
        user: null,
        body: `<section class="narrow">
  <h1>Sign in to connect ${escapeHtml(read.name)}</h1>
  <p>Sign in to Routeloop in another tab, then come back here and press Continue.</p>
  <p><a class="btn" href="/login" target="_blank" rel="noopener">Sign in</a> <a class="btn-quiet" href="${escapeHtml(self)}">Continue</a></p>
</section>`,
      }),
    )
  }
  const hidden = Object.entries({
    client_id: read.req.clientId,
    redirect_uri: read.req.redirectUri,
    code_challenge: read.req.challenge,
    code_challenge_method: 'S256',
    response_type: 'code',
    state: read.req.state ?? '',
  })
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${escapeHtml(v)}">`)
    .join('\n    ')
  return c.html(
    page({
      title: 'Connect an app',
      user,
      body: `<section class="narrow oauth-consent">
  <h1>Let ${escapeHtml(read.name)} plan with you?</h1>
  <p class="oauth-where">If you allow it, you will be sent back to <strong>${escapeHtml(new URL(read.req.redirectUri).host)}</strong>. “${escapeHtml(read.name)}” is the name the app gave itself, so only allow it if you just asked an app you trust to connect to&nbsp;Routeloop.</p>
  <p>It will be able to read the rides you are on, search for places, and add, move and remove stops on rides you can edit, as you. It cannot delete a ride, change who can see one, or read your private stop details on anyone else’s&nbsp;ride.</p>
  <p>You can disconnect it any time in Preferences.</p>
  <form method="post" action="/oauth/authorize">
    ${hidden}
    <button type="submit" class="btn" name="decision" value="allow">Allow</button>
    <button type="submit" class="btn-quiet" name="decision" value="deny">Don’t allow</button>
  </form>
</section>`,
    }),
  )
})

oauthRoutes.post('/oauth/authorize', requireActive, requireSameOrigin, async (c) => {
  const body = (await c.req.parseBody()) as Record<string, string | undefined>
  const read = await readRequest(body)
  if (!read.ok) {
    if (read.back) return c.redirect(redirectWith(read.back, { error: read.why, state: body.state || undefined }), 302)
    return errorPage(c, read.why)
  }
  const state = read.req.state || undefined
  if (body.decision !== 'allow')
    return c.redirect(redirectWith(read.req.redirectUri, { error: 'access_denied', state }), 302)
  const code = await issueCode(read.req.clientId, currentUser(c).id, read.req.redirectUri, read.req.challenge)
  return c.redirect(redirectWith(read.req.redirectUri, { code, state }), 302)
})

oauthRoutes.post('/oauth/token', async (c) => {
  void pruneExpired().catch(() => {})
  const body = (await c.req.parseBody()) as Record<string, string | undefined>
  const fail = (error: string) => c.json({ error }, 400)
  if (!body.client_id) return fail('invalid_client')
  if (body.grant_type === 'authorization_code') {
    if (!body.code || !body.redirect_uri || !validVerifier(body.code_verifier)) return fail('invalid_request')
    const tokens = await redeemCode({
      code: body.code,
      clientId: body.client_id,
      redirectUri: body.redirect_uri,
      verifier: body.code_verifier,
    })
    return tokens ? c.json(tokens) : fail('invalid_grant')
  }
  if (body.grant_type === 'refresh_token') {
    if (!body.refresh_token) return fail('invalid_request')
    const tokens = await refresh(body.refresh_token, body.client_id)
    return tokens ? c.json(tokens) : fail('invalid_grant')
  }
  return fail('unsupported_grant_type')
})

// Disconnecting an app from Preferences: every token it holds for this rider.
oauthRoutes.post('/settings/apps/revoke', requireActive, requireSameOrigin, async (c) => {
  const body = await c.req.parseBody()
  if (typeof body.client_id === 'string') await revokeApp(currentUser(c).id, body.client_id)
  return c.redirect('/settings?saved=apps#apps', 303)
})
