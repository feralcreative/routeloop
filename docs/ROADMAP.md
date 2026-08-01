# TankBag roadmap

The durable plan for where TankBag is going. It pairs with two other docs and with GitHub Issues; none of them duplicates the others:

- **This file** — the narrative: the vision, the phases, and why each matters. It changes slowly.
- **[STATUS.md](STATUS.md)** — the current state and the very next steps. It moves fastest and wins wherever it disagrees with this file.
- **[\_AI_AGENT_PRIMER.md](../_AI_AGENT_PRIMER.md)** — the architecture and the load-bearing gotchas. Read it before writing code.
- **GitHub Issues** — the pickup-able units of work. Most roadmap items below should become one issue each; the ones tagged _good first issue_ are collected at the bottom.

## How to read this

Each roadmap item lists a **Goal**, the **Work** as a checklist, the code it **Touches**, and a **Status**:

- **shipped** — done and deployed.
- **in progress** — partially built; see STATUS.md for the exact edge.
- **next** — unblocked and worth doing soon.
- **planned** — wanted, not yet scheduled.

If you are a new contributor, jump to [Working in this repo](#working-in-this-repo) first.

## Vision

MyRouteApp, but far better: entire-trip focused, with a slicker UI and smoother UX.

TankBag is a tool to **plan, organize, and share** motorcycle rides and car road trips — not real-time navigation, and never will be. The point is to give riders a holistic view of an **entire** trip: every leg, every session, every stop, every hotel and gas station, across an unlimited number of days and miles. Existing tools cap out (Google My Maps allows ~10 waypoints and one route per layer; Apple Maps behaves differently on every device) and none of them shows the whole trip at once. TankBag has no such limits.

The model that everything else follows:

- A **Ride** is the shareable package — many routes over many sessions/days, with a start and an end that bound the whole trip.
- A **Route** is one day/session: an ordered list of stops joined by road-snapped legs, with its own start and end date-time.
- Three kinds of dots:
  - **Waypoint** — an ephemeral shaping point that only keeps the route on course. Nothing remarkable about the spot; we do not stop there.
  - **POI** — something interesting near the route (a vista, a museum, a quirky store) we might or might not stop for. It never affects routing.
  - **Stop** — a real stop (gas, food, rest, hotel). Stops always have a duration; "ends" are stops with no duration.
- **No platforms, no limits.** Import and export as many open route formats as possible, and never depend on a proprietary, licensed one.

The signature interaction is the **timeline**: a slider across the bottom of every Ride and Route, from its start time to its end time. The whole ride stays visible while the slider focuses the leg or section that corresponds to a given date and time.

<!--| PAGE-BREAK -->

## Where things stand

Built and deployed today (see STATUS.md for the living detail):

- **Data model** — rides → routes → stops/POIs → routed legs, plus the 17-role stop taxonomy.
- **Import** — KML/GPX upload becomes a structured, editable ride, through an XXE-safe, quota-enforced pipeline.
- **Ride builder** — plan a road-snapped route, classify stops, save. Now **multi-day**: every day of a trip is drawn on one map, with a day-focus slider.
- **Native viewer** — shared rides render from the database.
- **User profiles & authorization** — `users.status` gates who may use the app; profile page; home-address seeding.
- **Auth** — Google OAuth + emailed magic link, replacing Cloudflare Access.
- **Maps** — rendering, search (Places New) and routing (Routes API) all on Google.
- **Admin panel** — the owner approves, blocks and reinstates rider accounts.

The two big migrations (auth and maps) are deployed; what remains of them is cleanup, captured in item 1 below.

## Roadmap

### 1. Finish the Google migration and clear debt

**Goal.** Retire the last Mapbox dependency and the redundant Cloudflare Access policy so the stack is single-vendor and the dead config is gone.

**Work.**

- [ ] Remove the Cloudflare Access policy at the edge (the app already ignores its header; the policy is now pure redundancy).
- [ ] Move `profile.js` home-address geocoding to a server proxy alongside `POST /api/route` — the last Mapbox call and the only reason `MAPBOX_TOKEN` still has to be set.
- [ ] Teach the current engine to draw an imported ride's single-leg track, then collapse the two viewer shells into one and delete `public/js/main.js`.
- [ ] Drop `MAPBOX_TOKEN`, `MAPBOX_GL_VERSION` and `MAPBOX_CSS_LINK`, plus their `.env.example`, compose and deploy-guard references.
- [ ] Regenerate the favicons and social image from the current TankBag mark (they still carry the old routeloop artwork).
- [ ] Add privacy-policy and terms pages (required to publish the OAuth consent screen past 100 users).
- [ ] Set per-API daily quota caps on the GCP project so a runaway loop can't run up a bill.

**Touches.** `public/js/profile.js`, `src/routes/routing.ts`, `src/routes/*` viewer shells, `src/index.ts`, `src/config.ts`, `src/views/layout.ts`, `public/img/`.

**Status.** next. The maps and auth engines are settled, so all of this is unblocked.

### 2. The trip timeline

**Goal.** Ship the signature feature from the vision: a date-time slider that focuses a trip in time.

**Work.**

- [x] A date-time UI in the builder that writes `routes.start_at` / `routes.end_at` (the columns exist and already load into builder state; nothing sets them yet).
- [ ] A timeline slider across the viewer and builder that maps a moment to the leg/section active then, dimming the rest without hiding anything.
- [ ] Sensible defaults: derive a route's duration from its legs, and seed each day's start from the previous day's end. Duration derivation landed with the date-time UI; the day-start seeding has not.

**Touches.** `public/js/builder.js`, `public/js/viewer.js`, `public/js/map-common.js`, `src/db/schema.ts` (already has the fields), `src/routes/rides.ts`, `src/index.ts` (the `ride.json` contract has to start carrying per-leg data — it currently flattens every leg into one track).

**Status.** in progress on `feat/trip-timeline-slider` — multi-day editing and the date-time UI have landed; the slider itself has not. See docs/STATUS.md for the decisions behind it.

### 3. Route shaping and server-side export

**Goal.** Let riders pull a route into the exact shape they want by dragging the line onto the roads they mean, and export a finished ride to open formats.

**Work.**

- [ ] **Drag the route line onto a different road to shape it.** Grabbing a rendered leg anywhere and dragging it to a nearby road drops a **waypoint** — an ephemeral leg via-point — at the release point and re-snaps the leg through it, so the route follows the road you meant rather than the one the router picked. This is the standard rubber-band map drag, and it is the third dot kind from the vision.
- [ ] Persist the pulled points into `route_legs.via_points` (the column already round-trips through the API). On drop, re-request only the affected leg through `POST /api/route` with the new via list; the anchor stops stay fixed.
- [ ] Via-points are themselves draggable and removable after creation, and render distinctly from stops and POIs — smaller and clearly ephemeral — so the routing anchors stay legible.
- [ ] Moving or reordering a stop invalidates that leg's shaping and clears its via-points (already the builder's behavior); keep that so a stale shaping point can't fight a new route.
- [ ] `src/maps/export.ts` — build KML and GPX from stored rows.
- [ ] Source-aware `/kml` and `/gpx` endpoints that serve native rides from the database and imported rides from their original file.
- [ ] Round-trip the `ROLE - Name` convention on export so files reopen correctly in Google Earth and elsewhere.

