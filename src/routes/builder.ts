// The ride builder's API and page shells. A ride payload is the full graph —
// ride meta + days + stops/POIs + routed legs — saved whole (PUT is a
// full-replace inside one transaction). The builder MVP sent exactly one day;
// the API accepted many from day one, and the builder caught up on 2026-07-30.
import { Hono } from 'hono'
import type { Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db/index'
import {
  rides,
  days as daysTable,
  points as pointsTable,
  routeLegs,
  userProfiles,
  type RideRow,
  type UserRow,
} from '../db/schema'
import { currentUser, requireActive, requireActiveApi, requireSameOrigin, type AuthEnv } from '../auth/middleware'
import { METERS_PER_MILE, distFromStartAlongTrack, sanitizeText, trackMeters, type Track } from '../maps/kml'
import { toDurationFormat, type DurationFormat } from '../maps/duration'
import { DAY_COLORS } from '../maps/palette'
import { detailsForOwner } from '../maps/point-details'
import { MAX_ROLES_PER_POINT, ROLES, ROLE_META } from '../maps/roles'
import { twistiness } from '../maps/twist'
import { faqLink, googleMapsLoader, page, panelShell, rideTimeline } from '../views/layout'
import { TRASH_HOLD_DAYS } from '../trash/policy'
import { asset } from '../views/assets'
import { GMAPS_KEY, GMAPS_MAP_ID } from '../config'
import { generateSlug } from '../maps/slug'
import { turnstileEnabled, verifyTurnstile } from '../maps/turnstile'
import { canEditRide, ownRide } from './maps'
import { canClone } from '../access/policy'
import { grantsFor } from '../access/query'
import { fields, firstIssue } from '../maps/fields'
import { LIVE_RIDE } from '../trash/service'
import {
  MAX_DAYS,
  MAX_STOPS,
  insertRideGraph,
  normalize,
  ridePayload,
  rideTotals,
  type RidePayload,
} from '../maps/ride-graph'

export const builderRoutes = new Hono<AuthEnv>()

// A native ride is DB rows, not files — caps bound the rows since byte quota
// does not apply. 8 MB JSON backstop over the structural caps.
const BODY_LIMIT = 8 * 1024 * 1024
async function parseRideBody(
  c: Context<AuthEnv>,
): Promise<{ data: RidePayload; error?: never } | { data?: never; error: string }> {
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    return { error: 'invalid JSON body' }
  }
  const parsed = ridePayload.safeParse(raw)
  if (!parsed.success) return { error: firstIssue(parsed.error) }
  normalize(parsed.data)
  return { data: parsed.data }
}

// --- API -------------------------------------------------------------------

const jsonLimit = bodyLimit({ maxSize: BODY_LIMIT, onError: (c) => c.json({ error: 'payload too large' }, 413) })

builderRoutes.post('/api/rides', requireActiveApi, requireSameOrigin, jsonLimit, async (c) => {
  const user = currentUser(c)

  // Same bot gate as import: enforced once Turnstile keys are set. The token
  // rides in the X-Turnstile-Token header for JSON requests.
  if (turnstileEnabled()) {
    const token = c.req.header('X-Turnstile-Token') ?? ''
    if (!(await verifyTurnstile(token, c.req.header('CF-Connecting-IP')))) {
      return c.json({ error: 'bot check failed—reload and try again' }, 403)
    }
  }

  const body = await parseRideBody(c)
  if (!body.data) return c.json({ error: body.error }, 400)
  const p = body.data

  const created = await db.transaction(async (tx) => {
    const [ride] = await tx
      .insert(rides)
      .values({
        ownerId: user.id,
        slug: generateSlug(),
        title: p.title,
        description: p.description || null,
        visibility: p.visibility,
        source: 'native',
        externalUrl: p.external_url || null,
        ...rideTotals(p),
      })
      .returning()
    await insertRideGraph(tx, ride.id, p)
    return ride
  })
  console.log(`[rides] user ${user.id} created ride ${created.id} (${created.stopCount} stops)`)
  return c.json({ id: created.id, slug: created.slug }, 201)
})

