# AI Agent Primer: tankbag

**Last Updated:** 2026-07-30
**Project:** Motorcycle/road-trip ride planning, sharing & organizing app (tankbag.app)
**Status:** **Live in production**, and mid-migration on two axes at once. The product moved from "upload KML files" to "plan rides in-app"; that pivot and Sprint 2's user profiles are committed and merged. The app was renamed `tankbag` → `routeloop` on 2026-07-24 and **renamed back to `tankbag` on 2026-07-29**; `routeloop.app` now 301s to `tankbag.app`. On branch `refactor/google-maps-and-auth` two replacements are underway: **Cloudflare Access → Google OAuth + magic link** (committed in `17de208`; credentials in place on the `tankbag` GCP project and both methods verified locally 2026-07-30—still needs a prod deploy) and **Mapbox → Google Maps** (**engine ported and browser-verified 2026-07-30** in `942e1d9`; only `profile.js` geocoding and dead config remain).

This document orients an AI agent working on the codebase. Read it first, then [docs/STATUS.md](docs/STATUS.md) for exactly where things stand — that file moves faster than this one and wins where they disagree.

> **Read this before trusting any "Cloudflare Access" detail below.** It is still being replaced, and sections describing it are accurate for what is currently in `main`, marked where the branch diverges. **Mapbox is no longer the rendering engine**—where this document still names it, it is describing history or the one remaining call in `profile.js`.

> **Historical baggage.** The `app/` directory (a prior PHP/MySQL build) and `utils/schema.sql` (MySQL) are **superseded** reference material. Older plans (`_PLANS/multi-tenant-rebuild.md`, `_PLANS/tankbag-hono-rebuild.md`, `_PLANS/tankbag-phase2-auth.md`) describe earlier stages and are historical. The live backend is the TypeScript/Hono code under `src/`.

## What this project is

tankbag lets riders **plan** motorcycle rides (and car road trips) directly in the app: drop stops on a map, classify them (gas, food, camp, lodging, scenic…), and the route between them is snapped to roads. A ride is then managed, shared by link, and exported. It is a **planning / sharing / organizing tool—explicitly not a turn-by-turn navigation app** (see `docs/ideas.md`). The pain it solves: Google My Maps caps at ~10 waypoints and one route per layer and can't be used to navigate—"the worst of both worlds." tankbag has no such limits.

Importing existing files (KML, GPX; later KMZ, CSV) is a **migration path**, not the main event. The vision doc is `docs/ideas.md`; near-term feature requests are in `_PLANS/changes-260724T0250Z.md`.

## The product model (drives the schema)

From `docs/ideas.md`:

- **Ride** — the shareable package (has the slug, visibility, title). Holds many routes across many days/sessions — the holistic view of an entire trip.
- **Route** — one session/day within a ride: an ordered list of stops joined by routed legs, with a start/end date-time (time model exists in the schema; the timeline-slider UI is a later phase).
- **Three kinds of dots:**
  - **Waypoint** — an ephemeral shaping point that just keeps the route on course. Modeled as **leg via-points** (`route_legs.via_points`), *not* rows in `points`.
  - **POI** — an interesting place near the route that does *not* affect routing. `points.kind = 'poi'`, unordered.
  - **Stop** — a real stop (gas, food, hotel…); always has a duration; "ends" are stops with no duration. `points.kind = 'stop'`, ordered — these are the routing anchors.

## Architecture and stack

