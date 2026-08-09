# AI Agent Primer: tankbag

**Last Updated:** 2026-08-06
**Project:** Motorcycle/road-trip ride planning, sharing & organizing app (tankbag.app)
**Status:** **Live in production on the new stack.** The product moved from "upload KML files" to "plan rides in-app"; upload survives as an import path. The app was renamed `tankbag` → `routeloop` on 2026-07-24 and **renamed back to `tankbag` on 2026-07-29**. Both migrations that defined branch `refactor/google-maps-and-auth` are **done and deployed**: **Cloudflare Access → Google OAuth + magic link**, and **Mapbox → Google Maps**. Since then the app has gained multi-day rides on one map, the trip timeline, an admin panel, public profiles, import/export across six formats, a printable roadbook, the Expand hand-off to Google Maps, undo plus crash-recovery drafts, and drag-to-shape. See "Where things stand" at the end of this document before starting anything.

This document orients an AI agent working on the codebase. Read it first, then [docs/STATUS.md](docs/STATUS.md) for exactly where things stand—that file moves faster than this one and wins where they disagree. Where either disagrees with the code, **the code is right**; that has happened more than once and has already caused a bogus GitHub issue to be filed for work already finished.

> **Neither Cloudflare Access nor Mapbox exists in this codebase any more.** Where this document names them it is describing history or explaining why something is shaped as it is. No `MAPBOX_*` value is read anywhere, and `public/js/main.js` is deleted. The Access _policy_ still exists at the Cloudflare edge and should be removed—it is redundant, not protective, since the deployed app has not read the header it injects since 2026-07-30.

> **Historical baggage.** The `app/` directory (a prior PHP/MySQL build) and `utils/schema.sql` (MySQL) are **superseded** reference material. Older plans (`_PLANS/multi-tenant-rebuild.md`, `_PLANS/tankbag-hono-rebuild.md`, `_PLANS/tankbag-phase2-auth.md`) describe earlier stages and are historical. The live backend is the TypeScript/Hono code under `src/`.

## What this project is

tankbag lets riders **plan** motorcycle rides (and car road trips) directly in the app: drop stops on a map, classify them (gas, food, camp, lodging, scenic…), and the route between them is snapped to roads. A ride is then managed, shared by link, and exported. It is a **planning / sharing / organizing tool—explicitly not a turn-by-turn navigation app** (see `docs/ideas.md`). The pain it solves: Google My Maps caps at ~10 waypoints and one route per layer and can't be used to navigate—"the worst of both worlds." tankbag has no such limits, and hands the finished plan off: `/m/:slug/navigate` serializes a ride into Google Maps links (9 waypoints plus two ends each), with **Expand** weaving in shaping points so Maps has too little room to pick its own roads.

Importing existing files (KML, KMZ, GPX, GeoJSON, CSV, or a zip of them) is a **migration path**, and native Tankbag JSON is the lossless backup format, not the main event. Files this app exports carry a **naming convention** (`src/maps/filename.ts`) so a folder of them re-imports as the trip it came from; see "The file naming convention" below. The vision doc is `docs/ideas.md`; near-term feature requests are in `_PLANS/changes-260724T0250Z.md`.

## The product model (drives the schema)

From `docs/ideas.md`:

- **Ride**—the shareable package (has the slug, visibility, title). Holds many routes across many days/sessions—the holistic view of an entire trip.
- **Route**—one session/day within a ride: an ordered list of stops joined by routed legs, with a start/end date-time. The builder edits several routes per ride as of 2026-07-30; the date-time fields exist in the schema and load into state but nothing sets them yet.
- **Three kinds of dots:**
  - **Waypoint**—an ephemeral shaping point that just keeps the route on course. Modeled as **leg via-points** (`route_legs.via_points`), _not_ rows in `points`.
  - **POI**—an interesting place near the route that does _not_ affect routing. `points.kind = 'poi'`, unordered.
  - **Stop**—a real stop (gas, food, hotel…); always has a duration; "ends" are stops with no duration. `points.kind = 'stop'`, ordered—these are the routing anchors.

## Architecture and stack

