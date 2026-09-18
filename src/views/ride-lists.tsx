// THE TWO CARDS A RIDER'S OWN LIST IS MADE OF: a ride they own, and a ride
// somebody else put them on. Both were private to src/routes/home.tsx from
// 2026-08-24, when the ride list folded into the dashboard, until 2026-09-15,
// when it left again for /rides — and a view file is where a fragment two
// routes could ask for lives (src/views/bin.tsx set that precedent). Nothing
// here changed in the move; the comments below are the ones the cards carried.
import { fmtRideDistance, CardFace } from './cards'
import { type Units, distanceUnit } from './units'
import type { RideRow, Rsvp } from '../db/schema'
import { RSVP_LABELS } from '../members/policy'
import { SEP } from './sep'

// Deliberately not views/cards.tsx's own Card: this one carries a visibility pill
// and an edit link that the public card must never show. Same shape, different
// contract — merging them would mean a flag that only ever means "am I the
// owner", which is the thing the two separate components already say.
//
// What IS shared is CardFace, the picture-or-color-block, because that part has
// no contract of its own. It is also the part with the traps in it — the `?v=`
// immutability hash, the lazy loading, the source dimensions that keep the grid
// from reflowing — and those had already been copied once.
//
// Moved here from src/routes/rides.tsx on 2026-08-24 when that page folded into
// this one. Became a card on 2026-08-25 with the rest of them (#135).
//
// THE EDIT LINK AND THE PILL SIT OUTSIDE THE ANCHOR, and that is not a layout
// preference: an <a> inside an <a> is invalid HTML and browsers recover from it
// by closing the outer one early, which silently drops half the card out of the
// link. The foot is a sibling of the link, and the card's own padding is what
// makes the two read as one object.
// THE BIG BUTTON A THUMB GETS, AND THE SMALL ONES AROUND IT, 2026-09-17.
// Ziad's calls, in passes on an emulated phone: the list is rows, and a big
// Load matters more than a big map — the number one use of a phone here, by
// leaps and bounds, is to load a ride that is already planned into a GPS. Load
// is the guide sign with its arrow and takes the width; beside it a small blue
// Keep, which stores the ride on the phone for when there is no signal — the
// same act as Keep on this phone on the On the road page, through the same
// keep.js — and, in the foot, a small amber Edit (work zone) or a brown Riders.
// Every one of them is deliberately much smaller and off the green so it
// cannot compete with Load. They render on EVERY card, because the markup
// cannot know the width; the phone rule in _rides.scss is what shows them, and
// the foot's small text links are what it hides in exchange. On a desktop the
// row is `display: none` and the card is exactly what it was.
//
// KEEP SHIPS `hidden` AND rides.js UN-HIDES IT, only where the browser has a
// Cache API and a service worker — a sign that promises a copy on a phone that
// cannot hold one is worse than no sign. It is a <button>, not a link: nothing
// navigates, the manifest is fetched from /m/:slug/keep.json when pressed.
//
// OUTSIDE THE CARD'S ANCHOR, like the foot and for the same reason: an <a>
// inside an <a> is invalid and a browser closes the outer one early.
function RideCardGo({ ride }: { ride: RideRow }) {
  return (
    <div class="ride-card-go">
      <a class="btn btn-sign" href={`/m/${ride.slug}`}>
        Load ride
      </a>
      {/* data-updated is what lets a kept copy say it has gone stale: the
          registry row remembers the updatedAt it was kept at, and this is the
          live one. */}
      <button
        type="button"
        class="btn btn-sign btn-services ride-card-go-minor"
        data-keep={ride.slug}
        data-updated={ride.updatedAt.toISOString()}
        hidden
      >
        Keep
      </button>
    </div>
  )
}

