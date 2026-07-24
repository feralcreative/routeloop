# Pivot Handoff — stopped night of 2026-07-22

Where the route-builder pivot stands and exactly how to resume. The governing
plan is [tankbag-route-builder-pivot.md](tankbag-route-builder-pivot.md)
(rev 2, approved 2026-07-22). Read that first if context is lost; read this to
pick up the work.

## Git state

- Last commit: `d4ca68f` "feat: add map upload, edit, delete, and CSRF
  middleware" (committed by Ziad, includes `docs/ideas.md`).
- **Everything below is uncommitted working tree** — all of Phase 1 and the
  Phase 2 build. Nothing has been pushed or deployed. Do not commit without
  Ziad's explicit go-ahead.

## Phase 0 — one item still open (Ziad's task)

Create a Mapbox account and two public tokens:

1. `tankbag-dev` — no URL restriction (for local dev).
2. `tankbag-web` — URL-restricted to `https://tankbag.app` and
   `https://stage.tankbag.app` (for deploy later).

Then add to `.env`: `MAPBOX_TOKEN=<the dev token>` and restart the dev server.
Until this exists, `/builder` renders a red "Mapbox token not configured"
banner and no map — everything else still works.

## Phase 1 — COMPLETE and verified

- `src/db/schema.ts` — `maps` renamed to `rides` (+ `source` native|imported,
  cached `totalMiles`/`totalDurationS`/`stopCount`; per-ride `color` and
  `waypoint_count` dropped); new tables `routes` (per-day, owns `color`,
  `startAt`/`endAt`), `points` (kind stop|poi, ordered stops, roles enum
  array ≤ 4, `durationMin`, `distFromStartM`), `route_legs` (geometry jsonb,
  `distanceM`/`durationS`, `viaPoints`).
- `src/maps/roles.ts` — canonical 17-role table (union of the three legacy
  alias tables + WTF/CHARGER fixes), `parseRoleName`/`formatRoleName`.
- `src/maps/kml.ts` — structured extraction (`points` + `track` +
  `trackMeters`), `processGpx` (written, not yet wired to any route),
  `distFromStartAlongTrack`, exported `sanitizeText`.
- `src/routes/maps.ts` — import now also inserts route/points/leg rows in the
  same transaction; PATCH `color` updates `routes`; DELETE cascades and
  refunds quota. Exports `fields`, `firstIssue`, `ownRide` for reuse.
- `src/db/seed.ts` — extracts structured rows from `moto-storage/1/1.kml`.
- Local dev DB has the new schema (`drizzle-kit push` applied; the enum-array
  default and check constraints pushed fine).

Verified by running: seed → legacy endpoints all 200 with correct legacy
contract; curl import → 201 + rows with parsed roles (`MEET/GAS - Sinclair
Station` → `{meet,gas}`) + quota bump; delete → cascade + refund + file
removal; unlisted viewer 200.

## Phase 2 — BUILT, half verified

Built:

- `src/routes/rides.ts` — `POST /api/rides`, `PUT /api/rides/:id`
  (full-replace, 409 for imported), `GET /api/rides/:id` (owner load);
  payload zod with caps; `normalize()` (sanitize text, round coords, 15 %
  distance clamp); `/builder` + `/builder/:id` page shells (Mapbox GL v3.10.0
  via CDN, `window.TB = {token, roles, rideId}`).
- `src/index.ts` — `GET /api/public/rides/:slug/ride.json` (normalized public
  contract, both sources); `/m/:slug` branches: native → `nativeViewHtml`
  (Mapbox shell), imported → legacy Google shell (unchanged).
- `src/routes/dashboard.ts` — "Plan a ride" CTA, per-card Edit links
  (native only).
- `public/js/map-common.js` — shared engine: track+arrow layers (canvas
  arrow images, not glyphs), inline-SVG `currentColor` markers with legacy
  ±13px grid stacking, ported tooltip markup (same
  `waypoint-tooltip-*` classes), gas/charge mileage semantics
  (`stopMileages`), panel collapse. Exposes `window.TBMap`.
- `public/js/viewer.js` — renders ride.json: multi-route, legend rows with
  visibility checkboxes + hover dim, downloads row, arrows toggle.
- `public/js/builder.js` — click/search to add stops & POIs, Directions v5
  per-leg routing with stale-response guards + straight-line fallback,
  draggable markers (dragend re-routes adjacent legs, clears their vias),
  role picker (≤ 4), stop durations, reorder/delete with targeted leg
  recompute, totals, explicit Save (POST then PUT), dirty tracking +
  beforeunload, existing-ride load (warns and shows day 1 only if multi-day).