- **Backend**—TypeScript on **Hono**, run by Node (`tsx` in dev, Docker in prod); portable to Cloudflare Workers. **PostgreSQL** via **Drizzle ORM**. **Zod** for payload validation.
- **Maps**—**Google Maps JavaScript API** (rendering, via the inline bootstrap loader that defines `google.maps.importLibrary`), **Places (New)** `AutocompleteSuggestion` for search, and the **Routes API** for per-leg routing—proxied server-side through `POST /api/route`, because the Routes key is IP-restricted and unusable from a browser. Geocoding is proxied the same way through `POST /api/geocode`, for the same reason. The frontend has **no bundler**; libraries are imported on demand at runtime. The driver for the migration was place-search quality; the reason it was a whole-engine swap rather than a search swap is that each provider's terms tie their search results to their own basemap.
- **Auth**—Google OAuth (via `arctic`) plus an emailed magic link, both resolving through [src/auth/identity.ts](src/auth/identity.ts) into the same hand-rolled server sessions (SHA-256-hashed tokens). Deployed to stage and prod on 2026-07-30. It replaced Cloudflare Access, which is billed **per seat** and so could not survive open signups. Cloudflare **Turnstile** still guards uploads/saves, feature-flagged off until keys are set.
- **Authorization is separate from authentication.** `users.status` (`pending` | `active` | `blocked`) decides who may use the app; every new account starts `pending`. This is the capacity gate for a NAS-hosted alpha and is unaffected by either migration.
- **Frontend**—vanilla JavaScript. SCSS compiled to CSS with the `sass` CLI.
- **Hosting**—Synology NAS (Docker) behind Cloudflare Tunnel; HTTPS at the edge. Each container publishes **two** host ports and answers on both, which is what lets the canonical name change without touching tunnel config. Prod: `tankbag.app → localhost:6686` (canonical) and `routeloop.app → localhost:16703` (301s away). Stage: `stage.tankbag.app → localhost:16687` (canonical) and `stage.routeloop.app → localhost:6687` (301s away).

## One map engine

There is now **one** viewer and one shell. The legacy `public/js/main.js`—1,135 lines of `google.maps` predating everything else, which served imported rides on their own shell and read `window.MOTO` rather than `window.TB`—was deleted on 2026-08-01. It had survived the Mapbox era as the reference implementation for the port _back_ to Google, and once that was done its remaining job turned out to be already handled: `ride.json` has served both sources identically since the timeline work added per-leg spans, so an imported ride is simply one route with one leg. Retiring it was flipping a conditional and deleting the file, not porting a renderer.

The client is now:

- **`public/js/map-common.js`**—the shared engine, `window.TBMap`.
- **`public/js/viewer.js`** (read-only) and **`public/js/builder.js`** (editing), both reading `ride.json`.
- Four pure helpers that own arithmetic rather than DOM: **`ride-time.js`** (`window.TBTime`, the trip time model), **`twist.js`** (`window.TBTwist`), **`route-shape.js`** (`window.TBShape`, drag-to-shape index math) and **`builder-history.js`** (`window.TBHistory`, undo plus crash-recovery drafts). Each is `eval`'d by its own test file, which is the whole reason it is not inside `builder.js`.

The marker/tooltip/mileage behavior in `map-common.js` was ported from the legacy viewer's hard-won logic (colored `currentColor` SVG icons, the `From Start / From Gas / From Charge` tooltip columns, direction arrows, per-route hover-dim)—first onto Mapbox, then back onto Google.

**`map-common.js` is the only file that touches `google.maps`.** That boundary is load-bearing. The Mapbox version left marker construction to its callers, so `viewer.js` and `builder.js` each reached for `new mapboxgl.Marker` directly—which is exactly why swapping engines had to touch three files instead of one. They now go through `addMarker`, `removeMarker`, `onMarkerDragEnd`, `onMapClick`, `panTo` and `searchPlaces`, and name no vendor API at all. Preserve that.

Three things to know before editing the engine:

- **Coordinate order.** The app stores and speaks `[lng, lat]`; `google.maps` speaks `{lat, lng}`. `toLatLng` and `fromLatLng` in `map-common.js` are the only client-side conversion, matching `toGoogleWaypoint` in `src/routes/routing.ts` on the server. Reversed pairs still render—just in the wrong hemisphere, or subtly off. Routes API accepts `polylineEncoding: GEO_JSON_LINESTRING`, so `route_legs.geometry` keeps its `[lng,lat][]` shape and **no stored ride ever needed migrating**.
- **`.tb-marker` is deliberately `0×0`** in `_map.scss`. An `AdvancedMarkerElement` anchors its content at the content's _bottom-center_, so a zero-size wrapper puts that anchor exactly on the point and the legacy negative-margin offsets keep working. Give that wrapper a size and every marker drifts off its own coordinates.
- **A day is drawn as one polyline**, the concatenated geometry of every leg. That is what makes drag-to-shape non-trivial: a drag hands back a vertex index into that flat path, and turning it back into a leg plus a via-point slot is `route-shape.js`'s entire job. Legs share their joint vertex, because the concat drops the duplicate where one leg's last coordinate meets the next leg's first, and a leg with no geometry consumes no indices—an index calculation has to handle both. The leg highlight is one spare `Polyline` per map, sliced from the route's own line, rather than a `Polyline` per leg: per-leg lines would have changed the layer-id contract every caller depends on.

