# AI Agent Primer: Moto-Rooter

**Last Updated:** 2026-07-11
**Project:** Multi-tenant motorcycle route map sharing app
**Status:** Active rebuild (M0 and M1 complete; M2+ in progress)

This document orients an AI agent working on the codebase. Read it before
making changes. For exactly where the project stands and what to do next, see
[docs/STATUS.md](docs/STATUS.md); the full build plan is
[\_PLANS/multi-tenant-rebuild.md](_PLANS/multi-tenant-rebuild.md).

## What this project is

Moto-Rooter lets riders sign in, upload their motorcycle route files (KML/GPX),
and share interactive maps. It began as a single-person, file-on-disk static
viewer and is being rebuilt into a public, multi-tenant web service on a
PHP + MySQL (LAMP) stack hosted on DreamHost shared hosting.

The valuable, hard-won asset — the client-side Google Maps viewer — is reused
almost verbatim. Everything server-side (accounts, upload, storage, sharing) is
new.

## Secrets and configuration

Configuration is a plain PHP array resolved by `app/Config.php` from the first
source that exists, in order:

1. the `MOTO_CONFIG` environment variable (absolute path)
2. `../moto-config/config.php` — a sibling of the repo (the DreamHost layout)
3. `config.local.php` in the repo root — local dev only, git-ignored

Copy `config.example.php` to create either file. Keys:

- `app_url` — public base URL (builds OAuth redirects and share links)
- `db` — MySQL host / name / user / pass / charset
- `google`, `github` — OAuth client id + secret (added in M2)
- `turnstile` — Cloudflare Turnstile site + secret keys (added in M3)
- `gmaps_key` — Google Maps **browser** key; it is exposed in page source by
  design, so protect it with HTTP-referrer + API restrictions in the GCP console
- `storage_path` — absolute path to the private user-file store, **outside** the
  web root
- `default_quota_bytes` — per-user storage quota

Never commit secrets. `config.local.php`, `moto-config/`, `.env`, and
`moto-storage/` are all git-ignored.

## Architecture and stack

- **Backend** — PHP 8.3 (target; 8.1+ supported), MySQL. A minimal hand-rolled
  front controller and router — no framework. Composer is used only for the
  OAuth libraries.
- **Frontend** — vanilla JavaScript and the Google Maps JavaScript API. SCSS is
  compiled to CSS with the `sass` CLI (Node is a build-time tool only; it does
  not run on the server).
- **Hosting** — DreamHost shared hosting. HTTPS via free Let's Encrypt.

**Request flow:** every non-static request is rewritten to `public/index.php`,
which boots the app (`app/bootstrap.php`), builds the router, and dispatches to
a controller. Static assets under `public/` are served directly. User map files
are **never** in the web root; they are streamed through a PHP ownership /
visibility gate.

## Directory structure

```text
public/                Web root (the only web-served directory)
  index.php            Front controller (routes registered here)
  router.php           Dev-server shim for `php -S`
  .htaccess            Apache rewrite + hardening
  js/main.js           The reused map viewer (vanilla JS)
  style/main.min.css   Compiled CSS (build output)
  img/                 Waypoint icons, logos, favicons, assets
app/                   Application code (not web-served)
  bootstrap.php        Autoloader, sessions, helpers (e, render, json_response)
  Config.php  Db.php  Router.php
  Controllers/         PageController, PublicController (Auth/Map added later)
  views/               PHP templates (view.php, home.php)
utils/                 schema.sql and maintenance scripts (migrations, cron)
style/main.scss        SCSS source (compiled into public/style/)
_PLANS/                The rebuild plan
config.example.php     Config template
```

<!--| PAGE-BREAK -->

## Entry points and data flow

**Server.** `public/index.php` registers routes and dispatches:

- `GET /` — public map listing (`PageController::home`)
- `GET /m/{slug}` — the viewer page (`PageController::viewMap`)
- `GET /api/public/maps/{slug}` — route metadata JSON (viewer data source)
- `GET /api/public/maps/{slug}/kml` — gated KML stream
- `GET /api/public/maps/{slug}/gpx` — gated GPX download

**Viewer.** `app/views/view.php` renders the DOM scaffold the viewer expects
(`#map`, `#info-panel`, `.route-table`, `#toggle-arrows`), sets
`window.MOTO.metadataUrl`, injects the Maps key, and loads `public/js/main.js`.
Google Maps calls `initMap()`, which fetches the metadata, then the KML, and
draws the route.

## The reused viewer (public/js/main.js)

A ~1150-line vanilla-JS engine: KML parsing, route polyline with direction
arrows, mileage via the Maps geometry library, typed waypoint markers with
tooltips, a legend/table with visibility checkboxes and download buttons, hover
highlight/dim, and colored SVG icons.

It was recovered from git history and rewired at **three seams** so it reads
from the API instead of files on disk:

1. the route list came from `data/routes.json` → now `window.MOTO.metadataUrl`
2. geometry came from `data/{base}.kml` → now the gated `/kml` endpoint, with the
   already-fetched KML text passed through so it is parsed once, not twice
3. download buttons probed the filesystem for `.gpx`/`.url` → now driven by
   metadata fields (`gpxUrl`, `externalUrl`)

Fixes applied during the port, worth preserving:

- **Stored-XSS defense** — waypoint names and descriptions from KML are escaped
  with an `esc()` helper before being injected into tooltip/label `innerHTML`
