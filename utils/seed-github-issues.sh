#!/usr/bin/env bash
#
# Seed GitHub issues for the TankBag roadmap (docs/ROADMAP.md).
#
# Creates one tracking issue per roadmap item, a set of "good first
# contributions", and the unscheduled idea backlog — each tagged with area:*
# labels so issues that touch the same code are visible at a glance.
#
# The good-first set below predates several of them being built: the roles.ts
# unit tests and KMZ import both shipped, so those two are skipped on a fresh
# run against an empty repo and their bodies no longer describe reality.
# docs/ROADMAP.md's "Good first contributions" section is the current list.
# Idempotent:
# it skips any issue whose exact title already exists, so a re-run never
# duplicates (it does NOT retro-add labels to issues that already exist).
#
# Review it, then:
#   ./utils/seed-github-issues.sh --dry-run   # print what it would do
#   ./utils/seed-github-issues.sh             # actually create the issues
#
# Requires: gh (authenticated). REPO is pinned below.

set -uo pipefail

REPO="feralcreative/tankbag"
DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

# Labels these issues need. enhancement / good first issue / help wanted /
# documentation are GitHub defaults; the rest are created here (idempotent).
# The area:* labels share one color so they read as a group in the list.
if ! $DRY_RUN; then
  gh label create roadmap --color 1d76db --description "A milestone from docs/ROADMAP.md" --force >/dev/null 2>&1 || true
  gh label create idea --color fef2c0 --description "Unscheduled backlog idea (docs/ROADMAP.md)" --force >/dev/null 2>&1 || true
  for a in \
    "area:schema|src/db/schema.ts (push-only — serialize schema changes)" \
    "area:builder|public/js/builder.js" \
    "area:viewer|public/js/viewer.js" \
    "area:map-engine|map-common.js / expand.ts / gmaps-links.ts (load-bearing google.maps)" \
    "area:import-export|kml.ts / export.ts / maps.ts" \
    "area:ops|config, deploy, CI, infra"; do
    name="${a%%|*}"; desc="${a#*|}"
    gh label create "$name" --color c5def5 --description "$desc" --force >/dev/null 2>&1 || true
  done
fi

create_issue() {
  local title="$1" labels="$2" body="$3"
  if gh issue list --repo "$REPO" --state all --limit 300 \
       --search "in:title \"$title\"" --json title -q '.[].title' 2>/dev/null \
       | grep -qxF "$title"; then
    echo "skip (exists): $title"
    return
  fi
  if $DRY_RUN; then
    echo "would create: [$labels] $title"
    return
  fi
  if gh issue create --repo "$REPO" --title "$title" --label "$labels" --body "$body" >/dev/null; then
    echo "created: $title"
  else
    echo "FAILED:  $title"
  fi
}

# --- Roadmap items (one tracking issue each) --------------------------------

read -r -d '' B <<'EOF' || true
**Goal.** Retire the last Mapbox dependency and the redundant Cloudflare Access policy so the stack is single-vendor and the dead config is gone.

- [ ] Remove the Cloudflare Access policy at the edge (the app already ignores its header).
- [ ] Move `profile.js` geocoding to a server proxy alongside `POST /api/route`.
- [ ] Teach the current engine to draw an imported ride's single-leg track, then delete `public/js/main.js` and collapse the two viewer shells.
- [ ] Drop `MAPBOX_TOKEN`, `MAPBOX_GL_VERSION`, `MAPBOX_CSS_LINK` and their config/deploy references.
- [ ] Regenerate favicons and the social image from the current TankBag mark.
- [ ] Add privacy-policy and terms pages.
- [ ] Set per-API daily quota caps on the GCP project.

_Detail: docs/ROADMAP.md item 1._

