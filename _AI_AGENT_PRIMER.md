# AI Agent Primer: routeloop

**Last Updated:** 2026-07-24
**Project:** Motorcycle/road-trip ride planning, sharing & organizing app (routeloop.app)
**Status:** Mid-pivot and **live in production**. The product moved from "upload
KML files" to "**plan rides in-app on Mapbox**"; Phases 0–2 are built and
verified, Phase 3 is next. Since the last update the app was renamed
`tankbag` → `routeloop`, auth was rebuilt on Cloudflare Access, and the stack was
deployed fresh to the NAS serving `routeloop.app`. Sign-in is restricted to the
single address `ziad@feralcreative.co` by an Access policy. **Nothing is
committed:** the pivot, the rename, and the auth work all live in the working
tree on branch `feat/auth`.

This document orients an AI agent working on the codebase. Read it before making
changes, then read the governing plan
[\_PLANS/routeloop-route-builder-pivot.md](_PLANS/routeloop-route-builder-pivot.md)
and the session handoff
[\_PLANS/routeloop-pivot-handoff.md](_PLANS/routeloop-pivot-handoff.md).

> **Historical baggage.** The `app/` directory (a prior PHP/MySQL build) and
> `utils/schema.sql` (MySQL) are **superseded** reference material. Older plans
> (`_PLANS/multi-tenant-rebuild.md`, `_PLANS/routeloop-hono-rebuild.md`,
> `_PLANS/routeloop-phase2-auth.md`) describe earlier stages and are historical.
> The live backend is the TypeScript/Hono code under `src/`.

## What this project is

routeloop lets riders **plan** motorcycle rides (and car road trips) directly in
the app: drop stops on a Mapbox map, classify them (gas, food, camp, lodging,
scenic…), and the route between them is snapped to roads. A ride is then
managed, shared by link, and exported. It is a **planning / sharing /
organizing tool — explicitly not a turn-by-turn navigation app** (see
`docs/ideas.md`). The pain it solves: Google My Maps caps at ~10 waypoints and
one route per layer and can't be used to navigate — "the worst of both worlds."
routeloop has no such limits.

Importing existing files (KML, GPX; later KMZ, CSV) is a **migration path**, not
the main event. The vision doc is `docs/ideas.md`; near-term feature requests
are in `_PLANS/changes-260724T0250Z.md`.

## The product model (drives the schema)

From `docs/ideas.md`:

- **Ride** — the shareable package (has the slug, visibility, title). Holds many
  routes across many days/sessions — the holistic view of an entire trip.
- **Route** — one session/day within a ride: an ordered list of stops joined by
  routed legs, with a start/end date-time (time model exists in the schema; the
  timeline-slider UI is a later phase).
- **Three kinds of dots:**
  - **Waypoint** — an ephemeral shaping point that just keeps the route on
    course. Modeled as **leg via-points** (`route_legs.via_points`), *not* rows
    in `points`.
  - **POI** — an interesting place near the route that does *not* affect
    routing. `points.kind = 'poi'`, unordered.
  - **Stop** — a real stop (gas, food, hotel…); always has a duration; "ends"
    are stops with no duration. `points.kind = 'stop'`, ordered — these are the
    routing anchors.

## Architecture and stack

- **Backend** — TypeScript on **Hono**, run by Node (`tsx` in dev, Docker in
  prod); portable to Cloudflare Workers. **PostgreSQL** via **Drizzle ORM**.
  **Zod** for payload validation.
- **Maps** — **Mapbox GL JS** (rendering) + **Mapbox Directions API** (per-leg
  road routing) + **Mapbox Geocoding v6** (place search). Called client-side
  with a URL-restricted public token. Loaded from the Mapbox CDN via a
  `<script>` tag — the frontend has **no bundler**.
- **Auth** — Cloudflare Access at the edge, bridged to hand-rolled server
  sessions (SHA-256-hashed tokens). Cloudflare **Turnstile** guards uploads/saves
  (feature-flagged off until keys are set). See
  [docs/cloudflare-access.md](docs/cloudflare-access.md) for the live
  application IDs and the steps left to open sign-in.