- **Backend** — TypeScript on **Hono**, run by Node (`tsx` in dev, Docker in prod); portable to Cloudflare Workers. **PostgreSQL** via **Drizzle ORM**. **Zod** for payload validation.
- **Maps**—**Google Maps JavaScript API** (rendering, via the inline bootstrap loader that defines `google.maps.importLibrary`), **Places (New)** `AutocompleteSuggestion` for search, and the **Routes API** for per-leg routing—proxied server-side through `POST /api/route`, because the Routes key is IP-restricted and unusable from a browser. The frontend has **no bundler**; libraries are imported on demand at runtime. The driver for the migration was place-search quality; the reason it was a whole-engine swap rather than a search swap is that each provider's terms tie their search results to their own basemap. One Mapbox call survives, in `profile.js`—see the phases below.
- **Auth** — **being replaced.** Today on `main`: Cloudflare Access at the edge bridged to local sessions. On this branch: Google OAuth (via `arctic`) plus an emailed magic link, both resolving through [src/auth/identity.ts](src/auth/identity.ts) into the same hand-rolled server sessions (SHA-256-hashed tokens). Access is billed **per seat**, which is why it could not stay. Cloudflare **Turnstile** still guards uploads/saves, feature-flagged off until keys are set.
- **Authorization is separate from authentication.** `users.status` (`pending` | `active` | `blocked`) decides who may use the app; every new account starts `pending`. This is the capacity gate for a NAS-hosted alpha and is unaffected by either migration.
- **Frontend** — vanilla JavaScript. SCSS compiled to CSS with the `sass` CLI.
- **Hosting** — Synology NAS (Docker) behind Cloudflare Tunnel; HTTPS at the edge. Each container publishes **two** host ports and answers on both, which is what lets the canonical name change without touching tunnel config. Prod: `tankbag.app → localhost:6686` (canonical) and `routeloop.app → localhost:16703` (301s away). Stage: `stage.tankbag.app → localhost:16687` (canonical) and `stage.routeloop.app → localhost:6687` (301s away).

## Two map engines, both now Google

There are still **two** viewers, but they are no longer two vendors:

1. **Legacy viewer**—`public/js/main.js`, 1,135 lines of `google.maps` predating everything else. Serves **imported** rides only, via the `viewHtml` shell in `src/index.ts`. It parses KML in the browser and reads `window.MOTO`, not `window.TB`.
2. **The current engine**—`public/js/map-common.js` (shared, `window.TBMap`) plus `public/js/viewer.js` (read-only) and `public/js/builder.js` (editing). Serves **native** rides from `ride.json`.

The marker/tooltip/mileage behavior in `map-common.js` was ported from the legacy viewer's hard-won logic (colored `currentColor` SVG icons, the `From Start / From Gas / From Charge` tooltip columns, direction arrows, per-route hover-dim)—first onto Mapbox, then back onto Google. `main.js` was the reference implementation for that second move, which is why it was kept rather than deleted.

**`map-common.js` is the only file that touches `google.maps`.** That boundary is load-bearing. The Mapbox version left marker construction to its callers, so `viewer.js` and `builder.js` each reached for `new mapboxgl.Marker` directly—which is exactly why swapping engines had to touch three files instead of one. They now go through `addMarker`, `removeMarker`, `onMarkerDragEnd`, `onMapClick`, `panTo` and `searchPlaces`, and name no vendor API at all. Preserve that.

Two things to know before editing the engine:

- **Coordinate order.** The app stores and speaks `[lng, lat]`; `google.maps` speaks `{lat, lng}`. `toLatLng` and `fromLatLng` in `map-common.js` are the only client-side conversion, matching `toGoogleWaypoint` in `src/routes/routing.ts` on the server. Reversed pairs still render—just in the wrong hemisphere, or subtly off. Routes API accepts `polylineEncoding: GEO_JSON_LINESTRING`, so `route_legs.geometry` keeps its `[lng,lat][]` shape and **no stored ride ever needed migrating**.
- **`.tb-marker` is deliberately `0×0`** in `_map.scss`. An `AdvancedMarkerElement` anchors its content at the content's *bottom-center*, so a zero-size wrapper puts that anchor exactly on the point and the legacy negative-margin offsets keep working. Give that wrapper a size and every marker drifts off its own coordinates.

Retiring `main.js` means teaching the current engine to render an imported ride's single-leg track—which `ride.json` already serves identically for both sources.

<!--| PAGE-BREAK -->

## Data model (PostgreSQL via Drizzle)

`src/db/schema.ts` is the **source of truth**. Schema is applied with `npx drizzle-kit push` (declarative — there are no migration files; the NAS post-deploy hook runs the same push).

