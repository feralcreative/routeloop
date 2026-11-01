---
kind: app
checked: 2026-10-31
---

# Ready to ride: the pre-ride checklist

Run this whenever a rider asks "is this ready?", "check my ride", or anything like it, and before you call any plan you built finished. Work top to bottom: the first section is what strands riders, the last is polish. Never say a ride is ready because get_ride looks clean. A correct final answer is usually "here is what I checked and fixed, here is what you need to confirm, and here is what you need to look at on the map."

## Start with check_ride

Call check_ride first. It runs the route checks in code and returns them worst first, each with the route, the place, the number, and the fix, then the trip checks only the riders can confirm. It does not look at the weather or road reports: call get_conditions and get_road_reports per dated route for those. Then fix, and run it again. The checks it reports, by id:

- `fuel-dry`: the tank runs dry before the next fill (an E marker on the map). Fix with a fuel stop before that point; get_fuel_plan says between which points, and find_along_route or search_places finds one.
- `fuel-unreachable-stop`: a planned fuel stop is past where the tank first runs dry. Add a fill before it.
- `fuel-unknown`: nobody has a range on file, so nothing checks fuel. Ask for the shortest tank, or have riders add bikes in the Paddock and pick them on the Riders tab.
- `leg-undrawn`: a leg the router never drew, a straight line on the map; everything after it is a guess (section 4).
- `route-empty`: a route with fewer than two points.
- `no-departure`: no departure time, so nothing can be checked against the clock (section 6).
- `after-stop-by`: the route arrives after the ride's stop-by time (section 7).
- `past-midnight`: the route arrives after midnight.
- `long-day`: more riding hours than the rule of thumb for the vehicle (8 for a motorcycle); ask how long a day this group likes (section 9).
- `alternates`: alternates are in play; confirm the active one is the one they mean to ride.

The sections below explain each area in depth and cover what check_ride cannot see.

## Before you start