// A ride the viewer is ON but does not own.
//
// A THIRD CARD RATHER THAN A FLAG ON THE OTHER TWO, for the same reason
// OwnRideCard is not views/cards.tsx's Card: the contract is different. There is
// no visibility pill, because the setting is not this rider's to know or change;
// there is no edit link, because they cannot; and there is an RSVP, which
// neither of the others has anywhere to put. A flag meaning "am I the owner"
// plus a flag meaning "am I a member" is two booleans encoding three cards.
//
// No color block: `ridesImOn` does not join routes, and a fourth query per
// dashboard render to tint a short list is not worth it. CardFace draws the
// thumbnail when there is one and a neutral field when there is not.
export function JoinedRideCard({
  ride,
  rsvp,
  owner,
  units,
}: {
  ride: RideRow
  rsvp: Rsvp
  owner: string
  units: Units
}) {
  return (
    <li class="ride-card">
      <a class="ride-card-link" href={`/m/${ride.slug}`}>
        <CardFace slug={ride.slug} thumbHash={ride.thumbHash} color={null} />
        <span class="ride-card-body">
          <span class="ride-card-title">{ride.title}</span>
          <span class="ride-card-meta">
            {ride.stopCount} stops{SEP}
            {fmtRideDistance(ride.totalMiles, units)} {distanceUnit(units)}
          </span>
          {/* WHOSE RIDE, since 2026-09-15: this card sits in the same list as the
              rider's own now, and the RSVP pill below says they were asked but
              not by whom. Its own line rather than a third meta term, so a
              long name wraps on a phone without taking the mileage with it. */}
          <span class="ride-card-owner">Planned by {owner}</span>
        </span>
      </a>
      <RideCardGo ride={ride} />
      <div class="ride-card-foot">
        <span class="pill">{RSVP_LABELS[rsvp]}</span>
        {/* Straight to the roster rather than to the ride, because answering is
            the thing this card is asking for. Twice: the text link for a
            desktop, the small sign for a phone; _rides.scss shows one. */}
        <a class="editlink" href={`/m/${ride.slug}/riders`}>
          Riders
        </a>
        <a class="btn btn-sign btn-recreation ride-card-go-minor ride-card-foot-sign" href={`/m/${ride.slug}/riders`}>
          Riders
        </a>
      </div>
    </li>
  )
}

export function OwnRideCard({ ride, color, units }: { ride: RideRow; color: string | null; units: Units }) {
  return (
    <li class="ride-card">
      <a class="ride-card-link" href={`/m/${ride.slug}`}>
        <CardFace slug={ride.slug} thumbHash={ride.thumbHash} color={color} />
        <span class="ride-card-body">
          <span class="ride-card-title">{ride.title}</span>
          <span class="ride-card-meta">
            {ride.stopCount} stops{SEP}
            {fmtRideDistance(ride.totalMiles, units)} {distanceUnit(units)}
          </span>
        </span>
      </a>
      <RideCardGo ride={ride} />
      <div class="ride-card-foot">
        <span class="pill">{ride.visibility}</span>
        {/* Every own ride is editable now, imported ones included — this used to
            test `ride.source === 'native'` because the builder could not open an
            import. It can; see canEditRide in ./maps. Twice: the text link for
            a desktop, the small amber sign for a phone; _rides.scss shows one. */}
        <a class="editlink" href={`/builder/${ride.id}`}>
          Edit
        </a>
        <a class="btn btn-sign btn-warning ride-card-go-minor ride-card-foot-sign" href={`/builder/${ride.id}`}>
          Edit ride
        </a>
        {/* NO "are you sure?". This moves the ride to the recycle bin, where it
            sits for thirty days with a button to undo — the bin is the
            confirmation. A dialog in front of a reversible action is how riders
            learn to click through the one that is not. */}
        {/* data-ride-id is for dashboard.js, which bins this in place rather than
            letting the POST navigate — see #175. The id is already in the action,
            but parsing it back out of a URL is a second place the route shape has
            to be known; an attribute says it once. With script off nothing reads
            it and the plain POST is unchanged. */}
        <form method="post" action={`/trash/rides/${ride.id}/bin`} class="ride-card-del" data-ride-id={ride.id}>
          <button class="linkbtn" type="submit" data-tip="ride-delete" title="Move to the recycle bin">
            Delete
          </button>
        </form>
      </div>
    </li>
  )
}
