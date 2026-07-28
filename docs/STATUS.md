# Status and handoff

**Updated:** 2026-07-26
**Branch:** `refactor/google-maps-and-auth`, based on `2a96dae`
**For:** the next agent, or the owner returning cold

Read [\_AI_AGENT_PRIMER.md](../_AI_AGENT_PRIMER.md) for architecture, then this
for where things actually stand. This document is the one that gets stale
fastest; if it disagrees with the code, the code is right.

## TL;DR

routeloop is a ride **planning / sharing / organizing** app, not navigation. It
is live at `routeloop.app` on a Synology NAS behind Cloudflare Tunnel.

Two migrations are in flight on this branch, both decided on 2026-07-26:

| | Was | Is becoming | State |
| --- | --- | --- | --- |
| Auth | Cloudflare Access | Google OAuth + magic link, owned by the app | **code done**, uncommitted, needs credentials |
| Maps | Mapbox GL + Directions + Geocoding | Google Maps JS + Places + Routes | **not started** |

Everything through Sprint 2 (user profiles) is committed and merged. Everything
described under "In flight" below is uncommitted working tree.

## Why these two migrations

Both are recorded in full in
[decisions-auth-and-search.md](decisions-auth-and-search.md); the short version:

**Auth.** Cloudflare Access is billed per seat — $7/user/month for *every* user
once you pass 50, with no partial billing. That is $700/month at 100 users and
$70,000 at 10,000. It is an employee-access product, and it cannot survive
opening signups. The migration was never optional, only deferred.

**Maps.** Place search on Mapbox Geocoding is not good enough for finding
businesses. Google's terms forbid displaying Places content on a non-Google map,
so "keep Mapbox rendering, use Google search" is not available — it is the whole
engine or nothing. Cost is close between the two at scale (~20% apart at 100,000
users); the argument against Google is the one-way migration, not the bill.

<!--| PAGE-BREAK -->

## Done and committed

**Through `2a96dae`:** the pivot from file-upload to in-app planning (Phases 0–2),
the `tankbag` → `routeloop` rename with production cutover, the unified page
shell and SCSS partial split, the sign-in splash with its background clip, and
Sprint 2's user profiles.

**Sprint 2 specifically** ([_PLANS/sprint-02-260726T1731Z.md](../_PLANS/sprint-02-260726T1731Z.md)):

- `users.status` (`pending` | `active` | `blocked`) — the authorization gate, and
  the thing that lets the audience stay small on a NAS while the door is open.
  `requireActive` / `requireActiveApi` in
  [src/auth/middleware.ts](../src/auth/middleware.ts) enforce it; a pending rider
  gets `/welcome` and a **403** from the API, never a 401.
- `user_profiles` — names, address, geocoded home point, payment handles,
  sharing toggles. Kept off the `users` row deliberately: `withSession` selects
  that row on every request and `jsonScript` serializes objects into page HTML,
  so a street address and four payment handles have no business on the hot path.
- `/profile` as an HTML form POST with inline errors, `/welcome` as the holding
  page, and a home-address stop the builder seeds on new rides only.

**Deferred from Sprint 2, deliberately:** Places (the saved-locations feature) is
still unbuilt — it was a whole phase of its own and would have doubled the
sprint. The rider list is a capability flag with no implementation behind it,
because lookup by email or phone is a user-enumeration surface that wants rate
limiting before it exists.

## In flight — uncommitted on this branch

### Auth: done in code, blocked on credentials

Cloudflare Access is **gone from the codebase**. `src/auth/access.ts` is deleted
along with the `Cf-Access-Authenticated-User-Email` trust and the
`DEV_AUTH_EMAIL` fallback.

New modules:

- [src/auth/identity.ts](../src/auth/identity.ts) — `resolveUser()`, provider-
  agnostic. Links to an existing verified-email user where one exists, creates as
  `pending` otherwise, `OWNER_EMAIL` as `active`, and never demotes an existing
  account. Takes an optional transaction handle.
- [src/auth/google.ts](../src/auth/google.ts) — Arctic OAuth, state + PKCE in
  `SameSite=Lax` cookies. Rejects an id token whose email is not verified, which
  is load-bearing because `resolveUser` links accounts by email.
- [src/auth/magic.ts](../src/auth/magic.ts) — emailed links. Only the SHA-256
  hash is stored, single-use, 15-minute expiry, rate limited per address and per
  IP.
- [src/auth/mailer.ts](../src/auth/mailer.ts) — nodemailer over SMTP.

Both methods are **feature-flagged by omission**: with no credentials the
controls are not rendered at all, rather than offered and broken.

Verified against the running app: the forged-header regression test (no session,
no cookie), magic-link single-use and expiry, pending gating, and cross-provider
linking — one address arriving by Google and by email produces one user with two
identities, still `active`.

### Maps: not started

`map-common.js`, `viewer.js`, `builder.js` and `profile.js` are still Mapbox. The
plan and its findings are in the plan file; the short version is that the
migration is smaller than it looks — only six of `map-common.js`'s thirteen
exports touch `mapboxgl`, the stylesheet has zero `mapboxgl-*` selectors, and
Routes API can return GeoJSON so `route_legs.geometry` needs no migration.

