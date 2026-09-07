// Route colors, in one place.
//
// The same palette the legacy viewer used, so a multi-route ride gets visually
// distinct routes without the rider picking each one.
//
// This lives server-side and is injected as `window.TB.routeColors`, which is the
// convention roles.ts already established — a table the client needs is defined
// once here and shipped in the page shell rather than copied into a script.
// The copy in builder.js was the only one until the importer needed to color
// the routes of a folder import too, and two copies of a palette drift the moment
// one gains a color.
//
// NO RED IN HERE, AND THAT IS RESERVED RATHER THAN AN OVERSIGHT. Ziad's call,
// 2026-08-31. `#cc0000` was the second entry and it is the exact value of
// `$stop` — the same red the fuel wall and the unrideable stretch are drawn in
// (#229), so a route assigned it drew its whole route in the color that means
// "you cannot ride this". A rider has no way to tell those apart, and the one
// that carries a warning has to win.
//
// Removing an entry reshuffles every route after it, which costs nothing: the
// color is stored per route, so only routes colored from now on are affected.
// **Rides created before this keep the red they were given** — the palette is
// what is offered, not what is enforced.
export const ROUTE_COLORS = [
  '#0066cc',
  '#8800dd',
  '#ff6f00',
  '#dd00dd',
  '#006064',
  '#4a148c',
  '#4e342e',
  '#00aaaa',
  '#a0740b',
  '#003300',
  '#550000',
] as const

// Wraps rather than running out. A ride with more routes than colors repeats,
// which is better than a route with no color at all.
export const routeColor = (index: number): string => ROUTE_COLORS[index % ROUTE_COLORS.length]
