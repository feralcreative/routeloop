// The ride card list, shared by the signed-in home page and public profiles.
//
// Lifted out of index.ts because pages.ts needs it and index.ts imports pages.ts
// — importing it back created a cycle that only worked because the call happens
// at request time rather than module load. Views belong here anyway.
//
// First file converted to JSX. Note there is no esc() anywhere below: Hono's JSX
// escapes every interpolated value, so a ride title containing `<` is handled
// without anyone remembering to handle it. Deliberate markup would need raw(),
// which makes every intentional injection point greppable.
import type { RideRow } from '../db/schema'

export type CardRow = { ride: RideRow; color: string | null }

function Card({ ride, color, showViews }: CardRow & { showViews: boolean }) {
  return (
    <li>
      <a class="card" href={`/m/${ride.slug}`}>
        <span class="swatch" style={{ background: color ?? '#0000cc' }}></span>
        <span>{ride.title}</span>
        {/*
          Literal · rather than &middot;, and the two are not interchangeable
          here. JSX *decodes* entities in static text, so `&middot;` compiles to
          the character anyway — but inside an expression it does not, and
          `{'&middot;'}` would render the visible text "&middot;" because the
          ampersand gets escaped. One spelling that behaves the same in both
          positions is the safe one. The page is UTF-8, so the character is fine.
        */}
        <span class="meta">
          {ride.stopCount} stops · {Number(ride.totalMiles)} mi
          {showViews ? ` · ${ride.viewCount} views` : ''}
        </span>
      </a>
    </li>
  )
}

/**
 * Returns a string rather than a JSXNode on purpose, for as long as the
 * migration is partial: page() and every unconverted caller still concatenate
 * strings, and handing them an element would render `[object Object]`. The
 * `.toString()` goes away in the final commit, when page() itself takes a node.
 */
export function rideCards(rows: CardRow[], showViews = false): string {
  if (rows.length === 0) return '<p class="empty">No rides yet.</p>'
  return (
    <ul class="cards">
      {rows.map((row) => (
        <Card {...row} showViews={showViews} />
      ))}
    </ul>
  ).toString()
}