**Areas:** map-engine, viewer, ops — shares code with other issues carrying those labels; check them (and whether one is assigned or In Progress) before starting. `public/js/map-common.js` is load-bearing (only file touching `google.maps`) — coordinate tightly.
EOF
create_issue "Finish the Google migration and clear debt" "roadmap,enhancement,area:map-engine,area:viewer,area:ops" "$B"

read -r -d '' B <<'EOF' || true
**Goal.** Ship the signature feature: a date-time slider that focuses a trip in time.

- [ ] A date-time UI in the builder that writes `routes.start_at` / `routes.end_at` (columns exist; nothing sets them yet).
- [ ] A timeline slider across viewer and builder that maps a moment to the active leg, dimming the rest.
- [ ] Defaults: derive a route's duration from its legs; seed each day's start from the previous day's end.

_Detail: docs/ROADMAP.md item 2._

**Areas:** builder, viewer, map-engine — shares code with other issues carrying those labels; check them before starting. `map-common.js` is load-bearing. (Reads `routes.start_at`/`end_at` but does not change the schema.)
EOF
create_issue "Trip timeline: date-times and the timeline slider" "roadmap,enhancement,area:builder,area:viewer,area:map-engine" "$B"

read -r -d '' B <<'EOF' || true
**Goal.** Let riders pull a route into shape by dragging the line onto the roads they mean, and export a finished ride to open formats.

- [ ] Drag the route line onto a different road to drop a shaping waypoint and re-snap the leg through it.
- [ ] Persist pulled points into `route_legs.via_points`; re-request only the affected leg on drop.
- [ ] Via-points draggable/removable, rendered distinctly from stops and POIs.
- [ ] `src/maps/export.ts` — build KML and GPX from stored rows.
- [ ] Source-aware `/kml` and `/gpx` endpoints (native from DB, imported from original file).

_Detail: docs/ROADMAP.md item 3._

**Areas:** builder, map-engine, import-export — shares code with other issues carrying those labels; check them before starting. Dragging the route line is `map-common.js` work (load-bearing). `export.ts` is shared with item 8.
EOF
create_issue "Route shaping and server-side export" "roadmap,enhancement,area:builder,area:map-engine,area:import-export" "$B"

read -r -d '' B <<'EOF' || true
**Goal.** Hand a rider the exact route they planned, ready to navigate in Google Maps, instead of stops the nav app re-routes between.

Expand:
- [ ] Densify a route by sampling shaping waypoints along `route_legs.geometry` so a hand-off follows the planned roads.
- [ ] Rider-controllable density (target count/spacing); e.g. 10–20 points expanded to 30+.
- [ ] Hand-off-time transform over existing geometry, not new stored state.

Batched Google Maps links:
- [ ] Serialize ordered points (post-Expand) into Google Maps directions URLs.
- [ ] Every point is a plain waypoint (kind/duration dropped for Google; preserved only in file exports).
- [ ] Batch at <=10 points per URL; never batch across a route boundary.
- [ ] Share surface listing links per route/batch ("Day 2 - part 1 of 3").
- [ ] Decide batch continuity (clean partition vs one-point overlap).

_Detail: docs/ROADMAP.md item 4._

**Areas:** map-engine, viewer — shares code with other issues carrying those labels; check them before starting. Mostly new files (`expand.ts`, `gmaps-links.ts`), but reads `route_legs.geometry` and adds share UI to the viewer.
EOF
create_issue "Navigation hand-off: Expand and batched Google Maps links" "roadmap,enhancement,area:map-engine,area:viewer" "$B"

read -r -d '' B <<'EOF' || true
**Goal.** A rider's reusable library of locations (home, favorite fuel stops, meet points) droppable into any ride.

- [ ] Schema for places and place groups.
- [ ] CRUD endpoints and a marker-group primitive in the map engine.
- [ ] Builder integration: search or pick from saved places when adding a stop.

_Detail: docs/ROADMAP.md item 5._

