// THE PURE HALF OF THE RIDE LIST: which tab a query names, and how many of a
// rider's own rides a page draws. Split out of src/routes/home.tsx on
// 2026-09-15 ahead of the list's move to /rides, so the rule a bot's invented
// `?tab=` value gets and the cap arithmetic are testable with no database —
// the src/trash/policy.ts arrangement.

// The five lists, in strip order. `bin` is last because it is the one a rider
// goes looking for rather than reads by default (#343).
export const RIDE_TABS = ['mine', 'friends', 'following', 'public', 'bin'] as const
export type RideTab = (typeof RIDE_TABS)[number]

// WHICH TAB OPENS (#343). The strip was always server-rendered on Your rides
// and tabs.js took it from there; `/trash` lands on the list with `?tab=bin`,
// so the server has to be able to open a tab. Anything but a known name is
// the first tab, which is what a bot's invented value should get.
export function rideTabOf(raw: string | undefined): RideTab {
  return (RIDE_TABS as readonly string[]).includes(raw ?? '') ? (raw as RideTab) : 'mine'
}

// How many of a rider's own rides a page draws before it offers the rest.
//
// It was RECENT = 6, a "picking up where you left off" strip beside a full list
// at /rides. That page folded into the dashboard on 2026-08-24, so this number
// stopped being a teaser and became a cap — and a cap is what it has to be: the
// old list was unpaginated, and hanging an unbounded one under eight blocks of
// stats made the page worse the more a rider used the app. The list has its own
// page again since 2026-09-15 and the cap stays, for the same reason.
//
// `?show=all` renders every one. A query parameter rather than script, because
// the list renders as text and a "show all" that needs JavaScript would be the
// one thing on the page that does.
export const RIDE_PAGE = 24

// The ceiling `?show=all` raises the cap to, rather than removing it. Nobody is
// near this — the largest dev corpus is twenty rides — and it exists so the page
// cannot be made slow by a rider who imports a folder every week for a year.
export const RIDE_CEILING = 500

// The query fetches ONE MORE than the cap, which is what says there IS more
// without a second count query; this slices the extra row off before rendering.
// Under `showAll` the query was bounded by RIDE_CEILING instead and everything
// it returned is shown.
export function pageOwned<T>(rows: T[], showAll: boolean): { visible: T[]; hasMore: boolean } {
  const hasMore = !showAll && rows.length > RIDE_PAGE
  return { visible: hasMore ? rows.slice(0, RIDE_PAGE) : rows, hasMore }
}