- **`users`** — identity, `quota_bytes`, denormalized `used_bytes`.
- **`user_identities`** — one row per login method, so a rider can arrive by Google or by magic link and land on the same account. Legacy Google and GitHub identity rows remain valid.
- **`sessions`** — PK is the SHA-256 hash of the browser token, never the token.
- **`rides`** — `owner_id`, unguessable `slug`, `title`, `description`, `visibility` (public/unlisted/private), **`source`** (native | imported), `external_url`, byte columns + generated `size_bytes` (imported originals + quota), and caches `total_miles`, `total_duration_s`, `stop_count`.
- **`routes`** — `ride_id`, `position`, `title`, **`color`** (per-route, feeds the legend), `start_at`/`end_at` (nullable; timeline model), `distance_m`, `duration_s`.
- **`points`** — `route_id`, `kind` (stop | poi), `position` (stop order; null for POIs), `lat`/`lng`, `name`, `description`, **`roles waypoint_role[]`** (≤ 4, DB-checked), `duration_min` (null = no duration), `dist_from_start_m` (server-computed).
- **`route_legs`** — `route_id`, `position` (leg i = stop i → i+1), `geometry jsonb` (`[lng,lat][]`, 6-decimal), `distance_m`, `duration_s`, `via_points jsonb` (the ephemeral shaping waypoints).

**One rendering path for both sources.** An **imported** ride is stored as one route with a single leg at `position 0` holding the whole track; a **native** ride has one leg per pair of stops. Viewers always render `concat(legs)` per route — so imported and native rides render identically.

**Enums:** `provider`, `visibility`, `ride_source`, `point_kind`, `waypoint_role` (the 17 roles — keep in sync with `src/maps/roles.ts`).

**File storage.** Imported originals live at `{STORAGE_PATH}/{owner_id}/{ride_id}.kml` (and `.gpx`), paths built only from integer ids and containment-checked. Native rides have no files. Quota applies to imported bytes only.

## The role taxonomy

`src/maps/roles.ts` is the **single source of truth** for the 17 waypoint roles (start, finish, home, meet, split, gas, charge, break, camp, hotel, food, coffee, drinks, grocery, view, poi, wtf). It unifies the three divergent alias tables that existed in the legacy viewer and fixes their bugs (WTF now matches "WTF"; CHARGE matches "CHARGER"). It exports:

- `ROLES`, `ROLE_META` (`{ title, icon, aliases }` per role)
- `canonicalRole(term)` — alias → role
- `parseRoleName("GAS/FOOD - Chevron")` → `{ roles: ['gas','food'], name: 'Chevron' }`
- `formatRoleName(['gas'], 'Chevron')` → `"GAS - Chevron"` (for export/round-trip)

The `ROLE - Name` / `GAS/FOOD - Name` string convention now lives **only at the import/export boundary**. In the DB, roles are first-class enum values. Page shells inject `ROLE_META` as `window.TB.roles` so client code never re-declares it. Icons are in `public/img/icons/icon-<role>.svg`, filled with `currentColor` so they tint to the route color.

## Entry points and routes (`src/index.ts` + `src/routes/*`)

A host middleware runs **first**, ahead of every route: requests for `routeloop.app` / `www.routeloop.app` / `stage.routeloop.app`, plus `www.tankbag.app`, get a **301 to the same path and query on the canonical host** (`tankbag.app`, or `stage.tankbag.app` for the staging pair). The redirect direction reversed on 2026-07-29 when the name went back to tankbag; before that it pointed the other way. Because it runs ahead of every route, a request arriving on a non-canonical hostname is redirected before any auth handler sees it.

Public (gated by `getViewable(slug, viewer)` — public/unlisted for anyone, private owner-only, else 404):

- `GET /` — public ride listing
- `GET /m/:slug`—viewer page; **native → current engine shell**, **imported → legacy `main.js` shell**
- `GET /api/public/rides/:slug/ride.json` — normalized viewer contract (both sources): ride meta + `routes[]` each with `track`, `stops[]`, `pois[]`
- `GET /api/public/maps/:slug`—**legacy** metadata array (`main.js` only; retires with it)
- `GET /api/public/maps/:slug/kml` · `/gpx` — gated file streams (imported originals)