**Areas:** schema, builder, map-engine — shares code with other issues carrying those labels; check them before starting. Schema is push-only, so serialize with other `area:schema` issues. Also touches `profile.ts` (shared with item 7).
EOF
create_issue "Saved places" "roadmap,enhancement,area:schema,area:builder,area:map-engine" "$B"

read -r -d '' B <<'EOF' || true
**Goal.** Model bikes and riders so the app can reason about range and comfort.

- [ ] Bike profiles: tank / fuel economy (or battery / consumption), per-rider comfort limits.
- [ ] Fuel/charge range rings and low-range warnings between stops.
- [ ] Suggest rest cadence from rider limits and leg durations.

_Detail: docs/ROADMAP.md item 6._

**Areas:** schema, builder — shares code with other issues carrying those labels; check them before starting. Schema is push-only, so serialize with other `area:schema` issues.
EOF
create_issue "Bikes and range planning" "roadmap,enhancement,area:schema,area:builder" "$B"

read -r -d '' B <<'EOF' || true
**Goal.** Turn a solo planning tool into a group one.

- [ ] Rider list / roster (`users.can_manage_riders` already exists).
- [ ] Invite riders to a ride; per-ride RSVP.
- [ ] Surface cost splitting from the payment handles on the profile.
- [ ] Rate-limit rider lookup by email/phone (user-enumeration surface).

_Detail: docs/ROADMAP.md item 7._

**Areas:** schema — shares code with other issues carrying that label; check them before starting. Schema is push-only, so serialize with other `area:schema` issues. Also touches `admin.ts` and `profile.ts` (the latter shared with item 5).
EOF
create_issue "Riders and group rides" "roadmap,enhancement,area:schema" "$B"

read -r -d '' B <<'EOF' || true
**Goal.** Handle as many open route/map formats as possible, in both directions.

- [ ] Native TankBag JSON export/import (lossless; the save=load payload already exists).
- [ ] Import KMZ (zipped KML) and CSV.
- [ ] Import/export GeoJSON.
- [ ] Export GPX flavors that load cleanly on Garmin/TomTom (shaping points, not stops).
- [ ] Keep every format inside the existing XXE-safe, quota-enforced pipeline.

_Detail: docs/ROADMAP.md item 8._

**Areas:** import-export — shares code with other issues carrying that label; check them before starting. `export.ts`/`maps.ts` are shared with item 3; the payload work in `rides.ts` is shared with items 2 and 10.
EOF
create_issue "Import and export breadth" "roadmap,enhancement,area:import-export" "$B"

read -r -d '' B <<'EOF' || true
**Goal.** Make good public rides findable and give riders a public identity.

- [ ] Public profile pages at `/@username` (usernames already reserved and unique).
- [ ] A browsable gallery of public rides (recency + `rides.view_count`).
- [ ] "Clone this ride" to seed a new plan from a public one.

_Detail: docs/ROADMAP.md item 9._

**Areas:** schema — shares code with other issues carrying that label; check them before starting. Schema is push-only, so serialize with other `area:schema` issues. Also touches `views/layout.ts`.
EOF
create_issue "Discovery and public profiles" "roadmap,enhancement,area:schema" "$B"

read -r -d '' B <<'EOF' || true
**Goal.** Let a stop hold everything a rider needs on arrival — reservations, codes, check-in/out, links, notes.

- [ ] Structured detail fields: confirmation number, check-in/out date-time, phone, address, URLs.
- [ ] Freeform notes field.
- [ ] Surface fields by role (hotel/camp vs food, etc.).
- [ ] Builder + viewer UI.
- [ ] Privacy boundary: gate codes / confirmations must NOT leak via `ride.json` on a public share — model like `user_profiles` split from `users`; likely a `point_details` table.

_Detail: docs/ROADMAP.md item 10._

**Areas:** schema, builder, viewer, import-export — the broadest surface here; shares code with many other issues, check them before starting. Schema is push-only, so serialize with other `area:schema` issues.
EOF
create_issue "Rich stop details" "roadmap,enhancement,area:schema,area:builder,area:viewer,area:import-export" "$B"