- **Frontend** — vanilla JavaScript. SCSS compiled to CSS with the `sass` CLI.
- **Hosting** — Synology NAS (Docker) behind Cloudflare Tunnel; HTTPS at the
  edge. Prod is `routeloop.app → localhost:16703`, stage is
  `stage.routeloop.app → localhost:6687`. Each container also publishes an
  **alias port** (`:6686` prod, `:16687` stage) so the surviving legacy
  `tankbag.app` / `stage.tankbag.app` tunnel routes hit the same app and get
  301'd to the canonical host for that environment.

## Two map engines during the transition

There are currently **two** viewers, on purpose:

1. **Legacy Google Maps viewer** — `public/js/main.js` (uses `google.maps.*`).
   Serves **imported** rides only, via the `viewHtml` shell in `src/index.ts`
   (which injects `GMAPS_KEY` + the `maps.googleapis.com` script). This is
   scheduled for deletion in Phase 4.
2. **New Mapbox engine** — `public/js/map-common.js` (shared) plus
   `public/js/viewer.js` (read-only) and `public/js/builder.js` (editing).
   Serves **native** rides today; will serve everything after Phase 4.

The Mapbox marker/tooltip/mileage behavior in `map-common.js` is a faithful port
of the legacy viewer's hard-won logic (colored `currentColor` SVG icons, the
`From Start / From Gas / From Charge` tooltip columns, direction arrows,
per-route hover-dim). When Phase 4 lands, `main.js` and `GMAPS_KEY` are removed.

<!--| PAGE-BREAK -->

## Data model (PostgreSQL via Drizzle)

`src/db/schema.ts` is the **source of truth**. Schema is applied with
`npx drizzle-kit push` (declarative — there are no migration files; the NAS
post-deploy hook runs the same push).

- **`users`** — identity, `quota_bytes`, denormalized `used_bytes`.
- **`user_identities`** — links a user to Cloudflare Access; legacy Google and
  GitHub identity rows remain valid.
- **`sessions`** — PK is the SHA-256 hash of the browser token, never the token.
- **`rides`** — `owner_id`, unguessable `slug`, `title`, `description`,
  `visibility` (public/unlisted/private), **`source`** (native | imported),
  `external_url`, byte columns + generated `size_bytes` (imported originals +
  quota), and caches `total_miles`, `total_duration_s`, `stop_count`.
- **`routes`** — `ride_id`, `position`, `title`, **`color`** (per-route, feeds
  the legend), `start_at`/`end_at` (nullable; timeline model), `distance_m`,
  `duration_s`.
- **`points`** — `route_id`, `kind` (stop | poi), `position` (stop order; null
  for POIs), `lat`/`lng`, `name`, `description`, **`roles waypoint_role[]`**
  (≤ 4, DB-checked), `duration_min` (null = no duration), `dist_from_start_m`
  (server-computed).
- **`route_legs`** — `route_id`, `position` (leg i = stop i → i+1),
  `geometry jsonb` (`[lng,lat][]`, 6-decimal), `distance_m`, `duration_s`,
  `via_points jsonb` (the ephemeral shaping waypoints).

**One rendering path for both sources.** An **imported** ride is stored as one
route with a single leg at `position 0` holding the whole track; a **native**
ride has one leg per pair of stops. Viewers always render `concat(legs)` per
route — so imported and native rides render identically.

**Enums:** `provider`, `visibility`, `ride_source`, `point_kind`,
`waypoint_role` (the 17 roles — keep in sync with `src/maps/roles.ts`).

**File storage.** Imported originals live at
`{STORAGE_PATH}/{owner_id}/{ride_id}.kml` (and `.gpx`), paths built only from
integer ids and containment-checked. Native rides have no files. Quota applies
to imported bytes only.

## The role taxonomy

`src/maps/roles.ts` is the **single source of truth** for the 17 waypoint roles
(start, finish, home, meet, split, gas, charge, break, camp, hotel, food,
coffee, drinks, grocery, view, poi, wtf). It unifies the three divergent alias
tables that existed in the legacy viewer and fixes their bugs (WTF now matches
"WTF"; CHARGE matches "CHARGER"). It exports:

