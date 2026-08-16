# RouteLoop roadmap

The durable plan for where RouteLoop is going. It pairs with two other docs and with GitHub Issues; none of them duplicates the others:

- **The code**—the actual source of truth, above everything on this list. This file is a thinking surface, not a spec or a commitment: ideas get tried, abandoned and replaced without it being edited first. Where it conflicts with what shipped, or uses a name the code no longer uses, **the code is right and this file is out of date**. Nothing here should ever be cited as evidence that something is planned, required, or already decided.
- **This file**—the narrative: the vision, the phases, and why each matters. It changes slowly.
- **[STATUS.md](STATUS.md)**—the current state and the very next steps. It moves fastest and wins wherever it disagrees with this file.
- **[AGENTS.md](../AGENTS.md)**—the operating rules, the commands and the load-bearing gotchas. Read it before writing code.
- **GitHub Issues**—the pickup-able units of work. Most roadmap items below should become one issue each; the ones tagged _good first issue_ are collected at the bottom.

## How to read this

Each roadmap item lists a **Goal**, the **Work** as a checklist, the code it **Touches**, and a **Status**:

- **shipped**—done and deployed.
- **in progress**—partially built; see STATUS.md for the exact edge.
- **next**—unblocked and worth doing soon.
- **planned**—wanted, not yet scheduled.