Owner API (all `requireAuthApi` + `requireSameOrigin`):

- Import — `POST /api/maps` (multipart KML+optional GPX → one imported ride with structured rows; full XXE-safe pipeline + transactional quota). In `src/routes/maps.ts`.
- Builder — `POST /api/rides`, `PUT /api/rides/:id` (full-replace), `GET /api/rides/:id` (owner load). In `src/routes/rides.ts`.
- Edit/delete — `PATCH /api/maps/:id`, `DELETE /api/maps/:id` (owner-scoped; serve both sources). In `src/routes/maps.ts`.
- Routing—`POST /api/route` (also `requireActiveApi`): `{origin, destination, vias?}` as `[lng,lat]` in, `{geometry, distanceM, durationS}` out. Proxies Google Routes because the server key is IP-restricted and unusable from a browser, and caches computed legs because editing re-requests the same pair constantly. In `src/routes/routing.ts`. The builder's `directions()` calls it.

Pages: `GET /builder` and `GET /builder/:id` (`requireAuth`, owner-checked, native-only) in `src/routes/rides.ts`; `GET /dashboard` in `src/routes/dashboard.ts`; `GET`/`POST /profile` in `src/routes/profile.ts`; auth routes in `src/routes/auth.ts`.

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

Server-side integrity on save (`src/routes/rides.ts`): all text is sanitized, coords rounded to 6 decimals, and each leg's claimed `distanceM` is clamped to the haversine length of its geometry if it deviates > 15 % (Directions stays authoritative in the honest case; spoofing is bounded). Caps: 31 routes/ride, 200 stops + 200 POIs/route, ≤ 4 roles/point, 25k pts/leg, 200k pts/ride.

## The security pipeline (imports)

Ported from the PHP era and preserved — re-derive, never drop these:

- **XXE-safe XML parse** (`src/maps/kml.ts`) — reject any `<!DOCTYPE>` before parsing; `@xmldom/xmldom` does no network or entity resolution.
- **Server-side extraction** — waypoint roles parsed from name prefixes; the route track is the longest coordinate line; mileage is authoritative.
- **Sanitization** — `sanitizeText` strips tags and defuses `javascript:` / `data:` schemes in every name/description, at rest; the viewer's `esc()` is the second layer.
- **Transactional quota** — `SELECT … FOR UPDATE`, HTTP 413 over quota.
- **Visibility gate** — unknown/forbidden slugs return 404, never confirming a ride exists.
- **CSRF** — `requireSameOrigin` checks the `Origin` header via `isAllowedOrigin` (`src/config.ts`).

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
  auth/               session.ts, middleware.ts (gates), identity.ts,
                      google.ts, magic.ts, mailer.ts
  maps/
    roles.ts          Canonical 17-role taxonomy (parse/format)
    kml.ts            XXE-safe parse, extraction, sanitize, processGpx
    storage.ts        Integer-id file paths, containment-checked writes
    slug.ts           22-char base62 unguessable share ids
    turnstile.ts      Feature-flagged siteverify
  routes/
    maps.ts           Import API + edit/delete (exports fields/ownRide/firstIssue)
    rides.ts          Builder API + /builder pages
    routing.ts        POST /api/route — Google Routes proxy + leg cache
    dashboard.ts      Owner's ride list
    profile.ts        /profile form POST, username reservations
    auth.ts           Google OAuth + magic link, /welcome, logout
  views/layout.ts     Shared chrome shell (esc, page)
public/
  js/main.js          Legacy Google viewer (imported rides)—retires in Phase 4
  js/map-common.js    Shared Google engine (window.TBMap)—ONLY file
                      that touches google.maps
  js/viewer.js        Native ride viewer (reads ride.json)
  js/builder.js       The ride builder
  js/profile.js       Profile page (address geocoding)
  js/site.js          Global chrome behavior
  style/main.min.css  Compiled CSS (build output)
  img/icons/          17 role SVGs (currentColor) + UI icons
