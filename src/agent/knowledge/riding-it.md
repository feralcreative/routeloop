# Riding it

## What you can and cannot do here

You cannot import, export, see or change visibility, share, keep a ride on a phone, open the bin, or see the ride page, roadbook, or On the road page. You do not know whether a ride was imported. Over MCP, list_rides gives builder links, not share links.

You can fix the data these pages print: departure times (set_departure) light the timeline, the roadbook's arrival column, and dated filenames; Gas or Charge categories make the roadbook's since-fuel column work; dwell feeds arrival times; a second stop makes a one-point route navigable. For everything else, give the rider the exact steps.

## Import

Where: `/import` (menu: Import / Export). Lands on the ride page.

- Formats and caps: GPX 10 MB, KML 5 MB, KMZ 10 MB (its KML 5 MB unpacked), GeoJSON 10 MB, JSON 10 MB (a Routeloop backup or GeoJSON), CSV 2 MB and 200 rows. A .zip is unpacked first: up to 30 files, 32 MB unpacked, only supported files kept. Up to 30 files per import, 16 MB per upload, 31 routes per ride ("split it and import the parts as separate rides"). Imported files count against the rider's 100 MB storage.
- A GPX makes one route per track, with waypoints assigned to the nearest track; with no track it falls back to route points joined by straight lines. KML makes a route per line; KMZ reads only its first KML. CSV is points with no road, always one route.
- A Routeloop backup (.routeloop.json) restores the ride's routes, points, legs, and times, plus private stop details when the ride's creator downloaded it; the import form's title and visibility win over the file's, and the roster is never in the file. Every version from 1 to 6 imports. It takes no storage.
- The track is cut into legs at each point along it. If no point lies within 100 m of the track's start or end, a stop named "Start" or "Finish" is added there.
- Dwell read from GeoJSON or CSV is capped at 24 hours.
- The ride gets the name typed in the form (up to 150 characters) and the visibility chosen (Private by default), never the file's.
- Adding or moving a stop on an imported road later re-routes the neighboring legs through Google.

The review table: before uploading, the page lists each file as a row (order, route title, date) the rider can edit, drag, or drop. A dropped row is not uploaded. A typed title beats the file's own track name; an untouched box does not. A cleared date means undated. A zip cannot be reviewed; its rows are read on upload.

## The filename convention

Every file Routeloop exports is named `routeloop_<ride>_d<NN>_<date>_<title>.<ext>`, for example `routeloop_big-sur-run_d02_2026-08-14_lost-coast.gpx`. Importing a folder of files named this way fills in the ride name, route order, and dates.

- The name must start with `routeloop_` (or the old `tankbag_`); otherwise it is just a name.
- `dNN` is the route number. Files are sorted by it only when every file has one.
- The date is `YYYY-MM-DD` or `YYYY-MM-DDTHHMM`, the departure as a wall-clock time with no time zone. Invalid dates are refused.

Only the Routeloop backup carries departure times inside the file; for GPX, KML, GeoJSON, and CSV the filename is the only place a date survives a round trip.

## Downloads

On the ride page's downloads row: GPX, KML, GeoJSON, CSV, Roadbook, On the road, and Routeloop (lossless), plus the original source link if the ride has one. There is no KMZ export.

- Ordinary downloads contain only active alternates. The Routeloop backup keeps everything.
- GPX writes stops as waypoints and the road as a track, never as a planned route, because a GPS given a planned route re-routes between points and ignores the planned road. A track is followed.
- On a ride with groups, a member downloads their own share (their approach plus shared routes). A planner who wants everything opens the ride page with `?group=all`.
- With more than one route, a second row offers one file per route as a zip, named by the convention, so dates survive.
- The export cart on `/import` (Export half): search your own rides by name or route date, pick a format each, up to 20 rides, one zip. Choose Routeloop (lossless) for a backup. It never uses stored originals.

Stored originals: an imported ride keeps the exact uploaded file, and downloading in that same format returns it byte for byte, styling and folders included. The moment the ride is saved again, even just a rename, color, or visibility change, that format is generated from the ride instead. A ride built from several files is always generated. The original stays in the rider's Download Me archive.

## What each format loses

