---
kind: app
checked: 2026-10-31
---

# The builder: how a ride is shaped and edited

The builder is the page where a ride is planned: a map, a panel with Routes, Groups, and Riders tabs, and a timeline under the map. Use this to explain the app and to point riders at the right control. What you can change yourself is listed at the end.

## The shape of a ride

A ride is a list of routes. A route is one ordered list of points. Between every two consecutive points is one leg: the road from one to the next. A route with N points has N − 1 legs.

- **Route.** Usually one day or one stretch. Riders say "day"; Routeloop says route. A ride holds up to 31 routes.
- **Stop.** A point the group means to stop at. It shows a number in the route list.
- **POI (point of interest).** A point the group rides past without necessarily stopping. It shows a dot, not a number. A POI is still on the road: the route goes through it, and moving or adding one changes the road.
- **Shaping point.** Not a point. A pass-through hint that bends one leg onto a different road, made by dragging the drawn line. It shows as a small handle on the map and a "Shaping point" row under the point whose leg it bends. No number, no name, never a stop.
- **Leg.** The drawn road between two points, with its distance and riding time.

Limits: 31 routes per ride; 400 points and 200 stops per route; 20 shaping points per leg; up to 4 categories per point; dwell 0 to 43,200 minutes; route title 150 characters; ride description 2,000; point name 255; address 300; public note 2,000.

A route needs at least one stop. A route with points but no stop cannot be saved; the panel says "Route N has no stop—give a point a category, or make one a stop."

## Categories, stops, and POIs

A category says why the group stops. There are 17: Start, Finish, Home, Meet, Split, Gas, Charge, Break, Camp, Hotel, Food, Coffee, Drinks, Grocery, View, Sight, and WTF. In get_ride they print lowercase, and Sight prints as `poi`.

- Picking any category makes a point a stop. Clearing its last category makes it a POI again.
- The category button is the round button on each row; the picker opens beside it.
- The route's only stop cannot be cleared: "A route needs at least one stop."
- The first point added to an empty route becomes a stop tagged Start automatically. Every other point arrives as a POI unless it came with a category (a category chip result, a saved place filed under one).
- A row menu item "Make this a stop" / "Make this a POI" appears only on POIs and on stops with no category. It changes nothing about the road.
- Promoting or demoting never re-routes and never drops shaping points.
- `poi` the category (Sight, somewhere to stop and look) is not POI the kind (ride past). A Sight is a stop.
- Gas and Charge are what the fuel plan counts as a refuel. Which one counts follows the ride's power: Charge for electric, Gas otherwise.

## Adding, replacing, moving, and deleting points

- **Add.** "+ Stop" arms the next map click for a route. Or type in a route's bottom search box, or in a "+" slot between two rows to insert there. A search needs at least 2 characters and returns numbered rows that match numbered dots on the map.
- **Replace.** Every row's name box is also a place search. Picking a result replaces that point where it sits and keeps its categories, dwell, both notes boxes, private details, and identity. Both legs touching it are re-routed and lose their shaping points. Typing plus the pick is one undo step.
- **Move.** Drag the grip on a row, or focus the grip and use the arrow keys. Every leg in the span between the old and new position is re-routed and loses its shaping points.
- **Delete.** Row menu, Delete. Deleting a middle point joins its two legs into one and carries both legs' shaping points onto it, keeping the first 20. Deleting the first or last point carries none. If the deleted point was the last stop, the first remaining point becomes a stop.
- **Row menu also has:** "Notes, reservations & details", "Save to my places", "Duplicate" (puts a copy on top of the original), "Select points…" (bulk delete, duplicate, or move to another route), "Comment on this stop", "End the route here", "Split a group off here".
- **Notes.** "Notes everyone on the ride can see" is public and appears in get_ride as `note:`. "Notes only you can see" and the reservation details (confirmation, check-in and check-out, phone, address, links) are visible only to the ride's creator.
- **Saved places** are copied into a ride, never linked. Fixing a saved place later changes no existing ride.