<!--| PAGE-BREAK -->

## The builder is multi-day, on one map

This is the feature the product model was designed around, and until 2026-07-30 it was the one thing missing: the schema, the API (`MAX_ROUTES = 31`) and the viewer all handled several routes per ride, while the builder held a single `state.route`, hardcoded route index `0` on the map layer, and loaded `ride.routes[0]` while warning that saving would drop the rest. A multi-day ride was effectively read-only.

**The rule that shapes the UI: every route is drawn at once, always.** Seeing the whole trip on a single map is the point of the app, so the day slider is a _focus_ control and never a navigation one—sliding to a day dims the others via `setRouteDim` (the same call the viewer's legend hover uses) and hides nothing. Position 0 is "all days" and dims nothing at all.

Consequences worth knowing before editing `public/js/builder.js`:

- **Edits always target exactly one day.** `editIndex()` is the focused day, or the _last_ day when the slider sits on "all"—that being the day you are extending. The label says which (`All days · editing Day 3`) so the color swatch is never ambiguous.
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

**File storage.** Imported originals live at `{STORAGE_PATH}/{owner_id}/{ride_id}.{ext}`, paths built only from integer ids and containment-checked, with `ext` from a closed list in `storage.ts`. A ride imported from several files keeps each one, day 2 onward suffixed `{ride_id}-{n}.{ext}`. Every format keeps its original—a KMZ as the KML pulled out of it, everything else as uploaded—and `rides.source_format` records what it arrived as. Bytes land in `kml_bytes`, `gpx_bytes` or `source_bytes`; `size_bytes` is generated from all three and **must** name every one, because the app increments `used_bytes` on import and the database decrements it from `size_bytes` on delete. Native rides have no files. Quota applies to imported bytes only.

## The role taxonomy

`src/maps/roles.ts` is the **single source of truth** for the 17 waypoint roles (start, finish, home, meet, split, gas, charge, break, camp, hotel, food, coffee, drinks, grocery, view, poi, wtf). It unifies the three divergent alias tables that existed in the legacy viewer and fixes their bugs (WTF now matches "WTF"; CHARGE matches "CHARGER"). It exports:

- `ROLES`, `ROLE_META` (`{ title, icon, aliases }` per role)
- `canonicalRole(term)`—alias → role
- `parseRoleName("GAS/FOOD - Chevron")` → `{ roles: ['gas','food'], name: 'Chevron' }`
- `formatRoleName(['gas'], 'Chevron')` → `"GAS - Chevron"` (for export/round-trip)

The `ROLE - Name` / `GAS/FOOD - Name` string convention now lives **only at the import/export boundary**. In the DB, roles are first-class enum values. Page shells inject `ROLE_META` as `window.TB.roles` so client code never re-declares it. Icons are in `public/img/icons/icon-<role>.svg`, filled with `currentColor` so they tint to the route color.

## The file naming convention

`src/maps/filename.ts` is the source of truth; `public/js/filename.js` mirrors it for the drop box and `test/filename-client.test.ts` holds the two together—the same arrangement `twist.ts`/`twist.js` and `ride-time.js` already use, and for the same reason.

```text
tankbag_big-sur-run_d02_2026-08-14_lost-coast.gpx
 marker     ride     day    date       title
```

- **Underscores separate fields, hyphens live inside one.** `slugField` guarantees no field ever contains an underscore, which is what stops a day title with a dash from splitting the filename. There is a test asserting exactly that; do not "simplify" the separator to a hyphen throughout.
- **The `tankbag_` marker is load-bearing.** `parseExportName` returns `null` without it, and every caller then does precisely what it did before the convention existed. A rider's own `day-2.gpx` must never be reinterpreted, and there is a table of realistic non-conforming names asserting it is not.
- **Optional fields are matched by shape, not position.**
- **Dates are formatted and parsed in UTC**, because the roadbook renders `routes.start_at` with `timeZone: 'UTC'`. Local getters would let a roadbook and a filename disagree about which day a route is on. Pinned by a test using an instant that falls on different calendar days in Pacific and UTC.
- **A title read off a filename is a guess**—`avenue-of-giants` comes back "Avenue Of Giants"—so the importer prefers a file's own internal name. **The date has no such competition and is authoritative**, and for GPX and KML it is the only place a schedule can survive at all.
- **Visibility and timezone are deliberately not fields.** A file named `public` that publishes a ride on import is a footgun; a filename claiming a zone would invent one.

`GET /api/public/maps/:slug/zip/{kml|gpx|geojson|csv}` downloads one conforming file per day. **It is registered ahead of the generic `:format` download route on purpose**—registered after it, the generic route swallows `/zip/gpx` and answers with a plain GPX. That was observed, not theorised.

`src/maps/zip.ts` owns both directions. The reader was `kmz.ts`'s internals and moved here when a second caller appeared; `kmz.ts` kept the *policy* (one entry, the first `.kml`) and its own error wording. Note `test/helpers/zip.ts` is a **different** writer that stays: it builds deliberately malformed archives for the reader's tests, writes no CRC, and would produce a file macOS refuses.

## Entry points and routes (`src/index.tsx` + `src/routes/*`)

A host middleware runs **first**, ahead of every route: requests for `routeloop.app` / `www.routeloop.app` / `stage.routeloop.app`, plus `www.tankbag.app`, get a **301 to the same path and query on the canonical host** (`tankbag.app`, or `stage.tankbag.app` for the staging pair). The redirect direction reversed on 2026-07-29 when the name went back to tankbag; before that it pointed the other way. Because it runs ahead of every route, a request arriving on a non-canonical hostname is redirected before any auth handler sees it.

Public (gated by `getViewable(slug, viewer)`—public/unlisted for anyone, private owner-only, else 404):

- `GET /`—public ride listing
- `GET /m/:slug`—viewer page. **One shell for both sources** since `main.js` was retired
- `GET /m/:slug/navigate`—the Google Maps hand-off page: each day as an ordered series of `/maps/dir/?api=1` links, with an Expand density control (off / light / tight) and the longest stretch Maps still routes for itself. Same visibility gate as the viewer. In `src/routes/handoff.tsx`
- `GET /m/:slug/roadbook`—the printable stop-by-stop sheet, server-rendered with no JavaScript. In `src/routes/roadbook.tsx`
- `GET /api/public/rides/:slug/ride.json`—normalized viewer contract (both sources): ride meta + `routes[]` each with `track`, `stops[]`, `pois[]`, and `legs[]` carrying `startIndex`/`endIndex` spans into that same `track`
- `GET /api/public/maps/:slug/:format{kml|gpx|geojson|csv}` and `/tankbag.json`—gated downloads. **Source-aware:** an imported ride streams its stored original byte-for-byte for the format it arrived in, and every other format is generated from the rows
- `GET /explore`, `/riders`, `/faq`, `/privacy`, `/terms`, and `/@:username` public profiles—in `src/routes/pages.tsx`. `/riders` is signed-in only, because an anonymous list of every account is a scraping target with no upside

Owner API (all `requireAuthApi` + `requireSameOrigin`):

- Import—`POST /api/maps` (multipart; KML, KMZ, GPX, GeoJSON, CSV, a **`.zip`** of any of those, or native Tankbag JSON → structured rows; full XXE-safe pipeline + transactional quota). **Several files posted at once become the days of one ride**, and all are validated before any is parsed so a bad tenth file names itself rather than leaving nine days half-imported. A zip is expanded before anything asks what format a file is, so nothing downstream ever sees one. **Day order comes from the `dNN` field when every file carries one, and from upload order otherwise**—partial sets keep upload order, because interleaving numbered and unnumbered files needs a rule nobody asked for. In `src/routes/maps.ts`; the upload form is `src/routes/import.tsx`, enhanced by `public/js/import.js` into a drop box that fills the form from the filenames.
- Builder—`POST /api/rides`, `PUT /api/rides/:id` (full-replace), `GET /api/rides/:id` (owner load). In `src/routes/rides.ts`.
- Edit/delete—`PATCH /api/maps/:id`, `DELETE /api/maps/:id` (owner-scoped; serve both sources). In `src/routes/maps.ts`.
- Clone—`POST /api/rides/:id/clone`, rebuilding a public native ride through the same `insertRideGraph` the builder uses. **Drops** descriptions (stop notes are where "gate code 4417" lives), times and via points, and lands **private**. Private and imported rides 404 rather than 403, so the endpoint confirms nothing.
- Routing—`POST /api/route` (also `requireActiveApi`): `{origin, destination, vias?}` as `[lng,lat]` in, `{geometry, distanceM, durationS}` out. Proxies Google Routes because the server key is IP-restricted and unusable from a browser, and caches computed legs because editing re-requests the same pair constantly. In `src/routes/routing.ts`. The builder's `directions()` calls it.
- Geocoding—`POST /api/geocode`, beside it and for the same reason. **A miss is cached as well as a hit** (a half-typed address is resubmitted constantly and a failed lookup bills the same as a successful one), and Geocoding reports "found nothing" as HTTP 200 with `ZERO_RESULTS`, handled explicitly rather than falling through as success.

Pages: `GET /builder` and `GET /builder/:id` (`requireAuth`, owner-checked, native-only) in `src/routes/rides.ts`; `GET /dashboard` in `src/routes/dashboard.tsx`; `GET`/`POST /profile` in `src/routes/profile.tsx`; `/admin` rider approval in `src/routes/admin.tsx`; auth routes in `src/routes/auth.tsx`.

### The ride payload (save = load shape)

Defined in `src/maps/ride-graph.ts`, not in `routes/rides.ts`, so the native JSON import validates and inserts through exactly the same code the builder's save does. A second path that agreed with it today would drift tomorrow.

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

- **XXE-safe XML parse** (`src/maps/kml.ts`)—reject any `<!DOCTYPE>` before parsing; `@xmldom/xmldom` does no network or entity resolution. A KMZ is unzipped and then handed to `processKml`, so it converges on this defense rather than routing around it.
- **Decompression cap** (`src/maps/kmz.ts`)—enforced _during_ inflate via `maxOutputLength`, not read from the archive header. A zip bomb is small on the wire and its declared size is whatever the author typed.
- **Structural depth check** (`src/maps/geojson.ts`)—JSON has no entities, so there is no DOCTYPE to refuse; deep nesting is the remaining structural attack and it is rejected before `JSON.parse` runs, on the same principle.
- **Server-side extraction**—waypoint roles parsed from name prefixes; the route track is the longest coordinate line; mileage is authoritative.
- **Sanitization**—`sanitizeText` strips tags and defuses `javascript:` / `data:` schemes in every name/description, at rest; the viewer's `esc()` is the second layer.
- **Transactional quota**—`SELECT … FOR UPDATE`, HTTP 413 over quota.
- **Visibility gate**—unknown/forbidden slugs return 404, never confirming a ride exists.
- **CSRF**—`requireSameOrigin` checks the `Origin` header via `isAllowedOrigin` (`src/config.ts`).

<!--| PAGE-BREAK -->

## Directory structure

```text
src/
  index.tsx           Hono app: home, viewer (one shell), ride.json,
                      gated download streams
  config.ts           Env-derived constants, allowed origins, feature flags
  content/            Static prose as HTML — faq, privacy, terms
  db/
    schema.ts         Drizzle schema — SOURCE OF TRUTH
    index.ts          DB connection (pg Pool + Drizzle)
    seed.ts           Dev seed: user #1 + sample ride (structured rows)
  auth/               session.ts, middleware.ts (gates), identity.ts,
                      google.ts, magic.ts, mailer.ts, username.ts,
                      ratelimit.ts (one sliding window, in-memory)
  maps/
    roles.ts          Canonical 17-role taxonomy (parse/format)
    kml.ts            XXE-safe parse, extraction, sanitize, KML + GPX
    kmz.ts            KMZ policy — one entry, the first .kml. Zip mechanics
                      live in zip.ts; this file owns what is read, not how
    zip.ts            Zip read + write. Caps the DECOMPRESSED size during
                      inflate, and the running total across entries
    filename.ts       The route-file naming convention — parse, build, plan
    geojson.ts        GeoJSON in; the only interchange format that keeps
                      roles, stop/POI and dwell
    csv.ts            RFC 4180 stop lists — no geometry, and none invented
    export.ts         Generates KML/GPX/GeoJSON/CSV + lossless Tankbag JSON
    ride-graph.ts     The ride payload schema, normalize, insertRideGraph —
                      shared by the builder's save and the native import
    fields.ts         Scalar field rules shared by every ride-shaped request
    palette.ts        Day colours; injected as window.TB.dayColors
    storage.ts        Integer-id file paths, containment-checked writes
    slug.ts           22-char base62 unguessable share ids
    twist.ts          Twistiness: degrees of heading change per mile
    expand.ts         Shaping points that bound the longest unpinned stretch
    gmaps-links.ts    A route as batched Google Maps directions URLs
    turnstile.ts      Feature-flagged siteverify
  routes/
    maps.ts           Import API + edit/delete (exports ownRide/canEditRide)
    import.tsx        GET /import — the multi-file upload form
    roadbook.tsx      GET /m/:slug/roadbook — the printable sheet
    handoff.tsx       GET /m/:slug/navigate — the Google Maps leg loader
    pages.tsx         /explore, /riders, /@username, /faq, /privacy, /terms
    admin.tsx         Rider approval — the reader of users.status
    rides.ts          Builder API + /builder pages
    routing.ts        POST /api/route + /api/geocode — Google proxies
    dashboard.tsx     Owner's ride list
    profile.tsx       /profile form POST, username reservations
    auth.tsx          Google OAuth + magic link, /welcome, logout
  views/
    layout.tsx        Shared chrome shell (page)
    splash.tsx        The alpha modal, injected into every page
    cards.tsx         rideCards — moved out of index to break a cycle
    esc.ts            HTML escaping
    assets.ts         Cache-busting asset() URLs
public/
  js/map-common.js    Shared Google engine (window.TBMap)—ONLY file
                      that touches google.maps
  js/viewer.js        Ride viewer (reads ride.json)
  js/builder.js       The ride builder — multi-day, one map, focus slider
  js/builder-history.js  Undo/redo (in memory) + drafts (survive a crash)
  js/route-shape.js   Drag-to-shape index math — pure, tested
  js/ride-time.js     The trip time model, shared by builder and viewer
  js/twist.js         Client twistiness, kept equal to the server's
  js/filename.js      The naming convention, kept equal to the server's
  js/import.js        The import drop box — enhancement over a plain form,
                      which still works with this file absent
  js/profile.js       Profile page (address geocoding via /api/geocode)
  js/site.js          Global chrome behavior
  style/main.min.css  Compiled CSS (build output)
  img/icons/          Role SVGs (currentColor) + UI icons — 22 files
style/main.scss       SCSS source + partials (_splash, _builder, _map, …)
moto-storage/         Imported originals (git-ignored) — {owner}/{ride}.{ext}
test/                 Vitest — pure logic only, no database or browser
docs/STATUS.md        Current state + next steps — READ THIS SECOND
docs/ROADMAP.md       The durable plan; GitHub issue labels outrank it
docs/ideas.md         The product vision
.github/workflows/    CI — typecheck + tests, Node 20 and 22
utils/
  seed-demo-rides.ts  Varied road-routed demo rides for dev (seeded RNG,
                      cached Routes calls, refuses a non-local DATABASE_URL)
  seed-dev.sh         Rebuilds the dev dataset, carrying accounts across
  tighten-em-dashes.mjs  Prose dash fixer — pre-commit hook + npm scripts
  deploy/             deploy.sh + prod/stage wrappers, deploy-utils.sh
                      (ops + env-to-env db-clone), hooks/post-deploy.sh,
                      sql/ hand-written additive DDL
_PLANS/               Plans + handoff (gitignored)
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

What _will_ bite: if the browser key's allow-list is wrong or lost, the map does not render at all and the console says `RefererNotAllowedMapError`. It happened on 2026-07-30 after the GCP project migration. See `docs/STATUS.md` for the re-verify script and the gotcha that makes a bad allow-list look like a working one.

## Configuration

`.env` (see `.env.example`). Keys of note:

```text
PORT=6686
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

- **Auth—Google OAuth + magic link** ✅ committed in `17de208`, **deployed to stage and prod 2026-07-30**. OAuth client (External consent screen), Vector Map ID and a Gmail app password all live on the `tankbag` GCP project (`976935115789`). Cloudflare Access is gone from the codebase. The **Access policy at the edge is the one loose end**, and the ordering constraint that used to guard it—deploy the code that stops trusting the header _before_ pulling the policy—has been satisfied since 2026-07-30.
- **Maps—Mapbox → Google** ✅ **deployed 2026-07-30** (`942e1d9`), browser-verified end to end. See [\_PLANS/AMENDMENTS-google-auth-and-maps.md](_PLANS/AMENDMENTS-google-auth-and-maps.md) for the four places the original plan was wrong—notably that `TWO_WHEELER` returns an empty HTTP 200 in the US and must be `DRIVE`.
- **Phase 4—retire Mapbox and the legacy viewer** ✅ 2026-08-01. `main.js` deleted (1,135 lines), `POST /api/geocode` took the last Mapbox call server-side, and every `MAPBOX_*` value is gone from config, compose, the deploy guards and `.env.example`.
- **Phase 3—Via-point shaping + server exports** ✅ both halves, in two pieces. Exports landed in sprint 09 (`src/maps/export.ts`, six formats in and five out, source-aware downloads); **drag-to-shape landed 2026-08-06**, so a rider can pull the line onto the road they meant and the dropped point becomes a via point on the right leg.
- **Trip timeline** ✅ 2026-08-01. `routes.start_at` / `end_at` are written by a real date-time UI, and the timeline and day slider write one shared focus model.
- **Admin panel** ✅ `users.status` has its reader: `/admin` approves, blocks and reinstates.
- **Public surfaces** ✅ `/explore`, `/riders`, `/@username` profiles, `/faq`, `/privacy`, `/terms`.
- **Autosave, undo and crash-recovery drafts** ✅ 2026-08-05.

Deferred, with reasons:

- **Places (saved locations)** ⬜ designed in [\_PLANS/sprint-01-260725T2320Z.md](_PLANS/sprint-01-260725T2320Z.md) Phase B, never built. Cut from Sprint 2 because it is two tables, seven endpoints, marker-group primitives and builder integration—larger than the rest of that sprint combined. The profile reserves a section for it.
- **The group layer** ⬜ the whole P1 tier, in dependency order: ride membership (#71), then friendships (#72), then the visibility levels that need both (#73). This is where the product stops being single-player, and it is the reason a rider brings anyone else.
- **On-the-road mobile interface** ⬜ #69. The navigate page exists and is not yet usable in gloves at a fuel stop: no finished-leg marking, no progress memory, no tolerance for losing signal.
- **Backlog** ⬜ bikes, drag-reorder, per-leg off-road mode, PostGIS, keyboard shortcuts, rich stop details.

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

## Where things stand—2026-08-06

The section to read first when picking this up cold. Everything above describes how the code works; this describes what was just done to it and what is waiting.

### Recently landed

| Sprint / date | What                                                                            |
| ------------- | ------------------------------------------------------------------------------- |
| 04–06         | Auth (Google OAuth + magic link), public profiles, admin panel, the timeline    |
| 07            | Builder panel model, POI dwell, **twistiness**                                  |
| 08            | HTML out of the TypeScript—static prose to `src/content/`, views to Hono JSX    |
| 09            | **Import and export**, branch `feat/import-export`, fourteen commits            |
| 2026-08-04    | Multi-track import (#70), **Expand** + the navigate page (#65, #66)             |
| 2026-08-05    | Contributor scaffolding: `CONTRIBUTING.md`, PR and issue templates, **CI**      |
| 2026-08-05/06 | **Autosave, undo and crash-recovery drafts** (#38), then **drag-to-shape** (#8) |
| 2026-08-09    | **The file naming convention**, per-day zip export, zip import, the drop box |

Sprint 09 in one line: the app reads KML, KMZ, GPX, GeoJSON, CSV and its own JSON, writes all but KMZ, takes several files as the days of one trip, and prints a roadbook.

Since then: a file holding several tracks lands as several days rather than only its longest; **Expand** (`src/maps/expand.ts`) plus `/m/:slug/navigate` turn a plan into Google Maps links, carrying **9 waypoints** per link—tested on a phone, where the "~10 points" figure in older docs was an assumption; CI runs typecheck and tests on Node 20 and 22 for every PR; and the builder gained undo, drafts that survive a crash, and drag-to-shape. **424 tests across 20 files.** Detail for all of it in [docs/STATUS.md](docs/STATUS.md).

**The P0 tier is empty.** The next real work is the P1 group layer—#71 ride membership, then #72 friendships, then #73 the visibility levels that need both.

### The load-bearing facts a new agent gets wrong

- **`[lng, lat]` everywhere.** Only `google.maps` speaks `{lat, lng}`, and exactly two places convert. GeoJSON agrees with us; do not "fix" it. Pinned in `test/round-trip.test.ts` across all five formats, which is the test that would catch a transposition that each format's own suite would not.
- **null is not zero.** Twistiness null means "nothing measured it"; 0 means "the road is straight". Same for `dist_from_start_m` on a trackless import. A format that guesses is indistinguishable from one that knows.
- **`rides.size_bytes` must name every byte column.** The app increments `used_bytes` on import, the database decrements it from `size_bytes` on delete. A column missing from that expression leaks quota on every delete, silently and forever.
- **Production is not precious.** Three accounts, all the owner's. Be careful with the _mechanics_ of a migration—`drizzle-kit push` without `--force`, additive DDL by hand in `utils/deploy/sql/`—and not about whether to do one. Deferring a schema change out of caution on 2026-08-03 is what shipped imports that destroyed multi-day structure.
- **The pre-commit tightener rewrites em dashes**, including in test fixtures. `test/em-dashes.test.ts` was once committed comparing strings to themselves because of it.
- **A filename is not a format.** `src/maps/filename.ts` carries four fields; everything else about a ride lives in the file or in Tankbag JSON. The temptation when someone asks for "all metadata in the filename" is to keep adding fields—roles, colours, dwell. Do not. The convention exists because GPX and KML cannot hold a **date**, and that is the field doing the work.
- **A snapshot shares what the builder never mutates in place, and that set changes.** `leg.geometry` is shared by reference because it is always replaced wholesale; `point.roles` must be copied because `splice()` mutates it. `leg.viaPoints` moved from the first group to the second the day drag-to-shape shipped, and nothing failed loudly—the snapshot just quietly gained the edit it existed to protect against. Check this whenever you add a feature that edits in place.

### Pick up here

1. **Point twistiness at real roads.** The whole reason the import path exists. Bands are calibrated on machine-generated demo rides; nothing in that corpus was chosen for being good. One const in `src/maps/twist.ts`.
2. **Remove the Cloudflare Access policy.** The code that stopped trusting it has been deployed since 2026-07-30; the policy is pure redundancy now.
3. **Add the `www.tankbag.app` tunnel route.** DNS exists, nothing routes it.
4. **The P1 group layer**, in dependency order: #71 → #72 → #73.

**Still open, not urgent:** `db-clone`'s dump/load path has never actually run; roughly 34 pre-existing prettier findings sit in files nobody has had reason to touch; and `.gitignore`'s `Icon` pattern no longer matches the macOS `Icon\r` file it was written for, which is latent rather than live.

**Do not re-file these—they are done, and were listed as outstanding after they were finished:** favicons (2026-07-31), privacy policy and terms (2026-08-01), the day-slider tick alignment (#19), the `/welcome` sign-out contrast (#45), single-file multi-day import (#70). This document and `docs/STATUS.md` have both described finished work as pending long enough to generate a bogus GitHub issue. **Look at the files before believing a checklist item.**

### Two things that are not checked by what you think checks them

- **`utils/` is not in `tsconfig.json`.** A bad import in `seed-demo-rides.ts` passed a clean typecheck and would only have failed at runtime:

  ```bash
  npx tsc --noEmit --strict --target ES2022 --module ESNext --moduleResolution Bundler \
    --types node --esModuleInterop --skipLibCheck utils/seed-demo-rides.ts
  ```

- **`test/` was not either, until 2026-08-03.** Vitest transpiles without type-checking, so fixtures drifted out of the types they claimed to be and everything still passed. Adding `test` to the include exposed eight real errors at once. It is in there now—keep it there.

### Deploy traps, all of which have actually happened

- **The old stack holds the ports.** `tankbag` wants `:6686` and `:16703`. Compose fails with `port is already allocated` and nothing more helpful. Bring the old stack down first.
- **A stale volume gets adopted silently.** Volumes are namespaced by `COMPOSE_PROJECT_NAME`, not the deploy directory, so a "fresh" deploy can come up on a 2026-07-20 pre-pivot schema. Symptom: a healthy container that 500s on sign-in with `column users.username does not exist`. Check `docker volume ls` before assuming an environment is empty.
- **The deploy ships only an explicit allow-list of env vars.** `GMAPS_MAP_ID`, `GOOGLE_CLIENT_*` and the `SMTP_*` set were once shipped nowhere: the container starts, passes its healthcheck, and is useless—no markers, and _neither sign-in method exists_, because both hide themselves when unconfigured. `deploy.sh` hard-fails on the ones that matter now.
- **The post-deploy hook used to be non-fatal and used `--force`.** A failed schema push printed a warning and the deploy still reported success, which is how production drifted three sprints behind and started 500ing. Both fixed; do not reintroduce either.
