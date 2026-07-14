# AI Agent Primer: tankbag

**Last Updated:** 2026-07-13
**Project:** Multi-tenant motorcycle route map sharing app (tankbag.app)
**Status:** Active rebuild on TypeScript + Hono + PostgreSQL. Phase 0 (scaffold)
and Phase 1 (DB-backed viewer) complete; Phases 2+ ahead.

This document orients an AI agent working on the codebase. Read it before making
changes. The build plan is [\_PLANS/tankbag-hono-rebuild.md](_PLANS/tankbag-hono-rebuild.md).

> **Historical baggage in this repo:** the `app/` directory (a prior PHP/MySQL
> implementation) and `utils/schema.sql` (MySQL) are **superseded**. The live app
> is the TypeScript/Hono code under `src/`. The PHP is kept only as a reference
> for logic still to be ported (the upload/security pipeline).

## What this project is

tankbag (formerly "Moto-Rooter") lets riders sign in, upload their motorcycle
route files (KML/GPX), and share interactive maps. It began as a single-person,
file-on-disk static viewer and is being rebuilt into a public, multi-tenant web
service.

The valuable, hard-won asset — the client-side Google Maps viewer
(`public/js/main.js`) — is reused almost verbatim. Everything server-side
(accounts, upload, storage, sharing) is new.

## The two pivots (why this differs from older docs)

Older docs (`docs/STATUS.md`, `_PLANS/multi-tenant-rebuild.md`) describe a
**PHP + MySQL app on DreamHost**. Two decisions changed that:

1. **Hosting → self-hosted NAS + Cloudflare Tunnel.** tankbag runs as Docker on
   Ziad's Synology NAS ("feral-nas"), fronted by a Cloudflare Tunnel — no open
   inbound ports, TLS at the edge. Prod `tankbag.app → :6686`, stage
   `stage.tankbag.app → :6687` (tunnel ingress + DNS already pre-staged).
2. **Stack → TypeScript + Hono + Postgres.** Freed from DreamHost's LAMP
   constraint, the backend was re-based on one language (the app is already
   ~all JS on the client). Hono runs the same code on Node (NAS Docker) today
   and Cloudflare Workers later.

## Architecture and stack

- **Backend** — TypeScript on **Hono**, run by Node (`tsx` in dev, Docker in
  prod); portable to Cloudflare Workers. **PostgreSQL** via **Drizzle ORM**.
- **Frontend** — vanilla JavaScript and the Google Maps JavaScript API. SCSS
  compiled to CSS with the `sass` CLI. The viewer is reused unchanged.
- **Hosting** — Synology NAS (Docker) behind Cloudflare Tunnel; HTTPS terminates
  at Cloudflare's edge.

**Request flow:** `src/index.ts` builds the Hono app, serves the static assets
under `public/`, renders the home listing and the viewer page, and exposes the
public API. Map metadata comes from Postgres; user KML/GPX files are streamed
from a storage root **outside** the web root through an ownership/visibility gate.

## Configuration and secrets

Local dev config is a git-ignored `.env` in the repo root:

```text
PORT=6686
GMAPS_KEY=<Google Maps browser key — referrer-restricted, exposed in page source by design>
STORAGE_PATH=./moto-storage
DATABASE_URL=postgres://tankbag:tankbag_dev_pw@127.0.0.1:5432/tankbag
```

OAuth (Google/GitHub) and Turnstile keys arrive with Phases 2–3. `.env`,
`moto-storage/`, and `node_modules/` are git-ignored. `config.local.php` is
legacy (PHP only).

## Directory structure

