---
kind: app
checked: 2026-10-31
---

# Map and timeline warnings

Everything the map, the route list, and the timeline show a rider about whether a plan works. You cannot see any of it: get_ride prints none of these overlays. When a rider describes one, use this to explain it; when you need one checked, name the exact symbol and ask the rider to look. The order of checks is in the ready-to-ride topic.

Two rules first. Warnings advise; nothing here blocks a save or reroutes the ride. And no data draws nothing: no range on file, no departure, or no forecast means no warning, never "all clear".

## The fuel overlay

### Whose range

The plan is built around the shortest usable range among the riders counted on the ride. In the builder that is everyone on the roster who has not declined, including riders not yet sent the invitation; each rider's bike is the one picked on the roster, else their default bike. Riders with no range on file are skipped, which can make the plan optimistic. The Riders tab says "Plan fuel around N miles—Name's Bike.", adds "N riders have no range on file, so this could still be optimistic." when some are missing, and says "No ranges on file, so there is nothing to plan fuel stops around." when nobody has one. Ranges come from bikes in each rider's Paddock, rounded down to whole miles.

On the shared ride page, only riders on the roster get the overlay. Someone opening a public link sees no ring and no E markers, exactly as if no range were on file.

### What refuels

A point refuels only if its categories include the refuel category: Charge when the ride's power is electric, Gas otherwise. The ride's power setting decides first, then the fuel type of the bike with the shortest range, then the rider's default. Pedal rides should have no fuel at all, but the app currently treats them as Gas and may draw fuel warnings on a bicycle ride (a known bug); ignore them. A point named "Shell" without the Gas category refuels nothing; a Gas stop does nothing for an electric plan.

Each route starts on a full tank. Fuel does not carry from one route to the next, so a route that ends nearly empty and a next route ridden straight on from it both look fine. Arriving at a fuel stop counts as filled.

### The range ring

A dotted circle around the timeline's position dot. Its edge passes through the place on the road where the current tank ends, or through the end of the route if the tank lasts that long. It shrinks as the dot moves along and resets at each fuel stop.

- **Green**: half the tank or less used since the last fill.
- **Orange**: more than half, less than three quarters.
- **Red**: three quarters or more.

Exactly half is green; exactly three quarters is red. A ring that reaches the end of the route with no E inside it means that route is covered. Past the point where the tank runs out there is no ring at all.

### E markers

A red disc with a white E (hover reads "Empty") on the road wherever the tank would run dry. There is one per tankful, not only the first: from the last fill, the walk rides to every fuel stop within range and refills there; when the next fuel stop is out of reach, the tank runs dry one full range past the last fill, an E goes there, and the walk carries on as if the group refueled at the E. So a 700-mile stretch with no fuel stops and a 110-mile range shows six E markers. A tank that runs out exactly at the end of the route still shows an E at the end. An E is where fuel runs out, not where fuel is.

E markers behind the position dot stay on the map; they describe the route, not the moment.

### The dry stretch

The road drawn solid red with white dashes over it, like hazard tape, from the first E to the next fuel stop, or to the end of the route if there is none after it. It is the part the group cannot ride on the fuel it has.

### The Range button

"Range" in the timeline bar turns the whole fuel overlay (ring, E markers, dry stretch) on and off. It is on by default, applies to the whole ride, and is forgotten when the page closes. It is hidden when no range is on file. The position dot stays either way. A rider who sees no fuel warnings may have Range off.

### One route at a time

The builder draws the fuel overlay for one route: the one the slider sits on, or, before the slider is touched, the route being edited, measured from its start. Checking a whole ride means clicking into each route. The ring, E markers, and stretch all measure along drawn roads; a straight placeholder leg (below) is shorter than the road, so fuel looks better than it is.

### In the route list

Each row after the first shows its arrival time, "X mi in", and "Y mi on this tank" (distance since the last fuel stop; hidden when it equals the miles in, and reset to zero at each fuel stop). The first row past the tank gets an amber "out of range" tag: "Past Name's Bike (N mi). Add a fuel stop before here." Only the first breach in a route is tagged, so fixing it can reveal the next. A fuel stop beyond the range is never tagged itself, because its tank count resets there; an E still appears before it on the map. The tags show for every route at once.

**What to do.** Add a Gas or Charge stop before each E, ideally where the ring would still be orange. Tag existing fuel stops correctly. If no range is on file, ask riders to add one in the Paddock and pick their bike on the roster.

## Stop-by: "Start looking for a bed at"

A clock time in the ride header (15-minute steps), one for the whole ride. Nothing shows until it is set. For each dated route, not a losing alternate, that is still under way when its clock reaches that time:

- An amber band across the route list, on the row before that moment: "4:00 PM · 142 mi in · 3h 20m still to go". "Still to go" appears only when more than an hour remains. The band's "Find somewhere to stay" button searches lodging along the road within 45 minutes of riding either side of that moment.
- A blue disc with a bed on the map where the group will be then, labeled "Route N · 4:00 PM · start looking here".

