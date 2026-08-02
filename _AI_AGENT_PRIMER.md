# AI Agent Primer: tankbag

**Last Updated:** 2026-07-30
**Project:** Motorcycle/road-trip ride planning, sharing & organizing app (tankbag.app)
**Status:** **Live in production on the new stack.** The product moved from "upload KML files" to "plan rides in-app"; that pivot and Sprint 2's user profiles are merged. The app was renamed `tankbag` → `routeloop` on 2026-07-24 and **renamed back to `tankbag` on 2026-07-29**. Both migrations that defined branch `refactor/google-maps-and-auth` are now **done and deployed**: **Cloudflare Access → Google OAuth + magic link**, and **Mapbox → Google Maps**. The builder gained **multi-day rides on a single map** on 2026-07-30, which is the feature the whole product model was designed around. See "Where things stand" at the end of this document before starting anything.

This document orients an AI agent working on the codebase. Read it first, then [docs/STATUS.md](docs/STATUS.md) for exactly where things stand—that file moves faster than this one and wins where they disagree.

> **Neither Cloudflare Access nor Mapbox is live any more.** Where this document names them it is describing history, or the one remaining Mapbox call in `profile.js`. The Access *policy* still exists at the Cloudflare edge and should be removed—it is redundant, not protective, since the deployed app no longer reads the header it injects.

> **Historical baggage.** The `app/` directory (a prior PHP/MySQL build) and `utils/schema.sql` (MySQL) are **superseded** reference material. Older plans (`_PLANS/multi-tenant-rebuild.md`, `_PLANS/tankbag-hono-rebuild.md`, `_PLANS/tankbag-phase2-auth.md`) describe earlier stages and are historical. The live backend is the TypeScript/Hono code under `src/`.

## What this project is

tankbag lets riders **plan** motorcycle rides (and car road trips) directly in the app: drop stops on a map, classify them (gas, food, camp, lodging, scenic…), and the route between them is snapped to roads. A ride is then managed, shared by link, and exported. It is a **planning / sharing / organizing tool—explicitly not a turn-by-turn navigation app** (see `docs/ideas.md`). The pain it solves: Google My Maps caps at ~10 waypoints and one route per layer and can't be used to navigate—"the worst of both worlds." tankbag has no such limits.

Importing existing files (KML, GPX; later KMZ, CSV) is a **migration path**, not the main event. The vision doc is `docs/ideas.md`; near-term feature requests are in `_PLANS/changes-260724T0250Z.md`.

## The product model (drives the schema)

From `docs/ideas.md`:

- **Ride**—the shareable package (has the slug, visibility, title). Holds many routes across many days/sessions—the holistic view of an entire trip.
- **Route**—one session/day within a ride: an ordered list of stops joined by routed legs, with a start/end date-time. The builder edits several routes per ride as of 2026-07-30; the date-time fields exist in the schema and load into state but nothing sets them yet.
- **Three kinds of dots:**
  - **Waypoint**—an ephemeral shaping point that just keeps the route on course. Modeled as **leg via-points** (`route_legs.via_points`), *not* rows in `points`.
  - **POI**—an interesting place near the route that does *not* affect routing. `points.kind = 'poi'`, unordered.
  - **Stop**—a real stop (gas, food, hotel…); always has a duration; "ends" are stops with no duration. `points.kind = 'stop'`, ordered—these are the routing anchors.

## Architecture and stack

