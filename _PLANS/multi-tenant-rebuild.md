# Moto-Rooter — Multi-Tenant Rebuild (LAMP on DreamHost)

## Context

Moto-Rooter began as a single-person tool: one owner dropped `.kml`/`.gpx` files into `demo/data/` over SSH, and an Express server injected the Google Maps key so a vanilla-JS viewer could render the routes. In August 2025 the entire viewer (`js/main.js`, the `demo/` page, and the sample data) was torn out in one commit (`8ce3cd9`) to begin a "complete refactor," and the rebuild was never committed. The working tree today is a skeleton: a ~90-line key injection server and an `index.html` that renders a background image.

The goal now is a genuine pivot: turn this into a **public, multi-tenant website** where friends (and randos) sign up, upload their own map files through a web UI, get per-user storage with quotas, and share routes for road trips — no more SSH-only, single-tenant workflow.

The single most valuable asset survives in git history: the ~1154-line client-side map engine at commit `0bdf2e2` (parent of the teardown). It is **hosting-agnostic browser code** and is reused nearly as-is.

## Locked Decisions

- **Hosting:** DreamHost shared (already owned, $0 marginal cost). This means a **PHP 8.3 + MySQL** backend — Node is not available on DreamHost shared, so the old Express server is retired (little lost; it was near-obsolete).
- **Auth:** Social login (Google + GitHub) via OAuth in PHP (`league/oauth2-client`), PHP native sessions.
- **Scope (Fuller v1):** accounts, web upload UI, per-user storage + quotas, profile/dashboard, public browse/discovery, shareable public view links. Deferred: embeds, club branding, email-route-files, multi-page nav.
- **Dependencies:** minimal. Hand-rolled front controller (no framework); Composer used only for OAuth. All else is PHP built-ins (PDO, DOMDocument, cURL, sessions, `random_bytes`).
- **Bot defense:** Cloudflare Turnstile (free; JS widget + PHP siteverify).
- **Map provider:** keep Google Maps (viewer ports as-is). MapLibre is a flagged later escape hatch if Maps billing ever bites — not built now.

## Why the Viewer Ports Cleanly

The engine is source-agnostic except for **three filesystem seams**. Rewire those to a DB + gated storage and everything else (KML parsing, polylines + direction arrows, mileage, the waypoint role/synonym/icon model, tooltips, legend, hover highlight, colored SVG icons) is reused unchanged.

- **Seam 1** — `fetch("data/routes.json")` in `initMap` → `GET /api/public/maps/{slug}` (metadata from MySQL).
- **Seam 2** — `fetch("data/{base}.kml")` in `loadAllKmlRoutes` / `loadKmlRoute` → `GET /api/public/maps/{slug}/kml` (gated stream). Also fix the confirmed **double-fetch/double-parse** here by passing the already fetched KML text into `loadKmlRoute`.
- **Seam 3** — the `HEAD`/`fetch` probes for `.gpx`/`.url` in `addRouteDownloadButtons` → driven off metadata fields, not disk probes.

Plus a **security fix landing in the same file**: the viewer builds InfoWindow and label `innerHTML` from KML `<name>`/`<description>` with no escaping — a stored-XSS vector. Add an `e()` escaper and wrap the interpolations.

## Target Architecture (DreamHost shared)

Apache + mod_rewrite + PHP 8.3 + MySQL. Single front controller; static assets served directly. **User KML/GPX bodies never live in the webroot** — they sit in a private dir streamed only through a PHP ownership/visibility gate.

```text
/home/USER/
├── moto-config/config.php      # secrets (DB, OAuth, Turnstile, Maps key) — not git, not web
├── moto-storage/{owner_id}/    # user files: {map_id}.kml / {map_id}.gpx — not web
└── moto/                       # git checkout
    ├── public/                 # DreamHost "Web Directory" points HERE
    │   ├── index.php           # front controller / router
    │   ├── .htaccess           # rewrite→index.php, HTTPS force, upload caps, deny dotfiles
    │   ├── js/main.js          # ported viewer (3 seams + escaping + dedupe)
    │   ├── style/main.min.css  # compiled locally via npx sass
    │   └── img/ … icons/       # role icons + logos + favicon
    ├── app/
    │   ├── Router.php  Db.php  Config.php
    │   ├── Auth/OAuth.php
    │   ├── Support/{Turnstile,KmlValidator,Html}.php
    │   ├── Controllers/{Auth,Map,Public,Page}Controller.php
    │   └── views/              # layout, view.php, browse.php, dashboard.php, login.php
    ├── utils/                  # migrate.php, deploy.sh, reconcile.php (cron)
    ├── docs/                   # design docs
    ├── composer.json  config.example.php
    └── style/main.scss         # remote feralcreative.dev import removed
```

Pointing the domain's Web Directory at `public/` is what keeps `app/`, `vendor/`, and `utils/` unreachable over HTTP.

