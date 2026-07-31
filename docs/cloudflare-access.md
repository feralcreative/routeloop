# Cloudflare Access

**Updated:** 2026-07-26
**State:** ⚠️ **being retired.** Still enforcing on prod and stage, open to one address (`ziad@feralcreative.co`) via Google only — but the application code that consumes it has already been deleted on `refactor/google-maps-and-auth`.

## Why this is going away

Cloudflare Zero Trust is billed **per seat**: free to 50 users, then $7/user/month applied to *every* user, with no partial billing. That is $700/month at 100 riders and $70,000 at 10,000. It is an employee-access product, and it cannot survive opening signups — see [decisions-auth-and-search.md](decisions-auth-and-search.md).

It is replaced by Google OAuth plus an emailed magic link, both owned by the app. `users.status` continues to do the authorization that the Access allowlist used to do, which is the part worth keeping: approving a rider is now a column you control rather than a dashboard edit in two places.

## The decommissioning order, which matters

`src/auth/access.ts` and its trust of the `Cf-Access-Authenticated-User-Email` header are **already deleted in the working tree**. That header was safe only because Access sat in front of `/auth/cloudflare` and controlled it.

1. Ship the new auth code to an environment.
2. Confirm Google sign-in and magic link both work there.
3. **Only then** remove that environment's Access policy and application.

Reverse those and there is a window where the *deployed* build still trusts the header while nothing sets it — anyone who can reach the origin mints a session for any address. Prod and stage are separate policy objects and must be done independently.

Everything below documents the system as it currently stands, for as long as it stands. It stops being true once step 3 runs.

tankbag uses Cloudflare Access for authentication while keeping authorization and sessions in the application. Only the login bridge is protected, so public and unlisted ride links stay reachable without an Access session.

## How it works

Access authenticates at the edge and injects `Cf-Access-Authenticated-User-Email`. The application — in `src/auth/access.ts`, now deleted — normalized and validated that address, linked it to an existing user with the same verified email when one existed, added a `cloudflare` row to `user_identities`, and created the normal tankbag session. Missing or malformed identity headers failed closed. `/auth/cloudflare` ([src/routes/auth.ts](../src/routes/auth.ts)) is the only path that needs a policy.

Direct Google/GitHub OAuth was removed in this work — `src/auth/oauth.ts` is deleted and the `arctic` dependency is uninstalled. Cloudflare owns the upstream login and the allowlist; the app owns users, sessions, and ride ownership.

Trusting an inbound header is only safe because the origin is unreachable except through the tunnel. Two guards back that up:

- The Access application intercepts `tankbag.app/auth/cloudflare` at the edge, so an external request carrying a forged header never reaches the origin.
- The legacy `tankbag.app` / `stage.tankbag.app` tunnel routes reach the **same containers**, and those paths are *not* covered by the Access applications — so the `LEGACY_HOSTS` middleware in [src/index.ts](../src/index.ts) 301s each legacy host to its own canonical host before any auth code runs. Verified on both: a forged `Cf-Access-Authenticated-User-Email` gets the redirect, not a session. Note that stage maps to *stage*, not prod — a legacy host must never redirect across environments.

If another hostname is ever pointed at either container, it must get its own Access application or an entry in `LEGACY_HOSTS`. Treat that as a standing invariant: an unprotected hostname on an Access-trusting origin is a full auth bypass.

## Live Cloudflare configuration

Team domain: `feralcreative.cloudflareaccess.com`

One self-hosted application per environment, both identical in shape:

```text
Application   tankbag Login                 tankbag Login (stage)
ID            252ee150-1024-4c0a-…-2a9592af25ea   ca61b858-9c6e-470e-…-afb9cc847cb5
Destination   tankbag.app/auth/cloudflare   stage.tankbag.app/auth/cloudflare
AUD           4d8d1f15839331605…dbe875b       (see dashboard)
Session       24h                             24h
Launcher      hidden                          hidden
Allowed IdP   Google only                     Google only
Auto-redirect on                              on
Policy        tankbag Owner (allow)         tankbag Owner (allow)
              c353c663-f8b3-45d8-…            949969b4-ba43-4e2b-…
```

Verified live on **both** hosts: `/auth/cloudflare` 302s to the Access login for its own AUD, a forged `Cf-Access-Authenticated-User-Email` never reaches the origin, the legacy host 301s away before any auth code runs, and `/login` still serves publicly while signed out.

### Identity providers

The account has two login methods configured:

```text
eb8c3be3-b566-4ba3-9ec9-aebeb6faff50   Google        (type: google)
9cfb8432-fbcb-497f-b6c9-dc524923e451   One-time PIN  (type: onetimepin)
```

Both tankbag apps set `allowed_idps` to **Google only**, with `auto_redirect_to_identity` on so the login-method chooser is skipped. This matters: leaving `allowed_idps` empty means Access offers *every* configured method, and one-time PIN emails a code to the address in the policy — a second way in that bypasses Google SSO and whatever 2FA sits behind it. Keep the IdP pinned.