style/main.scss       SCSS source
moto-storage/         Imported originals (git-ignored) — {owner}/{ride}.{ext}
docs/STATUS.md        Current state + next steps — READ THIS SECOND
docs/ideas.md         The product vision
_PLANS/               Plans + handoff (google-auth-and-maps-migration + its
                      AMENDMENTS file are current)
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

### localhost vs 127.0.0.1—no longer a wrinkle

**Either host works.** The old rule to prefer `localhost` was a Mapbox token restriction and died with the engine.

- `GMAPS_KEY`'s referrer allow-list covers **both** `localhost:6686` and `127.0.0.1:6686`.
- `APP_ORIGIN` is `http://127.0.0.1:6686`, but `isAllowedOrigin` (`src/config.ts`) accepts both names on the dev port, so the CSRF gate passes from either. Production is a single `https` origin, so none of this applies there.

What *will* bite: if the browser key's allow-list is wrong or lost, the map does not render at all and the console says `RefererNotAllowedMapError`. It happened on 2026-07-30 after the GCP project migration. See `docs/STATUS.md` for the re-verify script and the gotcha that makes a bad allow-list look like a working one.

## Configuration

`.env` (see `.env.example`). Keys of note:

```text
PORT=6686
MAPBOX_TOKEN=pk.<public token—LAST USE is profile.js geocoding; dies in Phase 4>
GMAPS_KEY=<Google browser key — referrer-restricted, ships in page source. SET>
GMAPS_SERVER_KEY=<Google server key — IP-restricted, Routes/Geocoding. SET>
GMAPS_MAP_ID=<vector Map ID, required for Advanced Markers. SET>
STORAGE_PATH=./moto-storage
DATABASE_URL=postgresql://tankbag:tankbag_dev_pw@127.0.0.1:5432/tankbag
APP_ORIGIN=http://127.0.0.1:6686
# Local auth identity + deploy vars: see .env.example
```

## Phases

Done and merged:

- **Rename + production cutover** ✅ `tankbag` → `routeloop` everywhere, with a full production cutover on 2026-07-24. **Reverted on 2026-07-29:** the name is `tankbag` again and `routeloop.app` 301s to `tankbag.app`.
- **Phase 1 — Data model + roles + structured import** ✅ `rides` / `routes` / `points` / `route_legs`, `roles.ts`, import produces structured rows.
- **Phase 2 — Builder MVP + native viewer** ✅ ride API (gating, validation, CSRF), the builder, the native viewer. Save round-trip confirmed in a browser.
- **Unified shell + SCSS split** ✅ one `page()` for every surface, global nav, alpha modal, SCSS partials, sign-in splash with background clip.
- **Sprint 2 — user profiles** ✅ `users.status` authorization, `user_profiles`, `/profile`, `/welcome`, home-address seeding.

In flight on `refactor/google-maps-and-auth`:

- **Auth — Google OAuth + magic link** 🔄 committed in `17de208`; **credentials now in place and both methods verified locally (2026-07-30)** — OAuth client (External consent screen), Vector Map ID, and a Gmail app password, all on the `tankbag` GCP project (`976935115789`). Cloudflare Access is deleted from the codebase; **do not remove the Access policy until this ships to prod**, or the deployed build is open. Still needs the prod deploy, in the correct order (deploy new auth, then pull the Access policy).
- **Maps—Mapbox → Google** 🔄 **engine done 2026-07-30** (`942e1d9`), browser-verified end to end. `map-common.js`, `viewer.js` and `builder.js` all run on `google.maps`; the builder routes through `POST /api/route` and searches with Places `AutocompleteSuggestion`. Keys + Vector Map ID live on the `tankbag` GCP project. **Two things remain:** `profile.js` still calls Mapbox Geocoding and wants a server proxy (Geocoding is on the IP-restricted server key), and Phase 4 retires `main.js` plus the dead `MAPBOX_*` config. See [docs/STATUS.md](docs/STATUS.md) for the port's details and [_PLANS/AMENDMENTS-google-auth-and-maps.md](_PLANS/AMENDMENTS-google-auth-and-maps.md) for the four places the original plan was wrong—notably that `TWO_WHEELER` returns an empty HTTP 200 in the US and must be `DRIVE`.