read -r -d '' B <<'EOF' || true
**Goal.** The groundwork that keeps a growing, multi-contributor codebase honest.

- [ ] Automated test suite (roles.ts, kml.ts, leg-distance clamp; ride save/load; viewer smoke).
- [ ] CI on GitHub Actions: typecheck, SCSS build, tests on every PR.
- [ ] Error tracking / structured request logging.
- [ ] Rate limiting on public and auth endpoints.
- [ ] Accessibility pass and i18n groundwork.
- [ ] Installable PWA with offline view of a saved ride.

_Detail: docs/ROADMAP.md item 11._

**Areas:** ops — mostly new files (`test/`, `.github/workflows/`) and cross-cutting, so low direct-collision risk, but coordinate the config/CI changes with item 1.
EOF
create_issue "Quality and platform" "roadmap,enhancement,area:ops" "$B"

# --- Good first contributions (grabbable, small) ----------------------------

create_issue "Regenerate favicons and social image from the TankBag mark" \
  "good first issue,help wanted" \
  "Favicons and the social preview still carry the old routeloop mark. Regenerate from the current TankBag artwork. Pure asset work, no app logic. Part of docs/ROADMAP.md item 1."

create_issue "Add privacy policy and terms pages" \
  "good first issue,documentation" \
  "Two static pages through the existing \`page()\` shell. Required to publish the OAuth consent screen past 100 users. Part of docs/ROADMAP.md item 1."

create_issue "Align day-slider tick labels to thumb positions" \
  "good first issue,area:builder" \
  "The builder's day-slider tick labels are evenly spaced rather than aligned to the thumb. Cosmetic; see docs/STATUS.md. **Area:** builder — coordinate with any In-Progress \`area:builder\` issue. Part of docs/ROADMAP.md item 2."

create_issue "Move profile.js geocoding to a server proxy" \
  "good first issue" \
  "The last Mapbox call in the app and the only reason MAPBOX_TOKEN must be set. A self-contained endpoint modeled on \`POST /api/route\` plus a small client change. Part of docs/ROADMAP.md item 1."

create_issue "First unit tests for src/maps/roles.ts" \
  "good first issue" \
  "\`canonicalRole\`, \`parseRoleName\`, \`formatRoleName\` are pure and well-specified — the ideal place to stand up the test runner (there is none yet). Part of docs/ROADMAP.md item 11."

create_issue "KMZ import" \
  "good first issue,area:import-export" \
  "KMZ is a zipped KML: unzip, then hand the KML to the existing import pipeline unchanged. **Area:** import-export — coordinate with items 3, 8 and 10. Part of docs/ROADMAP.md item 8."

# --- Idea backlog (unscheduled) ---------------------------------------------

create_issue "Elevation and grade profile per route" \
  "idea,enhancement,area:viewer" \
  "From the idea backlog in docs/ROADMAP.md (Planning power). Draw an elevation and grade profile under the timeline. Unscheduled. Area: viewer."

create_issue "Weather forecast along the route, keyed to the timeline" \
  "idea,enhancement,area:viewer" \
  "From the idea backlog in docs/ROADMAP.md (Planning power). Show a forecast along the route keyed to each leg's date-time — the timeline makes this genuinely useful. Unscheduled. Area: viewer."

create_issue "Print-friendly roadbook / cue sheet export" \
  "idea,enhancement" \
  "From the idea backlog in docs/ROADMAP.md (Planning power). A printable turn-by-turn cue sheet / roadbook for riders who tape it to the tank. Unscheduled."

create_issue "Reverse a route and duplicate a ride as a template" \
  "idea,enhancement,area:builder" \
  "From the idea backlog in docs/ROADMAP.md (Planning power). Reverse a route; duplicate a ride as a starting template. Unscheduled. Area: builder."

