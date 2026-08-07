# TankBag roadmap

The durable plan for where TankBag is going. It pairs with two other docs and with GitHub Issues; none of them duplicates the others:

- **This file**—the narrative: the vision, the phases, and why each matters. It changes slowly.
- **[STATUS.md](STATUS.md)**—the current state and the very next steps. It moves fastest and wins wherever it disagrees with this file.
- **[\_AI_AGENT_PRIMER.md](../_AI_AGENT_PRIMER.md)**—the architecture and the load-bearing gotchas. Read it before writing code.
- **GitHub Issues**—the pickup-able units of work. Most roadmap items below should become one issue each; the ones tagged _good first issue_ are collected at the bottom.

## How to read this

Each roadmap item lists a **Goal**, the **Work** as a checklist, the code it **Touches**, and a **Status**:

- **shipped**—done and deployed.
- **in progress**—partially built; see STATUS.md for the exact edge.
- **next**—unblocked and worth doing soon.
- **planned**—wanted, not yet scheduled.

If you are a new contributor, jump to [Working in this repo](#working-in-this-repo) first.

## Priorities

Every open issue carries a **P0–P3** label. The labels are the authority on what to do next; the item numbers below are stable identifiers, not an order. Reviewed 2026-08-06.

<!-- col-widths: 12% 88% -->

| Tier   | What it means                                                                      |
| ------ | ---------------------------------------------------------------------------------- |
| **P0** | Blocks real use of something that already ships. Do these next                     |
| **P1** | The group layer, plus the platform work that has to exist before anyone is invited |
| **P2** | Real gaps riders will hit, none of them urgent at this size                        |
| **P3** | Good ideas with no timeline, and the whole idea backlog                            |

**P0 is empty as of 2026-08-06.** The tier that used to hold this section has been cleared:

- ~~**[#8](https://github.com/feralcreative/tankbag/issues/8) Route shaping.**~~ **Shipped 2026-08-06.** A rider can pull a route onto the road they meant; everything else in the planner had been assuming the line was right with no way to correct it.
- ~~**[#38](https://github.com/feralcreative/tankbag/issues/38) Autosave and undo.**~~ **Shipped 2026-08-05.** The competitive research filed undo as a defection trigger rather than a nicety: "works pretty good at route planning until I mess up, then can't undo the mistake and have to start a new trip."
- **[#69](https://github.com/feralcreative/tankbag/issues/69) On-the-road mobile interface** is now labelled **P2**, not P0. The navigate page exists and is not yet usable in gloves at a fuel stop: no finished-leg marking, no progress memory, no tolerance for losing signal. That is still the difference between a demo and the feature, but the label is the authority and the label says P2.

**With P0 clear, P1 is the work.**

**P1—the group layer, in dependency order.** [#71](https://github.com/feralcreative/tankbag/issues/71) ride membership, then [#72](https://github.com/feralcreative/tankbag/issues/72) friendships, then [#73](https://github.com/feralcreative/tankbag/issues/73) the visibility levels that need both. [#12](https://github.com/feralcreative/tankbag/issues/12) sits on top of all three. [#16](https://github.com/feralcreative/tankbag/issues/16) is here for one reason: rate limiting. Every anonymous view of a shared ride is a billable Maps load, so cost scales with strangers rather than accounts—that has to exist before rides are shared widely.

A note on sequencing: P1 is where the product stops being single-player, and it is the reason a rider brings anyone else. It is second only because P0 makes the thing worth showing them.

## Vision

MyRouteApp, but far better: entire-trip focused, with a slicker UI and smoother UX.

TankBag is a tool to **plan, organize, and share** motorcycle rides and car road trips—not real-time navigation, and never will be. The point is to give riders a holistic view of an **entire** trip: every leg, every session, every stop, every hotel and gas station, across an unlimited number of days and miles. Existing tools cap out (Google My Maps allows ~10 waypoints and one route per layer; Apple Maps behaves differently on every device) and none of them shows the whole trip at once. TankBag has no such limits.

The model that everything else follows:

- A **Ride** is the shareable package—many routes over many sessions/days, with a start and an end that bound the whole trip.
- A **Route** is one day/session: an ordered list of stops joined by road-snapped legs, with its own start and end date-time.
- Three kinds of dots:
  - **Waypoint**—an ephemeral shaping point that only keeps the route on course. Nothing remarkable about the spot; we do not stop there.
  - **POI**—something interesting near the route (a vista, a museum, a quirky store) we might or might not stop for. It never affects routing.
  - **Stop**—a real stop (gas, food, rest, hotel). Stops always have a duration; "ends" are stops with no duration.
- **No platforms, no limits.** Import and export as many open route formats as possible, and never depend on a proprietary, licensed one.

The signature interaction is the **timeline**: a slider across the bottom of every Ride and Route, from its start time to its end time. The whole ride stays visible while the slider focuses the leg or section that corresponds to a given date and time.

<!--| PAGE-BREAK -->

## Where things stand

Built and deployed today (see STATUS.md for the living detail):

- **Data model**—rides → routes → stops/POIs → routed legs, plus the 17-role stop taxonomy.
- **Import**—KML/GPX upload becomes a structured, editable ride, through an XXE-safe, quota-enforced pipeline.
- **Ride builder**—plan a road-snapped route, classify stops, save. Now **multi-day**: every day of a trip is drawn on one map, with a day-focus slider.
- **Native viewer**—shared rides render from the database.
- **User profiles & authorization**—`users.status` gates who may use the app; profile page; home-address seeding.
- **Auth**—Google OAuth + emailed magic link, replacing Cloudflare Access.
- **Maps**—rendering, search (Places New) and routing (Routes API) all on Google.
- **Admin panel**—the owner approves, blocks and reinstates rider accounts.
- **Twistiness**—each day carries a measure of how much its roads bend, derived from geometry so imported rides get one too. Shown as a word in the builder and the viewer legend.
- **Expand**—a hand-off-time transform that weaves shaping points along the planned geometry, so whatever you navigate with has too little room to pick its own roads.
- **The navigate page**—`/m/:slug/navigate` turns a ride into an ordered series of Google Maps links, one leg at a time, with a density control and an honest statement of the longest stretch Maps still chooses for itself.
- **Lossless import**—a file holding several tracks lands as several days, names and all, rather than as its longest track.
- **Import and export**—six formats in (KML, KMZ, GPX, GeoJSON, CSV, native TankBag JSON), five out, several files at once becoming the days of one trip, and every original kept so nothing an upload contained is destroyed.
- **Roadbook**—a printable stop-by-stop sheet: leg and cumulative miles, miles since fuel, planned dwell, and an estimated clock.
- **Route shaping**—drag the route line onto the road you meant; the dropped point becomes an ephemeral via-point on the right leg and only that leg re-routes.
- **Undo and drafts**—undo/redo in the builder, plus a draft that survives a crash, a closed tab or a dead phone, including for a ride that has never been saved.
- **CI**—typecheck and 424 tests on every pull request and push to `main`, against Node 20 and 22.

The two big migrations (auth and maps) are **done**, in the code and in the Google Cloud console. One thing remains: removing the redundant Cloudflare Access policy at the edge, which is gated on a verified prod deploy and tracked in #58.

## Roadmap

### 1. Finish the Google migration and clear debt

**Goal.** Retire the last Mapbox dependency and the redundant Cloudflare Access policy so the stack is single-vendor and the dead config is gone.

**Work.**

- [ ] Remove the Cloudflare Access policy at the edge (the app already ignores its header; the policy is now pure redundancy).
- [x] Move `profile.js` home-address geocoding to a server proxy alongside `POST /api/route`—the last Mapbox call and the only reason `MAPBOX_TOKEN` still has to be set.
- [x] Teach the current engine to draw an imported ride's single-leg track, then collapse the two viewer shells into one and delete `public/js/main.js`. (The engine already handled it; the work was deleting the legacy shell.)
- [x] Drop `MAPBOX_TOKEN`, `MAPBOX_GL_VERSION` and `MAPBOX_CSS_LINK`, plus their `.env.example`, compose and deploy-guard references.
- [x] Regenerate the favicons and social image from the current TankBag mark. Done 2026-07-31; the files live in `public/img/favicon/`.
- [x] Add privacy-policy and terms pages (required to publish the OAuth consent screen past 100 users).
- [x] Set per-API daily quota caps on the GCP project so a runaway loop can't run up a bill. Done 2026-08-02—five metrics capped; see STATUS.
- [x] Disable the Maps APIs the app does not use. Done 2026-08-02—23 of 27 off, leaving only Maps JavaScript, Places (New), Routes and Geocoding.

**Touches.** `public/js/profile.js`, `src/routes/routing.ts`, `src/routes/*` viewer shells, `src/index.tsx`, `src/config.ts`, `src/views/layout.ts`, `public/img/`.

**Status.** Done, bar one thing. Mapbox is retired, the two viewer shells are one, the legal pages shipped, the favicons were regenerated on 2026-07-31, and the GCP console work landed 2026-08-02 (quota caps applied, 23 unused Maps APIs disabled). The tracking issue #6 is closed; the single remaining item—removing the Cloudflare Access policy at the edge—moved to #58, because it is gated on a verified prod deploy and nothing in this repo will ever tick it.

### 2. The trip timeline

**Goal.** Ship the signature feature from the vision: a date-time slider that focuses a trip in time.

**Work.**

- [x] A date-time UI in the builder that writes `routes.start_at` / `routes.end_at` (the columns exist and already load into builder state; nothing sets them yet).
- [x] A timeline slider across the viewer and builder that maps a moment to the leg/section active then, dimming the rest without hiding anything.
- [x] Sensible defaults: derive a route's duration from its legs, and seed each day's start from the previous day's end.

**Touches.** `public/js/builder.js`, `public/js/viewer.js`, `public/js/map-common.js`, `src/db/schema.ts` (already has the fields), `src/routes/rides.ts`, `src/index.tsx` (the `ride.json` contract has to start carrying per-leg data—it currently flattens every leg into one track).

**Status.** done on `feat/trip-timeline-slider`, closing #7 and #19. Duration is derived as legs **plus** stop dwell, and deliberately kept separate from `routes.duration_s`, which caches riding time only. `ride.json` now carries per-leg spans—the viewer could not map a moment to a leg without them. The time model is shared by both clients in `public/js/ride-time.js` so they cannot disagree. See docs/STATUS.md for the rest, including the two properties of leg spans that real data will break a naive assumption about.

### 3. Route shaping and server-side export

**Goal.** Let riders pull a route into the exact shape they want by dragging the line onto the roads they mean, and export a finished ride to open formats.

**Work.**

- [x] **Drag the route line onto a different road to shape it.** Grabbing a rendered leg anywhere and dragging it to a nearby road drops a **waypoint**—an ephemeral leg via-point—at the release point and re-snaps the leg through it, so the route follows the road you meant rather than the one the router picked. This is the standard rubber-band map drag, and it is the third dot kind from the vision.
- [x] Persist the pulled points into `route_legs.via_points`. On drop, re-request only the affected leg through `POST /api/route` with the new via list; the anchor stops stay fixed.
- [x] Via-points are themselves draggable and removable after creation, and render distinctly from stops and POIs—smaller and clearly ephemeral—so the routing anchors stay legible.
- [x] Moving or reordering a stop invalidates that leg's shaping and clears its via-points, so a stale shaping point can't fight a new route.
- [x] `src/maps/export.ts`—generate KML, GPX, GeoJSON and CSV from stored rows, and make downloads source-aware: an imported ride streams its stored original (byte-for-byte, which is why the file is kept) and everything else is generated. A native ride can be downloaded as any of the four for the first time.
- [x] Round-trip the `ROLE - Name` convention on export so files reopen correctly in Google Earth and elsewhere.

**Touches.** `public/js/builder.js`, `public/js/route-shape.js`, `public/js/map-common.js`, `src/maps/export.ts`, `src/routes/maps.ts`, `src/maps/roles.ts`.

**Status.** shipped—export in sprint 09 (2026-08-03), drag-to-shape on 2026-08-06 ([#8](https://github.com/feralcreative/tankbag/issues/8)). The index arithmetic that turns a drag on the day's single concatenated polyline back into "leg 3, between via 1 and via 2" lives in `route-shape.js`, kept pure so `test/route-shape.test.ts` can drive it.

<!--| PAGE-BREAK -->

### 4. Expand: densify a route so a hand-off stays on your roads

**Goal.** Give a nav app only your stops and it picks its own roads between them—often not the ones you meant. **Expand** fixes that: it densifies the route with extra shaping waypoints sampled along the planned geometry, pinning whatever you hand it to onto your roads. This is MyRouteApp's "Expand," the owner's favorite feature there—a 10–20-point route expanded to 30+ points to stay on track. It is provider-agnostic and improves _every_ hand-off: the Google Maps links (item 5) and the Garmin/TomTom file exports (item 3) alike.

**Work.**

- [ ] Densify a route by sampling extra shaping waypoints along the stored leg geometry (`route_legs.geometry` already holds the full, 6-decimal, road-snapped polyline), so a hand-off follows the planned roads instead of the nav app's own guess between distant stops.
- [ ] Rider-controllable density—a target point count or spacing. The owner's habit: expand a 10–20-point route to at least 30.
- [ ] Expansion is a hand-off-time transform over geometry that already exists, not new stored route state—TankBag's own viewer renders the exact path already, so Expand matters only when leaving the app.
- [ ] Refinement: bias added points toward junctions and decision points, where a nav app is most likely to diverge, rather than purely even spacing.
- [ ] Expand-added points are shaping points, not stops: written as Garmin/TomTom _shaping_ points in the file exports (item 3) and counted as plain waypoints in the Google Maps links (item 5).

**Touches.** new `src/maps/expand.ts` (densify over leg geometry), `route_legs.geometry` as the source, the export path (item 3) and the Google Maps link builder (item 5).

**Status.** done on `feat/expand-route`. `src/maps/expand.ts` places shaping points to bound the longest unpinned stretch rather than spacing them evenly—even spacing wastes points on a straight where the nav app was never going to diverge. Density is the rider's call at hand-off time (off / light / tight), because every extra point is another link and another tap. Nothing is stored: it is a transform over `route_legs.geometry`, which is what makes it free to change later.

### 5. One-tap Google Maps links

**Goal.** Hand a rider the exact route they planned, ready to navigate in Google Maps, instead of a loose set of stops it re-routes between however it likes. Google Maps takes 9 waypoints plus an origin and a destination per URL, so a route—especially an Expanded one—is serialized into an ordered series of links. This is the direct answer to the vision's first pain point, that Google My Maps caps at ~10 waypoints.

**Work.**

- [ ] Serialize a route's ordered points (after Expand, item 4) into Google Maps directions URLs—the `https://www.google.com/maps/dir/?api=1&…` form, or the `/maps/dir/lat,lng/lat,lng/…` path form.
- [ ] **Every point is a plain Google Maps waypoint.** Waypoint, POI, stop and Expand-added points all collapse to the same thing here: Google Maps does not differentiate the kinds and cannot attach a duration to a stop, so all of them count equally toward the batches. The kind and duration distinction only matters for the file exports (items 3 and 9), where GPX and KML can carry it.
- [ ] **Batch at no more than 10 points per URL.** Expand multiplies the point count, so it multiplies the links: a 30-point route is at least three of them; a 28-point route without expansion is 10, then 10, then 8.
- [ ] **Never batch across a route boundary.** Batching resets at each route end, so a route's final link is short rather than topped up with the opening points of the next route. Each route (day/session) is chunked independently.
- [ ] A share surface that lists the links per route and batch—e.g. "Day 2 · part 1 of 3"—copyable and sendable to riders.

**Open questions to settle when building.**

- **Batch continuity.** A clean partition (10 + 10 + 8) leaves a gap between links: the segment from point 10 to point 11 sits in no URL. Overlapping each batch by one point (…9, 10 │ 10, 11…) closes the gap at the cost of one point per link. Decide which, and make the choice obvious in the UI.
- **Coordinate order.** Google Maps URLs want `lat,lng`; the app stores `[lng, lat]`. Reuse the existing conversion discipline (`toLatLng` / `fromLatLng`), never a fresh inline swap.

**Touches.** new `src/maps/gmaps-links.ts` (link builder), `route_legs.geometry` and Expand (item 4) as the source, `public/js/viewer.js` and the share UI, possibly a small share endpoint under `src/routes/`.

**Status.** done on `feat/expand-route`, in `src/maps/gmaps-links.ts`. Three things were settled by testing on a real iPhone rather than from the documentation:

- A `/maps/dir/?api=1` link opens the **native app** and carries **9 waypoints**, so 11 points per link counting the two ends. Google's docs say "up to three waypoints supported on mobile browsers, and a maximum of nine waypoints supported otherwise"—the three applies to a route rendered in the mobile browser, not to the app the link hands off to. Earlier drafts of this roadmap said ~10 points; that figure was an assumption.
- Omitting `origin` makes Maps start from the rider's current location and offer **Start** instead of **Preview**, which removes the "add Your Location and drag it to the top" ritual at every fuel stop.
- Raw coordinates render as "dropped pin". Named places need Google place IDs, which this app does not store; the route is exact and navigable either way.

Consecutive links overlap by one point, so the leg between two batches is never left unnavigated, and a batch prefers to end on a stop—a tap is free if the rider is already off the bike.

### 6. Saved places

**Goal.** A rider's reusable library of locations (home, favorite fuel stops, meet points) they can drop into any ride.

**Work.**

- [ ] Schema for places and place groups.
- [ ] CRUD endpoints and a marker-group primitive in the map engine.
- [ ] Builder integration: search or pick from saved places when adding a stop.

**Touches.** `src/db/schema.ts`, new `src/routes/places.ts`, `public/js/map-common.js`, `public/js/builder.js`, `src/routes/profile.ts` (the profile already reserves a section for this).

**Status.** planned—designed in `_PLANS/sprint-01-260725T2320Z.md` Phase B, cut from Sprint 2 for size.

### 7. Bikes and range planning

**Goal.** Model bikes and riders so the app can reason about range and comfort, per the original vision.

**Work.**

- [ ] Bike profiles: tank size / fuel economy (or battery / consumption for EVs), and per-rider comfort limits.
- [ ] Fuel/charge range rings and low-range warnings between stops.
- [ ] Suggest rest cadence from rider limits and leg durations.

**Touches.** `src/db/schema.ts`, new routes, `public/js/builder.js`.

**Status.** planned.

### 8. Riders and group rides

**Goal.** Turn a solo planning tool into a group one.

**Work.**

- [ ] Rider list / roster (the `users.can_manage_riders` capability flag already exists).
- [ ] Invite riders to a ride; per-ride RSVP.
- [ ] Surface cost splitting from the payment handles already stored on the profile.
- [ ] Rate-limit rider lookup by email/phone before it exists—it is a user-enumeration surface.

**Touches.** `src/db/schema.ts`, new routes, `src/routes/admin.ts` (extend), `src/routes/profile.ts`.

**Status.** planned. The admin panel is the first slice of this and is already shipped.

### 9. Import and export breadth

**Goal.** Handle as many open route/map formats as possible, in both directions.

**Work.**

- [x] **Native TankBag JSON export/import**—`/tankbag.json` writes the builder's own save payload and the importer feeds it back through the same schema and the same insert. Verified lossless on a real 3-day ride: days, colours, start/end times, legs, via points, stops, POIs, dwell and roles all identical. The `tankbag` version field is what tells it apart from a GeoJSON, since both arrive as `.json`.
- [x] Import KMZ (zipped KML)—the archive is read by `src/maps/kmz.ts` and its KML handed to the existing pipeline, so the cap is on the _decompressed_ size.
- [x] Import/export CSV—a stop list, not a route. `src/maps/csv.ts` parses RFC 4180 (a quoted comma in "Chevron, Petaluma" is not an edge case), sniffs the delimiter, and reads a decimal comma. No geometry, so no mileage and a **null** twistiness rather than a zero.
- [x] Import/export GeoJSON—`src/maps/geojson.ts` in, `src/maps/export.ts` out. The only format that keeps roles, the stop/POI distinction and dwell time across a round trip, because it is the only one whose properties this app controls.
- [x] Export GPX that loads cleanly on a device—stops are `<wpt>` and shaping points are `<trkpt>`, never `<rte>`/`<rtept>`. A route file lets the device re-derive the ride between anchors, which is the failure the FAQ describes under "Why does my GPS ignore the route I planned?".
- [x] Keep every added format inside the existing XXE-safe, quota-enforced import pipeline.
- [x] Round-trip fidelity tests per format (#35)—`test/fixtures/` holds one ride written five ways and `test/round-trip.test.ts` asserts the parsers agree. It caught a real disagreement on its first run: KML read a one-point line as a zero-length track while GeoJSON rejected the whole file.

**Touches.** `src/maps/kml.ts`, `src/maps/export.ts`, `src/routes/maps.ts`, `src/routes/rides.ts` (the payload shape).

**Status.** in progress—KMZ, GeoJSON, CSV and multi-file import landed 2026-08-03. Several files become several days of one ride, which is what a rider with a folder of per-day GPX files actually has.

The single-file gap closed 2026-08-04 (#70): every track in a file now lands as its own day, in document order, carrying the file's own name for it—GPX `<trk><name>`, KML Placemark names, GeoJSON feature names. All three parsers previously kept only their longest line and discarded the rest, which meant the app could not read back its own multi-day export. Waypoints are assigned to the day they physically sit on, since GPX ties them to nothing. More than 31 days is refused rather than truncated.

Remaining: device-aware GPX flavors (#13)—`buildGpx` writes GPX 1.1 with `<trk>` and no device picker, and a Garmin wants `<rte>` shaping points.

### 10. Discovery and public profiles

**Goal.** Make good public rides findable and give riders a public identity.

**Work.**

- [x] Public profile pages at `/@username` (usernames are already reserved and unique).
- [x] A browsable gallery of public rides, sorted by recency and popularity (`rides.view_count` exists).
- [x] "Clone this ride" so a public ride can seed a new plan.

**Touches.** `src/routes/*`, `src/views/layout.ts`, `src/db/schema.ts`.

**Status.** done on `feat/legal-and-faq-pages`, closing #14 and #26. What a public surface may show is stated once in `pages.ts` rather than decided per template: username, display name and public rides are shown; last name is opt-in; first name, email, address, coordinates and payment handles never. Clone drops descriptions and times and lands private. See docs/STATUS.md for the Hono routing gotcha that makes `/@username` work.

### 11. Rich stop details

**Goal.** Let a stop hold everything a rider actually needs when they arrive—reservations, confirmation numbers, gate and door codes, check-in / check-out times, links, and freeform notes—not just a name and a category.

**Work.**

- [ ] Structured detail fields on a stop: confirmation / reservation number, check-in and check-out date-time (feeds the timeline, item 2), phone, address, and one or more URLs (booking link, menu, map).
- [ ] A freeform notes field for the unstructured stuff—"gate code 4417, park behind the barn, ask for Dave."
- [ ] Surface fields **by role** rather than as one giant form: a HOTEL / CAMP stop wants check-in/out and a confirmation number; a FOOD stop wants a reservation time and a menu link. The role taxonomy already has hotel, camp, food, coffee, drinks, grocery to key off.
- [ ] Builder UI to edit the details; viewer UI to show them in the stop's info window / panel.
- [ ] **Privacy boundary—this is the load-bearing part.** Gate codes, confirmation numbers and phone numbers are private. They must not go out with a public or unlisted share (they'd otherwise leak through `ride.json`), and probably not in exports either—only the owner sees them, and later, invited riders. Model this the way `user_profiles` is split from `users`: sensitive detail kept off any payload that reaches a public viewer's client. Note that `points.description` already exists (2000 chars) and `sanitizeText` / `esc` already defuse `javascript:` and `data:` URLs—reuse both.

**Touches.** `src/db/schema.ts` (extend `points`, or a separate `point_details` table so private fields never ride along on the public viewer contract), `src/routes/rides.ts` (payload + sanitize), `public/js/builder.js`, `public/js/viewer.js`, `src/index.tsx` (the `ride.json` contract), `src/maps/export.ts` (decide what is exportable).

**Status.** planned.

### 12. Quality and platform

**Goal.** The groundwork that keeps a growing, multi-contributor codebase honest.

**Work.**

- [ ] An automated test suite. Vitest is configured and `roles.ts`, the format parsers, Expand, the Google Maps link builder, the drag-to-shape index math and the builder's undo/draft model are covered (424 tests across 20 files). Still missing: the leg-distance clamp, integration tests for ride save/load, and a viewer smoke test.
- [x] CI on GitHub Actions: `npm run typecheck` and `npm test` on every pull request and on pushes to `main`, against Node 20 and 22 (`.github/workflows/ci.yml`). The SCSS build is deliberately not gated—formatting and style are qlty's job, and a failing build there would block a PR on something no reviewer reads.
- [ ] Error tracking / structured request logging in production.
- [ ] Rate limiting on public and auth endpoints.
- [ ] An accessibility pass (keyboard, focus, contrast, ARIA) and groundwork for i18n.
- [ ] Installable PWA with an offline view of a saved ride.

**Touches.** repo-wide; new `test/`, `.github/workflows/`.

**Status.** planned—pick these up alongside feature work, not in a big bang.

### 13. Rider Subgroups: converging and splitting group rides

**Goal.** Model a group ride the way it actually happens: riders, organized into **Rider Subgroups**, set off from different places, converge at one or more meeting points, ride the middle as one group, then split back into subgroups at the end to head home in different directions. A Rider Subgroup is a named set of riders sharing an approach—the Oakland contingent, the Sacramento contingent—and it is the primitive the whole feature is built on. Each person gets one continuous plan of their own—their origin, the pickups along the way, the shared middle, their route home—while the planner sees the whole converging-and-diverging shape on one map. The worked example: a Sierras ride where people leave from Santa Cruz, San Jose, San Francisco, Oakland and Sacramento, join at meeting points along the way, ride the rest as one pack, and reverse the process going home.

**Work.**

- [ ] Make **Rider Subgroup** a first-class thing: a named set of riders sharing an approach. Assign subgroups to legs, so a leg carries the subgroups on it. A stop where the set of subgroups changes is a **meeting point** (subgroups merge) or a **split** (a subgroup peels off)—the `meet` and `split` roles already exist in the taxonomy and become structural here rather than decorative.
- [ ] Support multiple feeder approaches converging at **one or more** meeting points, possibly in stages: SF and Santa Cruz merge in San Jose, then that combined group meets the Oakland contingent in Dublin. Each feeder is a geographically distinct line ending at its meeting point; from there the merged group rides on as one shared leg. The same structure runs in reverse on the way home, splitting progressively.
- [ ] Generate each rider's personal itinerary from the legs they're on—their start point, their pickups, the shared trunk, their way back—so no rider has to mentally subtract the legs that aren't theirs.
- [ ] Per-rider hand-off: Expand (item 4), the Google Maps links (item 5) and the file exports (items 3, 9) produce a rider-specific file—mine starts in Oakland, Dylan's starts in Sacramento—not one file for an abstract whole-group route nobody actually rides end to end.
- [ ] Show it on one map: distinct approach lines converging on the meeting points, the shared trunk drawn once, and a way to focus a single rider's path (reuse the route-dim mechanism the day slider and legend hover already use).

**Open questions to settle when building.**

- **Model.** Two shapes are viable and the choice is load-bearing. Either each approach and dispersal is its own Route within the Ride (leans on the existing rides-hold-many-routes model; a meeting point is a stop shared between a feeder's end and the trunk's start), or legs carry participant membership directly and a rider's route is the ordered set of legs they are on (matches "assign people to legs" literally, but needs branching geometry within a single route). Decide before building—it changes the schema and every downstream view.
- **Timing.** Convergence is a time problem too: two groups have to reach Dublin near enough the same moment. The timeline (item 2) already models per-leg spans; a meeting point wants an arrival window and a warning when approaches do not line up.
- **Who edits.** Does each subgroup's lead plan their own approach, or does the ride leader plan all of them? Ties to collaborative editing in the backlog.

**Touches.** `src/db/schema.ts` (participant/leg assignment, or feeder-route structure), new or extended routes under `src/routes/`, `public/js/builder.js`, `public/js/viewer.js`, `src/maps/expand.ts` and the export path (per-rider hand-off), `src/maps/roles.ts` (`meet` / `split` become structural).

**Status.** planned—extends item 8 (riders and group rides), which is its prerequisite: there have to be riders before they can be assigned to legs.

### 14. Alternate routes and group voting

**Goal.** Let a ride carry more than one candidate for a stretch—"over the pass" versus "the valley road"—and let the group vote them up or down, so the plan reflects what most people actually want to ride rather than whatever the organizer picked alone.

**Work.**

- [ ] An **alternate** is a first-class thing: two or more candidate paths that share a start and end anchor and diverge between them. Exactly one is the **active** path at a time; the others ride along as recorded options rather than being thrown away.
- [ ] Up/down voting on each alternate—one vote per ride member, changeable until the decision closes—with a live tally.
- [ ] A resolution step: the ride leader promotes the winning alternate to the active path, or opts into auto-resolve by tally at a deadline. A losing alternate is kept, so a reversed decision doesn't lose the work.
- [ ] Voting is scoped to invited ride members, never the public share link, and writes on a member's behalf so it needs the same abuse guardrails as any write.
- [ ] Draw alternates distinctly—active path solid, alternates ghosted—and let a voter see each option on the map before voting. Reuse the route-dim / hover machinery.
- [ ] Timeline and roadbook show the **active** path only; alternates never clutter the hand-off.

**Open questions to settle when building.**

- **Granularity.** Segment-level (a fork between two stops), day/route-level (a whole alternate day), or both? Segment-level matches the "this way or that" pitch; route-level is simpler and reuses the rides-hold-many-routes model. It changes the schema.
- **Who proposes.** Only the ride leader, or any member? Any-member turns this into lightweight collaborative editing (backlog) and needs guardrails.
- **Resolution rules.** Simple majority, quorum, deadline, tie-breaking, and whether the leader can override the vote. Settle the governance before building the buttons.
- **Anonymous vs. named votes.** Named votes create social pressure; anonymous is cleaner but hides who wants what.

**Touches.** `src/db/schema.ts` (alternates + votes), new routes under `src/routes/`, `public/js/builder.js`, `public/js/viewer.js`, `public/js/map-common.js` (ghosted alternates), the timeline and roadbook (active path only).

**Status.** planned—a group-collaboration feature; depends on riders (item 8) and overlaps the collaborative-editing backlog item.

### 15. On-the-road mobile interface

**Goal.** A phone-sized, glove-friendly view of a ride for use in the saddle—big buttons, high contrast, no clutter—that does two things well: send the ride's files to whatever the rider navigates with, and step through a route's Google Maps legs one batch at a time. This is a **consumption** surface, not a planning one (planning stays a big-screen job), and it is the digital counterpart to the printed roadbook.

**Work.**

- [ ] A mobile layout for a ride: large tap targets, high contrast for sunlight, minimal chrome, usable one-handed. Reachable from any ride under the same visibility gate as the viewer—no account needed for a public or unlisted one.
- [x] **The Google Maps leg-loader (the headline).** List every batch from item 5 as a big button—"Day 2 · part 2 of 4"—that opens the Google Maps app on tap. Highlight the current batch, mark the finished ones, and make loading the next a single obvious tap the moment the last one ends. Remember progress per device (localStorage; no account required).
- [ ] **Send files to the device.** Offer the ride's exports (GPX, KML, …) through the phone's native share sheet / "open in"—the Web Share API with files where supported, a plain download otherwise—so a file lands in Garmin Drive, TomTom, or wherever the rider's app picks it up.
- [ ] Usable on spotty signal: once loaded, the leg-loader and its links should work without a connection, since the whole point is loading the next leg in the middle of nowhere. Leans on the PWA/offline groundwork in item 12.
- [ ] Fold in the roadbook data (stop order, leg and cumulative miles, miles since fuel, dwell) as an at-a-glance list, so the mobile page is the roadbook and the live hand-off in one.

**Open questions to settle when building.**

- **Where it lives.** A dedicated mobile route (e.g. `/m/:slug/go`) versus a responsive mode of the existing viewer. A separate, purpose-built page is probably cleaner than bending the map viewer to a glove.
- **Offline mechanism.** A full PWA (installable, service worker) versus a lighter localStorage cache of just the links and roadbook. Decide alongside item 12.
- **Batch boundary.** Whether the "next" button pre-fills the next batch's start with the previous batch's end so the rider isn't dropped between links (ties to item 5's batch-continuity question).
- **Web Share reach.** File sharing via `navigator.share` is uneven across iOS/Android browsers; define the plain-download fallback and what "send to device" means where the share sheet can't take a file.

**Touches.** new mobile route under `src/routes/` (a JSX page) plus a small `public/js/` controller, `src/maps/gmaps-links.ts` (item 5) and `src/maps/export.ts` as the data sources, the roadbook data, SCSS for the mobile layout, and the PWA groundwork in item 12.

**Status.** in progress—the leg-loader shipped as `/m/:slug/navigate` on `feat/expand-route`, listing every link per day with the density control. What remains is what makes it usable _on the bike_ rather than at a desk: glove-sized targets, marking finished legs, remembering progress per device without an account, and tolerating no signal. Overlaps the PWA/offline item (item 12).

<!--| PAGE-BREAK -->

## Idea backlog (unscheduled)

Not yet shaped into milestones—raw material for future issues. Grouped by theme.

**Planning power.**

- Elevation and grade profile per route, drawn under the timeline.
- Weather forecast along the route keyed to each leg's date-time—the timeline makes this genuinely useful, not a gimmick.
- [x] Print-friendly roadbook for riders who tape it to the tank—`/m/:slug/roadbook`. **Stop-by-stop, not turn-by-turn:** `route_legs` holds geometry, distance and duration and nothing else, maneuvers are a separate Directions field priced per call, and they would be blank for every imported ride anyway. What it does print is the part that stays true when a road closes: stops in order, leg and cumulative miles, **miles since fuel**, planned dwell, and an estimated clock when the day has a start time.
- Reverse a route; duplicate a ride as a template.
- Distance and moving-time estimates with configurable rest cadence.

**Motorcycle-specific.**

- Twistiness / curvature scoring, and a "prefer the fun road" routing bias—the feature that would beat MyRouteApp for riders who care about the road, not the ETA.
- Avoid-highways / prefer-scenic routing options.
- Per-leg surface preference (paved / unpaved) and an off-road mode.
- EV charge-stop planning as the electric counterpart to fuel range.

**Social and collaboration.**

- Real-time or turn-based co-editing of a shared ride.
- Trip journal: photos and notes attached to stops.
- Follow other riders; a feed of public rides.

**Data and formats.**

- Round-trip fidelity tests per format, so import→export never silently loses a stop.
- Bulk import of a folder of files into one ride.
- PostGIS for spatial queries once discovery needs "rides near me."

**Platform and quality.**

- Autosave and undo in the builder.
- Drag-to-reorder stops.
- Keyboard shortcuts for the builder.
- Usage analytics that respect privacy (self-hosted, no third-party trackers).

## Non-goals

Things deliberately not built, recorded so they do not get proposed twice. These are decisions, not backlog—if one changes, change it here rather than opening an issue.

<!-- col-widths: 26% 74% -->

| Not doing                             | Why                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Round-trip generators**             | Scenic, Kurviger and Garmin all ship one and riders say all three pad the distance with junk roads—"many roads that are minor and not fast at all… just there to make up the total distance." Garmin's Adventurous Routing gets called a complete disaster. Shipped everywhere, good nowhere.                                                                          |
| **Turn-by-turn navigation**           | Not a permanent vow, but a separate product with its own failure surface: freezing, battery drain, late voice cues, destructive recalculation. That is where every competitor's reputation actually fails. Nothing should be attempted here until the hand-off is excellent, and a companion app is a different conversation from bolting navigation onto the planner. |
| **Curviness as the headline feature** | Kurviger picks single-track farm lanes because they carry a high speed limit; American riders call the result borderline useless. Curviness without road-width and speed-limit context produces routes nobody wants. Worth having (#28); not worth leading with.                                                                                                       |
| **Inventing new vocabulary**          | Shaping, via, waypoint and stop already mean something different in every tool, and getting it wrong silently ruins a route. Name things the way _devices_ name them, not the way the app thinks about them.                                                                                                                                                           |
| **Paywalling export or sharing**      | A tool that cannot hand a GPX to a friend on another app is useless for group riding. Accountless view links and unrestricted export stay free regardless of what else ever does not.                                                                                                                                                                                  |

One wording correction that falls out of this: the vision above says TankBag is "not real-time navigation, and never will be." **Never** overstates it. The accurate claim is that it does not navigate today, and that making the app you already use follow your plan is the better problem to solve first.

## Good first contributions

Well-scoped, low-context tasks a new contributor can land without holding the whole app in their head. These carry the _good first issue_ label on GitHub.

- **[#35](https://github.com/feralcreative/tankbag/issues/35) Round-trip fidelity tests per format.** Pure test work in `test/`, no app context needed—assert what each format can and cannot carry, so import → export never silently drops a stop.
- **[#40](https://github.com/feralcreative/tankbag/issues/40) Keyboard shortcuts for the builder.** Contained to `public/js/builder.js` and its key handling.
- **[#51](https://github.com/feralcreative/tankbag/issues/51) Layer stacking with per-layer opacity.** A self-contained map-engine feature with a clear reference implementation in Gaia GPS.

The three tasks previously listed here—privacy and terms pages, the day-slider tick labels, and the `profile.js` geocoding proxy—all shipped, as #18, #19 and #20.

## Working in this repo

Setup, the gotchas that will bite you, branch and commit conventions, and how to open a pull request all live in **[CONTRIBUTING.md](../CONTRIBUTING.md)**. It is the canonical copy—GitHub links it from the issue and pull-request composer, which is why it is there rather than here.

Two things to read first either way: [\_AI_AGENT_PRIMER.md](../_AI_AGENT_PRIMER.md) for the architecture, and [STATUS.md](STATUS.md) for where things actually stand.