There is exactly one reusable Access **group** in the account (`vmc`); the six-address "ZR Personal Projects" list on `print.ezzat.com` is an inline policy, not a group, so it cannot simply be referenced from here.

## Authentication at the edge, authorization in the app

As of Sprint 2 the two are separate concerns, and the split matters for anyone changing either half.

Whatever authenticates — Access before, Google OAuth and magic link after — answers *who is this*. `users.status` (`pending` | `active` | `blocked`) answers *may they use tankbag*, and that half is unchanged by the migration. [resolveUser](../src/auth/identity.ts) creates every genuinely new account as `pending`; only `OWNER_EMAIL` is created `active`, and linking an existing same-email user never changes an existing status. `requireActive` and `requireActiveApi` ([src/auth/middleware.ts](../src/auth/middleware.ts)) gate every signed-in page and every owner API, sending pending riders to `/welcome` and returning **403** rather than 401 to API callers — a pending rider holds a perfectly valid session, so 401 would loop them through a pointless re-login.

`status` defaults to `'active'` on purpose. `drizzle-kit push` stamps a NOT NULL default onto every existing row, so a `'pending'` default would demote the owner and lock them out of the app that does the approving.

This separation is what makes removing Access survivable at all: the edge stops being the gate, and the app was already the one deciding. It is also why the allowlist below never needs widening — it gets deleted instead.

Approving a rider is one statement until the Sprint 3 admin panel exists:

```sql
UPDATE users SET status = 'active' WHERE email = 'rider@example.com';
```

## The allowlist

Exactly one address can sign in, on both prod and stage. Anyone else is denied at the edge.

```text
Policy   tankbag Owner
Decision allow
Include  email = ziad@feralcreative.co
Prod     c353c663-f8b3-45d8-b4db-b64cb4721c10
Stage    949969b4-ba43-4e2b-885c-44f27c82d173
```

The two policies are separate objects and must be edited in both places.

The app was briefly configured with **no** policy at all, which default-denied everyone including the owner. That is what an empty `policies` array means — it is not a partially-configured allowlist, it is a closed door. If sign-in ever needs to be shut again, removing this policy is sufficient.

To widen the list later, add addresses to the `include` array of that policy. `print.ezzat.com` carries the fuller "ZR Personal Projects" list (the two gmail, two feralcreative.co, and two cannonballcreative.agency addresses) and is the natural template if tankbag should match it.

The contact address for the project is still **undecided** and unrelated to this allowlist — it will be some address other than the ones in use today. Nothing in the codebase depends on it yet: there is no `mailto:`, contact link, or support address anywhere in the app, and the only email in the source is the local dev seed user (`demo@tankbag.app` in [src/db/seed.ts](../src/db/seed.ts)).

## API token scopes

`CLOUDFLARE_API_TOKEN` in `.env` was verified against every operation this project needs (2026-07-25):

```text
✅ Access: Apps and Policies — Edit      created both apps + policies
✅ Access: Organizations, IdPs, Groups   enumerated IdPs and groups
✅ Cloudflare Tunnel — Read/Edit         rewrote tunnel ingress (v2 → v3)
✅ Zone / DNS — Read/Edit                created the stage.tankbag.app CNAME
✅ Cache Purge                           deploy hook purges successfully
```

One cosmetic quirk: `GET /user/tokens/verify` reports the token as `1000 Invalid API Token` even though every scoped call against it succeeds. Ignore it — it is not a real failure, and it will look alarming if you verify the token from the dashboard or CLI.

Two API shape notes, both of which cost time to discover:

- Access applications **cannot** be updated with `PATCH` — it returns `10405 Method not allowed for this authentication scheme`. Use `PUT` with the full object, and include `policies` as `[{id, precedence}]` or the PUT will detach them.
- Tunnel configuration is a **whole-config PUT**. There is no per-route endpoint, so a careless write silently drops every other hostname on the tunnel. Always GET the current config, modify the `ingress` array, keep the catch-all (`http_status:404`) last, and preserve sibling keys like `warp-routing`.

An alternative worth considering when stage exists: enable **Protect with Access** on the matching Tunnel public-hostname route, so `cloudflared` validates the Access token before proxying. It is not enabled today — enforcement is purely the edge application — and the host-redirect guard above is what covers the gap.

## Local development

Set `DEV_AUTH_EMAIL` in `.env`, open `/login`, and select **Continue with Google**. Local requests never pass through Cloudflare, so `accessEmail()` falls back to that value. The fallback is ignored whenever `APP_ORIGIN` uses HTTPS, so it cannot impersonate a production user.

## Verification checklist

1. Apply the schema with `npx drizzle-kit push` so the `provider` enum includes `cloudflare`.
2. In an incognito window, open `/login` and continue through Google.
3. Confirm Access rejects a non-allowlisted account.
4. Confirm the successful request creates one local session and links an existing same-email user instead of duplicating it.
5. Confirm private rides remain visible to their owner and public ride links still work while signed out.
6. Confirm `tankbag.app/auth/cloudflare` still 301s instead of authenticating.
7. Sign out and confirm both the tankbag session and the Cloudflare Access application cookie are cleared.
