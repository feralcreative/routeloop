# Status and Handoff

**Updated:** 2026-07-11
**Repo:** `mapbox` (this is the source-of-truth repo going forward)
**For:** the next agent picking up development

Read [\_AI_AGENT_PRIMER.md](../_AI_AGENT_PRIMER.md) first for architecture, then
this doc for exactly where things stand and what to do next. The full build plan
is [\_PLANS/multi-tenant-rebuild.md](../_PLANS/multi-tenant-rebuild.md).

## TL;DR

Moto-Rooter is being rebuilt from a single-tenant static viewer into a public,
multi-tenant PHP + MySQL app. **M0 (restructure) and M1 (one stored map renders
from the database) are complete and browser-verified.** The next milestone is
**M2 — accounts / social login**, which is partly blocked on OAuth credentials
only the owner can create (see below).

## What works right now

Hitting `/m/{slug}` renders a full interactive map (route polyline, direction
arrows, typed waypoint markers, tooltips, legend, and GPX/KML/URL download
buttons) driven entirely by the database and PHP endpoints — no files on disk in
the web root. Verified in a real browser: map tiles + polyline + 26 markers
render, mileage computes (185.2 mi on the seed route), the KML is fetched once
(the old double-fetch is gone), and the console is clean.

Built and lint-clean:

- `public/index.php` front controller + `app/Router.php`, `Config`, `Db`,
  `bootstrap.php`
- `app/Controllers/PublicController.php` — metadata JSON + gated KML/GPX
  streaming (realpath containment, visibility gating: private/unknown → 404)
- `app/Controllers/PageController.php` + `app/views/{view,home}.php`
- `public/js/main.js` — the ported viewer with its three seams rewired, four
  stored-XSS sites escaped, the `icon-wtf` path fixed, and per-map color unified
- `utils/schema.sql` — `users`, `user_identities`, `maps`

## Run it locally

The local dev environment is already set up on this machine:

- MariaDB is running; database `moto_rooter` exists with the schema loaded and
  one seeded public map
- `config.local.php` (git-ignored) points at it and at `./moto-storage`
- The seed map slug is in `moto-storage/.seed-slug`
  (currently `Zgn3ti1PzyCZehbQiwc3RP`)

```bash
cd /Users/ziad/www/moto/mapbox
npm install && npm run sass          # first time only
php -S 127.0.0.1:6686 -t public public/router.php
# open http://127.0.0.1:6686  (list)  and  /m/<slug>  (viewer)
```

Port 6686 is the project's designated port. Do not start a server on it without
the owner's OK (their standing rule).

On a fresh machine instead: create the DB, `mysql moto_rooter < utils/schema.sql`,
`cp config.example.php config.local.php` and fill it in, then seed a map (a row
in `maps` + a `.kml` under `storage_path/{owner_id}/{map_id}.kml`).

## Next: M2 — accounts (Google / GitHub sign-in)

The schema tables (`users`, `user_identities`) already exist. The plan's OAuth
section has the full flow. Concrete tasks:

1. `composer install` (composer.json already declares `league/oauth2-client`,
   `league/oauth2-google`, `league/oauth2-github`). The bootstrap already loads
   `vendor/autoload.php` when present.
2. Build `app/Auth/OAuth.php` (provider wiring, state + PKCE) and
   `app/Controllers/AuthController.php`.
3. Register routes in `public/index.php`: `GET /login`,
   `GET /auth/{provider}/start`, `GET /auth/{provider}/callback`,
   `POST /logout` (CSRF-checked).
4. Identity → user mapping: match `user_identities`; else link by verified
   email; else create a user + identity. Finish with
   `session_regenerate_id(true)`. Sessions are already started with hardened
   cookies in `app/bootstrap.php`.
5. A `/dashboard` shell (empty is fine for M2; it fills in during M3).

### Blocked on the owner — OAuth credentials

M2 cannot be tested end-to-end until these exist. Ask the owner to create them
and drop the values into `config.local.php` (`google` and `github` blocks):

- **Google** — an OAuth client in the Google Cloud console, redirect URI
  `http://127.0.0.1:6686/auth/google/callback` for dev → client id + secret
- **GitHub** — an OAuth app in Developer settings, callback
  `http://127.0.0.1:6686/auth/github/callback` → client id + secret

You can build and unit-check all the M2 code before the credentials arrive; only
the live sign-in test waits on them.

## Then M3 → M5

- **M3** — drag-and-drop upload, the full validation pipeline (Turnstile,
  XXE-safe parse rejecting `<!DOCTYPE>`, KML sanitization, server-side metadata
  extraction, transactional quota), and owner endpoints
  (list / delete / update visibility). Needs a Cloudflare Turnstile key.
- **M4** — public browse/discovery page and share-link UI.
- **M5** — DreamHost deploy (web dir → `public/`, secrets/storage outside the
  web root, Let's Encrypt, `composer install`, GCP referrer lock, cron).

Details for each are in the plan.

## Conventions and guardrails

- **Never commit or push.** When work reaches a checkpoint, hand the owner a
  terse commit message; they commit themselves.
- **SCSS** is compiled with `npm run sass` (the `sass` CLI), never an IDE
  extension. Source is `style/main.scss`; output is `public/style/main.min.css`.
- **Utility scripts** go in `utils/`; **docs** (besides README and the primer)
  go in `docs/`.
- **Security invariants** to preserve: visibility gating returns 404 (never
  confirm a private/unknown map exists); user files are served only through the
  ownership gate from outside the web root; user-derived strings are escaped
  before entering `innerHTML` (`esc()` in `main.js`); the upload pipeline must
  stay XXE-safe and path-safe.
- **Don't re-couple the viewer to the filesystem.** It reads from the API via
  `window.MOTO.metadataUrl` and the `/kml` endpoint; keep it that way.
- Follow the owner's markdown rules in docs (fenced blocks need a language, no
  `---` horizontal rules, blank lines around headings/lists/code).

## Provenance and the two-copies situation

The map engine was recovered from commit `0bdf2e2` of the original
`moto-rooter` repo. That original repo still holds the same M0+M1 work as
**uncommitted** changes on branch `refactor/public-version`. **This `mapbox`
repo is the source of truth.** Ignore or later discard the original's working
changes to avoid divergence.