## MySQL Schema

- **`users`** — `id`, `email` (nullable, unique), `display_name`, `avatar_url`, `quota_bytes` (default 250 MB, configurable), `used_bytes` (denormalized cache), timestamps, `last_login_at`.
- **`user_identities`** — `id`, `user_id` FK, `provider` enum(google,github), `provider_user_id`, `provider_email`; unique `(provider, provider_user_id)`. Lets one account link both providers.
- **`maps`** — `id`, `owner_id` FK, `slug` CHAR(22) unique (base62 of 128-bit random = unguessable share id), `title`, `description`, `color`, `visibility` enum(public,unlisted,private), `external_url`, `gpx_present`, `kml_bytes`, `gpx_bytes`, `size_bytes` (generated), `waypoint_count`, `total_miles`, timestamps. Indexes on `owner_id` and `(visibility, created_at)` for browse.

**Sessions/OAuth state:** PHP native sessions only (single-host shared hosting); transient OAuth `state` + PKCE verifier live in `$_SESSION` for the redirect.

**Quota enforcement:** at upload, in a transaction, `SELECT quota_bytes, used_bytes ... FOR UPDATE`; reject with **413** if `used_bytes + prospective > quota_bytes`; else write files, insert row, bump `used_bytes`. Nightly `utils/reconcile.php` recomputes `used_bytes` from `SUM(size_bytes)` and prunes orphaned files.

## Endpoints (all via `public/index.php`)

- **Auth:** `GET /login`, `GET /auth/{provider}/start`, `GET /auth/{provider}/callback`, `POST /logout` (CSRF-checked).
- **Owner (auth required):** `POST /api/maps` (multipart upload), `GET /api/maps`, `GET /api/maps/{id}/kml`, `GET /api/maps/{id}/gpx`, `PATCH /api/maps/{id}`, `DELETE /api/maps/{id}`.
- **Public:** `GET /browse`, `GET /api/public/maps`, `GET /m/{slug}` (viewer page), `GET /api/public/maps/{slug}` (Seam 1), `GET /api/public/maps/{slug}/kml` (Seam 2).

**Visibility gate** (one helper used everywhere): public/unlisted viewable by anyone with the link; private viewable only by owner; unknown/private to a non-owner returns **404** (never confirm existence). `/browse` queries `public` only.

## OAuth Flow (PHP)

`league/oauth2-client` with Google + GitHub providers. `start` sets `state` (+ PKCE `S256` for Google) in session and redirects. `callback` checks `state`, exchanges the code, reads the resource owner (GitHub needs an extra `/user/emails` call for a verified primary email), then maps identity → user: match `user_identities`, else link by verified email, else create user + identity. Finish with `session_regenerate_id(true)`. Session cookies: `Secure`, `HttpOnly`, `SameSite=Lax`.

## Upload Pipeline (security-critical, cheap checks first)

1. Auth (401) → 2. CSRF token → 3. Turnstile siteverify (reject bots before touching files) → 4. presence + per-file size caps (KML ≤ 5 MB, GPX ≤ 10 MB, with PHP `upload_max_filesize` backstop) → 5. extension + `finfo` MIME sniff (authoritative gate is that it parses, not MIME) → 6. **XXE-safe XML parse** (`DOMDocument` with `LIBXML_NONET`, **reject any `<!DOCTYPE>`** to kill billion-laughs/external-entity) → 7. **server-side metadata extraction** (haversine mileage over the longest `<coordinates>` line, waypoint count — authoritative, unspoofable, no Maps needed) → 8. **sanitize KML** (strip tags/`on*`/`javascript:`/`data:` from `<name>`/`<description>`, re-serialize as stored file) → 9. validate `external_url` (http/https only) → 10. transactional quota check → 11. write files named **only from integer `owner_id`/`map_id`** (structurally defeats path traversal), `0640` perms.

Extraction is PHP (authoritative); sanitization is **both** PHP (at rest) and the viewer's escaping (at render) — defense in depth.

## Viewer Rewiring (minimal edits to `public/js/main.js`)

- Add `window.MOTO = { metadataUrl }` (set by `view.php`) and an `e()` HTML escaper.
- `initMap`: one line — `fetch(window.MOTO.metadataUrl)` instead of `data/routes.json`.
- `loadAllKmlRoutes`: use `route.kmlUrl` and `route.color`; pass the fetched `kmlText` into `loadKmlRoute` (kills the double fetch).
- `loadKmlRoute`: add optional `kmlText` param → parse it if given, else fetch; escape the two InfoWindow interpolations (`${e(displayName)}`, `${e(desc)}`).
- `addRouteDownloadButtons`: drop the 3 probes; drive GPX/KML/URL buttons off metadata (`gpxUrl`, `kmlUrl`, `externalUrl` with an `^https?:` guard); escape the label name.

Everything else in the engine stays byte-for-byte.