- **Backend**—TypeScript on **Hono**, run by Node (`tsx` in dev, Docker in prod); portable to Cloudflare Workers. **PostgreSQL** via **Drizzle ORM**. **Zod** for payload validation.
- **Maps**—**Google Maps JavaScript API** (rendering, via the inline bootstrap loader that defines `google.maps.importLibrary`), **Places (New)** `AutocompleteSuggestion` for search, and the **Routes API** for per-leg routing—proxied server-side through `POST /api/route`, because the Routes key is IP-restricted and unusable from a browser. The frontend has **no bundler**; libraries are imported on demand at runtime. The driver for the migration was place-search quality; the reason it was a whole-engine swap rather than a search swap is that each provider's terms tie their search results to their own basemap. One Mapbox call survives, in `profile.js`—see the phases below.
- **Auth**—Google OAuth (via `arctic`) plus an emailed magic link, both resolving through [src/auth/identity.ts](src/auth/identity.ts) into the same hand-rolled server sessions (SHA-256-hashed tokens). Deployed to stage and prod on 2026-07-30. It replaced Cloudflare Access, which is billed **per seat** and so could not survive open signups. Cloudflare **Turnstile** still guards uploads/saves, feature-flagged off until keys are set.
- **Authorization is separate from authentication.** `users.status` (`pending` | `active` | `blocked`) decides who may use the app; every new account starts `pending`. This is the capacity gate for a NAS-hosted alpha and is unaffected by either migration.
- **Frontend**—vanilla JavaScript. SCSS compiled to CSS with the `sass` CLI.
- **Hosting**—Synology NAS (Docker) behind Cloudflare Tunnel; HTTPS at the edge. Each container publishes **two** host ports and answers on both, which is what lets the canonical name change without touching tunnel config. Prod: `tankbag.app → localhost:6686` (canonical) and `routeloop.app → localhost:16703` (301s away). Stage: `stage.tankbag.app → localhost:16687` (canonical) and `stage.routeloop.app → localhost:6687` (301s away).

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

## The builder is multi-day, on one map

This is the feature the product model was designed around, and until 2026-07-30 it was the one thing missing: the schema, the API (`MAX_ROUTES = 31`) and the viewer all handled several routes per ride, while the builder held a single `state.route`, hardcoded route index `0` on the map layer, and loaded `ride.routes[0]` while warning that saving would drop the rest. A multi-day ride was effectively read-only.