- `ROLES`, `ROLE_META` (`{ title, icon, aliases }` per role)
- `canonicalRole(term)` — alias → role
- `parseRoleName("GAS/FOOD - Chevron")` → `{ roles: ['gas','food'], name: 'Chevron' }`
- `formatRoleName(['gas'], 'Chevron')` → `"GAS - Chevron"` (for export/round-trip)

The `ROLE - Name` / `GAS/FOOD - Name` string convention now lives **only at the
import/export boundary**. In the DB, roles are first-class enum values. Page
shells inject `ROLE_META` as `window.TB.roles` so client code never re-declares
it. Icons are in `public/img/icons/icon-<role>.svg`, filled with `currentColor`
so they tint to the route color.

## Entry points and routes (`src/index.ts` + `src/routes/*`)

A host middleware runs **first**, ahead of every route: requests for
`tankbag.app` / `www.tankbag.app` get a **301 to the same path and query on
`routeloop.app`**. The old domain is forwarded for a year, then dropped. This
also means the legacy tunnel route cannot be used to reach `/auth/cloudflare`
with a forged identity header — the redirect fires before any auth code runs.

Public (gated by `getViewable(slug, viewer)` — public/unlisted for anyone,
private owner-only, else 404):

- `GET /` — public ride listing
- `GET /m/:slug` — viewer page; **native → Mapbox shell**, **imported → Google
  shell**
- `GET /api/public/rides/:slug/ride.json` — normalized viewer contract (both
  sources): ride meta + `routes[]` each with `track`, `stops[]`, `pois[]`
- `GET /api/public/maps/:slug` — **legacy** metadata array (Google viewer only;
  retires in Phase 4)
- `GET /api/public/maps/:slug/kml` · `/gpx` — gated file streams (imported
  originals)

Owner API (all `requireAuthApi` + `requireSameOrigin`):

- Import — `POST /api/maps` (multipart KML+optional GPX → one imported ride with
  structured rows; full XXE-safe pipeline + transactional quota). In
  `src/routes/maps.ts`.
- Builder — `POST /api/rides`, `PUT /api/rides/:id` (full-replace),
  `GET /api/rides/:id` (owner load). In `src/routes/rides.ts`.
- Edit/delete — `PATCH /api/maps/:id`, `DELETE /api/maps/:id` (owner-scoped;
  serve both sources). In `src/routes/maps.ts`.

Pages: `GET /builder` and `GET /builder/:id` (`requireAuth`, owner-checked,
native-only) in `src/routes/rides.ts`; `GET /dashboard` in
`src/routes/dashboard.ts`; auth routes in `src/routes/auth.ts`.

### The ride payload (save = load shape)

```json
{ "title": "...", "description": "", "visibility": "private", "external_url": "",
  "routes": [ { "title": "", "color": "#0066cc", "startAt": null, "endAt": null,
    "stops": [ { "lat": 0, "lng": 0, "name": "", "description": "",
                 "roles": ["gas"], "durationMin": null } ],
    "pois":  [ { "lat": 0, "lng": 0, "name": "", "description": "", "roles": [] } ],
    "legs":  [ { "geometry": [[lng,lat]], "distanceM": 0, "durationS": 0,
                 "viaPoints": [] } ] } ] }
```

Server-side integrity on save (`src/routes/rides.ts`): all text is sanitized,
coords rounded to 6 decimals, and each leg's claimed `distanceM` is clamped to
the haversine length of its geometry if it deviates > 15 % (Directions stays
authoritative in the honest case; spoofing is bounded). Caps: 31 routes/ride,
200 stops + 200 POIs/route, ≤ 4 roles/point, 25k pts/leg, 200k pts/ride.

## The security pipeline (imports)

Ported from the PHP era and preserved — re-derive, never drop these:

- **XXE-safe XML parse** (`src/maps/kml.ts`) — reject any `<!DOCTYPE>` before
  parsing; `@xmldom/xmldom` does no network or entity resolution.
- **Server-side extraction** — waypoint roles parsed from name prefixes; the
  route track is the longest coordinate line; mileage is authoritative.
- **Sanitization** — `sanitizeText` strips tags and defuses `javascript:` /
  `data:` schemes in every name/description, at rest; the viewer's `esc()` is
  the second layer.
