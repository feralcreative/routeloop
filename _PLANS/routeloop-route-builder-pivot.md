# routeloop — Route-Builder Pivot Plan (rev 2)

Updated: 2026-07-22, after ingesting `docs/ideas.md`. Supersedes the Phase 3 "upload-first" trajectory in `_PLANS/routeloop-hono-rebuild.md`. On approval, copy this plan to `_PLANS/routeloop-route-builder-pivot.md` (user rule).

## Context

routeloop.app is live (NAS Docker + Cloudflare Tunnel, OAuth working) but useless: sign in, look at an empty dashboard. The pivot: **planning rides in-app is the product** — "MyRouteApp but 1000x better, entire-trip focused" (`docs/ideas.md`). Users build snapped routes on Mapbox, classify stops in the existing 17-category taxonomy, and manage/share/export whole trips. File upload (KML/GPX, later KMZ/CSV, "as many formats as possible") becomes the import/migration path. Planning + sharing tool, explicitly NOT realtime navigation. No platform limits (vs Google's 10 waypoints).

## Product model (from ideas.md — drives the schema)

- **Ride** — the shareable package (slug, visibility, title): many routes over many days/sessions. The holistic view: every leg, every stop, every hotel, unlimited days and miles.
- **Route** — one session/day within a ride: ordered stops, start/end day-time. A ride's duration is the span of its routes.
- **Three kinds of dots**:
  - *Waypoint* — ephemeral shaping dot; keeps the route on course; nothing remarkable there. → modeled as **leg via-points**, not rows of their own.
  - *POI* — interesting, may-or-may-not stop; does NOT affect routing — annotation near the route. → `points.kind = 'poi'`, unordered.
  - *Stop* — not riding for a while; always has a duration; ends are stops without durations. Routing anchors. → `points.kind = 'stop'`, ordered.
- **Timeline slider** (later phase, schema-ready now): scrub a ride/route by date-time; the corresponding leg/section highlights. Position = route `start_at` + cumulative (leg `duration_s` + stop durations).
- **Profiles: riders + bikes** (backlog, additive): bike range enables "you'll need gas around here" from stop roles + leg distances.

## Decisions (made by Ziad, 2026-07-22)

1. **Mapbox** — GL JS + Directions + Geocoding v6. Ziad creates account + tokens; prod public token URL-restricted.
2. **Snap-to-roads** with draggable via-point shaping.
3. **Viewer unifies on Mapbox GL**; Google Maps + key retire at the end.
4. **Import v1 = KML + GPX**; KMZ + CSV fast-follow; format list grows over time, nothing proprietary/licensed.

Design defaults (flagged, not asked): imported maps read-only in the builder until a later converter; native rides bypass byte-quota (bounded by per-ride caps); vanilla JS frontend, CDN-pinned Mapbox GL, no bundler; builder MVP edits one route per ride (multi-route UI arrives with the trip phase, schema supports it from day one).

## What is kept (incl. uncommitted work)

Auth/sessions/middleware (`src/auth/*`), owner-aware visibility gate (`src/index.ts`), slug scheme (`src/maps/slug.ts`), XXE-safe parse/sanitize (`src/maps/kml.ts`), storage (`src/maps/storage.ts`), Turnstile flag (`src/maps/turnstile.ts`), import API + quota transaction (`src/routes/maps.ts`), deploy tooling. The 17-role taxonomy and `currentColor` SVG icons become first-class data — fixing the three inconsistent alias tables, missing WTF literal, CHARGE/CHARGER mismatch. Multi-route rendering (legend rows, per-route colors/toggles) is **kept and ported** — a multi-day ride is multiple routes on one map.

## Phase 0 — Baseline + Mapbox setup

- Commit the uncommitted import-pipeline work (asking Ziad first, per rule).
- **Ziad**: Mapbox account + two public tokens — `routeloop-dev` (unrestricted, local) and `routeloop-web` (URL-restricted to routeloop.app + stage.routeloop.app).
- Env: `MAPBOX_TOKEN` in `.env`; deploy plumbing mirrors `GMAPS_KEY` (`utils/deploy/deploy.sh`, `docker-compose.prod.yml`). Keep `GMAPS_KEY` until Phase 4.

## Phase 1 — Data model + unified roles + structured import

No visible change; safe deploy. Schema via `npx drizzle-kit push` locally + existing post-deploy hook in prod. Only seed data exists anywhere, so the rename below is free today and never again.

### Schema (`src/db/schema.ts`)

- **`rides`** (rename of `maps` — stakes are zero now): keeps id, ownerId, slug, title, description, visibility, externalUrl, byte columns (imported originals + quota), timestamps. Adds `source` enum native|imported (default imported). Drops per-map `color`, `waypoint_count`, `total_miles` in favor of per-route color and ride-level cached `totalMiles`/`totalDurationS`/`stopCount` recomputed on save/import.
- **`routes`**: id, rideId (FK cascade), position (unique per ride), title (varchar 150, default ''), color (varchar 7 — per-route, feeds legend), `startAt`/`endAt` (timestamptz, nullable — time model present now, UI later), `distanceM`/`durationS` caches.
- **`points`**: id, routeId (FK cascade), `kind` enum stop|poi, position (smallint, null for POIs; unique per route among stops), lat/lng (doublePrecision), name (varchar 255, default ''), description (varchar 2000), `roles waypoint_role[]` (17-value enum, default `{}`, check cardinality ≤ 4), `durationMin` (integer, null = no duration; ends are stops with null), `distFromStartM` (server-computed; stops by prefix sum, POIs by nearest-point projection). Check: kind stop → position not null.
- **`route_legs`**: id, routeId (FK cascade), position (leg i = stop i → i+1, unique per route), `geometry jsonb` (`[lng,lat][]`, 6-decimal rounding), `distanceM`, `durationS`, `viaPoints jsonb` (the ephemeral shaping waypoints).
- Per-leg rows, not a blob: incremental re-route maps 1:1, Directions distances stored losslessly, future per-leg `mode` (straight-line/dirt) is one column, timeline math is a prefix sum. **Imported** files → one route, one leg at position 0 holding the whole track; viewer always renders `concat(legs)` per route — one code path.
- Backlog-ready, not built now: `bikes` (userId, name, fuelRangeMi, notes), rider profile fields.
- Risk check: verify `drizzle-kit push` handles enum-array default + check constraints in dev first; fallback = drop DB checks, zod enforces.

### One canonical role table — `src/maps/roles.ts` (new)

`ROLES` (17), `ROLE_META` (title, icon, aliases — union of the three legacy tables + fixes), `canonicalRole()`, `parseRoleName()` (`"GAS/FUEL - Chevron"` → `{roles:['gas'], name:'Chevron'}`, dedup, cap 4), `formatRoleName()` (inverse, for export). Pages inject as `window.TB.roles`; clients never duplicate it.

### Structured extraction on import

- `src/maps/kml.ts`: export `sanitizeText`; `KmlResult` gains `points` (lat/lng/name/description/roles via `parseRoleName`) + `track` (longest coordinates line); add `distFromStartAlongTrack()` (port nearest-point + cumulative-meters from `main.js:273-309`, server-side once).
- `processGpx()`: track from `trk/trkseg/trkpt` (fallback `rte/rtept`), points from `wpt`; GPX file still stored byte-for-byte.
- `src/routes/maps.ts` POST: inside the existing transaction, insert one route (position 0, the ride's color) + points as **stops in doc order** (legacy semantics; POI reclassification is a later edit) + one full-track leg (`distanceM` = haversine). Turnstile/quota/file writes untouched.
- `src/db/seed.ts`: seed structured rows via `processKml` so dev exercises the unified viewer.

## Phase 2 — Builder MVP + native viewer (site stops being useless here)

### Ride API — `src/routes/rides.ts` (new)

Save = load payload: `{ title, description, visibility, external_url, routes: [{ title, color, startAt, endAt, stops: [{lat, lng, name, description, roles[], durationMin}], pois: [{lat, lng, name, description, roles[]}], legs: [{geometry, distanceM, durationS, viaPoints}] }] }`. Builder MVP sends exactly one route; the API accepts many from day one.

- Zod: reuse exported `fields` from `src/routes/maps.ts`; roles `z.enum(ROLES).array().max(4)`; caps per route — 200 stops, 200 POIs, 20 vias/leg, 25k pts/leg, 200k pts/ride total; `legs.length === max(0, stops.length - 1)` per route; ≤ 31 routes/ride; JSON bodyLimit 8 MB; `sanitizeText` on every name/description.
- Server integrity on save: recompute haversine per leg; claimed `distanceM` deviating > 15 % replaced. Prefix-sum `distFromStartM` for stops, project POIs onto the track, recompute ride/route caches.
- `POST /api/rides` (create: native, `generateSlug()`, Turnstile if enabled) · `PUT /api/rides/:id` (full-replace transaction: delete + reinsert routes/points/legs; owner-scoped 404; 409 for imported) · `GET /api/rides/:id` (owner load incl. vias). All `requireAuthApi` + `requireSameOrigin`. Existing PATCH/DELETE `/api/maps/:id` → renamed mount `/api/rides/:id` semantics preserved (PATCH meta, DELETE frees quota), one shared `ownRide` helper.

### Normalized public endpoint (`src/index.ts`)

`GET /api/public/rides/:slug/ride.json` — gated by `getViewable`: `{ title, description, source, totalMiles, kmlUrl, gpxUrl, externalUrl, routes: [{ title, color, startAt, track, stops: [... distFromStartMi, durationMin], pois: [...] }] }`. From-gas/from-charge NOT served — viewer derives from roles + distances (first stop counts as gas, never charge; charge column only if a later stop has role charge). Old `/api/public/maps/:slug*` paths stay as aliases until Phase 4 (legacy viewer still consumes them for imported maps).

### Page shells

- `viewHtml` branches on `source`: native → Mapbox shell (same panel markup; CDN-pinned GL JS v3 + CSS; `window.TB = { rideUrl, token, roles }`; loads `/js/map-common.js` + `/js/viewer.js`). Imported → existing Google shell untouched until Phase 4.
- `GET /builder` + `GET /builder/:id` (requireAuth, owner, native-only): full-bleed map + panel (ride meta, route color, search box, stop/POI list, Save). Loads `builder.js`.
- Dashboard: primary CTA "Plan a ride" → `/builder`; "Edit" on native cards.
- `style/main.scss` builder styles; `npm run sass`.

### Client JS (vanilla, CDN)

- **`public/js/map-common.js`** — init (outdoors-v12), per-route track source/layers + direction-arrow symbol layer (toggleable), marker factory (inline SVG, `el.style.color` = route color — `currentColor` replaces the data-URI recolor hack; multi-role grid stacking ≤ 4; distinct visual for POIs vs stops — POIs smaller/hollow), popup builder porting the tooltip exactly (role title + icon, From Start / From Gas / conditional From Charge, stop duration when set, name, description, esc(), hover-open + click-pin).
- **`public/js/viewer.js`** — fetch ride.json, render ALL routes (per-route colors), legend `.route-table` (per-route visibility checkbox, miles, GPX/KML/URL buttons — same DOM/classes so SCSS carries over), hover highlight/dim between routes (ported — meaningful again with multi-route rides), arrows toggle, panel collapse.
- **`public/js/builder.js`** — state mirrors payload + dirty flag. Add-mode toggle: **Stop** (default; routing anchor — click map or pick a geocode result) vs **POI** (annotation; never re-routes). Search: debounced Geocoding v6 forward, plain fetch. Drag stop marker → re-route adjacent legs on `dragend`. Stop rows: name, description, role-picker grid (17 icons, ≤ 4), duration input (minutes; blank for ends), up/down reorder, delete (merges adjacent legs). POI rows: name/description/roles only. Directions v5 driving, one leg per request (25-coord limit never approached), `geometries=geojson&overview=full`; per-leg sequence numbers drop stale responses; NoRoute → toast + revert. Explicit Save (POST → `history.replaceState`; PUT after); `beforeunload` when dirty; live totals (miles, riding time + stop time).

## Phase 3 — Via-point shaping + server exports

- **Vias** (`builder.js`): invisible wide hit-layer per leg → ghost point on hover → drag inserts into `viaPoints` (ordered by fractional position) → re-route that leg only. Small draggable circles; double-click deletes. Persisted in `route_legs.via_points`.
- **Exports** — `src/maps/export.ts` (new): `buildKml()` — one Document, per route a Folder with LineStyle (`#rrggbb` → `aabbggrr`), stop/POI Placemarks named via `formatRoleName` (round-trips our importer, Google Earth, the README convention), track LineString; XML-escaped everywhere. `buildGpx()` — GPX 1.1 `creator="routeloop.app"`, all `wpt` before one `trk` per route (multiple `trk` elements = multi-day rides in one file).
- `/kml` + `/gpx` endpoints become source-aware: imported streams the stored original; native returns generated docs. URLs unchanged.

## Phase 4 — Unify viewer, import UI, retire Google

1. `utils/backfill-structured.ts` (tsx): rides with zero legs get structured rows from stored KML; run once per environment.
2. `/m/:slug` always Mapbox; delete Google branch, `public/js/main.js`, legacy metadata-array endpoint + `/api/public/maps/*` aliases, unused `icon-waypoint*.svg`.
3. Import UI on dashboard ("Import from another app"): KML/GPX form → `POST /api/maps` (renamed `/api/rides/import`), Turnstile widget when configured.
4. Remove `GMAPS_KEY` everywhere; Ziad deletes the Google key in GCP after prod verifies.
5. Docs: README headline = builder; naming convention reframed as import/export convention with the unified alias table; update `docs/STATUS.md`, `_AI_AGENT_PRIMER.md`.

## Phase 5 — Trip phase: multi-day rides + timeline

- Builder: route tabs/list per ride ("add a day/session"), per-route start/end datetimes, route reorder; viewer legend groups by day.
- **Timeline slider** (the ideas.md signature feature): scrubber under the map from ride start to ride end; position → (route, leg, fraction) via cumulative leg `durationS` + stop `durationMin`; highlight that section, dim the rest (reuses hover-dim rendering); play button later.
- Stop schedule readout: computed arrive/depart times per stop.

## Phase 6 — Backlog (unscheduled)

Bikes + rider profiles (fuel range → "gas needed near here" hints); KMZ + CSV import, then more formats (no proprietary licensing); autosave/drafts; imported→editable converter (chunked Directions matching); drag-reorder; per-leg straight-line/dirt `mode`; GPX `rte/rtept` export for turn-by-turn; PostGIS ("routes near me"); per-user ride-count cap if abuse appears.

## Verification

- Each phase: `npm run typecheck`; dev stack (`docker compose up -d db`, `npm run dev`, seed) — no console errors.
- Phase 1: import a real KML via curl → routes/points/legs rows populated with parsed roles; seed renders in legacy viewer unchanged.
- Phase 2 (end-to-end via chrome-devtools MCP on 127.0.0.1:6686): sign in → `/builder` → search + click stops, roles, a POI, durations → snapped route draws → Save → dashboard lists → `/m/:slug` Mapbox viewer shows track, arrows, icons, tooltip mileage columns → private still 404s signed-out.
- Phase 3: drag-shape a leg, save, reload — persists; export KML → re-import → stops/roles round-trip; open exports externally.
- Phase 4: backfilled seed renders on Mapbox identically; grep proves no `GMAPS_KEY`/`main.js` references.
- Phase 5: two-route ride with datetimes + durations; slider highlights the right leg at a chosen time.

## Risks (flagged to Ziad)

- Mapbox free tier (~50k loads / 100k directions / 100k geocodes monthly, historically) — verify at signup; dragend-only re-routing keeps usage low.
- URL restriction is Referer-based (spoofable) — acceptable; fallback is a thin server proxy for Directions/Geocoding.
- Client-supplied geometry trusted within caps + 15 % clamp + sanitization — worst case, a weird line on the owner's own map.
- `drizzle-kit push` vs enum-array default / check constraints — tested in dev first; DB checks dropped if needed (zod still enforces).
- `maps`→`rides` rename while only seed data exists — free now, painful later; doing it now is deliberate.
- Native export is display-grade track, not turn-by-turn routable (Phase 6 rte/rtept item).