**Touches.** `public/js/builder.js`, `src/maps/export.ts` (new), `src/routes/maps.ts`, `src/maps/roles.ts`.

**Status.** next — was deferred behind the maps migration; that reason has expired.

<!--| PAGE-BREAK -->

### 4. Navigation hand-off: Expand and batched Google Maps links

**Goal.** Hand a rider the exact route they planned, ready to navigate in Google Maps (and later on-device), instead of a loose set of stops the nav app re-routes between however it likes. Two problems sit between a planned route and a faithful hand-off, and this milestone solves both together:

- **Side-quests.** Give a nav app only your stops and it picks its own roads between them — often not the ones you meant. **Expand** fixes this: it densifies the route with extra shaping waypoints sampled along the planned geometry, pinning the nav app to your roads. This is MyRouteApp's "Expand," the owner's favorite feature there — a 10–20-point route is expanded to 30+ points to stay on track.
- **The waypoint cap.** Google Maps takes only ~10 points per URL, so an expanded route is split into an ordered series of links. This is the direct answer to the vision's first pain point, that Google My Maps caps at ~10 waypoints.

**Work — Expand.**

- [ ] Densify a route by sampling extra shaping waypoints along the stored leg geometry (`route_legs.geometry` already holds the full, 6-decimal, road-snapped polyline), so a hand-off follows the planned roads instead of the nav app's own guess between distant stops.
- [ ] Rider-controllable density — a target point count or spacing. The owner's habit: expand a 10–20-point route to at least 30.
- [ ] Expansion is a hand-off-time transform over geometry that already exists, not new stored route state — TankBag's own viewer renders the exact path already, so Expand matters only when leaving the app.
- [ ] Refinement: bias added points toward junctions and decision points, where a nav app is most likely to diverge, rather than purely even spacing.