- **Transactional quota** — `SELECT … FOR UPDATE`, HTTP 413 over quota.
- **Visibility gate** — unknown/forbidden slugs return 404, never confirming a
  ride exists.
- **CSRF** — `requireSameOrigin` checks the `Origin` header via `isAllowedOrigin`
  (`src/auth/access.ts`).

<!--| PAGE-BREAK -->

## Directory structure

```text
src/
  index.ts            Hono app: home, viewer (native/imported branch),
                      ride.json, legacy metadata + gated file streams
  db/
    schema.ts         Drizzle schema — SOURCE OF TRUTH
    index.ts          DB connection (pg Pool + Drizzle)
    seed.ts           Dev seed: user #1 + sample ride (structured rows)
  auth/               session.ts, middleware.ts, access.ts (+ isAllowedOrigin)
  maps/
    roles.ts          Canonical 17-role taxonomy (parse/format)
    kml.ts            XXE-safe parse, extraction, sanitize, processGpx
    storage.ts        Integer-id file paths, containment-checked writes
    slug.ts           22-char base62 unguessable share ids
    turnstile.ts      Feature-flagged siteverify
  routes/
    maps.ts           Import API + edit/delete (exports fields/ownRide/firstIssue)
    rides.ts          Builder API + /builder pages
    dashboard.ts      Owner's ride list
    auth.ts           Cloudflare Access session bridge, login, logout
  views/layout.ts     Shared chrome shell (esc, page)
public/
  js/main.js          LEGACY Google Maps viewer (imported rides only)
  js/map-common.js    Shared Mapbox engine (window.TBMap)
  js/viewer.js        Native ride viewer (reads ride.json)
  js/builder.js       The ride builder
  style/main.min.css  Compiled CSS (build output)
  img/icons/          17 role SVGs (currentColor) + UI icons
style/main.scss       SCSS source
moto-storage/         Imported originals (git-ignored) — {owner}/{ride}.{ext}
docs/ideas.md         The product vision
_PLANS/               Plans + handoff (route-builder-pivot is current)
app/, utils/schema.sql  LEGACY PHP/MySQL (reference only)
```

## Local development

```bash
npm install
docker compose up -d --wait db          # Postgres on 127.0.0.1:5432
# create .env (see .env.example), then:
npx drizzle-kit push                     # apply schema
npx tsx src/db/seed.ts                   # user #1 + sample ride
npm run sass                             # compile CSS if SCSS changed
npm run dev                              # tsx watch → :6686
```

### The localhost vs 127.0.0.1 wrinkle (read this)