- **Per-map color** — the polyline, legend swatch, and marker accents all use
  the map's `color`, falling back to the palette
- **Double-fetch removed** — each KML is fetched and parsed once
- The `icon-wtf.svg` path was corrected to be absolute

The metadata contract (a one-element array; the legend renders fine with one):

```json
[{ "name": "...", "color": "#0000cc", "kmlUrl": "...", "gpxUrl": null,
   "externalUrl": null, "gpxPresent": false, "waypointCount": 12,
   "totalMiles": 143.2 }]
```

The waypoint naming convention (e.g. `GAS/FOOD - Roadside Stop`) is the upload
format contract — see the README for the full type table.

## Data model (MySQL)

Schema is in `utils/schema.sql`:

- **`users`** — identity, `quota_bytes`, and a denormalized `used_bytes` cache
- **`user_identities`** — links a user to Google and/or GitHub logins
- **`maps`** — `owner_id`, an unguessable `slug` (share id), `title`,
  `description`, `color`, `visibility` (public / unlisted / private),
  `external_url`, byte sizes, `waypoint_count`, `total_miles`

**File storage.** A map's files live at
`{storage_path}/{owner_id}/{map_id}.kml` (and `.gpx`). Paths are built only from
integer ids, so they cannot escape the storage root; a `realpath` containment
check guards against symlink surprises.

**Quota.** Enforced at upload inside a transaction (`SELECT ... FOR UPDATE`),
rejecting with HTTP 413 when `used_bytes + incoming > quota_bytes`.

## Security model

- **Visibility gating** — public/unlisted are viewable by anyone with the link;
  private is owner-only. Unknown or forbidden slugs return **404** (never
  confirm that a private/unknown map exists).
- **File serving** — only through the ownership gate, from outside the web root.
- **Uploads (M3)** — Turnstile check first, then XXE-safe XML parsing
  (`DOMDocument` with `LIBXML_NONET`, reject any `<!DOCTYPE>`), server-side
  metadata extraction, KML sanitization (neutralize scripts / `on*` /
  `javascript:` in names and descriptions), scheme-checked external URLs, the
  transactional quota check, and writes named only from integer ids.
- **Sessions** — native PHP sessions with `HttpOnly`, `SameSite=Lax`, and
  `Secure` (over HTTPS) cookies.

## Milestones

- **M0 — Restructure** ✅ `public/` web root, front controller, viewer ported,
  SCSS compiled, config + schema in place.
- **M1 — One stored map renders** ✅ Front controller, the public endpoints, the
  seam rewiring; verified in a browser (route, arrows, markers, legend,
  downloads all render; KML fetched once; no console errors).
- **M2 — Auth** ⬜ `users` + `user_identities`, Google + GitHub OAuth via
  `league/oauth2-client`, sessions, a dashboard shell. Needs OAuth app
  credentials.
- **M3 — Upload + quota** ⬜ Drag-and-drop upload, the full validation pipeline,
  transactional quota, owner endpoints (list / delete / update visibility).
- **M4 — Browse + share** ⬜ Public discovery page, share-link UI, full
  visibility gating.
- **M5 — Deploy** ⬜ DreamHost web dir, secrets/storage placement, Let's Encrypt,
  Composer install, GCP referrer lock, cron.
- **M6 — Deferred** ⬜ Embeds, club branding, email-route-files, MapLibre
  migration.

## Local development

1. `mysql -e "CREATE DATABASE moto_rooter CHARACTER SET utf8mb4;"`
2. `mysql moto_rooter < utils/schema.sql`
3. `cp config.example.php config.local.php` and fill in `db`, `gmaps_key`,
   `storage_path`
4. `npm install && npm run sass`
5. `php -S 127.0.0.1:6686 -t public public/router.php`
6. Open <http://127.0.0.1:6686>; a map is viewable at `/m/{slug}`

Compile styles with the `sass` CLI (`npm run sass`), never an IDE extension.

## Deployment (DreamHost)

Point the domain's web directory at `public/`. Keep `moto-config/` (secrets) and
`moto-storage/` (user files) outside the deploy tree; keep `app/`, `vendor/`, and
`utils/` outside the web root. Deploy over SSH:
`git pull && composer install --no-dev -o && php utils/migrate.php`. Compile SCSS
locally and commit the CSS (the server has no Node). Enable Let's Encrypt and a
nightly reconcile cron. Full steps are in the plan (M5).

## Provenance

The map engine was recovered from commit `0bdf2e2` of the original Moto-Rooter
repository (the parent of the teardown commit `8ce3cd9`) and rewired for the new
architecture. The original repository retains the full history if earlier
revisions are needed.

## Key files

| Purpose                    | Path                                   |
| -------------------------- | -------------------------------------- |
| Front controller / routes  | `public/index.php`                     |
| App bootstrap + helpers    | `app/bootstrap.php`                    |
| Config loader              | `app/Config.php`                       |
| Database (PDO)             | `app/Db.php`                           |
| Viewer data endpoints      | `app/Controllers/PublicController.php` |
| Pages (list + viewer)      | `app/Controllers/PageController.php`   |
| The map viewer             | `public/js/main.js`                    |
| Viewer page template       | `app/views/view.php`                   |
| Schema                     | `utils/schema.sql`                     |
| SCSS source                | `style/main.scss`                      |
| Config template            | `config.example.php`                   |
| Build plan                 | `_PLANS/multi-tenant-rebuild.md`       |