**Work — batched Google Maps links.**

- [ ] Serialize a route's ordered points (after Expand) into Google Maps directions URLs — the `https://www.google.com/maps/dir/?api=1&…` form, or the `/maps/dir/lat,lng/lat,lng/…` path form.
- [ ] **Every point is a plain Google Maps waypoint.** Waypoint, POI, stop and Expand-added points all collapse to the same thing here: Google Maps does not differentiate the kinds and cannot attach a duration to a stop, so all of them count equally toward the batches. The kind and duration distinction only matters for the file exports (items 3 and 8), where GPX and KML can carry it — and where Expand-added points should be written as Garmin/TomTom *shaping* points, not stops.
- [ ] **Batch at no more than 10 points per URL.** Expand multiplies the point count, so it multiplies the links: a 30-point route is at least three of them; a 28-point route without expansion is 10, then 10, then 8.
- [ ] **Never batch across a route boundary.** Batching resets at each route end, so a route's final link is short rather than topped up with the opening points of the next route. Each route (day/session) is chunked independently.
- [ ] A share surface that lists the links per route and batch — e.g. "Day 2 · part 1 of 3" — copyable and sendable to riders.

**Open questions to settle when building.**

- **Batch continuity.** A clean partition (10 + 10 + 8) leaves a gap between links: the segment from point 10 to point 11 sits in no URL. Overlapping each batch by one point (…9, 10 │ 10, 11…) closes the gap at the cost of one point per link. Decide which, and make the choice obvious in the UI.
- **Coordinate order.** Google Maps URLs want `lat,lng`; the app stores `[lng, lat]`. Reuse the existing conversion discipline (`toLatLng` / `fromLatLng`), never a fresh inline swap.

**Touches.** new `src/maps/expand.ts` (densify over leg geometry) and `src/maps/gmaps-links.ts` (link builder), `route_legs.geometry` as the source, `public/js/viewer.js` and the share UI, possibly a small share endpoint under `src/routes/`.

**Status.** planned — high value; Expand plus batching is the workaround the whole vision is built around.

### 5. Saved places

**Goal.** A rider's reusable library of locations (home, favorite fuel stops, meet points) they can drop into any ride.

**Work.**

- [ ] Schema for places and place groups.
- [ ] CRUD endpoints and a marker-group primitive in the map engine.
- [ ] Builder integration: search or pick from saved places when adding a stop.

**Touches.** `src/db/schema.ts`, new `src/routes/places.ts`, `public/js/map-common.js`, `public/js/builder.js`, `src/routes/profile.ts` (the profile already reserves a section for this).

**Status.** planned — designed in `_PLANS/sprint-01-260725T2320Z.md` Phase B, cut from Sprint 2 for size.

### 6. Bikes and range planning