## Shaping points

Drag the drawn line to make one; press its handle or the × on its row to remove it. After the road comes back, each shaping point is pulled onto the road the router actually chose, so the handle moves. The router may have picked a nearby road that is not the one the rider meant: check the line, not the handle.

- 20 per leg; the 21st drag is refused.
- Moving a point clears the shaping points of the legs it touches. Deleting a middle point keeps them.
- "Twisty roads" is ignored on any leg that has shaping points.

## Routes

- **Add.** "+ Route". In the builder a new route starts at the last point of the previous counted route and departs at 08:00 the morning after that route ends, if it had a departure.
- **Rename and recolor** in the route header. Routes are numbered by position among counted routes; a losing alternate gets a letter (3b).
- **Route menu:** "Duplicate route", "Select routes…" (then "Group as alternatives", move, delete), "Ride this one instead" and "Ungroup alternatives" (on alternates), "Delete route". The last route cannot be deleted.
- **Reverse.** The reverse button in the route header flips the point order, swaps Start and Finish, drops every shaping point, and re-routes every leg. Over 12 legs it asks first, because each leg is a routing request.
- **Split.** "End the route here" in a row menu, on any point except the first and last. The second route starts with a copy of that point, sits right after the first, and departs at 08:00 the morning after the first ends. A Hotel or Camp row in mid-route shows "Sleeping here? End the route", which does the same.
- **Empty routes** are dropped when the ride saves.

## Routing preferences

Each route header has toggles: Avoid Highways, Tolls, and Ferries, and Prefer Twisty roads. They are per route, not per ride. Changing one re-routes every leg of that route (over 12 legs it asks first). The avoids are requests Google may not be able to honor. Twisty asks Google for its alternative roads and picks the one with the most curvature, only on legs with no shaping points. There is no scenic or avoid-unpaved option. Twistiness ratings are explained in the map-warnings topic.

## Alternates

Two or more routes can be grouped as candidates for the same stretch: "Select routes…", pick at least two, "Group as alternatives". The one highest in the route list becomes active. Exactly one member is active; only it counts toward ride mileage, time, the timeline, exports, and the roadbook. The others are drawn faded. "Ride this one instead" switches. Grouping routes that do not start and end within about 100 m of each other shows a warning toast once and is allowed. A group of one dissolves. Riders on the roster can vote; at a deadline a single top vote switches the active route, a tie or no votes changes nothing, and with no deadline it never resolves on its own.

In get_ride an alternate's route line ends `alternate group N, active` or `alternate group N, not chosen`. Never add a `not chosen` route into a ride total.

## Times

- **Departure.** Each route's "Starts" field is a local wall clock where that route starts. 09:00 means nine o'clock where the bike is, whatever time zone the rider plans from. Nothing in Routeloop converts it. Never shift it for time zones.
- **Ends** is worked out from the departure plus riding time plus every point's dwell, including the last point's, unless the rider typed one.
- **Dwell** ("how long you stop here") is per point, on stops and POIs alike, in the duration box on each row. Blank on a POI means rode past.
- **Arrival times** show on each row only when the route has a departure. They add the riding time of each leg and the dwell at every earlier point, including the first.
- **Estimated legs.** A leg the router never answered is drawn straight and timed at about 45 mph over the straight-line distance, which is shorter than the road. Times past it are labeled estimates.
- **Stop-by.** "Start looking for a bed at" in the ride header is one clock time for the whole ride. See the map-warnings topic.
- **Ride power and vehicle** ("For" in the ride header) decide the fuel words and whether Gas or Charge refuels.

## The timeline

The slider under the map scrubs a moment. A dot shows where the group would be, and the fuel ring, the forecast, and elevation are read at that moment. On a ride with more than one route a "Route | Ride" pill sets what it covers: Route is the route being edited; Ride is the whole ride in riding hours only, overnights skipped, in clock order rather than list order. A route with no departure has no timeline; the bar hides when the route being edited is undated. The route being edited is the one drawn bright, never the one the slider happens to sit on. Losing alternates are skipped in Ride scope.

