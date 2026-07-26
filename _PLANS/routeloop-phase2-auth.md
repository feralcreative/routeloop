# Phase 2 — Auth (Google + GitHub, server sessions)

**Created:** 2026-07-20
**Status:** in progress
**Depends on:** Phase 0/1 (built), Phase 5 deploy (done — stage and prod are live)

## Decisions taken

- **OAuth client: Arctic.** The older plan said Lucia, but Lucia is no longer a
  library — it is now a documentation site that teaches hand-rolled sessions and
  points at Arctic for OAuth. Sessions are ours either way; only the OAuth client
  was in question. Arctic keeps `state` and PKCE visible in our own code and
  stays runtime-agnostic, which protects the eventual Cloudflare Workers path.
- **Account linking: attach a second provider only on a verified email.** Google
  reports `email_verified` in the ID token; GitHub reports `verified` on
  `/user/emails`. Verified means both buttons reach one account. Unverified means
  a separate account, so nobody can claim an address they do not own.
- **Scope: auth + session + dashboard shell.** Owner actions (delete, visibility
  changes) and upload stay in Phase 3.

## Session design

Follows the Copenhagen Book / current Lucia guidance.

- Token: 24 random bytes from `crypto.getRandomValues`, hex-encoded, handed to
  the client in a cookie.
- Stored: the **SHA-256 hash** of that token is the primary key of `sessions`.
  A database leak therefore does not yield usable session cookies.
- Lifetime: 30 days, renewed when fewer than 15 days remain, so active users are
  not logged out on a fixed schedule.
- Cookie: `HttpOnly`, `SameSite=Lax`, `Path=/`, and `Secure` whenever
  `APP_ORIGIN` is https. Lax still permits the OAuth callback redirect.

`users.email` holds **only verified addresses**. An unverified provider email is
kept on `user_identities.provider_email` and left off the user row, which also
keeps the unique index on `users.email` from colliding.

## Files

```text
src/db/schema.ts        + sessions table
src/auth/session.ts     token generation, hashing, create/validate/invalidate
src/auth/oauth.ts       Arctic Google + GitHub clients, env-driven redirect URIs
src/auth/middleware.ts  session resolution, requireAuth
src/routes/auth.ts      /login, /auth/{provider}, /auth/{provider}/callback, /logout
src/routes/dashboard.ts /dashboard — the signed-in user's own maps
src/index.ts            mount the routers, header reflects auth state
```

## Flow

1. `GET /auth/google` — generate `state` + PKCE `code_verifier`, store both in
   short-lived `HttpOnly` cookies, redirect to Google.
2. `GET /auth/google/callback` — compare returned `state` to the cookie, reject
   on mismatch, exchange the code, decode the ID token for
   `sub` / `email` / `email_verified` / `name` / `picture`.
3. Resolve the user:
   - identity `(provider, provider_user_id)` already exists → that user;
   - else verified email matching an existing user → attach a new identity;
   - else → create user + identity in one transaction.
4. Create a session, set the cookie, redirect to `/dashboard`.

GitHub differs in two ways: no PKCE (GitHub OAuth Apps do not implement it, so
`createAuthorizationURL` takes state only), and the email arrives from
`/user/emails` rather than an ID token — pick the entry that is both primary and
verified.

## Credentials the owner must create

Only the account owner can create these; the code cannot be tested without them.

- **Google** — one OAuth 2.0 Web Application client, which accepts several
  redirect URIs, so one client covers every environment:
  - `http://127.0.0.1:6686/auth/google/callback`
  - `https://stage.routeloop.app/auth/google/callback`
  - `https://routeloop.app/auth/google/callback`
- **GitHub** — an OAuth App exposes a single Authorization callback URL field,
  so this likely needs one app per environment. Verify before creating three.

New environment variables: `APP_ORIGIN`, `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`. These must
also be piped through `deploy.sh` into the remote `.env` and referenced in
`docker-compose.prod.yml`, exactly as `GMAPS_KEY` is today.

## Deliberately out of scope

- Private maps remain invisible to their owners — `getViewable()` is unchanged
  until Phase 3/4 widen it.
- No account deletion, no provider unlinking, no email change.
- No CSRF tokens: logout is a POST and the session cookie is `SameSite=Lax`,
  which covers the write surface that exists at this point. Revisit in Phase 3
  when real mutations land.

## Verification

- Sign in with each provider on dev, confirm one `users` row and one
  `user_identities` row per provider.
- Sign in with the second provider on the same verified email, confirm the
  identity attaches rather than creating a duplicate user.
- Confirm `/dashboard` 302s to `/login` when signed out.
- Confirm the session cookie carries `HttpOnly`, `SameSite=Lax`, and `Secure`
  once deployed behind the tunnel.
- Confirm a tampered `state` parameter is rejected.