**Goal.** Model bikes and riders so the app can reason about range and comfort, per the original vision.

**Work.**

- [ ] Bike profiles: tank size / fuel economy (or battery / consumption for EVs), and per-rider comfort limits.
- [ ] Fuel/charge range rings and low-range warnings between stops.
- [ ] Suggest rest cadence from rider limits and leg durations.

**Touches.** `src/db/schema.ts`, new routes, `public/js/builder.js`.

**Status.** planned.

### 7. Riders and group rides

**Goal.** Turn a solo planning tool into a group one.

**Work.**

- [ ] Rider list / roster (the `users.can_manage_riders` capability flag already exists).
- [ ] Invite riders to a ride; per-ride RSVP.
- [ ] Surface cost splitting from the payment handles already stored on the profile.
- [ ] Rate-limit rider lookup by email/phone before it exists — it is a user-enumeration surface.

**Touches.** `src/db/schema.ts`, new routes, `src/routes/admin.ts` (extend), `src/routes/profile.ts`.

**Status.** planned. The admin panel is the first slice of this and is already shipped.

### 8. Import and export breadth

**Goal.** Handle as many open route/map formats as possible, in both directions.

**Work.**

- [ ] **Native TankBag JSON export/import** — expose the existing save=load ride payload for lossless backup and round-trip. Nearly free, since the shape already exists, and it is the only format that preserves point kind and stop duration exactly (everything else flattens them — see item 4).
- [ ] Import KMZ (zipped KML) and CSV.
- [ ] Import/export GeoJSON.
- [ ] Export GPX flavors that load cleanly on Garmin and other devices.
- [ ] Keep every added format inside the existing XXE-safe, quota-enforced import pipeline.

**Touches.** `src/maps/kml.ts`, `src/maps/export.ts`, `src/routes/maps.ts`, `src/routes/rides.ts` (the payload shape).

**Status.** planned — native JSON is the cheapest starting point; KMZ and CSV are the nearest of the interchange formats.

### 9. Discovery and public profiles

**Goal.** Make good public rides findable and give riders a public identity.

**Work.**

- [ ] Public profile pages at `/@username` (usernames are already reserved and unique).
- [ ] A browsable gallery of public rides, sorted by recency and popularity (`rides.view_count` exists).
- [ ] "Clone this ride" so a public ride can seed a new plan.

**Touches.** `src/routes/*`, `src/views/layout.ts`, `src/db/schema.ts`.

**Status.** planned.

### 10. Rich stop details

**Goal.** Let a stop hold everything a rider actually needs when they arrive — reservations, confirmation numbers, gate and door codes, check-in / check-out times, links, and freeform notes — not just a name and a category.

**Work.**