## Place search

- Typed names search the part of the map on screen; zoom out to search wider. A query naming a place ("gas station in Bakersfield") searches there.
- Chips under each route: Fuel (gas stations, or chargers on an electric ride), Food, Coffee, Lodging. A chip result arrives as a stop already tagged.
- The bottom search box has "On screen | Along the route". Along the route searches within 15 miles of the whole route, in up to 12 overlapping searches (about 745 miles of coverage); a longer route shows "part of this route only". A "+" slot always searches its own leg. Along-the-route results drop in between the two points whose leg passes them.
- The rider's favored and avoided places reorder results; they never hide any.

## Saving, undo, and conflicts

- There is no Save button. The ride saves itself 3 seconds after the last edit, and at least every 20 seconds while edits continue; a failed save retries after 15 seconds. The readout says "Not saved yet", "Unsaved changes", "Saving…", "Saved", or "Not saved".
- **Undo and redo** keep 100 steps. An Apply of your proposal is one step labeled "assistant".
- **Recovery copy.** The browser keeps an unsaved copy; on reopening, a bar offers "Unsaved changes from N minutes ago". Restoring re-routes every leg, which can return slightly different roads.
- **Two riders at once.** Each route merges separately, so riders editing different routes never collide. A route someone else is editing is marked, not locked. If a save reports "Someone else edited this ride—reload to see their changes", autosave stops until the rider reloads.
- **Permissions.** Edit saves directly. Suggest (what an invitation grants) edits locally and sends a suggestion the owner accepts. View and Comment cannot edit.

## What you can do

- **get_ride** reads routes and points as text. It never shows leg geometry, shaping points, routing preferences, twistiness, colors, the stop-by time, the ride's power, bikes or ranges, the roster, votes, comments, road reports, or weather. Private notes appear only for the ride's creator.
- **search_places** returns up to 8 places with coordinates, near a point or a lat/lng, radius 1 to 50 km (default 25). It costs money: at most 6 per turn in the builder's assistant, one per call over MCP, and 300 Google calls a rider a day everywhere.
- **add_stop** inserts after a given point, or at the end. With categories it is a stop; without, a POI. Inserting between two points rebuilds the leg between them straight with no shaping points, then routes it.
- **replace_stop, remove_stop, move_stop** behave like the builder's replace, delete, and move above. move_stop takes a position from 0 to the route's last index; anything else is refused. remove_stop cannot empty a route.
- **set_categories** with any category makes a stop; with [] makes a POI, refused on the route's only stop.
- **set_dwell** in minutes, or null.
- **set_departure** as `YYYY-MM-DDTHH:MM` local time, or null.
- **add_route** appends a route with one starting point tagged Start, no departure, and its own color. Unlike the builder's "+ Route" it does not copy the previous finish or set a date: start it at the previous route's last point yourself, then set_departure.
- **rename_route.**
- Over MCP: **list_rides** and **create_ride** (a new private ride with one start point). Over MCP every edit adds to a pending proposal for that ride; **apply_changes** saves it in one write once the rider agrees, **review_changes** lists it, and **discard_changes** drops it.
- Each edit re-routes the legs it leaves straight, up to 30 routing requests per turn in the builder's assistant; over MCP each edit has its own small ceiling (2 legs for an add, replace, or remove; 12 for a move, which refuses a longer span) plus the daily ceiling; past that, legs stay straight and the reply says so.

You cannot: delete a ride or a route; reorder, reverse, split, duplicate, or recolor routes; group, ungroup, or choose alternates; edit shaping points or routing preferences; set the stop-by time, the ride's power, title, description, or visibility; touch notes, private details, the roster, groups, or saved places; move points between routes; or see the map. For those, tell the rider which control does it.