// Clone a public ride into the caller's account as a private draft.
//
// Reads the stored graph and rebuilds it through the same insertRideGraph the
// builder's save uses, so a clone is a first-class native ride rather than a
// second representation that drifts.
//
// Deliberately dropped:
//   - descriptions, on the ride and on every stop. Those are the author's
//     writing, and stop notes are where "gate code 4417, park behind the barn"
//     lives. Copying them hands one rider's private notes to a stranger.
//   - visibility. A clone lands private no matter what the original was; making
//     it public is a decision the new owner takes deliberately.
//   - via points, which are shaping for a route the cloner will now edit.
builderRoutes.post('/api/rides/:id/clone', requireActiveApi, requireSameOrigin, async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'not found' }, 404)

  const [src] = await db
    .select()
    .from(rides)
    .where(and(eq(rides.id, id), LIVE_RIDE))
    .limit(1)
  // canClone, not `visibility === 'public'` written out. Two levels are
  // clonable now — public, and friends by a friend — and which they are is
  // src/access/policy.ts's call, shared with the button on the viewer page that
  // offers this endpoint. A button and a gate that disagree is a Clone that
  // 404s, or worse.
  //
  // The `source !== 'native'` half of the old test is gone and stays gone: it
  // was there because an imported ride's graph could not be rebuilt into
  // something the builder would open, which stopped being true when the import
  // started splitting its track into real legs.
  if (!src || !canClone(src, user, await grantsFor(src, user))) {
    return c.json({ error: 'not found' }, 404)
  }

  const srcRoutes = await db.select().from(daysTable).where(eq(daysTable.rideId, src.id)).orderBy(daysTable.position)

  const payloadDays = []
  for (const r of srcRoutes) {
    const pts = await db.select().from(pointsTable).where(eq(pointsTable.dayId, r.id)).orderBy(pointsTable.position)
    const legs = await db.select().from(routeLegs).where(eq(routeLegs.dayId, r.id)).orderBy(routeLegs.position)

    const point = (p: (typeof pts)[number]) => ({
      lat: p.lat,
      lng: p.lng,
      name: p.name,
      description: '',
      roles: p.roles,
      // A clone gets FRESH identities and NO private details, and both halves of
      // that are deliberate.
      //
      // `details: null` is a privacy boundary, not a tidiness choice. A public
      // ride is clonable by anyone, and its author's confirmation numbers, gate
      // codes and phone numbers are exactly what point_details exists to keep
      // off a stranger's screen. Copying them here would hand them over wholesale
      // — the one place a clone could leak what `ride.json` is careful not to.
      //
      // `uid: null` follows from it: the new ride mints its own, so nothing ties
      // a cloned stop back to the original's details row.
      uid: null,
      details: null,
    })

    payloadDays.push({
      title: r.title,
      color: r.color,
      // Times belong to the ride the author planned, not to whenever the cloner
      // rides it. The timeline re-derives from legs and stops either way.
      startAt: null,
      endAt: null,
      // Kept, unlike the times and the via-points above. An alternate is part of
      // what the author planned — "here are two ways to do Thursday" is the
      // thing being cloned, not incidental state — and dropping it would both
      // lose that and hand the clone a bigger mileage than the original, because
      // the losing alternates would become ordinary days.
      altGroup: r.altGroup,
      altActive: r.altActive,
      // ONE ORDERED LIST, and the read above is already ordered by position,
      // so the rider's own sequence clones intact. Both kinds carry a duration,
      // so a clone keeps the POI dwell too — dropping it would quietly shorten
      // every cloned day.
      points: pts.map((p) => ({ ...point(p), kind: p.kind, durationMin: p.durationMin })),
      legs: legs.map((l) => ({
        geometry: l.geometry,
        distanceM: l.distanceM,
        durationS: l.durationS,
        viaPoints: [],
      })),
    })
  }

  const p: RidePayload = {
    title: src.title,
    description: '',
    visibility: 'private',
    external_url: '',
    days: payloadDays,
  }

  const created = await db.transaction(async (tx) => {
    const [ride] = await tx
      .insert(rides)
      .values({
        ownerId: user.id,
        slug: generateSlug(),
        title: p.title,
        description: null,
        visibility: 'private',
        source: 'native',
        externalUrl: null,
        ...rideTotals(p),
      })
      .returning()
    await insertRideGraph(tx, ride.id, p)
    return ride
  })

  console.log(`[rides] user ${user.id} cloned ride ${src.id} -> ${created.id}`)
  return c.json({ id: created.id, slug: created.slug }, 201)
})