- [ ] Structured detail fields on a stop: confirmation / reservation number, check-in and check-out date-time (feeds the timeline, item 2), phone, address, and one or more URLs (booking link, menu, map).
- [ ] A freeform notes field for the unstructured stuff — "gate code 4417, park behind the barn, ask for Dave."
- [ ] Surface fields **by role** rather than as one giant form: a HOTEL / CAMP stop wants check-in/out and a confirmation number; a FOOD stop wants a reservation time and a menu link. The role taxonomy already has hotel, camp, food, coffee, drinks, grocery to key off.
- [ ] Builder UI to edit the details; viewer UI to show them in the stop's info window / panel.
- [ ] **Privacy boundary — this is the load-bearing part.** Gate codes, confirmation numbers and phone numbers are private. They must not go out with a public or unlisted share (they'd otherwise leak through `ride.json`), and probably not in exports either — only the owner sees them, and later, invited riders. Model this the way `user_profiles` is split from `users`: sensitive detail kept off any payload that reaches a public viewer's client. Note that `points.description` already exists (2000 chars) and `sanitizeText` / `esc` already defuse `javascript:` and `data:` URLs — reuse both.

**Touches.** `src/db/schema.ts` (extend `points`, or a separate `point_details` table so private fields never ride along on the public viewer contract), `src/routes/rides.ts` (payload + sanitize), `public/js/builder.js`, `public/js/viewer.js`, `src/index.ts` (the `ride.json` contract), `src/maps/export.ts` (decide what is exportable).

**Status.** planned.

### 11. Quality and platform

**Goal.** The groundwork that keeps a growing, multi-contributor codebase honest.

**Work.**

- [ ] An automated test suite — unit tests for `roles.ts`, `kml.ts` and the leg-distance clamp; integration tests for ride save/load; a viewer smoke test. There is no test runner configured yet.
- [ ] CI on GitHub Actions: typecheck, SCSS build, and the tests above on every PR.
- [ ] Error tracking / structured request logging in production.
- [ ] Rate limiting on public and auth endpoints.
- [ ] An accessibility pass (keyboard, focus, contrast, ARIA) and groundwork for i18n.
- [ ] Installable PWA with an offline view of a saved ride.

**Touches.** repo-wide; new `test/`, `.github/workflows/`.

**Status.** planned — pick these up alongside feature work, not in a big bang.

<!--| PAGE-BREAK -->

## Idea backlog (unscheduled)

Not yet shaped into milestones — raw material for future issues. Grouped by theme.

**Planning power.**

- Elevation and grade profile per route, drawn under the timeline.
- Weather forecast along the route keyed to each leg's date-time — the timeline makes this genuinely useful, not a gimmick.
- Print-friendly roadbook / turn-by-turn cue sheet for riders who tape it to the tank.
- Reverse a route; duplicate a ride as a template.
- Distance and moving-time estimates with configurable rest cadence.

**Motorcycle-specific.**

- Twistiness / curvature scoring, and a "prefer the fun road" routing bias — the feature that would beat MyRouteApp for riders who care about the road, not the ETA.
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

## Good first contributions

Well-scoped, low-context tasks a new contributor can land without holding the whole app in their head. These map directly to _good first issue_ labels.

- **Regenerate favicons and the social image** from the current TankBag mark (item 1). Pure asset work; no app logic.
- **Add privacy and terms pages** (item 1). Two static pages through the existing `page()` shell.
- **Align the day-slider tick labels** to the thumb positions in the builder (a known cosmetic nit in STATUS.md).
- **`profile.js` geocoding → server proxy** (item 1). A self-contained endpoint modeled on `POST /api/route`, plus a small client change.
- **First unit tests** (item 11). `src/maps/roles.ts` — `canonicalRole`, `parseRoleName`, `formatRoleName` — is a pure, well-specified module and an ideal place to stand up the test runner.
- **KMZ import** (item 8). KMZ is a zipped KML; unzip, then hand the KML to the existing pipeline unchanged.

## Working in this repo

Before writing code:

1. Read **[\_AI_AGENT_PRIMER.md](../_AI_AGENT_PRIMER.md)** for architecture, then **[STATUS.md](STATUS.md)** for where things actually stand.
2. Follow the local-dev setup in the **[README](../README.md)** — Postgres in Docker, `.env` from `.env.example`, `drizzle-kit push`, then `npm run dev` on port 6686.

Gotchas that will bite otherwise:

- **Coordinate order.** The app stores and speaks `[lng, lat]` (GeoJSON order); Google's JS objects speak `{lat, lng}`. Getting it backwards still renders a map, just in the wrong place. Exactly two functions convert — `toGoogleWaypoint` on the server and `toLatLng` / `fromLatLng` in `map-common.js` — keep it that way.
- **`public/js/map-common.js` is the only file that touches `google.maps`.** The viewer and builder go through the handles it returns. Preserve that boundary.
- **SCSS** compiles with `npm run sass` (never an IDE extension), and prose is never hard-wrapped.
- **Conventional Commits** for messages (`type(scope): subject`), and never commit, push, or deploy without the owner's say-so.
- **Schema is push-only** — `npx drizzle-kit push`, no migration files. Read the statement list before applying; riders now hold data that cannot be rebuilt from an upload.