- `style/main.scss` — marker/legend/builder/toast styles appended (uses only
  existing variables); compiled to `public/style/main.min.css`. Note: sass
  emits lighten/darken deprecation warnings — cosmetic, pre-existing pattern.
- `src/views/layout.ts` — chrome `.btn`, `.cardrow`, `.editlink`.

Verified via curl (dev server on :6686):

- `POST /api/rides` → 201, ride id 3, slug `NXWbMcEMe1ZDRCyG6K7zbO`
  ("Test Loop", **unlisted**, 2 stops + 1 POI — still in the dev DB for
  testing).
- `ride.json` → correct shape (roles, distFromStartMi, POI projection,
  native → null kml/gpx URLs).
- `/m/<slug>` serves the Mapbox shell; `/builder` 200; `/builder/3` 200;
  `/builder/1` 409 (imported); `GET /api/rides/3` full payload.

## NOT yet done / NOT yet verified — tomorrow's first moves

1. **Finish API verification** (was interrupted mid-command). Mint a session
   and run these; expected results in comments:

   ```bash
   TOKEN=$(npx tsx -e "import('./src/auth/session').then(async s => { console.log(await s.createSession(1)); process.exit(0) })")
   S=NXWbMcEMe1ZDRCyG6K7zbO
   # unlisted without cookie → 200
   curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:6686/api/public/rides/$S/ride.json
   # PATCH to private, then: no cookie → 404, owner cookie → 200
   curl -s -X PATCH http://127.0.0.1:6686/api/maps/3 -H "Origin: http://127.0.0.1:6686" \
     -H "Cookie: tankbag_session=$TOKEN" -H 'Content-Type: application/json' -d '{"visibility":"private"}'
   # PUT round-trip → 200 {id,slug}; then GET /api/rides/3 reflects the change
   # bad payload (3 stops, 1 leg) → 400 "legs must connect consecutive stops"
   # PUT with no Origin header → 403 bad origin
   ```

2. **Visual E2E in the browser** (needs `MAPBOX_TOKEN` in `.env` first) via
   chrome-devtools MCP against `http://127.0.0.1:6686`:
   - Sign-in flow is OAuth-only; for a driver session, set the
     `tankbag_session` cookie manually with a minted token (same one-liner).
   - `/builder`: click map → stops appear + snapped route draws; search box
     adds stops; role picker ≤ 4; +POI mode; drag a stop → reroute; reorder;
     delete; totals update; Save → URL becomes `/builder/<id>`; reload holds.
   - `/m/<slug>` (ride 3): track + arrows render, markers with role icons,
     tooltips show From Start / From Gas (+duration), legend toggles work,
     arrows checkbox works, panel collapse works.
   - `/dashboard`: CTA + Edit links; `/m/sample-route-one` (imported) still
     renders on the **Google** viewer unchanged.
   - Expect client-JS bugs — all three files have never executed in a
     browser.

3. **Then Phase 3** per the plan: via-point shaping in `builder.js`;
   `src/maps/export.ts` (`buildKml`/`buildGpx` via `formatRoleName`);
   source-aware `/kml` + `/gpx` endpoints (native = generated) and flip
   ride.json's native `kmlUrl`/`gpxUrl` from null to real URLs.

## Environment notes

- Dev stack: Docker Desktop must be running; `docker compose up -d db`;
  `npm run dev` (tsx watch, port 6686 — kill and reuse 6686 if taken, never
  another port). Dev server and Docker were left RUNNING tonight.
- Dev DB contents right now: ride 1 = seeded `sample-route-one` (imported,
  public); ride 3 = "Test Loop" (native, unlisted). Ride 2 was created and
  deleted during testing. Re-running `npx tsx src/db/seed.ts` wipes all of it
  and re-creates only ride 1.
- New deps added this session: `@xmldom/xmldom`, `zod`.
- **Deploy landmine noted for Phase 5/deploy time**: the NAS post-deploy hook
  runs `drizzle-kit push` non-interactively; it cannot resolve the
  `maps`→`rides` rename and will die waiting for a TTY. Before the first
  deploy of this branch, run `DROP TABLE IF EXISTS maps CASCADE;` on the
  stage/prod databases (data there is seed-grade; the plan accepted this).
- Import UI does not exist yet (Phase 4); imports are curl-only today.
- Turnstile remains feature-flagged off (no keys in `.env`).