No band appears on a route with no departure, on a route that finishes first, or on a route that sets off after that time of day. The route's end includes the last point's dwell, so a long dwell on the final hotel can put the band on the hotel itself.

**What to do.** Leave earlier, end the route sooner (a Hotel or Camp row mid-route offers "Sleeping here? End the route"), or move the time.

**After dark.** Nothing in Routeloop computes sunset or warns about riding in the dark.

## Road reports

Any rider can report a road from the map's report button ("Report a road condition"): press it, then press right on a drawn route. A press more than 24 pixels from a route line at the current zoom is refused with "Zoom in and press right on the road". Three kinds:

- **Closed**: red diamond with ×. Lasts 60 days, or never expires if seasonal.
- **Rough or unpaved**: amber diamond with !. Lasts 180 days.
- **Hazard**: amber diamond with !. Lasts 21 days.

Reports come from any rider, not only this ride's. A report counts on every route of the ride within 75 m of it, including losing alternates, and appears in the panel's "Road reports" list. Its popup gives the kind, the note (up to 400 characters), "Reported N days ago, counts until DATE", and never who reported it. A route saved only during a site update may not pick up reports until its next save.

### Seasonal closures

Only a closure can be seasonal. It names two month-days and may wrap the new year (Nov 1 – May 31). It is judged against each route's dates:

- The route's start or end date falls in the season: "Closed Nov 1 – May 31, which includes your date". Red.
- The route has no departure: "Closed every year Nov 1 – May 31". Amber in the list.
- Dated outside the season: "Closed Nov 1 – May 31, not on your dates". The pin goes gray.

Only the start and end dates are tested, not days in between.

**What to do.** For a closure on the date, get the route onto another road or change the date, then verify with the road authority. For surface and hazard reports, read the note and decide whether the bikes suit it. The app never avoids a reported road on its own, and an absent report does not mean a road is open.

## The conditions strip

Above the timeline, an elevation profile with "5,120 ft · +4%" at the cursor; the timeline readout adds the forecast for that hour and place: "Rain, 54°F, 40% rain, wind 18 mph". The "Elevation" button hides or shows the profile. Elevation comes from up to 80 samples per route, at least 500 m apart. Weather comes from up to 12 places per route about 40 km apart, refreshed every 30 minutes, and is read in the route's own local time.

Weather words: Clear, Partly cloudy, Overcast, Fog, Drizzle, Rain, Snow, Showers, Snow showers, Thunderstorms. Freezing drizzle reads Drizzle and freezing rain reads Rain. Rain chance prints only at 10 percent or more; wind only at 25 km/h (about 16 mph) or more.

**Blank is not good.** Weather is empty when the route has no departure, its dates are in the past or more than 16 days out, the weather service is down or rate-limited, or the slider sits outside the fetched hours. Elevation can be partial on a long ride while it fills in, over a minute or more. The strip reads the last saved ride, so it lags an unsaved edit. The app never warns about cold, heat, wind, storms, snow, or steep grades; any judgment is yours (see weather-and-seasons).

## Twistiness

How much the road bends, as a wavy line that gets wavier plus a word, shown in the builder's totals line, the ride page's legend, and the dashboard; hovering gives degrees per mile. It is measured from the drawn road every 25 m, ignoring bends under 1 degree, as total turning per mile:

- 240 or more: Very twisty (5)
- 150 to 239: Twisty (4)
- 90 to 149: Some curves (3)
- 40 to 89: Mostly straight (2)
- Under 40: Straight (1)

A route also records its twistiest 20 miles. No rating means nothing measured it, not that it is straight. A route with straight placeholder legs rates straighter than it is. Twistiness says nothing about pavement, safety, or difficulty, but very twisty roads ride slower than the router's times.

## Straight placeholder legs

A leg the router has not answered, or could not, is a dead-straight line between its two points, with its time estimated at about 45 mph over the straight-line distance. A toast says why: "No road route for that leg—drawn straight, its time is estimated" (the point is off any road), "Routing is unavailable right now—the leg is drawn straight", "Signed out—reload the page. The leg is drawn straight until then". A straight leg stays straight, and saves straight, until an edit touches it. In get_ride the route line says `(part estimated)`.

**What to do.** Move the point onto a road, or touch the leg again once routing is back.

## Shaping point rows

"Shaping point" (numbered when a leg has several) under the point whose leg it bends, with × to remove it, plus a handle on the map. After routing, the handle jumps onto the road the router chose. If the line does not follow the road the rider meant, drag it again or remove the shaping point, then recheck the leg's miles and time.

## Junction rows

On a ride with more than one rider, the line under each route header says who rides it. Where the set changes it names the change instead, in blue: "Dylan joins here · Sam leaves here". On the last point of a route where a group peels off: "VMCSC splits off here → Santa Cruz", a button that jumps to their route. Both come from who rides which route, not from the map. Nothing warns when groups' routes never meet a shared route. See groups-and-riders.

## Alternates on the map

A losing alternate is drawn faded and does not count toward totals, the timeline, or exports. It still collects road reports. Grouping alternates that do not start and end within about 100 m of each other shows one warning toast and is then allowed.
