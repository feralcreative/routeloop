# Architecture

How the app is put together, and which boundaries are load-bearing. Operating instructions are in [AGENTS.md](../AGENTS.md); this is the depth behind its Architecture section.

## Stack

- **Backend**—TypeScript on Hono, run by Node (`tsx` in dev, Docker in prod), portable to Cloudflare Workers. PostgreSQL via Drizzle ORM. Zod for payload validation. Views are Hono JSX.
- **Maps**—Google Maps JavaScript API for rendering (via the inline bootstrap loader that defines `google.maps.importLibrary`), Places (New) `AutocompleteSuggestion` for search, and the Routes API for per-leg routing. Routes and Geocoding are proxied server-side because the server key is IP-restricted and unusable from a browser.
- **Auth**—Google OAuth (via `arctic`) plus an emailed magic link, both resolving through `src/auth/identity.ts` into the same hand-rolled server sessions (the session PK is the SHA-256 hash of the browser token, never the token). Cloudflare Turnstile guards uploads and saves, feature-flagged off until keys are set.
- **Authorization is separate from authentication.** `users.status` (`pending` | `active` | `blocked`) decides who may use the app; every new account starts `pending`. That is the capacity gate for a NAS-hosted alpha.
- **Frontend**—plain JavaScript, no bundler; libraries are imported on demand at runtime. SCSS compiled by the `sass` CLI.

## Server modules

`src/` is organized by subject, not by layer.

| Path                                                      | What it owns                                                                                                                           |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `index.tsx`                                               | Hono app, host canonicalization, static assets, viewer, `ride.json`, gated download streams                                            |
| `config.ts`                                               | Env-derived constants, allowed origins, feature flags, `IS_DEV`                                                                        |
| `db/schema.ts`                                            | Drizzle schema—source of truth                                                                                                         |
| `db/seed.ts`                                              | Dev seed: user #1 plus a sample ride                                                                                                   |
| `auth/`                                                   | `session.ts`, `middleware.ts` (the gates), `identity.ts`, `google.ts`, `magic.ts`, `mailer.ts`, `username.ts`, `ratelimit.ts`          |
| `maps/roles.ts`                                           | The canonical 17-role taxonomy—parse and format                                                                                        |
| `maps/kml.ts`                                             | XXE-safe parse, extraction, sanitize, KML and GPX                                                                                      |
| `maps/kmz.ts`                                             | KMZ policy: one entry, the first `.kml`. Zip mechanics live in `zip.ts`                                                                |
| `maps/zip.ts`                                             | Zip read and write; caps the decompressed size during inflate                                                                          |
| `maps/geojson.ts`                                         | GeoJSON in—the only interchange format that keeps roles, stop/POI and dwell                                                            |
| `maps/csv.ts`                                             | RFC 4180 stop lists—no geometry, and none invented                                                                                     |
| `maps/export.ts`                                          | Generates KML, GPX, GeoJSON, CSV and lossless Routeloop JSON                                                                           |
| `maps/ride-graph.ts`                                      | The ride payload schema, `normalize`, `insertRideGraph`, and the caps                                                                  |
| `maps/filename.ts`                                        | The export filename convention—parse, build, plan                                                                                      |
| `maps/storage.ts`                                         | Integer-id file paths, containment-checked writes                                                                                      |
| `maps/expand.ts`                                          | Shaping points that bound the longest unpinned stretch                                                                                 |
| `maps/gmaps-links.ts`                                     | A day as batched Google Maps directions URLs                                                                                           |
| `maps/twist.ts`                                           | Twistiness: degrees of heading change per mile                                                                                         |
| `maps/slug.ts`, `palette.ts`, `fields.ts`, `turnstile.ts` | Share ids, day colors, shared scalar field rules, siteverify                                                                           |
| `routes/`                                                 | One module per surface; see [api.md](api.md)                                                                                           |
| `invites/`, `survey/`, `stats/`                           | Rule split from query—`policy.ts`/`score.ts`/`shape.ts` are pure and tested, `service.ts`/`questions.ts`/`query.ts` touch the database |
| `emails/`                                                 | JSX email templates plus `rules.ts` (what may be sent) and `theme.ts`                                                                  |
| `views/`                                                  | `layout.tsx` shell, `splash.tsx`, `cards.tsx`, `esc.ts`, `assets.ts` cache-busting                                                     |
| `content/`                                                | Static prose as HTML—faq, privacy, terms                                                                                               |
| `dev/livereload.ts`                                       | SSE reload endpoint, gated on `IS_DEV`                                                                                                 |

## One map engine