| Field | GPX | KML | GeoJSON | CSV |
| --- | --- | --- | --- | --- |
| Ride title and description | yes | yes | yes | no |
| Route name | yes | yes | yes | no |
| Route color | no | yes | yes | no |
| Departure and end times | no | no | no | no |
| Point names, categories, notes | yes | yes | yes | yes |
| Stop versus pass-by point | no | no | yes | yes |
| Dwell | no | no | yes | yes |
| The road itself | yes | yes | yes | no |

On re-import, only GeoJSON and CSV bring back stop-versus-pass-by and dwell; GPX and KML points all come back as stops. Colors, distances, and twistiness are never read back. Shaping points, alternates, groups, routing preferences, and private details survive only in the Routeloop backup. To move a ride to another account or restore it, use the Routeloop backup.

## The ride page

`/m/<slug>`: the map, a panel listing each route (checkbox, mileage, badges, a Navigate sign), the downloads, the timeline, a QR code, and links to the roadbook and On the road.

- Anyone who cannot open it, for any reason, sees one message: deleted or not shared with them.
- On a phone the panel is a bottom sheet; drag the grab bar up to see the routes, and tap a row to highlight it.
- Losing alternates appear ghosted and are left out of totals.
- The timeline covers the whole ride in riding hours, nights removed, and needs departure times.
- The fuel ring appears only for members.
- The QR code is the share link, always black on white, and only works for people the ride is visible to.

## The roadbook

`/m/<slug>/roadbook`, with a Print button. A stop-by-stop sheet for a tank bag, not turn-by-turn directions (Routeloop stores no turn instructions).

- Columns: stop number (pass-by points are unnumbered), categories, notes, distance to the next stop, distance from the start, distance since the last fuel stop, arrival, and stay.
- Since-fuel stays blank until the first Gas (or Charge) stop.
- Arrival times appear only on routes with a departure time and are estimates: the route's riding time spread over its distance plus the planned stays. No traffic, weather, or pace.
- Only active alternates; the reader's units and formats; no private details.

## The On the road page

`/m/<slug>/go`: the phone page for a fuel stop. Same access as the ride page; active routes only.

- Sections: the GPX to send to a nav app, Keep on this phone, the Google Maps legs, the roadbook as a list, and "What this does not promise."
- Which leg is next is remembered on that phone (not in private browsing).

### Google Maps legs and the waypoint limit

Google Maps takes at most 9 waypoints per link. Every link here starts from the phone's current location so it opens straight into navigation, which leaves 10 planned points per link. Consecutive links overlap by one point, so nothing is skipped.

- A link prefers to end at a stop (where the rider is already off the bike) if that still uses at least 60% of the link.
- Links never span two routes. A route with no points shows "Nothing to navigate—this route has no stops yet"; a one-point route is a single destination.
- Stops and pass-by points are both waypoints, so a route with many points needs more links.
- Density sets how many shaping points are added between stops: Stops only (none), Light (about 25, the default), and Tight (about 60). More points hold Google to Routeloop's road but cost more taps. The page prints the number of legs and the longest unpinned stretch for each density; that stretch is where Google can pick its own road.
- Google Maps still applies the rider's own avoid-highways and avoid-tolls settings and shows stops as dropped pins.

### Send to your nav app

The On the road page's GPX button sends the whole ride (or the rider's share) as GPX. iOS opens the share sheet but nav apps usually do not appear in it: tap Save to Files, then open the file from the Files app. Android always downloads. For an imported, unedited ride this is the original file.

## Navigate (one route)

Each route row on the ride page has a green Navigate sign that sends just that route's GPX. On iOS it opens the share sheet with the file ready; elsewhere it downloads. To load one day onto a GPS, use Navigate or the per-route zip, not the whole-ride GPX, unless the unit handles several tracks per file.

## Keep on this phone

On the On the road page (Keep on this phone) and on ride cards on `/rides` (phone only), a Keep sign stores the On the road page, the roadbook, and the GPX so they work with no signal. Nothing else is stored: not the map page, not map tiles, and Google Maps legs still need Google Maps' own signal or offline maps.