```text
src/                  TypeScript app (the live backend)
  index.ts            Hono app: routes, viewer/home templates, gated file streaming
  db/
    schema.ts         Drizzle schema — SOURCE OF TRUTH (users, user_identities, maps)
    index.ts          DB connection (pg Pool + Drizzle)
    seed.ts           Dev seed (one user + the sample map)
public/               Static, served directly
  js/main.js          The reused map viewer (vanilla JS)
  style/main.min.css  Compiled CSS (build output)
  img/                Waypoint icons, logos, favicons
style/main.scss       SCSS source (compiled into public/style/)
docker-compose.yml    Postgres for dev; app service added at deploy time
drizzle.config.ts     Drizzle Kit config
moto-storage/         Local user-file store (git-ignored) — {owner_id}/{map_id}.{ext}
utils/schema.sql      LEGACY MySQL schema (historical)
app/                  LEGACY PHP implementation (superseded; reference only)
_PLANS/               Rebuild plans (tankbag-hono-rebuild.md is current)
```

<!--| PAGE-BREAK -->

## Entry points and data flow

`src/index.ts` registers the routes:

- `GET /` — public map listing (`maps` where visibility = public)
- `GET /m/:slug` — the viewer page
- `GET /api/public/maps/:slug` — route metadata JSON (viewer data source)
- `GET /api/public/maps/:slug/kml` — gated KML stream
- `GET /api/public/maps/:slug/gpx` — gated GPX download

**Viewer wiring.** The viewer page renders the DOM scaffold the viewer expects
(`#map`, `#info-panel`, `.route-table`, `#toggle-arrows`), sets
`window.MOTO.metadataUrl`, injects the Maps key, and loads `public/js/main.js`.
Google Maps calls `initMap()`, which fetches the metadata, then the KML, and
draws the route.

The metadata contract (a one-element array; the legend renders fine with one):

```json
[{ "name": "...", "color": "#0066cc", "kmlUrl": "...", "gpxUrl": null,
   "externalUrl": null, "gpxPresent": false, "waypointCount": 12,
   "totalMiles": 143.2 }]
```

## The reused viewer (public/js/main.js)

A vanilla-JS engine: KML parsing, route polyline with direction arrows, mileage
via the Maps geometry library, typed waypoint markers with tooltips, a
legend/table with visibility checkboxes and download buttons, hover
highlight/dim, and colored SVG icons.

It reads from the API instead of files on disk via three seams: the route list
from `window.MOTO.metadataUrl`; geometry from the gated `/kml` endpoint; download
buttons driven by metadata fields (`gpxUrl`, `externalUrl`).

Fixes preserved from the original recovery, worth keeping: stored-XSS escaping
(`esc()`) of KML names/descriptions; per-map color for polyline/legend/markers;
each KML fetched and parsed once.

## Data model (PostgreSQL via Drizzle)

Schema is `src/db/schema.ts` (translated from the old MySQL `utils/schema.sql`):

- **`users`** — identity, `quota_bytes`, and a denormalized `used_bytes` cache.
- **`user_identities`** — links a user to Google and/or GitHub logins.
- **`maps`** — `owner_id`, an unguessable `slug` (share id), `title`,
  `description`, `color`, `visibility` (public / unlisted / private),
  `external_url`, byte sizes (with a generated `size_bytes`), `waypoint_count`,
  `total_miles`.

**File storage.** A map's files live at `{STORAGE_PATH}/{owner_id}/{map_id}.kml`
(and `.gpx`). Paths are built only from integer ids, guarded by a containment
check against the storage root.

**Quota (Phase 3).** Enforced at upload inside a transaction, rejecting with
HTTP 413 when `used_bytes + incoming > quota_bytes`.

## Security model

- **Visibility gating** — public/unlisted are viewable by anyone with the link;
  private is owner-only. Unknown or forbidden slugs return **404** (never confirm
  a private/unknown map exists). *(done)*
- **File serving** — only through the ownership gate, from outside the web root.
  *(done)*
- **Uploads (Phase 3 — port from the PHP `app/` code)** — Turnstile first, then
  XXE-safe XML parsing (reject any `<!DOCTYPE>`, no network), server-side
  metadata extraction, KML sanitization (neutralize scripts / `on*` /
  `javascript:` in names and descriptions), scheme-checked external URLs, the
  transactional quota check, and writes named only from integer ids.