create_issue "Distance and moving-time estimates with rest cadence" \
  "idea,enhancement,area:builder" \
  "From the idea backlog in docs/ROADMAP.md (Planning power). Configurable rest cadence feeding distance and moving-time estimates. Unscheduled. Area: builder."

create_issue "Twistiness / curvature scoring and a prefer-the-fun-road routing bias" \
  "idea,enhancement" \
  "From the idea backlog in docs/ROADMAP.md (Motorcycle-specific). Score road curvature and bias routing toward the fun road — the feature that would beat MyRouteApp for riders who care about the road, not the ETA. Unscheduled."

create_issue "Avoid-highways / prefer-scenic routing options" \
  "idea,enhancement" \
  "From the idea backlog in docs/ROADMAP.md (Motorcycle-specific). Routing options to avoid highways or prefer scenic roads. Unscheduled."

create_issue "Per-leg surface preference and off-road mode" \
  "idea,enhancement,area:builder" \
  "From the idea backlog in docs/ROADMAP.md (Motorcycle-specific). Per-leg paved/unpaved preference and an off-road mode. Unscheduled. Area: builder."

create_issue "EV charge-stop planning" \
  "idea,enhancement" \
  "From the idea backlog in docs/ROADMAP.md (Motorcycle-specific). The electric counterpart to fuel range — plan charge stops (pairs with Bikes and range planning, item 6). Unscheduled."

create_issue "Real-time or turn-based co-editing of a shared ride" \
  "idea,enhancement,area:builder" \
  "From the idea backlog in docs/ROADMAP.md (Social and collaboration). Let multiple riders edit one ride. Unscheduled. Area: builder (large)."

create_issue "Trip journal: photos and notes on stops" \
  "idea,enhancement" \
  "From the idea backlog in docs/ROADMAP.md (Social and collaboration). Attach photos and notes to stops (pairs with Rich stop details, item 10). Unscheduled."

create_issue "Follow other riders and a feed of public rides" \
  "idea,enhancement,area:schema" \
  "From the idea backlog in docs/ROADMAP.md (Social and collaboration). Follow riders; a feed of public rides (pairs with Discovery, item 9). Unscheduled. Area: schema."

create_issue "Round-trip fidelity tests per format" \
  "idea,enhancement,area:import-export" \
  "From the idea backlog in docs/ROADMAP.md (Data and formats). Tests that importing then exporting never silently loses a stop. Unscheduled. Area: import-export."

create_issue "Bulk import of a folder of files into one ride" \
  "idea,enhancement,area:import-export" \
  "From the idea backlog in docs/ROADMAP.md (Data and formats). Import a folder of files into a single ride. Unscheduled. Area: import-export."

create_issue "PostGIS for spatial queries (rides near me)" \
  "idea,enhancement,area:schema" \
  "From the idea backlog in docs/ROADMAP.md (Data and formats). Adopt PostGIS once discovery needs spatial queries like 'rides near me'. Unscheduled. Area: schema."

create_issue "Autosave and undo in the builder" \
  "idea,enhancement,area:builder" \
  "From the idea backlog in docs/ROADMAP.md (Platform and quality). Autosave and undo while building. Unscheduled. Area: builder."

create_issue "Drag-to-reorder stops" \
  "idea,enhancement,area:builder" \
  "From the idea backlog in docs/ROADMAP.md (Platform and quality). Reorder stops by dragging. Unscheduled. Area: builder."

create_issue "Keyboard shortcuts for the builder" \
  "idea,enhancement,area:builder" \
  "From the idea backlog in docs/ROADMAP.md (Platform and quality). Keyboard shortcuts in the builder. Unscheduled. Area: builder."

create_issue "Privacy-respecting usage analytics" \
  "idea,enhancement,area:ops" \
  "From the idea backlog in docs/ROADMAP.md (Platform and quality). Self-hosted analytics, no third-party trackers. Unscheduled. Area: ops."

echo "Done."