// THIS CHURNS EVERY POINT AND DAY ID, ON PURPOSE, AND THE BUILDER NOW CALLS IT
// CONSTANTLY. Decided 2026-08-15 while planning autosave (#89): the full replace
// below deletes the ride's days — cascading to points and legs — and re-inserts
// them, so `points.id` and `days.id` are different rows after every save. The
// builder used to save when a rider pressed a button, perhaps a dozen times in a
// session; it now flushes on idle, which is two orders of magnitude more often.
//
// That is still safe TODAY for exactly one reason: nothing anywhere references a
// point across a save. The client payload carries no ids, the exports rebuild
// from the graph, and the roadbook reads it whole.
//
// It stops being safe the moment anything does — rich stop details (#15), a
// comment on a stop, a photo attached to one. **Any feature that needs a point
// to keep its identity has to fix this first**, and the fix is not small: send
// ids in the payload, diff here, and update in place, which rewrites
// insertRideGraph, ridePayload and loadRidePayload — the path the native JSON
// import shares. Do not add the reference and hope; the failure is silent and
// looks like data that wandered off.
builderRoutes.put('/api/rides/:id', requireActiveApi, requireSameOrigin, jsonLimit, async (c) => {
  const user = currentUser(c)
  const ride = await ownRide(user.id, c.req.param('id'))
  if (!ride) return c.json({ error: 'not found' }, 404)

  const body = await parseRideBody(c)
  if (!body.data) return c.json({ error: body.error }, 400)
  const p = body.data

  await db.transaction(async (tx) => {
    await tx
      .update(rides)
      .set({
        title: p.title,
        description: p.description || null,
        visibility: p.visibility,
        externalUrl: p.external_url || null,
        ...rideTotals(p),
        updatedAt: new Date(),
      })
      .where(eq(rides.id, ride.id))
    // Full replace: routes cascade to points and legs.
    await tx.delete(daysTable).where(eq(daysTable.rideId, ride.id))
    await insertRideGraph(tx, ride.id, p)
  })
  return c.json({ id: ride.id, slug: ride.slug })
})

// Owner load for the builder — the same shape PUT accepts, vias included.
builderRoutes.get('/api/rides/:id', requireActiveApi, async (c) => {
  const user = currentUser(c)
  const ride = await ownRide(user.id, c.req.param('id'))
  if (!ride) return c.json({ error: 'not found' }, 404)
  return c.json(await loadRidePayload(ride))
})

export async function loadRidePayload(ride: RideRow) {
  // Owner-only by construction: every caller reaches this behind `ownRide()`.
  // detailsForOwner and not detailsForViewer for that reason — the check has
  // already happened, and doing it twice would mean two places to get it wrong.
  const details = await detailsForOwner(ride.id)
  const dayRows = await db.select().from(daysTable).where(eq(daysTable.rideId, ride.id)).orderBy(daysTable.position)
  const out = {
    id: ride.id,
    slug: ride.slug,
    source: ride.source,
    title: ride.title,
    description: ride.description ?? '',
    visibility: ride.visibility,
    external_url: ride.externalUrl ?? '',
    days: [] as unknown[],
  }
  for (const r of dayRows) {
    const pts = await db.select().from(pointsTable).where(eq(pointsTable.dayId, r.id)).orderBy(pointsTable.position)
    const legs = await db.select().from(routeLegs).where(eq(routeLegs.dayId, r.id)).orderBy(routeLegs.position)
    out.days.push({
      title: r.title,
      color: r.color,
      startAt: r.startAt?.toISOString() ?? null,
      endAt: r.endAt?.toISOString() ?? null,
      // Omitting these is how a saved alternate grouping silently disappears on
      // the next page load — the same trap the durationMin comment below names,
      // and worse here because the ride's mileage would jump at the same time.
      // This function names every field it carries; nothing is spread.
      altGroup: r.altGroup,
      altActive: r.altActive,
      // uid and details go out here and are sent straight back by the next
      // save. Omitting either is how a stop's confirmation number silently
      // disappears: without the uid the save mints a new one and orphans the
      // details row, and without the details the reconcile pass reads the stop
      // as cleared and deletes it.
      // ONE ORDERED LIST, in the rider's own order — the read above is ordered
      // by position, which is now set for both kinds. The two arms this
      // replaced were field-for-field identical apart from the filter, which is
      // the clearest sign the split was never carrying its weight.
      points: pts.map((p) => ({
        kind: p.kind,
        lat: p.lat,
        lng: p.lng,
        name: p.name,
        description: p.description ?? '',
        roles: p.roles,
        durationMin: p.durationMin,
        uid: p.uid,
        details: details.get(p.uid) ?? null,
      })),
      legs: legs.map((l) => ({
        geometry: l.geometry,
        distanceM: l.distanceM,
        durationS: l.durationS,
        viaPoints: l.viaPoints,
      })),
    })
  }
  return out
}