**The rule that shapes the UI: every route is drawn at once, always.** Seeing the whole trip on a single map is the point of the app, so the day slider is a *focus* control and never a navigation one—sliding to a day dims the others via `setRouteDim` (the same call the viewer's legend hover uses) and hides nothing. Position 0 is "all days" and dims nothing at all.

Consequences worth knowing before editing `public/js/builder.js`:

- **Edits always target exactly one day.** `editIndex()` is the focused day, or the *last* day when the slider sits on "all"—that being the day you are extending. The label says which (`All days · editing Day 3`) so the color swatch is never ambiguous.
- **Clicking a marker on a dimmed day focuses that day first**, otherwise the row it scrolls to would not be in the rendered list.
- **A new day is seeded with the previous day's last stop**, because a day begins where the last one ended.
- **Layers are keyed by route index**, so a delete or reorder invalidates every key at or after it. `rebuildLayers()` tears down and re-adds all of them rather than patching—O(routes) on a list capped at 31, and it removes a whole class of stale-layer bug.
- **Empty days are dropped at save time.** The API requires `stops.min(1)` per route, so a day added but never filled would fail validation for the entire ride; `payload()` filters them and `save()` says how many went.

## Data model (PostgreSQL via Drizzle)

`src/db/schema.ts` is the **source of truth**. Schema is applied with `npx drizzle-kit push` (declarative—there are no migration files; the NAS post-deploy hook runs the same push).

- **`users`**—identity, `quota_bytes`, denormalized `used_bytes`.
- **`user_identities`**—one row per login method, so a rider can arrive by Google or by magic link and land on the same account. Legacy Google and GitHub identity rows remain valid.
- **`sessions`**—PK is the SHA-256 hash of the browser token, never the token.
- **`rides`**—`owner_id`, unguessable `slug`, `title`, `description`, `visibility` (public/unlisted/private), **`source`** (native | imported), `external_url`, byte columns + generated `size_bytes` (imported originals + quota), and caches `total_miles`, `total_duration_s`, `stop_count`.
- **`routes`**—`ride_id`, `position`, `title`, **`color`** (per-route, feeds the legend), `start_at`/`end_at` (nullable; timeline model), `distance_m`, `duration_s`.
- **`points`**—`route_id`, `kind` (stop | poi), `position` (stop order; null for POIs), `lat`/`lng`, `name`, `description`, **`roles waypoint_role[]`** (≤ 4, DB-checked), `duration_min` (null = no duration), `dist_from_start_m` (server-computed).
- **`route_legs`**—`route_id`, `position` (leg i = stop i → i+1), `geometry jsonb` (`[lng,lat][]`, 6-decimal), `distance_m`, `duration_s`, `via_points jsonb` (the ephemeral shaping waypoints).

**One rendering path for both sources.** An **imported** ride is stored as one route with a single leg at `position 0` holding the whole track; a **native** ride has one leg per pair of stops. Viewers always render `concat(legs)` per route—so imported and native rides render identically.

**Enums:** `provider`, `visibility`, `ride_source`, `point_kind`, `waypoint_role` (the 17 roles—keep in sync with `src/maps/roles.ts`).

**File storage.** Imported originals live at `{STORAGE_PATH}/{owner_id}/{ride_id}.kml` (and `.gpx`), paths built only from integer ids and containment-checked. Native rides have no files. Quota applies to imported bytes only.

## The role taxonomy

`src/maps/roles.ts` is the **single source of truth** for the 17 waypoint roles (start, finish, home, meet, split, gas, charge, break, camp, hotel, food, coffee, drinks, grocery, view, poi, wtf). It unifies the three divergent alias tables that existed in the legacy viewer and fixes their bugs (WTF now matches "WTF"; CHARGE matches "CHARGER"). It exports:

- `ROLES`, `ROLE_META` (`{ title, icon, aliases }` per role)
- `canonicalRole(term)`—alias → role
- `parseRoleName("GAS/FOOD - Chevron")` → `{ roles: ['gas','food'], name: 'Chevron' }`
- `formatRoleName(['gas'], 'Chevron')` → `"GAS - Chevron"` (for export/round-trip)

The `ROLE - Name` / `GAS/FOOD - Name` string convention now lives **only at the import/export boundary**. In the DB, roles are first-class enum values. Page shells inject `ROLE_META` as `window.TB.roles` so client code never re-declares it. Icons are in `public/img/icons/icon-<role>.svg`, filled with `currentColor` so they tint to the route color.

## Entry points and routes (`src/index.ts` + `src/routes/*`)

A host middleware runs **first**, ahead of every route: requests for `routeloop.app` / `www.routeloop.app` / `stage.routeloop.app`, plus `www.tankbag.app`, get a **301 to the same path and query on the canonical host** (`tankbag.app`, or `stage.tankbag.app` for the staging pair). The redirect direction reversed on 2026-07-29 when the name went back to tankbag; before that it pointed the other way. Because it runs ahead of every route, a request arriving on a non-canonical hostname is redirected before any auth handler sees it.

Public (gated by `getViewable(slug, viewer)`—public/unlisted for anyone, private owner-only, else 404):

- `GET /`—public ride listing
- `GET /m/:slug`—viewer page; **native → current engine shell**, **imported → legacy `main.js` shell**
- `GET /api/public/rides/:slug/ride.json`—normalized viewer contract (both sources): ride meta + `routes[]` each with `track`, `stops[]`, `pois[]`
- `GET /api/public/maps/:slug`—**legacy** metadata array (`main.js` only; retires with it)
- `GET /api/public/maps/:slug/kml` · `/gpx`—gated file streams (imported originals)

Owner API (all `requireAuthApi` + `requireSameOrigin`):

- Import—`POST /api/maps` (multipart KML+optional GPX → one imported ride with structured rows; full XXE-safe pipeline + transactional quota). In `src/routes/maps.ts`.
- Builder—`POST /api/rides`, `PUT /api/rides/:id` (full-replace), `GET /api/rides/:id` (owner load). In `src/routes/rides.ts`.
- Edit/delete—`PATCH /api/maps/:id`, `DELETE /api/maps/:id` (owner-scoped; serve both sources). In `src/routes/maps.ts`.
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

Ported from the PHP era and preserved—re-derive, never drop these:

- **XXE-safe XML parse** (`src/maps/kml.ts`)—reject any `<!DOCTYPE>` before parsing; `@xmldom/xmldom` does no network or entity resolution.
- **Server-side extraction**—waypoint roles parsed from name prefixes; the route track is the longest coordinate line; mileage is authoritative.
- **Sanitization**—`sanitizeText` strips tags and defuses `javascript:` / `data:` schemes in every name/description, at rest; the viewer's `esc()` is the second layer.
- **Transactional quota**—`SELECT … FOR UPDATE`, HTTP 413 over quota.
- **Visibility gate**—unknown/forbidden slugs return 404, never confirming a ride exists.
- **CSRF**—`requireSameOrigin` checks the `Origin` header via `isAllowedOrigin` (`src/config.ts`).

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
  js/builder.js       The ride builder — multi-day, one map, focus slider
  js/profile.js       Profile page (address geocoding)
  js/site.js          Global chrome behavior
  style/main.min.css  Compiled CSS (build output)
  img/icons/          17 role SVGs (currentColor) + UI icons
style/main.scss       SCSS source
moto-storage/         Imported originals (git-ignored) — {owner}/{ride}.{ext}
docs/STATUS.md        Current state + next steps — READ THIS SECOND
docs/ideas.md         The product vision
utils/
  seed-demo-rides.ts  Varied road-routed demo rides for dev (seeded RNG,
                      cached Routes calls, refuses a non-local DATABASE_URL)
  deploy/             deploy.sh + prod/stage wrappers, deploy-utils.sh
                      (ops + env-to-env db-clone), hooks/post-deploy.sh
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
- **Phase 1—Data model + roles + structured import** ✅ `rides` / `routes` / `points` / `route_legs`, `roles.ts`, import produces structured rows.
- **Phase 2—Builder MVP + native viewer** ✅ ride API (gating, validation, CSRF), the builder, the native viewer. Save round-trip confirmed in a browser.
- **Unified shell + SCSS split** ✅ one `page()` for every surface, global nav, alpha modal, SCSS partials, sign-in splash with background clip.
- **Sprint 2—user profiles** ✅ `users.status` authorization, `user_profiles`, `/profile`, `/welcome`, home-address seeding.

In flight on `refactor/google-maps-and-auth`:

- **Auth—Google OAuth + magic link** 🔄 committed in `17de208`; **credentials now in place and both methods verified locally (2026-07-30)**—OAuth client (External consent screen), Vector Map ID, and a Gmail app password, all on the `tankbag` GCP project (`976935115789`). Cloudflare Access is deleted from the codebase; **do not remove the Access policy until this ships to prod**, or the deployed build is open. Still needs the prod deploy, in the correct order (deploy new auth, then pull the Access policy).
- **Maps—Mapbox → Google** ✅ **done and deployed 2026-07-30** (`942e1d9`), browser-verified end to end. `map-common.js`, `viewer.js` and `builder.js` all run on `google.maps`; the builder routes through `POST /api/route` and searches with Places `AutocompleteSuggestion`. Keys + Vector Map ID live on the `tankbag` GCP project. **Two things remain:** `profile.js` still calls Mapbox Geocoding and wants a server proxy (Geocoding is on the IP-restricted server key), and Phase 4 retires `main.js` plus the dead `MAPBOX_*` config. See [docs/STATUS.md](docs/STATUS.md) for the port's details and [_PLANS/AMENDMENTS-google-auth-and-maps.md](_PLANS/AMENDMENTS-google-auth-and-maps.md) for the four places the original plan was wrong—notably that `TWO_WHEELER` returns an empty HTTP 200 in the US and must be `DRIVE`.

Deferred, with reasons:

- **Phase 3—Via-point shaping + server exports** ⬜ drag-to-shape legs into `route_legs.via_points`; `src/maps/export.ts`; source-aware `/kml` + `/gpx`. It was deferred behind the two migrations because building leg-shaping against a routing engine that was about to be replaced would have been wasted work. **That reason has now expired**—the engine is settled, so this is unblocked whenever it is wanted. `route_legs.via_points` already round-trips through the API and the builder clears it on any anchor move.
- **Places (saved locations)** ⬜ designed in [_PLANS/sprint-01-260725T2320Z.md](_PLANS/sprint-01-260725T2320Z.md) Phase B, never built. Cut from Sprint 2 because it is two tables, seven endpoints, marker-group primitives and builder integration—larger than the rest of that sprint combined. The profile reserves a section for it.
- **Rider list** ⬜ capability flag only (`users.can_manage_riders`). Lookup by email or phone is a user-enumeration surface and wants rate limiting before it exists.
- **Admin panel** ⬜ Sprint 3. `users.status` is the column it will drive.
- **Phase 5—Trip features** 🔄 **multi-day editing done 2026-07-30**; the date/time half is not started. `routes.start_at` / `end_at` exist in the schema and load into builder state, but nothing sets them and there is no date-time UI, so the timeline slider proper is still ahead.
- **Backlog** ⬜ bikes, KMZ/CSV import, autosave, drag-reorder, per-leg off-road mode, PostGIS, public profile pages (`username` is reserved and unique so this stays possible).

## Deployment state

Production and staging both run the **tankbag** stacks as of 2026-07-30. The old `routeloop`-named containers, images, volumes and networks are gone; their deploy directories (`/volume1/web/routeloop.app`, `/volume1/web/stage.routeloop.app`) still sit on disk, stopped, and can be deleted whenever.

```text
container   tankbag              healthy, 127.0.0.1:6686  + :16703 → :6686
container   tankbag-db           healthy, schema current, 1 ride
container   tankbag-stage        healthy, 127.0.0.1:16687 + :6687  → :6686
container   tankbag-stage-db     healthy, schema current
tunnel      tankbag.app          → localhost:6686     (canonical)
tunnel      routeloop.app        → localhost:16703    (same container; 301s away)
tunnel      stage.tankbag.app    → localhost:16687    (canonical)
tunnel      stage.routeloop.app  → localhost:6687     (same container; 301s away)
DNS         www.tankbag.app      record exists, but NO tunnel route — 404s
```

Each container publishes two host ports and answers on both, which is what let the canonical name change without touching tunnel config.

**Two traps this deploy actually hit, both worth knowing before the next one:**

- **The old stack holds the ports.** `tankbag` wants `:6686` and `:16703`, exactly what `routeloop` had. Compose fails with `port is already allocated` rather than anything descriptive. Bring the old stack down first.
- **A stale volume gets adopted silently.** Volumes are namespaced by `COMPOSE_PROJECT_NAME`, not by the deploy directory, so `tankbag-prod_db-data` and `tankbag-stage_db-data` from 2026-07-20 were still around and a "fresh" deploy came up on them—carrying a pre-pivot schema with a `maps` table and no `rides`. The symptom is a healthy container that 500s on sign-in with `column users.username does not exist`. `docker compose down -v` then re-run the post-deploy hook. **Check `docker volume ls` before assuming a new environment is empty.**

`www.tankbag.app` has a DNS record but no tunnel route, so it returns a bare Cloudflare 404. The app already 301s `www` → apex in `LEGACY_HOSTS`; it just never receives the request. Add the public hostname to the tunnel.

## Provenance

The map engine was recovered from the original Moto-Rooter viewer and rewired. The server was rebuilt PHP/MySQL → TypeScript/Hono/Postgres, then the product pivoted from file-upload to an in-app ride builder on Mapbox, which was replaced by Google Maps five weeks later when place-search quality proved decisive. The legacy Google viewer's taxonomy and tooltip behavior survived both moves by being ported forward each time; the file-upload path survives as import.

<!--| PAGE-BREAK -->

## Where things stand—end of 2026-07-30

The section to read first when picking this up cold. Everything above describes how the code works; this describes what was just done to it and what is waiting.

### What landed today

Branch `refactor/google-maps-and-auth`, pushed, six commits:

| | |
| --- | --- |
| `4a0a89d` | Repointed GitHub references at `feralcreative/tankbag`—the repo was renamed and the local remote still used the redirect |
| `942e1d9` | **The map engine port**, Mapbox GL → `google.maps`, across the engine, both consumers, both shells and the marker CSS |
| `728fd0b` | Role picker rendered permanently open—`[hidden]` was losing on specificity to a class selector |
| `8b39424` | Splash clip slowed to half speed in the encode, re-cut from the ProRes master with interpolated frames |
| `691b018` | **Deploy shipped none of the Google Maps or sign-in credentials**—the most important fix of the day; see below |

Uncommitted at end of day, all verified but not yet in a commit:

- **Multi-day builder** (`builder.js`, `rides.ts`, `_builder.scss`)—the day slider, per-day controls, add/delete/reorder, multi-route save and load.
- **`config.ts` empty-env fix**—`env()` now treats `''` as unset. This was a real bug: the deploy writes every optional variable whether or not it has a value, so `OWNER_EMAIL=` defeated its own default and the owner's account was created `pending` with nobody able to approve it.
- **`db-clone` / `db-restore`** in `deploy-utils.sh`.
- **`utils/seed-demo-rides.ts`** and the `.gitignore` entry for its cache.
- **`.panel-title`** dropped 3rem → 2.1rem with `line-height: 1.15`.

### Deployed, and what that cost

Stage and prod both run the new code. Getting there surfaced three things that are now documented but were not obvious:

1. **The deploy shipped `GMAPS_MAP_ID`, `GOOGLE_CLIENT_*` and the `SMTP_*` set nowhere.** Without them the container starts, passes its healthcheck, and is useless—no markers render and *neither sign-in method exists*, because both hide themselves when unconfigured and Cloudflare Access no longer backs them up. `deploy.sh` now hard-fails on the ones that matter.
2. **A stale 2026-07-20 volume was silently adopted** by a "fresh" deploy, carrying a pre-pivot schema. Symptom: healthy container, 500 on sign-in, `column users.username does not exist`.
3. **The old stack holds the ports.** Bring it down before deploying the new one.

The same volume-namespace trap hit the *local* dev database first, which is why `docker-compose.yml` now pins `name: tankbag`.

### Pick up here

**Loose ends from today, small:**

- Commit the uncommitted work above.
- **`db-clone` has never actually run.** Its guards are verified; the dump/load path is not. Try `db-clone stage dev` first—both sides disposable.
- The day-slider tick labels are evenly spaced, not aligned to thumb positions. Deliberate (exact alignment is not achievable in CSS because the thumb is inset half its width at each end) but worth a look.

**Then, roughly in order of what is actually in the way:**

1. **Remove the Cloudflare Access policy.** The code that stopped trusting it is deployed, so the policy is now pure redundancy. This was gated on the deploy and the deploy is done.
2. **Add the `www.tankbag.app` tunnel route.** DNS exists; nothing routes it.
3. **An admin panel.** Approving a rider is currently a hand-written `UPDATE users SET status='active'` over SSH, which the owner described in exactly the terms it deserves. `users.status` and `can_manage_riders` already exist; this is one owner-only route and a template. Smallest thing with the biggest effect on daily use.
4. **`profile.js` geocoding → a server proxy.** The last Mapbox call in the app and the only reason `MAPBOX_TOKEN` still has to be set.
5. **Phase 4—retire Mapbox and `main.js`.** Teach the current engine to draw an imported ride's single-leg track (`ride.json` already serves both sources identically), collapse the two viewer shells, then delete `MAPBOX_TOKEN`, `MAPBOX_GL_VERSION` and `MAPBOX_CSS_LINK`.
6. **Phase 5's other half—the timeline.** `routes.start_at` / `end_at` are in the schema and load into builder state; nothing sets them. Multi-day editing is done, dates are not.

**Still open, not urgent:** favicons carry the old routeloop mark; privacy policy and terms are required to publish the OAuth consent screen past 100 users; per-API quota caps are unset on the `tankbag` GCP project; the SonarCloud key still says `feralcreative_routeloop-app`; and `/volume1/web/routeloop.app` plus `stage.routeloop.app` are stopped but still on disk.

**One caution.** `utils/` is **not** in `tsconfig.json`'s `include`, so `npm run typecheck` does not check it. A bad import in `seed-demo-rides.ts` passed a clean typecheck and would only have failed at runtime. Check those files explicitly:

```bash
npx tsc --noEmit --strict --target ES2022 --module ESNext --moduleResolution Bundler \
  --types node --esModuleInterop --skipLibCheck utils/seed-demo-rides.ts
```