- It appears only where the browser supports offline storage; in-app browsers and private windows often do not.
- The card sign reads Keep (white), Kept (filled blue; pressing it removes the copy), or Update (the ride changed since it was kept). Any save, even a rename, makes a copy out of date.
- Opening the kept On the road page with signal refreshes what that page loads, but only Update refreshes everything, the roadbook included.
- A copy stays on the phone even if the ride is later deleted; the live link stops working.
- Browser storage is best effort and can be cleared by the phone.

### On this phone

Above the list on `/rides` (phone only): None, Last 30 days, This year, All. The choice is by when a ride last changed, not its ride date, and is remembered per phone. It never acts on its own: it shows Download N rides (up to X MB) and Remove N rides as separate buttons. It covers rides you own or are on. It only removes what it kept; rides kept by hand are never removed by it.

## Sharing and cloning

The share link is `/m/<slug>`. Who it works for depends on visibility (Public and Unlisted: anyone with the link; Friends: the owner's signed-in friends; Private: owner, members, and personal-link holders). Members always get in. Owners change visibility in the builder.

Clone this ride: a signed-in rider who is not the owner can copy a Public or Friends ride they can see, never an Unlisted or Private one. The copy is private and theirs, without the description, stop notes, private details, shaping points, departure times, or groups; it keeps alternates, routing preferences, and dwell. If the button is missing, the rider is the owner, signed out, or the ride is Unlisted or Private.

## The Rides page

`/rides`, a phone's home page. Tabs: Your rides (yours, then rides you are on), Friends, Following, Public, and Recycle bin; 24 at a time, newest change first. On a phone each card has Open ride, Edit, Keep, and Delete. A ride missing from Your rides may be in the Recycle bin tab.

## The recycle bin

Deleting a ride moves it to the bin for 30 days, then it is destroyed (checked hourly). Where: the last tab on `/rides`.

- Binning frees its storage at once. Its link, roadbook, On the road page, and downloads stop working immediately.
- Restore can be refused: "Restoring this would put you over your storage limit."
- A notification warns a week before anything in the bin is destroyed.
- Only the creator can delete or restore.

## Not ready: riding it

1. Not kept before a no-signal stretch. Shows Keep on the card. You cannot see it. Fix: on the travel phone, on Wi-Fi, press Keep or use On this phone, then test in airplane mode.
2. Kept copy out of date. Shows Update or "the ride has changed since." Fix: press Update after every edit.
3. The phone cannot keep. No Keep section. Fix: Safari or Chrome proper, or Add to Home Screen; else print the roadbook and download the GPX.
4. Too many Google Maps legs, or a long unpinned stretch. Detect: more than 10 points on a route means several links. Fix: Light or Tight density, or stops where roads diverge.
5. A route with nothing to navigate. Detect in get_ride: a route with no points (a one-point route is a single destination, which may be what the rider means). Fix: add stops.
6. No real road. Detect in get_ride: "(part estimated)" on a route, or a route of 0 mi; a CSV import has no road at all. Fix: open the builder and let it route, or re-run the edit.
7. No departure times. Detect: "(no departure time)" in get_ride. No timeline, no arrival times, undated filenames. Fix: set_departure on each route.
8. Invented Start and Finish stops after import. Detect: points named exactly Start or Finish. Fix: rename or move them.
9. Riders cannot open the link. Fix: add them to the roster, send a personal link, or choose Unlisted.
10. The ride is in the bin. Everything 404s. Fix: restore from the Recycle bin tab.
11. Over storage. Imports and restores refused. Fix: bin other imported rides.
12. The download is no longer the original file. Expected after any edit; keep your own copy of the original or use the Routeloop backup.
13. A GPS rejects the file. Fix: Navigate or the per-route zip for one route per file; try KML.
14. The wrong alternate is active. Downloads, the roadbook, and Maps legs follow it. Detect in get_ride: "not chosen" on the intended route. Fix: an owner picks the active alternate.
15. A member sees only their share. Fix: `?group=all` for the whole ride, or correct who rides each route.
16. Maps settings override the route. Remind the rider to check avoid highways and tolls in Google Maps.
17. Fuel resets between routes. Every route starts on a full tank in Routeloop's checks. Fix: confirm a real fill-up before each route, tagged Gas.