// --- Builder pages ---------------------------------------------------------

// The rider's saved home, but only if they asked for it and it geocoded. Gating
// on the server rather than in builder.js is deliberate: the edit route below
// never loads this, so an existing ride cannot grow a home stop on every save
// even if the client logic were wrong.
async function homeSeed(userId: number): Promise<{ lat: number; lng: number } | null> {
  const [p] = await db
    .select({ lat: userProfiles.homeLat, lng: userProfiles.homeLng })
    .from(userProfiles)
    .where(and(eq(userProfiles.userId, userId), eq(userProfiles.addHomeToRides, true)))
    .limit(1)
  return p?.lat != null && p?.lng != null ? { lat: p.lat, lng: p.lng } : null
}

// Everything the builder needs off the rider's profile that is NOT the home
// seed, in one read. Two things travel together here because they come off the
// same row and the alternative was two round trips on the app's busiest page;
// they are otherwise unrelated and the comments below are per field.
//
//   publicStart — the public starting point, sent to every builder page rather
//   than only the new-ride one: an existing ride can be made public at any time,
//   and that is exactly when the swap is offered. Unlike homeSeed it is not
//   gated on a preference — it is not seeding anything, only standing by in case
//   a home-started ride is about to be shared.
//
//   durationFormat — how the stop duration field reads. Defaulted through
//   toDurationFormat rather than trusted, because a rider with no profile row at
//   all gets undefined here and every reader has to agree on what that means.
type PublicStart = { lat: number; lng: number; label: string }
type BuilderPrefs = { publicStart: PublicStart | null; durationFormat: DurationFormat }

async function builderPrefs(userId: number): Promise<BuilderPrefs> {
  const [p] = await db
    .select({
      lat: userProfiles.startLat,
      lng: userProfiles.startLng,
      label: userProfiles.startLabel,
      durationFormat: userProfiles.durationFormat,
    })
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId))
    .limit(1)
  return {
    publicStart:
      p?.lat == null || p?.lng == null ? null : { lat: p.lat, lng: p.lng, label: p.label?.trim() || 'Meeting point' },
    durationFormat: toDurationFormat(p?.durationFormat),
  }
}

builderRoutes.get('/builder', requireActive, async (c) => {
  const user = currentUser(c)
  const [home, prefs] = await Promise.all([homeSeed(user.id), builderPrefs(user.id)])
  return c.html(builderHtml(null, user, home, prefs))
})

builderRoutes.get('/builder/:id', requireActive, async (c) => {
  const user = currentUser(c)
  const ride = await ownRide(user.id, c.req.param('id'))
  if (!ride) return c.text('Not found', 404)
  // Same predicate the viewer's edit button reads, so the button and this gate
  // cannot drift into offering an action that is then refused. It no longer
  // refuses an imported ride — see canEditRide in ./maps.
  if (!canEditRide(ride, user)) return c.text('Not found', 404)
  return c.html(builderHtml(ride.id, user, null, await builderPrefs(user.id)))
})