If you are a new contributor, jump to [Working in this repo](#working-in-this-repo) first.

## Entries changed, and the issues that still need it

When an entry here is edited, the GitHub issue it maps to usually says the same stale thing—the issue was written from the entry. This table is the running list of edits whose matching issue has **not** been made yet. Delete a row once the issue is updated.

<!-- col-widths: 22% 44% 34% -->

| Entry                             | What changed on 2026-08-10                                                             | Issue to match                                                        |
| --------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Vision → the model                | `Route` as level 2 became **Day**; **Leg** added as its own bullet                     | none—not tracked as an issue                                          |
| 2. The ride timeline              | "a route's duration" → "a day's duration"                                              | [#7](https://github.com/feralcreative/routeloop/issues/7) (closed)—title still reads "**Trip** timeline" |
| 5. One-tap Google Maps links      | batching described per route → **per day**, in three places                            | [#66](https://github.com/feralcreative/routeloop/issues/66) (closed)     |
| 9. Import and export breadth      | "colours" → "colors"                                                                   | [#13](https://github.com/feralcreative/routeloop/issues/13)             |
| 12. Quality and platform          | test count 424/20 files → **777/34**                                                   | [#16](https://github.com/feralcreative/routeloop/issues/16)             |
| 13. Rider Subgroups               | "its own Route within the Ride" → **day**; "rides-hold-many-routes" → **-many-days**   | [#67](https://github.com/feralcreative/routeloop/issues/67)             |
| 14. Alternate routes and voting   | "day/route-level" → **day-level**                                                      | [#68](https://github.com/feralcreative/routeloop/issues/68)             |
| 15. On-the-road mobile interface  | "a route's Google Maps legs" → "a day's"                                               | [#69](https://github.com/feralcreative/routeloop/issues/69)             |
| Backlog → elevation profile       | "per route" → **per day**                                                              | [#23](https://github.com/feralcreative/routeloop/issues/23)             |
| Backlog → reverse and duplicate   | marked **shipped**; it was still listed as unbuilt                                     | [#26](https://github.com/feralcreative/routeloop/issues/26) already closed—no action |
| 7. Bikes and range planning       | one-line stub replaced with a decided schema: bikes one-to-many off users, seven fields | [#11](https://github.com/feralcreative/routeloop/issues/11)             |
| Backlog → drag-to-reorder         | affordance decided: a textured drag bar, not arrows                                    | [#39](https://github.com/feralcreative/routeloop/issues/39)             |

Cleared on 2026-08-15: every entry that read "needs a new issue" now has one. Items 16, 17, 18, 19 and 20 became [#88](https://github.com/feralcreative/routeloop/issues/88) (an epic with eleven children, one of which is the pre-existing [#39](https://github.com/feralcreative/routeloop/issues/39)), [#99](https://github.com/feralcreative/routeloop/issues/99), [#100](https://github.com/feralcreative/routeloop/issues/100), [#101](https://github.com/feralcreative/routeloop/issues/101) and [#102](https://github.com/feralcreative/routeloop/issues/102). The dashboard got its first issue ever, [#103](https://github.com/feralcreative/routeloop/issues/103), and its own `area:dashboard` label.

Three issues carry the old vocabulary in their **titles**, which is a separate edit from their bodies:

- **[#49](https://github.com/feralcreative/routeloop/issues/49) "Split a long route into day routes"**—should be "into days". The only one of the three where the stale word is also the feature's name.
- **[#23](https://github.com/feralcreative/routeloop/issues/23) "Elevation and grade profile per route"**—should be "per day", matching the row above.
- **[#70](https://github.com/feralcreative/routeloop/issues/70) "Never drop tracks on import; land them all as routes"**—closed, but the title is the clearest surviving statement of the old model.

## Priorities

Every open issue carries a **P0–P3** label. The labels are the authority on what to do next; the item numbers below are stable identifiers, not an order. **Re-scoped 2026-08-15**—the tiers below mean something different than they did, so an issue's label is only as good as the last sweep. See "What changed, and why" underneath the table.

<!-- col-widths: 12% 88% -->

| Tier   | What it means                                                                         |
| ------ | -------------------------------------------------------------------------------------- |
| **P0** | Blocks real use of something that already ships. Do these next                        |
| **P1** | The builder page, its tool panel, and the map engine                                  |
| **P2** | The dashboard at `/`, plus real gaps riders will hit                                  |
| **P3** | Everything else, including the group layer and the whole idea backlog                 |

### What changed, and why

P1 used to be *the group layer*. It is now *the builder*. The reasoning, recorded because a tier that changes meaning silently is worse than no tier at all:

**Planning a ride fluidly and intuitively is what this app is for.** Everything else in the product—sharing, hand-off, the group layer, the roadbook—is downstream of a plan that was pleasant to make. The map and the builder's tool panel are where that happens, and the panel has never been designed as one surface; it grew a control at a time. Item 16 measures the damage: 198 interactive elements in a 380px column, 807px of content in a 620px window, and a layout that jumps on nearly every edit.

**The group layer went to P3, not P2.** Nobody is in the beta and nobody will be for a while, so nothing needs #71, #72 or #73 to work. The dependency chain those three describe is still correct and still in item 8—it just is not next. #12 sits on top of all three and went with them.

**#16 stays at P1** despite being platform work, for the one reason it was already there: rate limiting. Every anonymous view of a shared ride is a billable Maps load, so cost scales with strangers rather than with accounts. That has to exist before rides are shared widely, and it is indifferent to what the rest of the tiers mean.

**The dashboard is P2 and had no issues at all.** `/` carries the stats, and until 2026-08-15 the nav did not link to it—the only way in was the logo. That gap is closed; nothing else about the page has been specified.

**P0 is empty as of 2026-08-06.** The tier that used to hold this section has been cleared:

- ~~**[#8](https://github.com/feralcreative/routeloop/issues/8) Route shaping.**~~ **Shipped 2026-08-06.** A rider can pull a route onto the road they meant; everything else in the planner had been assuming the line was right with no way to correct it.
- ~~**[#38](https://github.com/feralcreative/routeloop/issues/38) Autosave and undo.**~~ **Shipped 2026-08-05.** The competitive research filed undo as a defection trigger rather than a nicety: "works pretty good at route planning until I mess up, then can't undo the mistake and have to start a new trip."
- **[#69](https://github.com/feralcreative/routeloop/issues/69) On-the-road mobile interface** is now labelled **P2**, not P0. The navigate page exists and is not yet usable in gloves at a fuel stop: no finished-leg marking, no progress memory, no tolerance for losing signal. That is still the difference between a demo and the feature, but the label is the authority and the label says P2.

**With P0 clear, P1 is the work.**

**P1—the builder, and item 16 first within it.** The panel is the app's primary work surface and the one that has never been designed as one. Item 16 is where its twelve decided changes live, and it sequences itself: **autosave lands before the action row** (which deletes the Save button and probably Discard with it, so the row that survives is not the row that exists today) and **before the exit-guard question** (autosave may remove the reason for a confirm dialog entirely). Everything else on the list is independent of that pair.

The rest of P1 is the issues that touch `public/js/builder.js` and the map engine—drag-to-reorder ([#39](https://github.com/feralcreative/routeloop/issues/39)), keyboard shortcuts ([#40](https://github.com/feralcreative/routeloop/issues/40)), splitting a long day ([#49](https://github.com/feralcreative/routeloop/issues/49)), lodging as a day boundary ([#54](https://github.com/feralcreative/routeloop/issues/54)), detour-radius discovery ([#50](https://github.com/feralcreative/routeloop/issues/50)), layer stacking ([#51](https://github.com/feralcreative/routeloop/issues/51)), saved places ([#10](https://github.com/feralcreative/routeloop/issues/10)) and rich stop details ([#15](https://github.com/feralcreative/routeloop/issues/15)).

**[#16](https://github.com/feralcreative/routeloop/issues/16) stays P1 on its own argument**—rate limiting, per the note above. It is the one P1 that is not builder work.

**The group layer moved to P3**, in the dependency order it always had: [#71](https://github.com/feralcreative/routeloop/issues/71) ride membership, then [#72](https://github.com/feralcreative/routeloop/issues/72) friendships, then [#73](https://github.com/feralcreative/routeloop/issues/73) the visibility levels that need both, with [#12](https://github.com/feralcreative/routeloop/issues/12) on top of all three. That chain is unchanged and still correct; only its position moved. P1 used to say this was "where the product stops being single-player, and the reason a rider brings anyone else"—still true, and it waits, because a rider brought to a planner that is awkward to plan in does not stay.

## Vision

MyRouteApp, but far better: entire-ride focused, with a slicker UI and smoother UX.

RouteLoop is a tool to **plan, organize, and share** motorcycle rides and car road trips—not real-time navigation, and never will be. The point is to give riders a holistic view of an **entire** ride: every leg, every day, every stop, every hotel and gas station, across an unlimited number of days and miles. Existing tools cap out (Google My Maps allows ~10 waypoints and one route per layer; Apple Maps behaves differently on every device) and none of them shows the whole ride at once. RouteLoop has no such limits.

The model that everything else follows:

- A **Ride** is the shareable package—many days, with a start and an end that bound the whole ride.
- A **Day** is one session inside a ride: an ordered list of stops joined by road-snapped legs, with its own color, title and start/end date-time. A day is a *position* in a ride, not a calendar date—two days can share a date, and a ride with no dates at all still has days.
- A **Leg** is the road-snapped geometry from one stop to the next. It is never user-visible; the table is `route_legs`, which keeps that name on purpose because a leg really is a routed segment.
- Three kinds of dots:
  - **Waypoint**—an ephemeral shaping point that only keeps the route on course. Nothing remarkable about the spot; we do not stop there.
  - **POI**—something interesting near the route (a vista, a museum, a quirky store) we might or might not stop for. It never affects routing.
  - **Stop**—a real stop (gas, food, rest, hotel). Stops always have a duration; "ends" are stops with no duration.
- **No platforms, no limits.** Import and export as many open route formats as possible, and never depend on a proprietary, licensed one.

The signature interaction is the **timeline**: a slider across the bottom of every ride and day, from its start time to its end time. The whole ride stays visible while the slider focuses the leg or section that corresponds to a given date and time.

Where this document still says "route" it means the drawn path—the line on the map, the thing you shape and export. It no longer means level 2; that is a **day**.

<!--| PAGE-BREAK -->

## Where things stand

Built and deployed today (see STATUS.md for the living detail):

- **Data model**—rides → days → stops/POIs → routed legs, plus the 17-role stop taxonomy.
- **Import**—KML/GPX upload becomes a structured, editable ride, through an XXE-safe, quota-enforced pipeline.
- **Ride builder**—plan a road-snapped route, classify stops, save. Now **multi-day**: every day of a ride is drawn on one map, with a day-focus slider.
- **Native viewer**—shared rides render from the database.
- **User profiles & authorization**—`users.status` gates who may use the app; profile page; home-address seeding.
- **Auth**—Google OAuth + emailed magic link, replacing Cloudflare Access.
- **Maps**—rendering, search (Places New) and routing (Routes API) all on Google.
- **Admin panel**—the owner approves, blocks and reinstates rider accounts.
- **Twistiness**—each day carries a measure of how much its roads bend, derived from geometry so imported rides get one too. Shown as a word in the builder and the viewer legend.
- **Expand**—a hand-off-time transform that weaves shaping points along the planned geometry, so whatever you navigate with has too little room to pick its own roads.
- **The navigate page**—`/m/:slug/navigate` turns a ride into an ordered series of Google Maps links, one leg at a time, with a density control and an honest statement of the longest stretch Maps still chooses for itself.
- **Lossless import**—a file holding several tracks lands as several days, names and all, rather than as its longest track.
- **Import and export**—six formats in (KML, KMZ, GPX, GeoJSON, CSV, native RouteLoop JSON), five out, several files at once becoming the days of one ride, and every original kept so nothing an upload contained is destroyed.
- **Roadbook**—a printable stop-by-stop sheet: leg and cumulative miles, miles since fuel, planned dwell, and an estimated clock.
- **Route shaping**—drag the route line onto the road you meant; the dropped point becomes an ephemeral via-point on the right leg and only that leg re-routes.
- **Undo and drafts**—undo/redo in the builder, plus a draft that survives a crash, a closed tab or a dead phone, including for a ride that has never been saved.
- **CI**—typecheck and the full test suite on every pull request and push to `main`, against Node 20 and 22. (777 tests across 34 files as of 2026-08-10; `npm test` is the authority, not this number.)

The two big migrations (auth and maps) are **done**, in the code and in the Google Cloud console. One thing remains: removing the redundant Cloudflare Access policy at the edge, which is gated on a verified prod deploy and tracked in #58.

## Roadmap

### 1. Finish the Google migration and clear debt

**Goal.** Retire the last Mapbox dependency and the redundant Cloudflare Access policy so the stack is single-vendor and the dead config is gone.

**Work.**

- [ ] Remove the Cloudflare Access policy at the edge (the app already ignores its header; the policy is now pure redundancy).
- [x] Move `profile.js` home-address geocoding to a server proxy alongside `POST /api/route`—the last Mapbox call and the only reason `MAPBOX_TOKEN` still has to be set.
- [x] Teach the current engine to draw an imported ride's single-leg track, then collapse the two viewer shells into one and delete `public/js/main.js`. (The engine already handled it; the work was deleting the legacy shell.)
- [x] Drop `MAPBOX_TOKEN`, `MAPBOX_GL_VERSION` and `MAPBOX_CSS_LINK`, plus their `.env.example`, compose and deploy-guard references.
- [x] Regenerate the favicons and social image from the current RouteLoop mark. Done 2026-07-31; the files live in `public/img/favicon/`.
- [x] Add privacy-policy and terms pages (required to publish the OAuth consent screen past 100 users).
- [x] Set per-API daily quota caps on the GCP project so a runaway loop can't run up a bill. Done 2026-08-02—five metrics capped; see STATUS.
- [x] Disable the Maps APIs the app does not use. Done 2026-08-02—23 of 27 off, leaving only Maps JavaScript, Places (New), Routes and Geocoding.

**Touches.** `public/js/profile.js`, `src/routes/routing.ts`, `src/routes/*` viewer shells, `src/index.tsx`, `src/config.ts`, `src/views/layout.ts`, `public/img/`.

**Status.** Done, bar one thing. Mapbox is retired, the two viewer shells are one, the legal pages shipped, the favicons were regenerated on 2026-07-31, and the GCP console work landed 2026-08-02 (quota caps applied, 23 unused Maps APIs disabled). The tracking issue #6 is closed; the single remaining item—removing the Cloudflare Access policy at the edge—moved to #58, because it is gated on a verified prod deploy and nothing in this repo will ever tick it.

### 2. The ride timeline

**Goal.** Ship the signature feature from the vision: a date-time slider that focuses a ride in time.

**Work.**

- [x] A date-time UI in the builder that writes `days.start_at` / `days.end_at` (the columns exist and already load into builder state; nothing sets them yet).
- [x] A timeline slider across the viewer and builder that maps a moment to the leg/section active then, dimming the rest without hiding anything.
- [x] Sensible defaults: derive a day's duration from its legs, and seed each day's start from the previous day's end.

**Touches.** `public/js/builder.js`, `public/js/viewer.js`, `public/js/map-common.js`, `src/db/schema.ts` (already has the fields), `src/routes/rides.ts`, `src/index.tsx` (the `ride.json` contract has to start carrying per-leg data—it currently flattens every leg into one track).

**Status.** done on `feat/trip-timeline-slider`, closing #7 and #19. Duration is derived as legs **plus** stop dwell, and deliberately kept separate from `days.duration_s`, which caches riding time only. `ride.json` now carries per-leg spans—the viewer could not map a moment to a leg without them. The time model is shared by both clients in `public/js/ride-time.js` so they cannot disagree. See docs/STATUS.md for the rest, including the two properties of leg spans that real data will break a naive assumption about.

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

**Status.** shipped—export in sprint 09 (2026-08-03), drag-to-shape on 2026-08-06 ([#8](https://github.com/feralcreative/routeloop/issues/8)). The index arithmetic that turns a drag on the day's single concatenated polyline back into "leg 3, between via 1 and via 2" lives in `route-shape.js`, kept pure so `test/route-shape.test.ts` can drive it.

<!--| PAGE-BREAK -->

### 4. Expand: densify a route so a hand-off stays on your roads

**Goal.** Give a nav app only your stops and it picks its own roads between them—often not the ones you meant. **Expand** fixes that: it densifies the route with extra shaping waypoints sampled along the planned geometry, pinning whatever you hand it to onto your roads. This is MyRouteApp's "Expand," the owner's favorite feature there—a 10–20-point route expanded to 30+ points to stay on track. It is provider-agnostic and improves _every_ hand-off: the Google Maps links (item 5) and the Garmin/TomTom file exports (item 3) alike.

**Work.**

- [ ] Densify a route by sampling extra shaping waypoints along the stored leg geometry (`route_legs.geometry` already holds the full, 6-decimal, road-snapped polyline), so a hand-off follows the planned roads instead of the nav app's own guess between distant stops.
- [ ] Rider-controllable density—a target point count or spacing. The owner's habit: expand a 10–20-point route to at least 30.
- [ ] Expansion is a hand-off-time transform over geometry that already exists, not new stored route state—RouteLoop's own viewer renders the exact path already, so Expand matters only when leaving the app.
- [ ] Refinement: bias added points toward junctions and decision points, where a nav app is most likely to diverge, rather than purely even spacing.
- [ ] Expand-added points are shaping points, not stops: written as Garmin/TomTom _shaping_ points in the file exports (item 3) and counted as plain waypoints in the Google Maps links (item 5).

**Touches.** new `src/maps/expand.ts` (densify over leg geometry), `route_legs.geometry` as the source, the export path (item 3) and the Google Maps link builder (item 5).

**Status.** done on `feat/expand-route`. `src/maps/expand.ts` places shaping points to bound the longest unpinned stretch rather than spacing them evenly—even spacing wastes points on a straight where the nav app was never going to diverge. Density is the rider's call at hand-off time (off / light / tight), because every extra point is another link and another tap. Nothing is stored: it is a transform over `route_legs.geometry`, which is what makes it free to change later.

### 5. One-tap Google Maps links

**Goal.** Hand a rider the exact route they planned, ready to navigate in Google Maps, instead of a loose set of stops it re-routes between however it likes. Google Maps takes 9 waypoints plus an origin and a destination per URL, so a route—especially an Expanded one—is serialized into an ordered series of links. This is the direct answer to the vision's first pain point, that Google My Maps caps at ~10 waypoints.

**Work.**

- [ ] Serialize a day's ordered points (after Expand, item 4) into Google Maps directions URLs—the `https://www.google.com/maps/dir/?api=1&…` form, or the `/maps/dir/lat,lng/lat,lng/…` path form.
- [ ] **Every point is a plain Google Maps waypoint.** Waypoint, POI, stop and Expand-added points all collapse to the same thing here: Google Maps does not differentiate the kinds and cannot attach a duration to a stop, so all of them count equally toward the batches. The kind and duration distinction only matters for the file exports (items 3 and 9), where GPX and KML can carry it.
- [ ] **Batch at no more than 10 points per URL.** Expand multiplies the point count, so it multiplies the links: a 30-point route is at least three of them; a 28-point route without expansion is 10, then 10, then 8.
- [ ] **Never batch across a day boundary.** Batching resets at the end of each day, so a day's final link is short rather than topped up with the opening points of the next day. Each day is chunked independently.
- [ ] A share surface that lists the links per day and batch—e.g. "Day 2 · part 1 of 3"—copyable and sendable to riders.

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

**The model**, decided 2026-08-10: a bike belongs to exactly one rider and a rider owns many bikes—a plain one-to-many hanging off the user, not a shared catalog. A bike never owns a rider. Fields: **make, model, year, mpg, tank size, range to light, range to empty.**

**Work.**

- [ ] A `bikes` table owned by `users`, with the seven fields above, plus CRUD on the profile page beside the avatar (item 17).
- [ ] Per-rider comfort limits—these belong to the rider, not the bike, and stay on the profile.
- [ ] Fuel/charge range rings and low-range warnings between stops.
- [ ] Suggest rest cadence from rider limits and leg durations.
- [ ] EV counterpart—battery and consumption in place of tank and mpg. Tracked separately as [#31](https://github.com/feralcreative/routeloop/issues/31); the schema should not make it awkward.

**Open questions.**

- **Stored or derived.** `mpg × tank size` already implies a range, so *range to light* and *range to empty* are arithmetic on paper. They are not in practice: riders know their real numbers and those numbers beat the spec sheet. Recommendation is to store all three as entered and never overwrite a rider's figure with a computed one—but whether the fields seed themselves from the math on first entry is undecided.
- **Units.** mpg assumes US units. Ties to the miles/km preference still open in `docs/main-menu.md`, and the stored unit should be settled before the column exists rather than after.

**Touches.** `src/db/schema.ts`, new routes, `src/routes/profile.ts`, `public/js/builder.js`.

**Status.** planned—the model landed 2026-08-10 from a click-through; before that this item was a one-line stub. Note [#52 "Group-aware range planning"](https://github.com/feralcreative/routeloop/issues/52) is already open and depends on this: range only becomes a group problem once each rider on a ride has a bike, which needs items 8 and 13 as well.

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

- [x] **Native RouteLoop JSON export/import**—`/routeloop.json` writes the builder's own save payload and the importer feeds it back through the same schema and the same insert. Verified lossless on a real 3-day ride: days, colors, start/end times, legs, via points, stops, POIs, dwell and roles all identical. The `routeloop` version field is what tells it apart from a GeoJSON, since both arrive as `.json`.
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

- [ ] An automated test suite. Vitest is configured and `roles.ts`, the format parsers, Expand, the Google Maps link builder, the drag-to-shape index math and the builder's undo/draft model are covered (777 tests across 34 files as of 2026-08-10). Still missing: the leg-distance clamp, integration tests for ride save/load, and a viewer smoke test.
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

- **Model.** Two shapes are viable and the choice is load-bearing. Either each approach and dispersal is its own **day** within the ride (leans on the existing rides-hold-many-days model; a meeting point is a stop shared between a feeder's end and the trunk's start), or legs carry participant membership directly and a rider's path is the ordered set of legs they are on (matches "assign people to legs" literally, but needs branching geometry within a single day). Decide before building—it changes the schema and every downstream view.
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

- **Granularity.** Segment-level (a fork between two stops), day-level (a whole alternate day), or both? Segment-level matches the "this way or that" pitch; day-level is simpler and reuses the rides-hold-many-days model. It changes the schema.
- **Who proposes.** Only the ride leader, or any member? Any-member turns this into lightweight collaborative editing (backlog) and needs guardrails.
- **Resolution rules.** Simple majority, quorum, deadline, tie-breaking, and whether the leader can override the vote. Settle the governance before building the buttons.
- **Anonymous vs. named votes.** Named votes create social pressure; anonymous is cleaner but hides who wants what.

**Touches.** `src/db/schema.ts` (alternates + votes), new routes under `src/routes/`, `public/js/builder.js`, `public/js/viewer.js`, `public/js/map-common.js` (ghosted alternates), the timeline and roadbook (active path only).

**Status.** planned—a group-collaboration feature; depends on riders (item 8) and overlaps the collaborative-editing backlog item.

### 15. On-the-road mobile interface

**Goal.** A phone-sized, glove-friendly view of a ride for use in the saddle—big buttons, high contrast, no clutter—that does two things well: send the ride's files to whatever the rider navigates with, and step through a day's Google Maps legs one batch at a time. This is a **consumption** surface, not a planning one (planning stays a big-screen job), and it is the digital counterpart to the printed roadbook.

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

### 16. The builder panel

**Goal.** The panel is the app's primary work surface and it has never been designed as one—it grew a control at a time. On a 1400px viewport it is 380px wide holding 198 interactive elements, and on a 3-day ride with 7 stops on the focused day its content is 807px tall in a 620px window. Everything below is from a measured pass on 2026-08-10 against `/builder/9`.

**The governing rule.** **Nothing in the panel changes size as its value changes.** This is a constraint on every item below, not a task of its own—reserve the space, fix the footprint, and let content fit the box rather than the box track the content. Jumping layout is the single most jarring thing about the panel today, and it comes from a dozen small places rather than one:

- The **day band** is `hidden` until a day is picked, so the panel goes 482px → 696px on one slider move. The largest single jump.
- Per row, the **notes textarea** and the **17-button role picker** are both `hidden` and expand inline, pushing every row below them.
- The **role icon button** grows with the number of roles (see below).
- Variable-length readouts reflow what follows: `#totals`, `#save-status`, `#day-times-note`, `.day-pick-hint`, the `#search-results` list, and the recover bar.

**Work.**

- [x] **Autosave to the server; retire the Save button.** Shipped 2026-08-15. Two timers rather than one: a 3s idle debounce, and a 20s ceiling armed on the first edit of a dirty run and not re-armed by later ones. The ceiling is the one that matters—an idle debounce alone has no upper bound, so dragging a stop around for four minutes never goes idle and never saves. Both sit far under the five-minute acceptance bar deliberately, because the bar is what must never be exceeded rather than what to aim for. The route request keeps its own debounce in `computeLeg()` and is not coupled to this; that is the half that costs money. Save and Discard are both gone.
- [x] **Say that autosave is happening.** Shipped 2026-08-15. A dot and a word in the action row, in a **fixed-width box**—it was on the governing rule's list of variable-length readouts, and it cycles three states several times a minute right beside the link to the public page. A server error ellipsizes rather than being allowed to set the width. The readout is `aria-hidden` and a separate live region speaks only for an error or a blocked save; a polite region on the readout itself would announce the routine cycle aloud several times a minute.
- [x] **An X in the panel's top corner that exits the map.** Shipped 2026-08-15, and **half of this entry turned out to be wrong**. The existing control was never an X—`panelShell` renders `icon-collapse.svg`, a minimize glyph—so there was no wrong verb to fix and collapse did not have to move anywhere. What was real was the other half: there was **no exit at all**. A map page has no footer and its header is the floating nav, so the only way off was the hamburger in the opposite corner. An exit now sits beside collapse in `.panel-controls`, two controls for two verbs: collapse keeps you on the map, exit leaves it. It lands on the **viewer** as well, which was the same black hole, and goes to `/rides` for a signed-in rider or `/` for a visitor who followed a shared link and has never seen the site.
- [ ] **Drag to reorder, not arrows.** A textured drag bar replaces the per-row `↑`/`↓` pair. See [#39](https://github.com/feralcreative/routeloop/issues/39), which this decides the affordance for. It also reclaims real width: a stop row's name field is 113px against a POI row's 152px, and that 39px difference *is* the arrow pair.
- [ ] **One menu per row, not a row of buttons.** `✎` (notes) and `✕` (delete) collapse into a single control holding edit, delete, **duplicate** and whatever else a point grows. With the drag bar above, a row goes from six buttons to two, and `.row-actions`—80px of a 320px row—mostly returns to the name field. Note that duplicate-a-point does not exist today, so this adds a capability rather than only rearranging one. **Build the menu on open, never per row:** the role picker already renders 17 buttons for every point (119 in the DOM at 7 stops, 340 at 20), and a second eager per-row menu would repeat that exactly.
- [ ] **The two sliders are eating the panel.** The day scrubber, the ride timeline and the totals line come to 185px—**30% of the 620px visible panel**—and `#time-slider` is `disabled` on any ride without a day start time, so most of that is spent on a control doing nothing, under a note explaining why. Ziad's direction: one is a *view* slider and one is an *edit* slider, so possibly one edit mode and one view mode with a single slider each. Merge or tighten; the current stack is not defensible.
- [x] **The ride's name is the headline.** Shipped 2026-08-15. The input **is** the heading rather than something a pencil swaps in—a reveal would be a second mode and a layout jump, which is the thing the governing rule exists to remove. The field is drawn as the heading, carries no border until hovered or focused, and shows the pencil then as an affordance. The summary moved directly under it and both now sit outside `.panel-contents-wrapper`, so they stay put while the stop list scrolls; `renderTotals()` writes `#totals` by id and did not notice. Note this also fixed something unrelated that nobody had filed: on a **new** ride the panel had no `<h1>` at all, so a collapsed panel showed an empty strip.
- [x] **The action row is icons, not labels.** Shipped 2026-08-15, and the sequencing paid off exactly as predicted: autosave had already deleted Save and Discard, so what got drawn was undo, redo, a status readout and the link to the public page—the row that survives rather than the one that existed. The glyphs are U+21B6 and U+21B7 with `aria-label`s, so no icon asset is involved. **The fold is fixed too:** `.builder-actions` was `position: static` at the end of a list that grows without limit, so the controls a rider reaches for most were the ones furthest out of reach—140px below the visible area on a seven-stop day. It is `position: sticky; bottom: 0` now, with an opaque background because content scrolls under it.
- [ ] **Stop durations show as hours with one decimal, and the format is a preference.** The row's duration field is `type="number"` in raw minutes today. Default becomes hours to one decimal, with hours+minutes, plain minutes and whatever else offered in Settings. **Storage does not change**—`durationMin` stays the stored unit, so the roadbook, the timeline and every export are untouched and this is a formatter plus a setting. Note the granularity: one decimal hour is six minutes, so a 20-minute gas stop reads `0.3`.
- [ ] **Color pickers are square.** `#day-color` is 50 × 27 in a 320px day head—`<input type="color">` renders wide by default and the extra 23px is dead space beside a day-name field that only gets 165px. Applies to any color input, not just this one.
- [ ] **Role icons get a fixed footprint.** `roleIconsHtml()` joins one 16px chip per role into a flex button with `max-width: none`, so the control is roughly `18n + 10` wide—28px at one role, about 316px of a 320px row at all seventeen. The name field pays for it. **Decided: multiple icons never occupy more than one icon's footprint.** How—stacking, quarter-scale satellites, a badge count—is open.

**Open questions.**

- **Whether exiting needs a guard at all. Answered by autosave: no dialog.** Nothing to lose means nothing to confirm, and with the flush shipped the ride is on the server within three seconds of the last keystroke. The `beforeunload` guard narrowed rather than vanished—it now fires only for the genuine window, an edit inside the debounce or a flush in flight, and in practice a rider never sees it. That also removes the "un-dismiss the exit confirmation" entry from `/settings` in `docs/main-menu.md`, leaving the duration format below as its only decided content.
- **Save churns IDs. Decided 2026-08-15: accept it, and guard it.** The `PUT` deletes and re-inserts every day and point, so identifiers change on each save, and autosave now makes that happen constantly rather than a dozen times a session. It stays safe for exactly one reason—nothing anywhere references a point across a save—and the alternative was to send ids in the payload and diff server-side, which rewrites `insertRideGraph`, `ridePayload` and `loadRidePayload`, the path the native JSON import shares, for a bigger job than the rest of item 16. The constraint is written on the `PUT` handler in `src/routes/builder.ts` where the next person will hit it: **anything that needs a point to keep its identity has to fix this first**—rich stop details (item 11), a comment on a stop, a photo attached to one. The failure is silent and looks like data that wandered off.
- **Does a view/edit mode split contradict the vision?** The Vision section calls the timeline "the signature interaction: a slider across the bottom of every ride and day," with the whole ride staying visible while the slider focuses a moment. Putting it behind a view mode means it is absent while planning. Defensible, but it is a change to a stated headline feature rather than a layout tweak—and it raises a second thought worth having: the timeline may belong across the bottom edge of the map, where the vision actually puts it, rather than inside a 380px panel at all.
- **Where the fold falls.** `.builder-actions` is `position: static`, so Save sits 140px below the visible area on a 7-stop day and drops further with every stop added. Autosave removes the Save button, but Undo, Redo and Discard are in the same row and have the same problem.

**Touches.** `src/routes/builder.ts` (the panel markup and `PUT /api/rides/:id`—renamed from `rides.ts` in [#104](https://github.com/feralcreative/routeloop/pull/104)), `src/views/layout.tsx` (`panelShell`, shared with the viewer—so the collapse/close change lands on both), `public/js/builder.js`, `public/js/builder-history.js`, `style/_builder.scss`, `src/routes/settings.tsx`, `docs/ops/faq.md`.

**Status.** planned—opened 2026-08-10 from a click-through. Nothing here existed on the roadmap before; the builder panel had never been an item.

### 17. Avatar upload

**Goal.** Let a rider upload their own avatar from the profile page. `users.avatar_url` exists but is write-once from Google sign-in; a magic-link rider has none and never can, and the profile page has no avatar section at all.

**Work.**

- [ ] **A section at the top of the profile page, beside the username**, holding the avatar, the upload control, and remove-and-revert-to-fallback. Placement decided 2026-08-15.
- [ ] **Raster only. No SVG, ever.** Decided 2026-08-10—an SVG avatar is stored XSS, and `src/views/layout.tsx` renders the avatar in the nav on every page of the app. This is a security boundary, not a format preference.
- [ ] **PNG or JPEG only, 1 MB maximum.** Added 2026-08-15. The two format names are the concrete expression of the raster-only rule above—accept exactly these and reject everything else by sniffing the bytes, not by trusting the extension or the `Content-Type`. The 1 MB bound is a cheap first gate that rejects most of what a phone camera produces before any decode happens, which matters because decoding is where a malicious image does its damage.
- [ ] **Square, 500×500 maximum.** Decided 2026-08-10 and reaffirmed 2026-08-15 against a 1000 proposal. Stored square; **circular is a display treatment only**—`.nav-avatar` already carries `border-radius: 50%`, so nothing round is ever written to disk.
- [ ] **A circular crop box the rider sizes and positions**, working on any aspect ratio—decided 2026-08-10, in place of a server-side center-crop, which beheads anyone who uploads a landscape photo. The circle is the *guide*; what gets written is the square that bounds it, so the corners are still stored and a square display keeps working if we ever want one. **Outside the circle is shaded**, not hidden, so the rider can see what they are cutting off while they position it.
- [ ] **Re-encode every upload server-side** to a known raster format at or under that bound. Never store or serve the bytes as received. **The client-side crop is convenience, not enforcement**—the browser's output is attacker-controlled, so the server re-validates dimensions and re-encodes regardless of what arrived.
- [ ] Strip EXIF—phone photos carry GPS, and a rider's avatar should not publish where they took it.
- [ ] Serve through a route, not a static path: `src/maps/storage.ts` deliberately writes outside the web root, and avatars follow the same rule.
- [ ] Confirm `STORAGE_PATH` is a named volume in prod before anything user-uploaded depends on it surviving a redeploy.

**Open question.** **Which crop library, if any.** Pinch-zoom, drag-to-position and touch handling on a crop box is a lot of fiddly work to get right, and this is the first item on the list that plausibly earns a dependency rather than bespoke code. See the standing preference in `AGENTS.md`: a library that earns its keep is welcome, options get presented rather than assumed.

**Touches.** `src/routes/profile.ts`, `src/maps/storage.ts` (or a sibling that follows its containment pattern), `src/db/schema.ts` if the source of an avatar needs distinguishing from Google's, `src/views/layout.tsx`.

**Status.** planned—raised 2026-08-10. This is the first user-uploaded binary the app serves *publicly*; the stored map originals are downloads behind auth, which is a materially different risk profile. The initials-on-a-tinted-disc fallback stays for riders who upload nothing—see `docs/main-menu.md`.

### 18. Profile autosave

**Goal.** The profile saves on a button today, so a rider who edits a field and navigates away loses it silently. Autosave after a few idle seconds, the way an editor does, and say so.

**Work.**

- [ ] Flush the profile form to the server after a short idle pause, and on blur of the last-touched field.
- [ ] An indicator that says saved / saving / failed, in place of the button it replaces. Silent saving is worse than an explicit button, not better.
- [ ] Per-field validation errors already come back from the `profile.tsx` schema; an autosave has to surface them without stealing focus or reverting what the rider typed.
- [ ] Decide what happens to a partially valid form. A profile is not a ride: individual fields are independent, so a bad postal code should not block a good display name from persisting.

**Sequencing against item 19—build this one first, and leave the address block out of it.**

Autosave and address autocomplete both watch the same fields and both act on a pause in typing, so shipped naively they fight: a rider types four characters of a street name, stops to read the suggestion list, and the idle timer fires and saves the fragment. The stored address is now `123 Ma`, the geocode against it is wrong or null, and if the save re-renders the field from the server the dropdown closes underneath them mid-choice.

- [ ] Build autosave with the address block **excluded**, saving every other field on idle. The address fields keep their explicit save until item 19 lands. This is a real state to ship in, not a stepping stone—the rest of the profile is the part with no save affordance problem.
- [ ] When item 19 lands, the address block joins autosave on a **different trigger**: it flushes when a suggestion is *selected*, or when the field is left with the dropdown closed. Never on an idle timer, because idle is exactly the state a rider is in while reading suggestions.
- [ ] Whichever ships second owns the integration test: type into an address field, pause longer than the idle delay with the dropdown open, and assert nothing was saved and the dropdown is still there.

**Open question.** **Whether it shares a mechanism with item 16.** The builder's autosave has the same shape—idle debounce, flush, status indicator—but a different failure model: the builder's `PUT` replaces the whole ride in one transaction, while a profile is a set of independent fields. Worth one helper if the debounce and the indicator are genuinely the same; not worth forcing if the persistence halves differ. Look at both before writing either.

**Touches.** `src/routes/profile.tsx`, `public/js/profile.js`, `style/_forms.scss`.

**Status.** planned—raised 2026-08-15.

### 19. Address autocomplete that fills the form

**Goal.** Typing an address should offer matches in a dropdown attached to the field, and picking one should fill address, city, state and postal code in a single action. Today the rider types every field by hand and a status line appears *below* the input reporting what the geocoder made of it, which is feedback after the fact rather than help during.

**Work.**

- [ ] Attach a suggestion dropdown to the address input itself, replacing the after-the-fact `#geocode-status` line as the primary feedback.
- [ ] On selection, populate `addressLine`, `city`, `state` and `postalCode` from the structured result, plus the coordinates the geocoder already writes—one action instead of five fields and a guess.
- [ ] Apply to **both** address blocks on the profile: the home address and the separate ride-start address, which are two copies of the same five fields today.
- [ ] Keep manual entry working unchanged. An address the provider does not know must still save as typed—the existing rule that a bad geocode yields null coordinates and never a validation failure stays exactly as it is.
- [ ] Keyboard-navigable list with the usual arrow/enter/escape semantics and correct ARIA, not a mouse-only menu.
- [ ] **Take over the address block's persistence from item 18**, which deliberately ships with those fields excluded from idle autosave. Flush on selection, or on leaving the field with the dropdown closed—never on an idle timer, which is the state a rider is in while reading the list. See the sequencing note under item 18 for why.

**Open questions.**

- **Which API, and what it costs.** Places Autocomplete (New) is already enabled for the builder's search box, but it is billed per session and per request, and this puts it behind every keystroke on the profile. Session tokens are the mechanism that keeps that from being priced per character—use them, and confirm the SKU before it ships. The daily quota caps from item 1 apply.
- **Server proxy or browser call.** The builder calls Places from the client with the referrer-restricted browser key; the profile's geocoding was deliberately moved *server-side* in item 1 so `GMAPS_SERVER_KEY` never reaches a client. Decide which side this sits on rather than inheriting whichever is nearer to hand.
- **Coverage outside the US.** The four field names are US-shaped. A provider returning a structured result for an address that does not decompose that way should degrade to filling the line and leaving the rest, not to filling them wrongly.

**Touches.** `src/routes/profile.tsx`, `public/js/profile.js`, `src/routes/routing.ts` (the existing geocode proxy), `style/_forms.scss`.

**Status.** planned—raised 2026-08-15. Related to item 6 (saved places), which will want the same picker when a rider adds a place.

### 20. Theme selection: default, high contrast, colorblind

**Goal.** A section on the settings page letting a rider choose the site's colors—**default**, **high contrast**, or **colorblind**—as three radio options. This is the first real content `/settings` gets; it currently says "Not much to set yet."

**Work.**

- [ ] Three named themes behind a rider preference, persisted to the account and applied server-side on render so there is no flash of the wrong theme.
- [ ] **Default** is the road-sign palette as it stands, including the ink pairing—which field takes the white legend and which takes the black—recorded in `style/_tokens.scss`.
- [ ] **High contrast** raises every foreground/background pair well past 4.5:1, including the pairs that only just clear it today and the ones that deliberately do not because they are decoration rather than text.
- [ ] **Colorblind** addresses the collisions the palette has by construction. `$stop` and `$go` are a red/green pair and converge under deuteranopia and protanopia; `$yield` and `$construction` are adjacent ambers. The existing note under the `/import` filename fields—that color is never the only cue—becomes a rule the whole app has to hold to, not a line in one comment.
- [ ] Audit where color is currently the *only* signal and give each a second cue (shape, icon, label, weight) before the colorblind theme claims to work. A theme that only shifts hues does not fix a signal that was carrying meaning alone.

**Mechanism—decided 2026-08-15: Sass generates, custom properties carry, `data-theme` switches.**

The obstacle is that several tokens are *derived* rather than authored—`$pending` is `color.adjust($yield, -20%)`, `$label` is `-22%`—and Sass runs at build time, so it cannot recompute them when a custom property changes at runtime. Three ways out, and the third is the one to take:

1. **Author every derived value per theme.** Three themes times every derived token, maintained by hand. It throws away the property the palette was just given—one source per hue—and guarantees drift the first time a base color moves.
2. **Move the derivations to `color-mix()` in CSS.** Genuinely runtime-derivable and well enough supported. But it relocates color arithmetic out of the one file that documents it, and the contrast figures the palette is built on stop being checkable in the place the values live.
3. **Keep the derivations in Sass and loop over a theme map.** A `$themes` map holds only the *authored* palette per theme; an `@each` emits one `:root[data-theme="…"]` block per entry, running the same `color.adjust` expressions against that theme's own base colors. The formula is written once and applied three times. Adding a fourth theme is a map entry, not an edit in N places. No runtime color math, no browser-support question, and the derived relationships stay honest per theme—high contrast's amber darkens by its own amount from its own base.

**The real migration cost is not the tokens, it is the 46 inline derivations.** `color.adjust($gpx, -8%)` and friends appear 46 times across the partials, in rules rather than in `_tokens.scss`—hover states, borders, tints. Every one of them reads a Sass variable that will no longer hold the live value once a theme can change it, and `color.adjust()` cannot operate on a `var()`. Each has to become a token emitted per theme. That is the bulk of the work and it should be sized before anything is drawn.

**Work, in order.**

- [ ] Promote all 46 inline derivations to named tokens. No behavior change, and it can land on its own well before any theme exists—which is the point of doing it first.
- [ ] Restructure `_tokens.scss` around a `$themes` map with one entry, `default`, emitting today's values as custom properties. Still no behavior change; the compiled output should be equivalent.
- [ ] Add `high-contrast` and `colorblind` as further map entries.
- [ ] Wire the preference and the `data-theme` attribute.

**Open questions.**

- **Does it interact with `prefers-contrast` / `prefers-color-scheme`?** The OS already reports both. Whether the setting overrides the OS, defers to it, or offers "system" as a fourth option is undecided—and note the emails have their own dark palette already, in `src/emails/theme.ts`, which no site-level setting can reach.
- **Dark mode is not on this list, and someone will ask.** These three are about legibility, not preference. Whether a dark theme joins them is a separate question with a much larger surface—the splash page is photo-backed and the map has its own styling.

**Touches.** `src/routes/settings.tsx`, `src/db/schema.ts` (the preference), `src/views/layout.tsx` (applying it at render), `style/_tokens.scss` and every partial that reads a token, `docs/main-menu.md`.

**Status.** planned—raised 2026-08-15. Overlaps the accessibility pass in item 12; this is the color half of it, and item 12's line should be read as the keyboard/focus/ARIA half once this exists.

<!--| PAGE-BREAK -->

## Idea backlog (unscheduled)

Not yet shaped into milestones—raw material for future issues. Grouped by theme.

**Planning power.**

- Elevation and grade profile per day, drawn under the timeline.
- Weather forecast along the route keyed to each leg's date-time—the timeline makes this genuinely useful, not a gimmick.
- [x] Print-friendly roadbook for riders who tape it to the tank—`/m/:slug/roadbook`. **Stop-by-stop, not turn-by-turn:** `route_legs` holds geometry, distance and duration and nothing else, maneuvers are a separate Directions field priced per call, and they would be blank for every imported ride anyway. What it does print is the part that stays true when a road closes: stops in order, leg and cumulative miles, **miles since fuel**, planned dwell, and an estimated clock when the day has a start time.
- [x] Reverse a day; duplicate a ride as a template. **Both shipped** (#26). Reverse is the ⇄ in the builder's day head—`reverseDay()` in `public/js/builder.js` re-requests every leg from the router rather than flipping geometry in place, because a leg's geometry and its shaping points are both directional. Duplicate shipped as "Clone this ride" with item 10.
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

- Autosave and undo in the builder. Undo shipped; autosave-to-server is item 16.
- Drag-to-reorder stops ([#39](https://github.com/feralcreative/routeloop/issues/39))—the affordance is decided, a textured drag bar replacing the arrows. See item 16.
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

One wording correction that falls out of this: the vision above says RouteLoop is "not real-time navigation, and never will be." **Never** overstates it. The accurate claim is that it does not navigate today, and that making the app you already use follow your plan is the better problem to solve first.

## Good first contributions

Well-scoped, low-context tasks a new contributor can land without holding the whole app in their head. These carry the _good first issue_ label on GitHub.

- **[#35](https://github.com/feralcreative/routeloop/issues/35) Round-trip fidelity tests per format.** Pure test work in `test/`, no app context needed—assert what each format can and cannot carry, so import → export never silently drops a stop.
- **[#40](https://github.com/feralcreative/routeloop/issues/40) Keyboard shortcuts for the builder.** Contained to `public/js/builder.js` and its key handling.
- **[#51](https://github.com/feralcreative/routeloop/issues/51) Layer stacking with per-layer opacity.** A self-contained map-engine feature with a clear reference implementation in Gaia GPS.

The three tasks previously listed here—privacy and terms pages, the day-slider tick labels, and the `profile.js` geocoding proxy—all shipped, as #18, #19 and #20.

## Working in this repo

Setup, the gotchas that will bite you, branch and commit conventions, and how to open a pull request all live in **[CONTRIBUTING.md](../CONTRIBUTING.md)**. It is the canonical copy—GitHub links it from the issue and pull-request composer, which is why it is there rather than here.

Two things to read first either way: [AGENTS.md](../AGENTS.md) for the operating rules, and [STATUS.md](STATUS.md) for where things actually stand.