- **Sessions (Phase 2)** — `HttpOnly`, `SameSite=Lax`, and `Secure` cookies.

> When porting Phase 3, re-derive these defenses from the PHP `app/` code — they
> are the hardest-won part and must not be lost.

## Phases

- **Phase 0 — Scaffold** ✅ Hono app, `tsx` dev server on `:6686`, viewer served,
  static assets wired.
- **Phase 1 — DB-backed viewer** ✅ Postgres container, Drizzle schema + seed;
  the public endpoints query the database; one stored map renders end-to-end.
- **Phase 2 — Auth** ⬜ Lucia (or Auth.js) with Google + GitHub OAuth, sessions,
  `users` + `user_identities`, a dashboard shell.
- **Phase 3 — Upload + quota** ⬜ Drag-and-drop upload, the full validation
  pipeline, transactional quota, owner endpoints (list / delete / visibility).
- **Phase 4 — Browse + share** ⬜ Public discovery page, share-link UI, full
  visibility gating.
- **Phase 5 — Deploy** ⬜ Dockerfile + compose (publishing `6686`/`6687`),
  Postgres on the NAS, migrations, verified through the tunnel.
- **Later** ⬜ PostGIS geo discovery ("routes near me"); MapLibre + vector tiles.

## Local development

```bash
npm install
docker compose up -d --wait db          # Postgres on 127.0.0.1:5432
# create .env (see Configuration), then:
npx drizzle-kit push                     # or apply the DDL straight to Postgres
npx tsx src/db/seed.ts                   # seeds user #1 + the sample map
npm run sass                             # compile CSS if the SCSS changed
npm run dev                              # tsx watch → http://127.0.0.1:6686
```

Open <http://127.0.0.1:6686>; the seed map is at `/m/sample-route-one`. Use
`127.0.0.1` (not `localhost`) to match the Maps key's referrer allowlist.
`src/db/schema.ts` is the schema source of truth — if a sandbox blocks
`drizzle-kit push`, the equivalent DDL can be applied directly to Postgres.

## Deployment (Synology NAS)

tankbag runs as a Docker container on the NAS, behind the existing Cloudflare
Tunnel (`feral-nas`). Prod `tankbag.app → :6686`, stage
`stage.tankbag.app → :6687` — the tunnel ingress + DNS are already staged, so the
routes light up as soon as a container listens on those ports. Postgres runs as a
sibling container. The app's `docker-compose.yml` must publish `6686`/`6687`.
HTTPS terminates at Cloudflare's edge; no inbound ports are open on the NAS. Full
steps land in Phase 5. `moto-rooter.feralcreative.dev` (the old viewer's dev
host) is decommissioned once tankbag ships.

## Provenance

The map engine was recovered from commit `0bdf2e2` of the original Moto-Rooter
repository and rewired to read from the API. The server side was first rebuilt in
PHP/MySQL (see `app/`, now superseded) and then re-based on TypeScript + Hono +
PostgreSQL. The rendering, mileage math, and waypoint model are unchanged;
everything around them is new.

## Key files

| Purpose                          | Path                            |
| -------------------------------- | ------------------------------- |
| Hono app / routes / templates    | `src/index.ts`                  |
| Drizzle schema (source of truth) | `src/db/schema.ts`              |
| DB connection                    | `src/db/index.ts`               |
| Dev seed                         | `src/db/seed.ts`                |
| The map viewer                   | `public/js/main.js`             |
| SCSS source / compiled CSS       | `style/main.scss` / `public/style/main.min.css` |
| Postgres (dev) + app (deploy)    | `docker-compose.yml`            |
| Drizzle Kit config               | `drizzle.config.ts`             |
| Build plan                       | `_PLANS/tankbag-hono-rebuild.md`|
| Legacy PHP (reference)           | `app/`, `utils/schema.sql`      |