- The **Mapbox** dev token was URL-restricted to `localhost`, so browse the
  builder/native viewer at **`http://localhost:6686`**. At `127.0.0.1` Mapbox
  tiles/Directions/geocoding returned **403** (style JSON still loads, so the map
  looks half-broken — that's the tell). **Caveat as of 2026-07-24:** the token
  now in `.env` answers 200 for every origin tested, so it looks unrestricted and
  this wrinkle may not currently bite. Treat that as a loose end to confirm in
  the Mapbox dashboard, not as license to ship an unrestricted prod token.
- The **legacy Google** viewer's key is referrer-restricted to `127.0.0.1`, so
  imported-ride viewing may want `127.0.0.1`. This split disappears in Phase 4
  when Google goes away.
- `APP_ORIGIN` is `http://127.0.0.1:6686`, but `isAllowedOrigin`
  (`src/auth/access.ts`) accepts **both** localhost and 127.0.0.1 on the dev port,
  so the CSRF gate passes from either. Production is a single `https` origin, so
  none of this applies there.

## Configuration

`.env` (see `.env.example`). Keys of note:

```text
PORT=6686
MAPBOX_TOKEN=pk.<public token, URL-restricted to localhost in dev>
GMAPS_KEY=<legacy Google key — imported viewer only, removed in Phase 4>
STORAGE_PATH=./moto-storage
DATABASE_URL=postgresql://routeloop:routeloop_dev_pw@127.0.0.1:5432/routeloop
APP_ORIGIN=http://127.0.0.1:6686
# Local auth identity + deploy vars: see .env.example
```

## Phases

- **Auth — Cloudflare Access** ✅ done and working. Direct Google/GitHub OAuth
  was removed (`src/auth/oauth.ts` deleted, `arctic` uninstalled) and replaced
  with the Access email-header bridge in `src/auth/access.ts` +
  `src/routes/auth.ts`. The Access application allows exactly one address,
  `ziad@feralcreative.co`; everyone else is denied at the edge. See
  [docs/cloudflare-access.md](docs/cloudflare-access.md).
- **Rename + production cutover** ✅ `tankbag` → `routeloop` everywhere;
  deployed fresh to the NAS; `tankbag.app` 301s to `routeloop.app`.
- **Phase 0 — Mapbox setup** ✅ token in `.env` (localhost-restricted).
- **Phase 1 — Data model + roles + structured import** ✅ verified. `rides` /
  `routes` / `points` / `route_legs`, `roles.ts`, import produces structured
  rows.
- **Phase 2 — Builder MVP + native viewer** ✅ built & verified. Ride API
  (curl-tested: gating, validation, CSRF), the Mapbox builder (click/search to
  add stops, per-leg routing, roles, save), and the native Mapbox viewer. Save
  round-trip confirmed in a real browser.
- **Phase 3 — Via-point shaping + server exports** ⬜ NEXT. Drag-to-shape legs
  (`route_legs.via_points`); `src/maps/export.ts` (`buildKml`/`buildGpx` via
  `formatRoleName`); make `/kml` + `/gpx` source-aware (native = generated) and
  flip native `kmlUrl`/`gpxUrl` in `ride.json` from null to real URLs.
- **Phase 4 — Unify viewer, import UI, retire Google** ⬜ backfill script for
  pre-pivot rides; `/m/:slug` always Mapbox; delete `main.js`, the legacy
  metadata endpoint, and `GMAPS_KEY`; dashboard import form.
- **Phase 5 — Trip phase** ⬜ multi-day rides (route tabs, per-route
  datetimes) + the timeline slider from `docs/ideas.md`.
- **Phase 6 / backlog** ⬜ bikes + rider profiles, KMZ/CSV import, autosave,
  drag-reorder, per-leg off-road mode, PostGIS. Plus the near-term UX requests
  in `_PLANS/changes-260724T0250Z.md` (title-as-placeholder, role
  multi-select dropdown, splash/login + home page with recent & popular rides,
  logo).

## Deployment state (2026-07-24)

Production was cut over by **replacing** the old stacks rather than migrating
them, so the `maps` → `rides` rename landmine is **resolved for prod**: the old
`routeloop.app` (an unrelated leftover "rootloop" Express app on `:16703`) and
the old `tankbag.app` stack were composed down and archived to
`/volume1/web/_retired/*-20260724T205817`, and this repo was deployed into a
fresh, empty database. Live now:

```text
container   routeloop            healthy, 127.0.0.1:16703 + :6686  → :6686
container   routeloop-db         healthy, empty at cutover
container   routeloop-stage      healthy, 127.0.0.1:6687  + :16687 → :6686
container   routeloop-stage-db   healthy, schema applied
tunnel      routeloop.app        → localhost:16703
tunnel      tankbag.app          → localhost:6686    (same container; 301s away)
tunnel      stage.routeloop.app  → localhost:6687
tunnel      stage.tankbag.app    → localhost:16687   (same container; 301s away)
DNS         routeloop.app        proxied CNAME → the feral-nas tunnel
DNS         stage.routeloop.app  proxied CNAME → the feral-nas tunnel
```

Stage was scaffolded on 2026-07-25; the old `tankbag-stage` stack that occupied
`:6687` is archived under `/volume1/web/_retired/`. Both environments were
deployed onto brand-new empty databases, which is why the `maps` → `rides`
rename landmine never had to be resolved.

The prod database being empty is expected, not a bug: a fresh deploy has no
rides until someone can sign in and make one.

## Provenance

The map engine was recovered from the original Moto-Rooter viewer and rewired.
The server was rebuilt PHP/MySQL → TypeScript/Hono/Postgres, then the product
pivoted from file-upload to the in-app Mapbox ride builder. The legacy Google
viewer and its taxonomy live on (ported) in the Mapbox engine; the file-upload
path survives as import.
