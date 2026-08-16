# Routeloop goals

The original vision document. Only the vocabulary has been touched since: what this doc called a "route" within a ride is called a **day** as of 2026-08-09, so the hierarchy reads `ride > day > leg > stop/POI` throughout. Nothing else was rewritten.

MyRouteApp but 1000x better, more entire-ride focused, and a much slicker UI and smoother UX.

- Profile for the user, other riders, and bikes, to calculate ranges and other strengths/limitations
- Multi-day ride planning
  - A "Ride" is a package containing many days
- Days have a starting point and and ending point, a starting day/time and an ending day/time, which comprise the length of the Ride.
- Across the bottom of every Ride and Day is a slider, from the start time to the end time that user can slide to see different parts of the ride at different times. The overall ride is always visible, but the leg/section that corresponds to that general date/time.
- Users should be able to plan days, label stops/waypoints, add umpteen days to a given ride.
  - There are three types of dots: waypoints, points of interest (POIs), and stops.
  - A waypoint is just an ephemeral point on the route used to keep us on course, make the correct turns, take the correct route to our ultimate destination. We don't need to stop, and there's nothing remarkable about the spot other than it's along the route.
  - a POI is something interesting along the way we may or may not want to stop and see. Could be a vista point, or a museum, or a quirky store, or whatever. IT's not vital that we stop, but it's interesting enough to note.
  - a Stop is a stop. Gas, rest, food, whatever, it means we aren't riding for a period of time. Stops always have durations. Ends are stops that don't have durations.
- No platforms, no limits.
  - Google maps offers a max of 10 waypoints. Apple maps yields different functionailty depending on the device. The point of this app is not realtime navigation and never will be—it's a planning and sharing tool. An app to finally allow riders to see a holistic view of their ENTIRE ride, every leg, every day, every stop, every hotel, every gas station, across an unlimited number of days and miles.
  - This app will import and export as many different formats as possible. I don't want to pay licensing rights to anything proprietary, but I want to ultimately be able to handle as many map/route formats as possible.
