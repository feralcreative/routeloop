// The ride card list, shared by /explore and public profiles.
//
// Lifted out of index.ts because pages.ts needs it and index.ts imports pages.ts
// — importing it back created a cycle that only worked because the call happens
// at request time rather than module load. Views belong here anyway.
//
// First file converted to JSX. Note there is no esc() anywhere below: Hono's JSX
// escapes every interpolated value, so a ride title containing `<` is handled
// without anyone remembering to handle it. Deliberate markup would need raw(),
// which makes every intentional injection point greppable.
//
// CARDS, NOT ROWS, since 2026-08-25 (#135). A ride in a list should show its
// route rather than only its title, so the thumbnail is the FACE of the card
// instead of a 160px chip at the start of a row. Stated as a general preference
// on 2026-08-16 — cards wherever rides are browsed — and held back deliberately
// until the thumbnails shipped (#116): a card with no picture is a row with more
// padding, and worse, because it trades a dense scannable list for a sparse one
// and gives nothing back.
//
// `.ride-cards` IS ITS OWN CLASS AND DOES NOT TOUCH `ul.cards`. That one is the
// generic white-row list and /admin and the survey summary both build on it —
// repurposing it would have turned the rider roster into a grid of empty
// picture frames. Two classes, because they are two things.
import type { RideRow } from '../db/schema'

export type CardRow = { ride: RideRow; color: string | null }

/**
 * The picture, or a color block standing in for one.
 *
 * Shared by this file, home.tsx's owner card, and home.tsx's "Your records" —
 * which is the ONE thing those three genuinely have in common. The rest of the
 * owner card is a visibility pill and an edit link a public card must never
 * show, and a record is a figure rather than a title.
 *
 * TAKES THE TWO FIELDS RATHER THAN A RIDE ROW, since 2026-08-26. A record knows
 * a slug and a hash and has no RideRow to hand over, and the alternative was a
 * third copy of the markup below — which is the copy this function was extracted
 * to prevent. `block` names the CSS block so each caller keeps its own class.
 *
 * `?v=` is the request hash, which is what lets the route serve the image
 * immutable: a changed picture is a changed URL. Lazy, because /explore and a
 * public profile are unbounded lists of images; width and height are the
 * SOURCE's dimensions, so the browser reserves the right shape before the bytes
 * land and the grid does not reflow as each one arrives.
 */
export function CardFace({
  slug,
  thumbHash,
  color,
  block = 'ride-card',
}: {
  slug: string
  thumbHash: string | null
  color: string | null
  block?: string
}) {
  return thumbHash ? (
    <img
      class={`${block}-face`}
      src={`/api/public/maps/${slug}/thumb.png?v=${thumbHash}`}
      alt=""
      width="640"
      height="400"
      loading="lazy"
      decoding="async"
    />
  ) : (
    // The whole face, not a dot. A ride that has not been swept yet, or one with
    // no geometry to draw, still has to occupy a card of the same shape as the
    // ones beside it — a grid where some cells are short is a grid that reads as
    // broken rather than as incomplete.
    //
    // NO INLINE STYLE WHEN THERE IS NO COLOR. The fallback used to be a `#0000cc`
    // literal written into the markup, which a themed app has no business doing
    // and which a record card cannot use — its blank face takes the record's own
    // accent. The same blue is now the stylesheet's default for `.ride-card-face`,
    // so a ride card looks exactly as it did.
    <span class={`${block}-face is-blank`} style={color ? { background: color } : undefined}></span>
  )
}

function Card({ ride, color, showViews }: CardRow & { showViews: boolean }) {
  return (
    <li class="ride-card">
      <a class="ride-card-link" href={`/m/${ride.slug}`}>
        <CardFace slug={ride.slug} thumbHash={ride.thumbHash} color={color} />
        <span class="ride-card-body">
          <span class="ride-card-title">{ride.title}</span>
          {/*
            Literal · rather than &middot;, and the two are not interchangeable
            here. JSX *decodes* entities in static text, so `&middot;` compiles to
            the character anyway — but inside an expression it does not, and
            `{'&middot;'}` would render the visible text "&middot;" because the
            ampersand gets escaped. One spelling that behaves the same in both
            positions is the safe one. The page is UTF-8, so the character is fine.
          */}
          <span class="ride-card-meta">
            {ride.stopCount} stops · {Number(ride.totalMiles)} mi
            {showViews ? ` · ${ride.viewCount} views` : ''}
          </span>
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
    <ul class="ride-cards">
      {rows.map((row) => (
        <Card {...row} showViews={showViews} />
      ))}
    </ul>
  ).toString()
}
