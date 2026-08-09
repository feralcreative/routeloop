// Day colours, in one place.
//
// The same palette the legacy viewer used, so a multi-day ride gets visually
// distinct days without the rider picking each one.
//
// This lives server-side and is injected as `window.TB.dayColors`, which is the
// convention roles.ts already established — a table the client needs is defined
// once here and shipped in the page shell rather than copied into a script.
// The copy in builder.js was the only one until the importer needed to colour
// the days of a folder import too, and two copies of a palette drift the moment
// one gains a colour.
export const DAY_COLORS = [
  '#0066cc',
  '#cc0000',
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

// Wraps rather than running out. A ride with more days than colours repeats,
// which is better than a day with no colour at all.
export const dayColor = (index: number): string => DAY_COLORS[index % DAY_COLORS.length]