**Metadata contract** (Seam 1 JSON, array; length 1 for a single map, legend still works):

```json
[{ "name": "...", "color": "#0000cc", "kmlUrl": "...", "gpxUrl": null,
   "externalUrl": null, "gpxPresent": false, "waypointCount": 12,
   "totalMiles": 143.2 }]
```

## Pages

- `/` landing → `/browse` + `/login`.
- `/browse` — public discovery grid (title, owner, miles, waypoint count, color), paginated, links to `/m/{slug}`.
- `/m/{slug}` — viewer page; PHP resolves + gates, echoes referrer-locked Maps key + `window.MOTO`, renders panel, loads `main.js`.
- `/dashboard` — my maps + **quota meter** (`used_bytes/quota_bytes`), per-map actions (view, copy share link, edit visibility/title/color/url, download, delete), and the drag-drop upload widget.

## Google Maps Key

Embed in the `/m/{slug}` PHP page from `config.php`; lock by **HTTP referrer** in the GCP console (Maps JS restricted to the prod domain + local dev). No server proxying. `main.js` needs no key changes. MapLibre remains the only Google-coupled surface (map/polyline/marker/InfoWindow/`geometry`) if a future migration is wanted.

## DreamHost Deployment

- Domain Web Directory → `/home/USER/moto/public`; `moto-config/` + `moto-storage/` outside the deploy tree.
- Free Let's Encrypt HTTPS; force HTTPS + `Secure` cookies.
- PHP 8.3 (FPM) selected in panel; upload limits set to match caps.
- Deploy over SSH: `git pull && composer install --no-dev -o && php utils/migrate.php` (a `utils/deploy.sh`). `npx sass` runs **locally**; the compiled `main.min.css` is committed (server has no Node).
- Secrets in `/home/USER/moto-config/config.php` (returns an array); a committed `config.example.php` documents the shape.
- Nightly cron → `utils/reconcile.php`.

## Phased Milestones

- **M0 — Restructure & tooling.** Create `public/ app/ utils/ docs/`, `composer.json`, `config.example.php`; drop the remote SCSS import; compile SCSS; copy `img/`, favicon, and the ported `main.js` into `public/`.
- **M1 — One stored map renders (no auth).** Seed a `maps` row + KML; build front controller, `/m/{slug}`, `/api/public/maps/{slug}[/kml]`; do the seam rewiring + XSS escaping + double-fetch fix. Proves the reused engine.
- **M2 — Auth.** `users` + `user_identities`; Google + GitHub; `/login`, `/auth/*`, `/logout`; sessions; dashboard shell.
- **M3 — Upload + validation + quota.** Drag-drop + Turnstile; full pipeline; owner endpoints; dashboard with quota meter.
- **M4 — Public browse + share.** `/browse` + `/api/public/maps`; share-link copy; verify gating (incognito vs owner).
- **M5 — DreamHost deploy.** Web dir, secrets/storage placement, Let's Encrypt, PHP 8.3, `composer install` over SSH, GCP referrer lock, prod OAuth redirect URIs + Turnstile keys, reconcile cron.
- **M6 — Deferred.** Embeds, club branding, email-route-files, collections, browse thumbnails, MapLibre.

## Verification

**Local (Node-free runtime):** MAMP (real `.htaccess`/mod_rewrite) or `php -S` with a router shim; load `utils/schema.sql`; dev OAuth redirect URIs; Turnstile test keys.

- **M1:** `/m/{slug}` draws polyline/arrows/tooltips/legend/downloads; Network panel shows each KML fetched **once**.
- **Auth:** Google then GitHub on the same email → one `users` row, two identities; session persists; id regenerated.
- **Upload:** real KML(+GPX) → row + files under `moto-storage/{uid}/`, correct waypoint/mileage/gpx flags, renders.
- **Security:** malicious KML (`<script>`, `onerror=`, `javascript:` in name/desc, `<!DOCTYPE>`/XXE) → XXE rejected, stored KML neutralized, tooltip escaped; `javascript:` external_url suppressed.
- **Quota:** tiny `quota_bytes` → upload to **413**; delete frees space.
- **Traversal:** `../` and non-numeric ids on file endpoints → always 404.
- **Visibility:** public in `/browse` + reachable; unlisted reachable by slug only; private → 404 incognito, 200 owner.

**DreamHost:** repeat signup → upload → view → quota → share → private-gated with prod keys; `curl` a `moto-storage` path and `config.php` URL (must not serve); confirm forced HTTPS and the cron.

## Open Items to Confirm (non-blocking)

- **Domain/subdomain** on DreamHost (drives OAuth redirect URIs + Maps referrer lock). The old `moto-rooter.feralcreative.dev` currently points at the NAS.
- **Default per-user quota** (plan assumes 250 MB).
- Per your convention, once out of plan mode I will also drop a copy of this plan in a root `_PLANS/` folder.