function builderHtml(
  rideId: number | null,
  user: UserRow,
  home: { lat: number; lng: number } | null,
  prefs: BuilderPrefs,
): string {
  // The day slider is a focus control, not a navigation one: every day stays
  // drawn on the map at all times and the slider only changes which one is
  // emphasized. Seeing the whole ride on one map is the product.
  // Three bands, each naming the scope of what it holds: the ride, the day
  // across all its days, and the one day being edited. Before this the panel was
  // a flat run of divs and nothing said whether a given control changed one day
  // or the whole ride — the day scrubber sat next to the day's own color
  // picker, and the ride timeline sat between two day-level blocks.
  //
  // THE RIDE TIMELINE IS NO LONGER IN HERE. It moved to a bar across the bottom
  // edge of the map on 2026-08-15 — see rideTimeline() in src/views/layout.tsx
  // and .map-timeline in style/_map.scss. What is left in the second ride band is
  // the day scrubber alone, and the two are not the same control: the scrubber
  // picks which day you are EDITING and belongs beside the edit controls, the
  // timeline moves through what you are LOOKING AT and belongs over the map.
  // That split is what issue #93 asked for.
  //
  // THERE IS NO SAVE BUTTON, and no Discard either. The builder autosaves on
  // idle — see the autosave block in public/js/builder.js for the timing and for
  // the two conditions that hold a flush. What is left in .builder-actions is
  // undo, redo, a status readout and the link to the public page.
  //
  // Two details in that row are load-bearing rather than cosmetic, both serving
  // the rule that nothing in the panel changes size as its value changes:
  //
  //   #save-status is aria-hidden and #save-announce below it is the live
  //   region. A polite region on the readout itself would say "Unsaved changes,
  //   Saving, Saved" aloud on every edit burst — three announcements a minute
  //   for something a sighted rider takes in peripherally. The live region
  //   speaks only for an error or a blocked save, which are the states that
  //   need acting on. Its width is fixed in _builder.scss for the same reason.
  //
  //   #view-link ships from first paint and is revealed by the first successful
  //   save, using visibility rather than the hidden attribute. An element that
  //   appeared would shove the status beside it, which is the exact jump this
  //   whole epic is about.
  const contents = `        <div class="panel-band panel-band--ride">
          <textarea id="ride-description" name="description" maxlength="2000" placeholder="Description (optional)" rows="2"></textarea>
          <div class="meta-row">
            <select id="ride-visibility" name="visibility" title="Visibility">
              <option value="private" selected>Private</option>
              <option value="friends">Friends</option>
              <option value="unlisted">Unlisted</option>
              <option value="public">Public</option>
            </select>${faqLink('visibility', 'private, friends, unlisted and public')}
            ${faqLink('waypoint-poi-stop', 'the difference between a stop and a POI')}
            <button type="button" class="day-add" id="day-add" title="Add a day">+ Day</button>
          </div>
        </div>

        <!-- Select mode's action bar, filled by renderSelectBar() in builder.js
             and hidden whenever state.select is null. It sits above the day list
             rather than floating over it so it cannot cover the very rows being
             ticked, and it is outside the scroller so it stays put while the
             rider scrolls down to reach day 9. -->
        <div class="select-bar" id="select-bar" hidden></div>

        <!-- THE SEARCH BOX THAT WAS HERE IS GONE, and its absence is the point.
             One field above the day list had to guess which day a searched
             address belonged to, and it guessed "whichever you touched last" —
             invisible until it is wrong, which is the moment you scroll to day
             4, type an address and watch it land on day 2.

             Every day now ends in its own search row, built by addRowHtml() in
             builder.js, which knows its day and says so. The results dropdown
             is created once on demand and moved to whichever row is asking; it
             is not in this markup because no row owns it. -->

        <!-- EVERY DAY, ALL THE TIME. This was one #day-band showing whichever day
             a slider at the bottom of the drawer had selected; the slider is gone
             and renderDays() in builder.js fills this with one .day-section per
             day instead. A fixed-height drawer has room to show the whole ride, so
             hiding all but one of its days was a constraint of the old floating
             panel rather than a decision.

             The per-day controls are CLASSES now, not ids—there are N of each —
             and every section and row carries data-day. wireDays() delegates on
             this container and reads that attribute, which is also what keeps the
             existing edit handlers correct: touching anything inside a section
             makes that day active first, so editIndex() resolves to it. -->
        <div class="day-list" id="day-list" data-duration-format="${prefs.durationFormat}"></div>

        <p class="day-empty-hint" id="day-empty-hint" hidden>No days yet.</p>
${
  // ONLY ON AN EXISTING RIDE. A ride that has never been saved has nothing to
  // delete — closing the tab already discards it — and a Delete button on a
  // blank builder is an offer to destroy something that does not exist.
  //
  // AT THE BOTTOM OF THE PANEL, not in the meta-row beside the visibility select
  // and + Day, and not in the action bar beside undo/redo. Both of those are
  // rows a rider's pointer lives in while building, and a destructive control
  // wants distance from the ones pressed by reflex. The end of the day list is
  // where a rider goes deliberately.
  rideId
    ? `        <div class="builder-danger">
          <button type="button" id="ride-delete" class="linkbtn">Delete this ride</button>
          <span class="builder-danger-note">Moves it to the recycle bin for ${TRASH_HOLD_DAYS} days.</span>
        </div>`
    : ''
}

        <span id="save-announce" class="visually-hidden" role="status" aria-live="polite"></span>
        <div id="recover-bar" class="tb-banner is-recover" hidden>
          <span id="recover-text"></span>
          <button id="recover-yes" class="linkbtn" type="button">Restore</button>
          <button id="recover-no" class="linkbtn" type="button">Discard</button>
        </div>`

  // THE RIDE'S NAME IS THE HEADING. It used to say "Edit ride" on the most
  // prominent line in the panel and put the actual name in an input below it,
  // spending the largest type in the app on a label the rider already knew — and
  // on a new ride there was no heading at all, so a collapsed panel showed
  // nothing. The viewer has always titled itself with the ride's name; this is
  // the builder catching up, with the difference that its copy is editable.
  //
  // The input IS the heading rather than something a pencil reveals. A reveal
  // would be a second mode and a layout jump, which is the exact thing item 16
  // exists to remove; instead the field is styled as the heading, carries no
  // border until it is hovered or focused, and shows the pencil as an affordance.
  // Nothing moves when it is edited.
  //
  // The summary line follows it, out of the band below both sliders where it
  // used to sit. Both are outside .panel-contents-wrapper, so they stay put while
  // the stop list scrolls — renderTotals() writes #totals by id and did not care
  // that it moved.
  //
  // IT IS A TEXTAREA, NOT A TEXT INPUT, and that is the only way to have it wrap.
  // An <input> is a single-line replaced element by definition: it will ellipsize
  // a long name but it will never break one onto a second line, so a rider naming
  // a ride "Big Sur and back the inland way" saw about half of it. The heading
  // came down 25% at the same time and now runs to two lines before it truncates.
  //
  // Being a textarea costs three things, all handled in builder.js: Enter has to
  // be swallowed or it puts a newline in a ride's name, pasted newlines have to be
  // flattened, and the height has to be set from scrollHeight on every edit since
  // a textarea does not size itself. `rows="1"` is the floor that fitTitle()
  // grows from; the two-line ceiling is a max-height in _builder.scss.
  const titleHtml = `<textarea id="ride-title" name="title" maxlength="150" rows="1" wrap="soft"
             placeholder="${rideId ? 'Untitled ride' : 'Plan a ride'}" autocomplete="off" spellcheck="false"
             aria-label="Ride name" title="Ride name—click to edit"></textarea>
          <div class="totals" id="totals"></div>`

  // PINNED TO THE DRAWER'S BOTTOM EDGE, not scrolled with the day list.
  // It was `position: sticky; bottom: 0` inside .panel-contents-wrapper, which
  // is close but not the same thing: a sticky element still belongs to the
  // scroller, so it sat above the scrollbar and shifted with the list's own
  // padding. As the drawer's footer it is a sibling of the scroller and cannot
  // move at all.
  const builderActions = `<div class="builder-actions">
          <!-- TWO DRAWN FILES, not one mirrored with scaleX(-1), which is what
               this was until 2026-08-16. The argument for mirroring was that a
               second file is a second chance for the arrowheads to land at
               different angles—but icon-redo.svg is drawn as a true reflection
               of icon-undo.svg (compare the two paths: the same numbers at
               500 − x), so the risk it guarded against is not present, and a
               real file beats a transform that has to be remembered.

               They are .tb-inline-icon rather than <img>, so hydrateIcons() in
               builder.js inlines the SVG and its fill="currentColor" can take
               the button's color—including the 0.35 opacity of the disabled
               state. An <img> cannot inherit color and would stay black while
               the button grayed out around it. -->
          <button id="undo" class="btn-icon" type="button" disabled title="Nothing to undo" aria-label="Undo"><span class="tb-inline-icon" data-icon="icon-undo.svg"></span></button>
          <button id="redo" class="btn-icon" type="button" disabled title="Nothing to redo" aria-label="Redo"><span class="tb-inline-icon" data-icon="icon-redo.svg"></span></button>
          <span id="save-status" class="save-status" data-state="new" aria-hidden="true">
            <span class="save-dot"></span>
            <span class="save-text">Not saved yet</span>
          </span>
          <a id="view-link" class="view-link is-empty" href="#" target="_blank" rel="noopener">View</a>
        </div>`

  return page({
    title: rideId ? 'Edit ride' : 'Plan a ride',
    user,
    variant: 'map',
    bodyClass: 'builder-page',
    navKey: 'builder',
    // The floating way into the intake. 'planning' matches areaFromPath() in
    // src/feedback/policy.ts, which is what the account-menu path infers.
    feedbackArea: 'planning',
    noscript: 'JavaScript is required to plan a ride.',
    body: `  <div id="map"></div>\n\n  ${panelShell({
      titleHtml,
      extraClass: 'builder-panel',
      contents,
      footer: builderActions,
      // THE FOOTER IS THE ACTION BAR. The day scrubber lived here for about an hour on 2026-08-16,
      // pinned to the drawer's bottom edge so it could not be shoved around by
      // the day band it selected. Showing every day at once removed the thing it
      // selected between, so the control went with it.
      //
      // The rail keeps a dot per day, but as a jump-to rather than a picker:
      // clicking one scrolls that day's section into view and makes it active.
      rail: `<div class="rail-days" id="rail-days"></div>`,
    })}\n\n  ${rideTimeline()}`,
    tb: {
      gmapsKey: GMAPS_KEY,
      mapId: GMAPS_MAP_ID,
      roles: ROLE_META,
      dayColors: DAY_COLORS,
      rideId,
      home,
      publicStart: prefs.publicStart,
      durationFormat: prefs.durationFormat,
    },
    // SortableJS drives drag-to-reorder on the stop list. Pinned to an exact
    // version with an SRI hash and crossorigin, so jsdelivr serving anything but
    // the 1.15.7 bytes gets refused rather than executed. MIT, 45KB, and the
    // version is 2026-02-11 rather than the stale release it is often assumed to
    // be. Approved as a dependency 2026-08-15.
    //
    // `defer` scripts run in document order, so this is loaded ahead of
    // builder.js and window.Sortable exists by the time initDragToReorder()
    // looks for it. **If the CDN fails, the builder still works** — that
    // function checks for the global and returns quietly, and every row's menu
    // carries Move up / Move down regardless. Those are also the keyboard path,
    // because a drag handle is not one.
    scripts: `${googleMapsLoader(GMAPS_KEY)}
  <script src="https://cdn.jsdelivr.net/npm/sortablejs@1.15.7/Sortable.min.js" integrity="sha384-DgmC6Xe2bSN2WjTDXzWYbUbxyhNP+NNkGDR/g78pCXV7E7rcVTGxVg0uIVCUUcBc" crossorigin="anonymous" defer></script>
  <script src="${asset('/js/map-common.js')}" defer></script>
  <script src="${asset('/js/ride-time.js')}" defer></script>
  <script src="${asset('/js/duration.js')}" defer></script>
  <script src="${asset('/js/twist.js')}" defer></script>
  <script src="${asset('/js/builder-history.js')}" defer></script>
  <script src="${asset('/js/route-shape.js')}" defer></script>
  <script src="${asset('/js/alts.js')}" defer></script>
  <script src="${asset('/js/place-query.js')}" defer></script>
  <script src="${asset('/js/day-clock.js')}" defer></script>
  <script src="${asset('/js/builder.js')}" defer></script>`,
  })
}