Deferred, with reasons:

- **Phase 3 — Via-point shaping + server exports** ⬜ drag-to-shape legs into `route_legs.via_points`; `src/maps/export.ts`; source-aware `/kml` + `/gpx`. Deferred behind the two migrations — building leg-shaping against a routing engine that is being replaced would be wasted work.
- **Places (saved locations)** ⬜ designed in [_PLANS/sprint-01-260725T2320Z.md](_PLANS/sprint-01-260725T2320Z.md) Phase B, never built. Cut from Sprint 2 because it is two tables, seven endpoints, marker-group primitives and builder integration — larger than the rest of that sprint combined. The profile reserves a section for it.
- **Rider list** ⬜ capability flag only (`users.can_manage_riders`). Lookup by email or phone is a user-enumeration surface and wants rate limiting before it exists.
- **Admin panel** ⬜ Sprint 3. `users.status` is the column it will drive.
- **Phase 5 — Trip features** ⬜ multi-day rides + the timeline slider.
- **Backlog** ⬜ bikes, KMZ/CSV import, autosave, drag-reorder, per-leg off-road mode, PostGIS, public profile pages (`username` is reserved and unique so this stays possible).

## Deployment state

Production was cut over on 2026-07-24 by **replacing** the old stacks rather than migrating them, so the `maps` → `rides` rename landmine is **resolved for prod**: the old `routeloop.app` (an unrelated leftover "rootloop" Express app on `:16703`) and the old `tankbag.app` stack were composed down and archived to `/volume1/web/_retired/*-20260724T205817`, and this repo was deployed into a fresh, empty database.

**What is live on the NAS right now still carries the `routeloop` names** — the 2026-07-29 rename changed this repo only, and nothing has been deployed since:

```text
container   routeloop            healthy, 127.0.0.1:16703 + :6686  → :6686
container   routeloop-db         healthy, empty at cutover
container   routeloop-stage      healthy, 127.0.0.1:6687  + :16687 → :6686
container   routeloop-stage-db   healthy, schema applied
tunnel      tankbag.app          → localhost:6686     (now canonical)
tunnel      routeloop.app        → localhost:16703    (same container; will 301 away)
tunnel      stage.tankbag.app    → localhost:16687    (now canonical)
tunnel      stage.routeloop.app  → localhost:6687     (same container; will 301 away)
DNS         tankbag.app          proxied CNAME → the feral-nas tunnel
DNS         routeloop.app        proxied CNAME → the feral-nas tunnel
DNS         stage.tankbag.app    proxied CNAME → the feral-nas tunnel
DNS         stage.routeloop.app  proxied CNAME → the feral-nas tunnel
```

All four tunnel routes already exist and reach the same containers, so the rename needs **no tunnel or DNS change** — only a deploy. The container, image, database and deploy-directory names all move to `tankbag` on that deploy, which is not a rename of the running stack but a replacement of it. Read the cutover procedure in [docs/STATUS.md](docs/STATUS.md) before deploying, or the deploy silently builds a new empty stack beside the live one.

Stage was scaffolded on 2026-07-25; the old `tankbag-stage` stack that occupied `:6687` is archived under `/volume1/web/_retired/`. Both environments were deployed onto brand-new empty databases, which is why the `maps` → `rides` rename landmine never had to be resolved.

The prod database being empty is expected, not a bug: a fresh deploy has no rides until someone can sign in and make one.

## Provenance

The map engine was recovered from the original Moto-Rooter viewer and rewired. The server was rebuilt PHP/MySQL → TypeScript/Hono/Postgres, then the product pivoted from file-upload to an in-app ride builder on Mapbox, which was replaced by Google Maps five weeks later when place-search quality proved decisive. The legacy Google viewer's taxonomy and tooltip behavior survived both moves by being ported forward each time; the file-upload path survives as import.
