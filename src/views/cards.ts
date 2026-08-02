// The ride card list, shared by the signed-in home page and public profiles.
//
// Lifted out of index.ts because pages.ts needs it and index.ts imports pages.ts
// — importing it back created a cycle that only worked because the call happens
// at request time rather than module load. Views belong here anyway.
import { esc } from './layout'
import type { RideRow } from '../db/schema'

export type CardRow = { ride: RideRow; color: string | null }

export function rideCards(rows: CardRow[], showViews = false): string {
  if (rows.length === 0) return '<p class="empty">No rides yet.</p>'
  return `<ul class="cards">${rows
    .map(
      ({ ride: m, color }) =>
        `<li><a class="card" href="/m/${esc(m.slug)}"><span class="swatch" style="background:${esc(color ?? '#0000cc')}"></span><span>${esc(m.title)}</span><span class="meta">${m.stopCount} stops &middot; ${Number(m.totalMiles)} mi${showViews ? ` &middot; ${m.viewCount} views` : ''}</span></a></li>`,
    )
    .join('')}</ul>`
}