<!--| PAGE-BREAK -->

## Blocked on you, in the console

Nothing below can be done from code — Google publishes no API for OAuth clients,
and gcloud's tokens on this machine have expired.

1. **OAuth client + consent screen.** Scopes must be exactly
   `openid` + `email` + `profile`; anything sensitive or restricted caps the app
   at 100 users pending review. → `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.
2. **A Gmail app password** for magic-link SMTP, on an account **separate from
   the OAuth client**. → `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`.
3. **A Map ID** (vector). Advanced Markers do not render without one — they fail
   with a console warning and no marker, which reads as a data bug. →
   `GMAPS_MAP_ID`.
4. **The browser API key**, referrer-restricted. → reuse `GMAPS_KEY`.
5. **The server API key**, IP-restricted to the NAS egress address. →
   `GMAPS_SERVER_KEY`.
6. Privacy policy and terms pages — required fields for a published external
   consent screen, and neither exists.
7. Per-API daily quota caps. A budget alert reports the money after it is spent.

Full instructions in [google-cloud-setup.md](google-cloud-setup.md).

### The sequencing that matters

**Deploy the new auth code before removing the Cloudflare Access policy.** In the
window between pulling the policy and shipping the code that stops trusting the
injected header, the deployed build is wide open — anyone who can reach the
origin can mint a session for any address. The order is not a preference.

## Known risks

- **Coordinate order** is the likeliest bug in the maps migration. Mapbox is
  `[lng, lat]`, Google is `{lat, lng}`, and `route_legs.geometry` stores Mapbox
  order. Getting it backwards still renders — just in the wrong place, or subtly
  off. Route every conversion through one named helper.
- **Google's free tiers are much smaller.** Dynamic Maps is 10,000 loads/month
  against Mapbox's 50,000; Routes is 10,000 against Directions' 100,000. Quota
  caps before traffic, not after.
- **The Mapbox token still appears unrestricted.** A style request with `Referer`
  set to four different hosts returned 200 for all four. Irrelevant once Mapbox
  is gone, but it is billable to this account until then.
- **The NAS egress IP.** The server key's IP restriction assumes it is static.
  Cloudflare Tunnel means inbound does not need one, which makes it easy to
  forget outbound still does. On a residential line an IP change silently breaks
  server-side Routes and Geocoding while the browser key keeps working.
- **Gmail sending caps** at roughly 2,000 recipients/day on Workspace, 500 on a
  consumer account. Fine for an alpha, a wall later.
- **Schema is push-only.** No `drizzle/` directory, no generated migrations. Run
  `npx drizzle-kit push` without `--force` and read the statement list first —
  riders now hold data that cannot be rebuilt from an uploaded file.

<!--| PAGE-BREAK -->

## Local development

```bash
cd /Users/ziad/www/moto/routeloop
npm install
cp .env.example .env          # see the file for what each value is for
docker compose up -d --wait db
npx drizzle-kit push
npx tsx src/db/seed.ts        # demo user + sample ride
npm run dev                   # http://localhost:6686
```

Port 6686 is this project's port — kill and reuse it, never switch.

- There is a shared tmux session named `shared` for terminal work. The dev server
  runs in its own window (`Ctrl-b 1`); backgrounding it in the main window gets it
  **suspended on tty input**, where it holds the port and answers nothing. If
  requests hang with the port bound, that is the cause — `kill -CONT` then
  `kill -9`, since SIGTERM never reaches a stopped process.
- Browse at `localhost`, not `127.0.0.1`, while Mapbox is still in place.
  `isAllowedOrigin` accepts both, so CSRF passes either way.
- `public/style/main.min.css` is a gitignored build artifact — `npm run sass`.
- `.prettierrc` exists now: width 120, single quotes and no semicolons for
  `src/`, with overrides so `public/js` keeps its double quotes and semicolons
  and SCSS keeps double-quoted strings. It was measured against the tree, not
  guessed, but the repo was never uniformly formatted so a few files will shift
  on first save.

## Deploy

```bash
./utils/deploy/stage.sh --dry-run
./utils/deploy/stage.sh             # stage.routeloop.app
./utils/deploy/prod.sh              # routeloop.app
```

Prod refuses a dirty tree or a non-`main` branch; `--force` bypasses both gates
at once but never the confirmation. Stage has neither gate, so it works from a
feature branch — that is the one to use for this branch.

Unlike the last handoff, **production now corresponds to a commit**: the whole
pivot was committed in seven commits on 2026-07-26 and merged. The deploy is
reproducible again.

The container runs as the host uid (`APP_UID`/`APP_GID` in `deploy.config`)
because the Synology ACL grants nothing to uid 1000. The symptom if that
regresses: a working ride list with silently 404-ing route files.

## Conventions

- **Never commit, push, or deploy without explicit permission.** Hand over a
  commit message instead. No AI co-author attribution, ever.
- SCSS compiles with `npm run sass`, never an IDE extension.
- Utility scripts in `utils/`; docs other than the README and primer in `docs/`.
- Markdown: fenced blocks need a language, no `---` rules, blank lines around
  headings, lists and code.