There is one viewer and one shell. The legacy `public/js/main.js` (1,135 lines of `google.maps` that served imported rides on their own shell and read `window.MOTO`) was deleted on 2026-08-01. `ride.json` has served both sources identically since the timeline work added per-leg spans, so an imported ride renders through the same path as a native one. (It used to be *literally* one day with one leg; since 2026-08-15 its track is split at its stops like any other ride's—see `src/maps/track-split.ts`.)

The client is:

- **`public/js/map-common.js`**—the shared engine, `window.TBMap`.
- **`public/js/viewer.js`** (read-only) and **`public/js/builder.js`** (editing), both reading `ride.json`.
- Four pure helpers that own arithmetic rather than DOM, each `eval`'d by its own test file—which is the whole reason each is not inside `builder.js`: **`ride-time.js`** (`window.TBTime`), **`twist.js`** (`window.TBTwist`), **`route-shape.js`** (`window.TBShape`) and **`builder-history.js`** (`window.TBHistory`, undo plus crash-recovery drafts).
- **`public/js/filename.js`**, **`import.js`** (the drop box), **`profile.js`** and **`site.js`**.

**`map-common.js` is the only file that calls `google.maps`**—nine references, all there; every other mention in the tree is a comment. That boundary is why the Mapbox → Google migration was a one-file rewrite. The Mapbox version left marker construction to its callers, so `viewer.js` and `builder.js` each reached for `new mapboxgl.Marker` directly, which is exactly why swapping engines had to touch three files instead of one. They now go through `addMarker`, `removeMarker`, `onMarkerDragEnd`, `onMapClick`, `panTo` and `searchPlaces`. Whether this is enforced policy is explicitly Ziad's call—see the Rules of engagement in [AGENTS.md](../AGENTS.md).

The marker, tooltip and mileage behavior in `map-common.js` was ported from the legacy viewer's hard-won logic: colored `currentColor` SVG icons, the `From Start / From Gas / From Charge` tooltip columns, direction arrows, per-day hover-dim.

### Three things to know before editing the engine

- **Coordinate order.** The app stores and speaks `[lng, lat]`; `google.maps` speaks `{lat, lng}`. `toLatLng` and `fromLatLng` are the only client-side conversion, matching `toGoogleWaypoint` on the server. The Routes API accepts `polylineEncoding: GEO_JSON_LINESTRING`, so `route_legs.geometry` keeps its `[lng,lat][]` shape and no stored ride ever needed migrating.
- **`.tb-marker` is deliberately `0×0`.** An `AdvancedMarkerElement` anchors its content at the content's bottom-center, so a zero-size wrapper puts that anchor exactly on the point and the legacy negative-margin offsets keep working.
- **A day is drawn as one polyline**, the concatenated geometry of every leg. That is what makes drag-to-shape non-trivial: a drag hands back a vertex index into that flat path, and turning it into a leg plus a via-point slot is `route-shape.js`'s entire job. Legs share their joint vertex because the concat drops the duplicate, and a leg with no geometry consumes no indices—an index calculation has to handle both. The leg highlight is one spare `Polyline` per map, sliced from the day's own line, rather than a `Polyline` per leg: per-leg lines would have changed the layer-id contract every caller depends on.

## The builder is multi-day, on one map

**Every day is drawn at once, always.** Seeing the whole ride on a single map is the point of the app, so the day slider is a _focus_ control and never a navigation one: sliding to a day dims the others via `setRouteDim` (the same call the viewer's legend hover uses) and hides nothing. Position 0 is "all days" and dims nothing.

Consequences before editing `public/js/builder.js`:

- **Edits always target exactly one day.** `editIndex()` is the focused day, or the _last_ day when the slider sits on "all"—that being the day you are extending. The label says which (`All days · editing Day 3`) so the color swatch is never ambiguous.
- **Clicking a marker on a dimmed day focuses that day first**, otherwise the row it scrolls to would not be in the rendered list.
- **A new day is seeded with the previous day's last stop**, because a day begins where the last one ended.
- **Layers are keyed by day index**, so a delete or reorder invalidates every key at or after it. `rebuildLayers()` tears down and re-adds all of them rather than patching—O(days) on a list capped at 31, and it removes a whole class of stale-layer bug.
- **Empty days are dropped at save time.** The API requires at least one stop per day, so `payload()` filters days with no points and `save()` reports how many went.
- **A day is one ordered list of points; `kind` says only whether a point anchors routing.** Every point created by a rider is a POI, promoted to a stop from the row menu—except the first point of a day, which `addPoint()` promotes on the spot and tags `start`. Legs connect consecutive stops, so a day of POIs alone draws dots and no line. `stopsOf()` in `src/maps/ride-graph.ts` and in `public/js/builder.js` is the bridge between the list's index space and the stop ordinals the leg array uses.

## The role taxonomy

`src/maps/roles.ts` is the single source of truth for the 17 waypoint roles (start, finish, home, meet, split, gas, charge, break, camp, hotel, food, coffee, drinks, grocery, view, poi, wtf). It unified three divergent alias tables from the legacy viewer and fixed their bugs. It exports `ROLES`, `ROLE_META` (`{ title, icon, aliases }`), `canonicalRole(term)`, `parseRoleName("GAS/FOOD - Chevron")` and `formatRoleName(['gas'], 'Chevron')`.

The `ROLE - Name` string convention lives **only at the import/export boundary**. In the database, roles are first-class enum values. Page shells inject `ROLE_META` as `window.TB.roles` so client code never re-declares it. Icons are `public/img/icons/icon-<role>.svg`, filled with `currentColor` so they tint to the day color.

Adding a role means all four: `ROLES` and `ROLE_META` in `roles.ts`, the `waypoint_role` enum in `src/db/schema.ts` (plus the generated migration), an icon SVG, and the alias table if the format importers should recognize a synonym.

## The file naming convention

`src/maps/filename.ts` is the source of truth; `public/js/filename.js` mirrors it for the drop box and `test/filename-client.test.ts` holds the two together—the same arrangement `twist.ts`/`twist.js` and `ride-time.js` already use, and for the same reason.

```text
routeloop_big-sur-run_d02_2026-08-14_lost-coast.gpx
 marker     ride     day    date       title
```

- **Underscores separate fields, hyphens live inside one.** `slugField` guarantees no field contains an underscore, which stops a day title with a dash from splitting the filename. A test asserts exactly that.
- **The `routeloop_` marker is load-bearing.** `parseExportName` returns `null` without it, and every caller then behaves as it did before the convention existed. There is a table of realistic non-conforming names asserting a rider's own `day-2.gpx` is never reinterpreted.
- **Optional fields are matched by shape, not position.**
- **Dates are formatted and parsed in UTC**, because the roadbook renders `days.start_at` with `timeZone: 'UTC'`. Pinned by a test using an instant that falls on different calendar days in Pacific and UTC.
- **A title read off a filename is a guess**—`avenue-of-giants` comes back "Avenue Of Giants"—so the importer prefers a file's own internal name. **The date has no such competition and is authoritative**, and for GPX and KML it is the only place a schedule can survive at all.
- **Visibility and timezone are deliberately not fields.** A file named `public` that publishes a ride on import is a footgun; a filename claiming a zone would invent one.

`src/maps/zip.ts` owns both zip directions. The reader was `kmz.ts`'s internals and moved when a second caller appeared; `kmz.ts` kept the _policy_ and its own error wording. `test/helpers/zip.ts` is a **different** writer that stays: it builds deliberately malformed archives for the reader's tests, writes no CRC, and would produce a file macOS refuses.

## The security pipeline (imports)

Ported from the PHP era and preserved. Re-derive these, never drop them.

- **XXE-safe XML parse** (`src/maps/kml.ts`)—reject any `<!DOCTYPE>` before parsing; `@xmldom/xmldom` does no network or entity resolution. A KMZ is unzipped and then handed to `processKml`, so it converges on this defense rather than routing around it.
- **Decompression cap** (`src/maps/zip.ts`)—enforced _during_ inflate via `maxOutputLength`, not read from the archive header. A zip bomb is small on the wire and its declared size is whatever the author typed.
- **Structural depth check** (`src/maps/geojson.ts`)—JSON has no entities, so deep nesting is the remaining structural attack; it is rejected before `JSON.parse` runs.
- **Server-side extraction**—waypoint roles parsed from name prefixes; the route track is the longest coordinate line; mileage is authoritative.
- **Sanitization**—`sanitizeText` strips tags and defuses `javascript:` and `data:` schemes in every name and description, at rest; the viewer's `esc()` is the second layer.
- **Transactional quota**—`SELECT … FOR UPDATE`, HTTP 413 over quota.
- **Visibility gate**—unknown or forbidden slugs return 404, never confirming a ride exists.
- **CSRF**—`requireSameOrigin` checks the `Origin` header via `isAllowedOrigin` in `src/config.ts`.

## Storage

Imported originals live at `{STORAGE_PATH}/{owner_id}/{ride_id}.{ext}`, with paths built only from integer ids, containment-checked, and `ext` drawn from a closed list in `storage.ts`. A ride imported from several files keeps each one, day 2 onward suffixed `{ride_id}-{n}.{ext}`. Every format keeps its original—a KMZ as the KML pulled out of it, everything else as uploaded—and `rides.source_format` records what it arrived as. Native rides have no files, and quota applies to imported bytes only.