- Call get_ride. Each route line reads `Route N [uid] "Title" departs YYYY-MM-DD HH:MM · X mi · Yh riding` (or km: the first line of get_ride says which unit every distance is in, and a bike's range must be converted to match before you compare them), or `(no departure time)` in place of the departure, then optionally `(part estimated)`, `alternate group N, active` or `alternate group N, not chosen`, and `ridden by GROUP`. Each point line reads `i. [uid] STOP|poi categories "Name", address (lat, lng) at X mi ETA YYYY-MM-DD HH:MM dwell Nm`, with `note:` lines under it.
- "at X mi" is miles from the start of that route. ETA appears only on a route with a departure. The last point's ETA is the arrival.
- get_ride's ETAs are the builder's own: dwell at every point counted, the first included, and about 45 mph over the straight-line distance for a leg the router never drew, with every distance and ETA past such a leg marked `(est.)`.
- Do not add route lines together for a ride total. A route marked `not chosen` is a losing alternate and does not count.
- In the builder, your edits are a proposal until the rider presses Apply, and Apply is refused if the rider edited meanwhile. Over MCP your edits are a pending proposal until you call apply_changes after the rider agrees, and it is refused if the ride changed meanwhile. Re-read with get_ride after edits before judging.

## 1. Fuel: will anyone run dry?

The app plans fuel around the shortest usable range among the riders counted on the ride, from bikes in each rider's Paddock. The tank carries from one route to the next: a route starts with whatever the group had left at the end of the route before it in that group's sequence, unless it starts at a gas or charge stop. A point refuels only if it carries the gas category (or charge, for an electric plan). get_fuel_plan and get_rider_context tell you the range and whose bike sets it.

**What the rider sees.** A dotted range ring around the timeline's position dot: green through the first half of the tank, orange past half, red from three quarters. A red disc with a white E on the road wherever the tank would run dry, one per tankful. The road drawn solid red with white dashes from the first E to the next fuel stop, or to the end of the route. An amber "out of range" tag on the first row past the tank, with "Past Name's Bike (N mi). Add a fuel stop before here." The Riders tab says "Plan fuel around N miles—Name's Bike." The map shows the fuel overlay for one route at a time, the one being edited; the "out of range" tags show in every route's list at once.

**Detect.** check_ride reports every E as `fuel-dry`; get_fuel_plan gives each route's starting tank, every E and where it falls, and the longest stretch between fills. If nobody has a range on file there is no fuel warning anywhere: silence means no data, not enough fuel. If some riders have none, the real limit may be shorter. The ring turns orange past half a tank and red past three quarters.

**Fix.** For each over-long gap, search_places for "gas station" (or "EV charging station") with near_point_uid set to the last point before the gap gets past about 75 percent of R (you have no road geometry, only the points, so search near a point and check each result's distance along the route by where it falls between points), then add_stop after the right point with categories ["gas"] (or ["charge"]) and a dwell of 10 to 15 minutes. Prefer a station on the road itself. Re-check: the "out of range" tag only flags the first breach, so a fix can reveal the next one. If a place called "Chevron" is on the route without the gas category, set_categories with its existing categories plus "gas" (the call replaces the whole list); the name alone refuels nothing. Without a known range, list the longest gaps between gas stops per route and ask the rider to check them against their tank, and to look for red E discs on each route.

## 2. Fuel: right kind, and across routes

**Fuel kind.** The refuel category follows the ride's power setting in the ride header, then the binding bike's fuel type, then the rider's default. Electric means charge, gas means gas. A pedal ride has no fuel at all and the map draws no fuel overlay: plan water and food instead. When the ride's power is left at the default, a mixed group follows the bike with the shortest range. Detect: ask what the group rides if the categories look wrong for it (gas stops on an electric ride). Fix: set_categories to charge or gas to match.

**Across routes.** The tank carries over: a hotel without a pump refills nobody, and a shared route starts as low as the lowest tank any group arrives with. An electric ride whose overnight stop has no charger starts the next morning where it ended. Fix: a gas or charge stop near the end of the first route, at the hotel, or early on the next.

## 3. Closed roads

Riders drop road reports on a route: Closed (red diamond with ×), Rough or unpaved, and Hazard (amber diamonds with !). A report counts on any route within 75 m of it and is listed in the panel under "Road reports". A closure lasts 60 days, a hazard 21, a surface report 180. A seasonal closure never expires and is judged against each route's dates: if any date the route spans falls in the season it reads "Closed Nov 1 – May 31, which includes your date"; if the route is undated, "Closed every year Nov 1 – May 31"; if dated outside the season, the pin goes gray and reads "not on your dates".

**Detect.** get_road_reports lists them, with each seasonal closure's verdict for the route's dates; they are rider reports, unverified. An undated route cannot be judged against a seasonal closure, so set departures first (check 6). No report is not evidence a road is open: reports expire, and the app has no official closure feed.

**Fix.** For a live closure on the date: move the route off that road (replace_stop or add_stop a point on another road, or have the rider drag the line onto another road), or change the date. The app never reroutes around a report. Tell the rider to verify with the road authority.

## 4. Roads never drawn

A leg the router never answered stays a straight line between its two points. Its mileage is the straight-line distance, shorter than any road, and its time is a guess. Every fuel and time figure built on it is optimistic.

**What the rider sees.** A dead-straight line across the map, and a toast such as "Could not route that leg—drawn straight, its time is estimated" or "No road route for that leg—drawn straight, its time is estimated".

**Detect.** `(part estimated: N legs not drawn yet)` on a route line in get_ride. Every distance and ETA past the first such leg carries `(est.)`, so the first point marked `(est.)` is the far end of the first undrawn leg. An undrawn leg's time is its straight-line distance at about 45 mph.

**Fix.** Your edit tools draw the road for every leg they touch; when they cannot (the routing budget is spent, or the router failed), the edit is refused and nothing changes, so try again later rather than assuming it landed. You cannot re-route an existing leg on purpose, and you never move a point to force one: ask the rider to drag the point slightly in the builder, which redraws its legs. If a leg stays straight after that, the point is probably unreachable by road (an island, a trail, a building interior): search_places for the place and replace_stop with a result on a road.

## 5. Wrong road, broken links between routes

**Shaping points and preferences.** You cannot see shaping points or the Avoid (highways, tolls, ferries) and twisty-road settings. A shaping point snaps onto whatever road the router chose, which may not be the one the rider meant. Ask the rider to look at any leg they shaped by hand. Your own add_stop between two points, replace_stop, move_stop, and remove_stop at a route's end discard the shaping points on the legs they rebuild; say so when the rider has shaped those legs.

**Routes that do not join.** Work per group, never down the whole list: a group rides its own routes plus every route tagged with no group, in list order, and several groups' routes can run at the same time. Within one group's sequence, compare the last point of each route with the first point of the next. A gap of more than a few hundred meters is a hole in the ride unless the rider means it (a ferry, a trailer). Fix: replace_stop or add_stop so they match.

**Alternates that end elsewhere.** Members of one alternate group should start and end at the same places; the app warns once with a toast when they are grouped and then allows it. Compare first and last points across `alternate group N` routes.

## 6. Departures

Every counted route needs a departure. Without one there are no ETAs, no timeline, no stop-by check, no weather, and no seasonal-closure verdict.

**Detect.** `(no departure time)` on a route line. Then check order within each group's sequence (its own routes plus the untagged ones): each route should depart after the previous one in that sequence arrives. Routes belonging to different groups may run at the same time, and two routes on the same day are normal, so never flag those.

**Fix.** Ask the date and time, then set_departure with the local time where that route starts, `YYYY-MM-DDTHH:MM`. Never convert time zones: 09:00 means nine o'clock where the bike is, wherever the rider is planning from.

## 7. Arriving past the stop-by time

"Start looking for a bed at" is a ride-wide time in the ride header. When a dated route is still riding at that clock time, the route list shows an amber band on the row before that moment, reading for example "4:00 PM · 142 mi in · 3h 20m still to go" with a "Find somewhere to stay" button, and the map shows a blue bed disc where the group will be then.

**Detect.** You cannot read the setting. Ask the rider for it, or whether any route shows the amber band. With the time T: a route whose last ETA is later than T on its own date (and that departed before T) shows the band. An undated route never shows it, which is not a pass.

**Fix.** Leave earlier (set_departure), or end the day at lodging: search_places for "hotel" near the point before the band, add_stop with ["hotel"], then tell the rider to press "Sleeping here? End the route" on that row (or "End the route here" in its row menu), which splits the route there; you have no split tool. Or ask whether T should move. The "Find somewhere to stay" button on the band searches lodging within 45 minutes of riding either side of that moment.

## 8. Arriving after dark

Nothing in Routeloop computes sunset. If the rider cares, estimate sunset yourself from the last point's coordinates and the route's date, in local time where the route ends, compare it with the last ETA, and say plainly it is your estimate, good to within about 15 minutes. Flag arrivals within 30 minutes of sunset or after it. Fix as for check 7.

## 9. Day length, stops, and weather

**Day length.** Compare each route's riding time and its last ETA minus departure against what the rider says they like (see the pacing topic). Long routes with no food, break, or coffee stops are a problem even when fuel works. Fix: add_stop with categories and set_dwell.

**Dwell on the final stop.** A large dwell on a route's last point (an overnight hotel) lengthens the route's end time, can put the stop-by band on the hotel itself, and pushes a new route's default start later. Overnights belong between routes, not in the finish's dwell. Fix: set_dwell to null on the finish.

**Weather and elevation.** The conditions strip above the timeline shows elevation and grade, and the timeline readout gives the forecast at the scrubbed hour ("Rain, 54°F, 40% rain, wind 18 mph"). You cannot read it. It is blank for an undated route, a date in the past or more than 16 days out, before the latest edit has saved, or when the weather service is down; blank is not good weather. Rain prints only at 10 percent or more and wind only at 25 km/h (about 16 mph) or more. The app never warns about cold, heat, storms, or snow. Ask the rider to scrub through each route and report what it says, and see the weather-and-seasons topic.

## 10. Group logistics

You see only `ridden by GROUP` tags and alternate status. Everything else is on the Groups and Riders tabs (see the groups-and-riders topic).

- **Alternates.** For each `alternate group N`, confirm the `active` route is the one the group chose. Votes have no quorum, a tie changes nothing, and a vote with no deadline never resolves. Only the rider can switch the active route ("Ride this one instead" in the route menu).
- **Groups converge.** If routes carry `ridden by` tags, at least one untagged route should follow them, where everyone rides together. The app shows no warning when groups never meet. Check each group's first route starts where that group sets off and each meeting point has a fuel stop.
- **Roster and bikes.** Ask whether every rider has been sent the ride, has answered, and has a bike with a range on file; riders without one make the fuel plan optimistic.

## 11. Polish

- `"Unnamed"` points: give them a name with replace_stop after search_places, or ask what they are.
- Two consecutive points at the same coordinates with 0.0 mi between them: usually a stray duplicate; remove_stop one unless the rider meant it.
- Stops that should be stops: hotels and camps at the end of a route tagged hotel or camp; fuel stops tagged gas or charge; a ride-past point left as `poi` is fine.
- Route titles: `"Untitled"` routes get rename_route.
- Privacy: you cannot see visibility. If the first point is the rider's home and the ride will be shared, mention that a public starting point can stand in for it.
- On the road: suggest Keep on this phone and a GPX download before leaving signal (see the riding-it topic).

## Reporting the result

List problems worst first. For each: what is wrong, where (route and point names), and the fix you made or propose. Then list, by name, every check you could not run and the exact thing for the rider to look at: "Open each route and look for red E discs and a red-and-white dashed road", "Read the Road reports list", "Check for an amber band in the route list", "Scrub the timeline for the forecast". Say "ready to ride" only when every check you can run passes and the rider has confirmed the ones you cannot.
