// The roster: who is on a ride, what they said, and how they vote.
//
// ONE PAGE PER RIDE at /m/:slug/riders, and it is still where every verb lives.
// The reason has not changed and is not about space: a rider who is NOT the
// owner has no builder to open and still needs somewhere to RSVP and vote, and
// most of what is here is a statement BY a rider rather than a decision by the
// planner.
//
// THE BUILDER HAS A RIDERS TAB AS OF 2026-08-26 and it is not a second copy of
// this page — see the JSON block at the foot of this file. It reads the roster
// and carries the two verbs that are about the PLAN (which approach a rider is
// on, and taking somebody off the ride); both call the same service functions
// the forms below do, so no gate is decided twice.
//
// SERVER-RENDERED FORMS for everything on the page itself — the same choice
// /trash and /friends made and for the same reason. Every verb here is one
// button press with no state to keep in sync, and a redirect back to the page is
// the interaction.
//
// The rules are src/members/policy.ts and src/votes/policy.ts. Nothing in this
// file decides whether a verb is allowed; it decides what to show.
import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import { db } from '../db/index'
import { days as daysTable, rides, rsvpEnum, type RideRole, type RideRow, type Rsvp } from '../db/schema'
import { currentUser, requireActive, requireActiveApi, requireSameOrigin, type AuthEnv } from '../auth/middleware'
import { canInvite, canRemove, canRsvp, isComing, RSVP_LABELS, type MemberFields } from '../members/policy'
import { invitableFriends, invite, removeMember, roleOf, roster, setRsvp, type RosterEntry } from '../members/service'
import { applyTallies, castVote, voteGroups, type VoteGroup } from '../votes/service'
import { bikesOnRide, groupRange, setBikeOnRide, type GroupRange } from '../bikes/group-range'
import { listBikes } from '../bikes/service'
import { bikeLabel } from '../bikes/policy'
import { assignRider, subgroupsOf } from '../subgroups/service'
import type { RideSubgroupRow } from '../db/schema'
import { hasVotes, votingOpen } from '../votes/policy'
import { LIVE_RIDE } from '../trash/service'
import { fmtDateFull } from '../views/date-format'
import { dateFormatFor } from '../views/prefs'
import type { DateFormat } from '../views/date-format'
import { page } from '../views/layout'
import { ownRide } from './maps'

export const rosterRoutes = new Hono<AuthEnv>()

/**
 * The ride, if this rider is on it.
 *
 * MEMBERSHIP, NOT VISIBILITY. A public ride is readable by anyone and its
 * roster is not — who is coming on a ride is a fact about people, and a share
 * link is permission to see a route. Answering not-found rather than forbidden,
 * the same as every other refusal that touches a slug.
 */
async function memberRide(slug: string, viewerId: number): Promise<{ ride: RideRow; role: 'owner' | 'rider' } | null> {
  const [ride] = await db
    .select()
    .from(rides)
    .where(and(eq(rides.slug, slug), LIVE_RIDE))
    .limit(1)
  if (!ride) return null
  const role = await roleOf(ride.id, viewerId)
  return role ? { ride, role } : null
}

const isRsvp = (v: unknown): v is Rsvp =>
  typeof v === 'string' && (rsvpEnum.enumValues as readonly string[]).includes(v)

function Verb({
  action,
  slug,
  fields,
  label,
  variant = '',
}: {
  action: string
  slug: string
  fields: Record<string, string | number>
  label: string
  variant?: string
}) {
  return (
    <form method="post" action={`/m/${slug}/riders/${action}`} class="roster-act">
      {Object.entries(fields).map(([k, v]) => (
        <input type="hidden" name={k} value={String(v)} />
      ))}
      <button class={`btn btn-sm${variant ? ` ${variant}` : ''}`} type="submit">
        {label}
      </button>
    </form>
  )
}

function RsvpForm({ slug, current }: { slug: string; current: Rsvp }) {
  return (
    <form method="post" action={`/m/${slug}/riders/rsvp`} class="roster-rsvp">
      <label class="visually-hidden" for="rsvp">
        Are you coming
      </label>
      {/* Submits on change rather than behind a Save button: it is a
          single-field form whose only possible next action is submitting it,
          and the <noscript> fallback below is what keeps it usable with the
          script off. */}
      <select id="rsvp" name="rsvp" onchange="this.form.submit()">
        {rsvpEnum.enumValues.map((v) => (
          <option value={v} selected={v === current}>
            {RSVP_LABELS[v]}
          </option>
        ))}
      </select>
      <noscript>
        <button class="btn btn-sm" type="submit">
          Save
        </button>
      </noscript>
    </form>
  )
}

function MemberRow({
  m,
  slug,
  viewerId,
  viewerRole,
  subgroups,
  canAssign,
}: {
  m: RosterEntry
  slug: string
  viewerId: number
  viewerRole: 'owner' | 'rider'
  subgroups: RideSubgroupRow[]
  canAssign: boolean
}) {
  const fields: MemberFields = { riderId: m.riderId, role: m.role, rsvp: m.rsvp }
  const isMe = m.riderId === viewerId
  return (
    <li class={isComing(fields) ? '' : 'is-out'}>
      <span class="roster-who">
        {m.username ? (
          <a class="rider-display" href={`/@${m.username}`}>
            {m.displayName}
          </a>
        ) : (
          <span class="rider-display">{m.displayName}</span>
        )}
        {m.role === 'owner' && <span class="roster-role">Owner</span>}
      </span>
      {/* Yours is a control; everybody else's is a fact. canRsvp says the same
          thing and this is it rendered — an owner who could edit a rider's
          answer would turn the roster from what people said into what the
          organizer wishes they had said. */}
      {/* WHICH APPROACH THEY ARE ON, and this one IS the owner's to set —
          unlike the RSVP beside it. Being on the Oakland run is a fact about
          the plan rather than a statement by the rider, and the planner is the
          one who knows it. Renders nothing on a ride with no subgroups. */}
      {subgroups.length > 0 &&
        (canAssign ? (
          <form method="post" action={`/m/${slug}/riders/group`} class="roster-rsvp">
            <input type="hidden" name="rider" value={String(m.riderId)} />
            <label class="visually-hidden" for={`sg-${m.riderId}`}>
              Which group {m.displayName} rides with
            </label>
            <select id={`sg-${m.riderId}`} name="group" onchange="this.form.submit()">
              <option value="">No group</option>
              {subgroups.map((g) => (
                <option value={String(g.id)} selected={m.subgroupId === g.id}>
                  {g.name}
                </option>
              ))}
            </select>
            <noscript>
              <button class="btn btn-sm" type="submit">
                Save
              </button>
            </noscript>
          </form>
        ) : (
          <span class="roster-said">{subgroups.find((g) => g.id === m.subgroupId)?.name ?? 'No group'}</span>
        ))}
      {isMe ? <RsvpForm slug={slug} current={m.rsvp} /> : <span class="roster-said">{RSVP_LABELS[m.rsvp]}</span>}
      {canRemove(viewerId, viewerRole, fields) && (
        <Verb
          action="remove"
          slug={slug}
          fields={{ rider: m.riderId }}
          label={isMe ? 'Leave' : 'Remove'}
          variant="btn-quiet"
        />
      )}
    </li>
  )
}

function Ballot({
  g,
  slug,
  dayTitles,
  open,
}: {
  g: VoteGroup
  slug: string
  dayTitles: Map<string, string>
  open: boolean
}) {
  const total = g.tallies.reduce((n, t) => n + t.votes, 0)
  return (
    <section class="ballot">
      <h3>
        Alternatives{' '}
        {hasVotes(g.tallies) && (
          <span class="ballot-total">
            {total} vote{total === 1 ? '' : 's'}
          </span>
        )}
      </h3>
      <ul class="ballot-list">
        {g.tallies.map((t) => (
          <li class={t.active ? 'is-active' : ''}>
            <span class="ballot-day">
              {dayTitles.get(t.uid) || 'Untitled day'}
              {t.active && <span class="roster-role">Riding this</span>}
            </span>
            {/* A count of zero is still shown here, unlike hasVotes above.
                Inside a ballot the zero is meaningful — this alternate is the
                one nobody picked — where a whole group of zeroes means voting
                has not started. */}
            <span class="ballot-count">{t.votes}</span>
            {open ? (
              <Verb
                action="vote"
                slug={slug}
                fields={{ day: t.uid }}
                label={g.mine === t.uid ? 'Your pick' : 'Pick this'}
                variant={g.mine === t.uid ? '' : 'btn-quiet'}
              />
            ) : (
              g.mine === t.uid && <span class="roster-said">Your pick</span>
            )}
          </li>
        ))}
      </ul>
      {open && g.mine && <p class="ballot-note">Press your own pick again to take it back.</p>}
    </section>
  )
}

function Deadline({ closeAt, dateFormat, open }: { closeAt: Date | null; dateFormat: DateFormat; open: boolean }) {
  if (!closeAt)
    return (
      <p class="ballot-note">The count is advisory. Nothing changes until you promote an alternative in the builder.</p>
    )
  return (
    <p class="ballot-note">
      {open ? 'Voting closes' : 'Voting closed'} {fmtDateFull(closeAt, dateFormat)}.
      {open && ' The alternative with the most votes is elected then; a tie leaves the current pick alone.'}
    </p>
  )
}

/**
 * #52, and the reason it needed both #11 and #12 to land first: a group is
 * limited by its SMALLEST tank, and the rider with a 120-mile range is the one
 * who ends up pushing.
 *
 * Says nothing when it knows nothing, rather than guessing — a fuel plan built
 * on an invented range is worse than no fuel plan because it looks like one.
 * And it says how many riders it could not account for, because a binding range
 * over two of five bikes is a different claim from one over all five.
 */
function Fuel({ range }: { range: GroupRange }) {
  if (range.riders === 0) return <></>
  if (range.miles === null) {
    return (
      <p class="roster-fuel is-quiet">
        Nobody coming has a range on file, so there is nothing to plan fuel stops around. Ranges live in the{' '}
        <a href="/profile">paddock</a>.
      </p>
    )
  }
  return (
    <p class="roster-fuel">
      Plan fuel stops around <strong>{range.miles} miles</strong> — {range.riderName}'s {range.bikeLabel} has the
      shortest range of anyone&nbsp;coming.
      {range.unknown > 0 && (
        <span class="roster-fuel-gap">
          {' '}
          {range.unknown} {range.unknown === 1 ? 'rider has' : 'riders have'} no range on file, so this could still be
          optimistic.
        </span>
      )}
    </p>
  )
}

rosterRoutes.get('/m/:slug/riders', requireActive, async (c) => {
  const user = currentUser(c)
  const found = await memberRide(c.req.param('slug'), user.id)
  if (!found) return c.text('Not found', 404)
  const { ride, role } = found

  const [members, groups, dayRows, friends, dateFormat, range, myGarage, subgroups] = await Promise.all([
    roster(ride.id),
    voteGroups(ride.id, user.id),
    db
      .select({ uid: daysTable.uid, title: daysTable.title, position: daysTable.position })
      .from(daysTable)
      .where(eq(daysTable.rideId, ride.id)),
    canInvite(role) ? invitableFriends(ride.id, user.id) : Promise.resolve([]),
    dateFormatFor(c),
    groupRange(ride.id),
    listBikes(user.id),
    subgroupsOf(ride.id),
  ])
  const dayTitles = new Map(dayRows.map((d) => [d.uid, d.title || `Day ${d.position + 1}`]))
  // From the roster rather than a second query: the row is already loaded and
  // `null` there means "my default", which the select renders as its first
  // option.
  const myBikeId = members.find((m) => m.riderId === user.id)?.bikeId ?? null
  const open = votingOpen(ride.altVotesCloseAt, new Date())
  const coming = members.filter(isComing).length
  const error = c.req.query('error')

  const body = (
    <>
      <p class="roster-back">
        <a href={`/m/${ride.slug}`}>← {ride.title}</a>
      </p>
      <h1>Riders</h1>
      <p class="lede">
        {coming} of {members.length} {members.length === 1 ? 'rider is' : 'riders are'} coming. A rider on this ride can
        see it whatever its visibility is set&nbsp;to.
      </p>

      {error && <p class="form-error">{ERRORS[error] ?? 'That did not work.'}</p>}

      <Fuel range={range} />

      <ul class="rider-list roster-list">
        {members.map((m) => (
          <MemberRow
            m={m}
            slug={ride.slug}
            viewerId={user.id}
            viewerRole={role}
            subgroups={subgroups}
            canAssign={role === 'owner'}
          />
        ))}
      </ul>

      {/* YOURS ONLY, the same rule the RSVP follows: which bike you are bringing
          is a statement about you. It is also what the fuel line above is
          computed from, so a rider changing it watches the number move — which
          is the whole feedback loop #52 wanted. */}
      {myGarage.length > 0 && (
        <form method="post" action={`/m/${ride.slug}/riders/bike`} class="roster-row">
          <label for="bike">Bringing</label>
          <select id="bike" name="bike" onchange="this.form.submit()">
            {/* "" is the default-bike fallback, and it is first because it is
                what every rider is until they say otherwise. */}
            <option value="">My default bike</option>
            {myGarage.map((b) => (
              <option value={String(b.id)} selected={myBikeId === b.id}>
                {bikeLabel(b)}
              </option>
            ))}
          </select>
          <noscript>
            <button class="btn btn-sm" type="submit">
              Save
            </button>
          </noscript>
        </form>
      )}

      {canInvite(role) && (
        <section class="roster-invite">
          <h2>Add a rider</h2>
          {friends.length > 0 ? (
            <form method="post" action={`/m/${ride.slug}/riders/invite`} class="roster-row">
              <label class="visually-hidden" for="who">
                Which friend
              </label>
              <select id="who" name="handle">
                {friends.map((f) => (
                  <option value={f.username}>
                    {f.displayName} (@{f.username})
                  </option>
                ))}
              </select>
              <button class="btn btn-sm" type="submit">
                Add
              </button>
            </form>
          ) : (
            <p class="empty">
              {/* The whole invite mechanism, said in one line rather than
                  discovered by pressing something that refuses. */}
              Everyone you are friends with is already here. Add more on the <a href="/friends">friends</a> page — you
              can only put a friend on a ride.
            </p>
          )}
        </section>
      )}

      {groups.length > 0 && (
        <section class="roster-votes">
          <h2>The vote</h2>
          <Deadline closeAt={ride.altVotesCloseAt} dateFormat={dateFormat} open={open} />
          {groups.map((g) => (
            <Ballot g={g} slug={ride.slug} dayTitles={dayTitles} open={open} />
          ))}
          {role === 'owner' && (
            <div class="roster-row roster-owner-acts">
              <Verb action="resolve" slug={ride.slug} fields={{}} label="Apply the votes now" variant="btn-quiet" />
              <form method="post" action={`/m/${ride.slug}/riders/deadline`} class="roster-act">
                <label class="visually-hidden" for="close">
                  Close voting at
                </label>
                <input id="close" name="closeAt" type="datetime-local" value={localValue(ride.altVotesCloseAt)} />
                <button class="btn btn-sm btn-quiet" type="submit">
                  {ride.altVotesCloseAt ? 'Change the deadline' : 'Set a deadline'}
                </button>
              </form>
            </div>
          )}
        </section>
      )}
    </>
  ).toString()

  return c.html(page({ title: `${ride.title} – riders`, user, bodyClass: 'content-page roster-page', body }))
})

/**
 * A deadline is a WALL CLOCK at the ride, carried as UTC — the same rule
 * days.start_at follows, and for the same reason: a vote closing "at 6pm" means
 * 6pm where the ride is, whoever set it and wherever they are. Nothing here
 * converts it into anyone's local time, so the digits typed are the digits
 * stored and every surface reads it back with timeZone: 'UTC'.
 */
const localValue = (d: Date | null): string => (d ? d.toISOString().slice(0, 16) : '')

const ERRORS: Record<string, string> = {
  'not-owner': 'Only the ride owner can do that.',
  'not-a-friend': 'You can only add a rider you are friends with.',
  'already-on': 'They are already on this ride.',
  full: 'This ride is full.',
  'unknown-rider': 'No such rider.',
  closed: 'Voting has closed on this ride.',
  'not-an-alternate': 'That day is not one of a set of alternatives.',
  refused: 'That is not something you can do here.',
}

/** Every verb lands back on the roster, with the refusal in the query string
 *  rather than as a status code — this is a form post from a page, and a bare
 *  403 would replace the roster with an error document. */
const back = (slug: string, error?: string) => `/m/${slug}/riders${error ? `?error=${error}` : ''}`

rosterRoutes.post('/m/:slug/riders/invite', requireActive, requireSameOrigin, async (c) => {
  const user = currentUser(c)
  const found = await memberRide(c.req.param('slug'), user.id)
  if (!found) return c.text('Not found', 404)
  const form = await c.req.parseBody()
  const handle = typeof form.handle === 'string' ? form.handle.trim() : ''
  if (!handle) return c.redirect(back(found.ride.slug), 303)
  const res = await invite(found.ride.id, user.id, handle)
  return c.redirect(back(found.ride.slug, res.ok ? undefined : res.reason), 303)
})

rosterRoutes.post('/m/:slug/riders/remove', requireActive, requireSameOrigin, async (c) => {
  const user = currentUser(c)
  const found = await memberRide(c.req.param('slug'), user.id)
  if (!found) return c.text('Not found', 404)
  const form = await c.req.parseBody()
  const rider = Number(form.rider)
  const ok = Number.isInteger(rider) && (await removeMember(found.ride.id, user.id, rider))
  // Leaving takes away the page you are standing on, so a rider who removed
  // themselves goes to the ride rather than to a roster that will 404 at them.
  if (ok && rider === user.id) return c.redirect(`/m/${found.ride.slug}`, 303)
  return c.redirect(back(found.ride.slug, ok ? undefined : 'refused'), 303)
})

rosterRoutes.post('/m/:slug/riders/rsvp', requireActive, requireSameOrigin, async (c) => {
  const user = currentUser(c)
  const found = await memberRide(c.req.param('slug'), user.id)
  if (!found) return c.text('Not found', 404)
  const form = await c.req.parseBody()
  const ok = isRsvp(form.rsvp) && (await setRsvp(found.ride.id, user.id, form.rsvp))
  return c.redirect(back(found.ride.slug, ok ? undefined : 'refused'), 303)
})

// WHICH BIKE I AM BRINGING. Mine only — setBikeOnRide is owner-scoped over the
// bikes as well as over the membership, so a forged id cannot pull somebody
// else's machine into the group's range calculation or onto this page.
rosterRoutes.post('/m/:slug/riders/bike', requireActive, requireSameOrigin, async (c) => {
  const user = currentUser(c)
  const found = await memberRide(c.req.param('slug'), user.id)
  if (!found) return c.text('Not found', 404)
  const form = await c.req.parseBody()
  const raw = typeof form.bike === 'string' ? form.bike.trim() : ''
  // '' is the default-bike fallback and is a real answer, not a missing one.
  const bikeId = raw === '' ? null : Number(raw)
  if (bikeId !== null && !Number.isInteger(bikeId)) return c.redirect(back(found.ride.slug, 'refused'), 303)
  const ok = await setBikeOnRide(found.ride.id, user.id, bikeId)
  return c.redirect(back(found.ride.slug, ok ? undefined : 'refused'), 303)
})

// WHICH APPROACH A RIDER IS ON. Owner-only, and that is the difference from the
// RSVP: being on the Oakland run is a fact about the plan rather than a
// statement by the rider, and the planner is the one who knows it.
rosterRoutes.post('/m/:slug/riders/group', requireActive, requireSameOrigin, async (c) => {
  const user = currentUser(c)
  const found = await memberRide(c.req.param('slug'), user.id)
  if (!found) return c.text('Not found', 404)
  if (found.role !== 'owner') return c.redirect(back(found.ride.slug, 'not-owner'), 303)
  const form = await c.req.parseBody()
  const rider = Number(form.rider)
  const raw = typeof form.group === 'string' ? form.group.trim() : ''
  const groupId = raw === '' ? null : Number(raw)
  if (!Number.isInteger(rider) || (groupId !== null && !Number.isInteger(groupId))) {
    return c.redirect(back(found.ride.slug, 'refused'), 303)
  }
  // Scoped to this ride's own subgroups, so an id from another ride cannot be
  // written onto a member row here. The FK would accept it — it points at
  // ride_subgroups and not at these ride's rows — and every reader downstream
  // would then see a rider on an approach that is not part of their ride.
  const mine = (await subgroupsOf(found.ride.id)).some((g) => g.id === groupId)
  if (groupId !== null && !mine) return c.redirect(back(found.ride.slug, 'refused'), 303)
  await assignRider(found.ride.id, rider, groupId)
  return c.redirect(back(found.ride.slug), 303)
})

rosterRoutes.post('/m/:slug/riders/vote', requireActive, requireSameOrigin, async (c) => {
  const user = currentUser(c)
  const found = await memberRide(c.req.param('slug'), user.id)
  // Membership IS the vote gate — canVote is `role !== null`, which memberRide
  // has already established. Never the public share link: a public ride would
  // otherwise let anyone on the internet pick which road it takes.
  if (!found) return c.text('Not found', 404)
  const form = await c.req.parseBody()
  const day = typeof form.day === 'string' ? form.day : ''
  const res = await castVote(found.ride.id, user.id, day)
  return c.redirect(back(found.ride.slug, res.ok ? undefined : res.reason), 303)
})

rosterRoutes.post('/m/:slug/riders/resolve', requireActive, requireSameOrigin, async (c) => {
  const user = currentUser(c)
  const found = await memberRide(c.req.param('slug'), user.id)
  if (!found) return c.text('Not found', 404)
  if (found.role !== 'owner') return c.redirect(back(found.ride.slug, 'not-owner'), 303)
  // The same applyTallies the sweep calls, so a pressed resolution and a
  // scheduled one cannot disagree about what the votes said.
  await applyTallies(found.ride.id)
  return c.redirect(back(found.ride.slug), 303)
})

rosterRoutes.post('/m/:slug/riders/deadline', requireActive, requireSameOrigin, async (c) => {
  const user = currentUser(c)
  const found = await memberRide(c.req.param('slug'), user.id)
  if (!found) return c.text('Not found', 404)
  if (found.role !== 'owner') return c.redirect(back(found.ride.slug, 'not-owner'), 303)
  const form = await c.req.parseBody()
  const raw = typeof form.closeAt === 'string' ? form.closeAt.trim() : ''
  // An empty field clears the deadline, which returns the ride to an advisory
  // tally. `${raw}:00Z` rather than new Date(raw): a datetime-local value has no
  // zone, so parsing it plainly would read it in the SERVER's zone and store an
  // instant that drifts with TZ — the trap days.start_at documents at length.
  const closeAt = raw ? new Date(`${raw}:00Z`) : null
  if (closeAt && Number.isNaN(closeAt.getTime())) return c.redirect(back(found.ride.slug, 'refused'), 303)
  await db.update(rides).set({ altVotesCloseAt: closeAt }).where(eq(rides.id, found.ride.id))
  return c.redirect(back(found.ride.slug), 303)
})

// --- The builder's Riders tab, over JSON ------------------------------------
//
// THREE ROUTES, NOT A SECOND ROSTER. The page above is still where a rider
// RSVPs, picks a bike, is invited and votes — every verb that is a statement by
// the rider rather than a decision about the plan. What the builder gets is the
// read, plus the two verbs that ARE about the plan: which approach a rider is
// on, and taking somebody off the ride.
//
// Both writes call the same service functions the forms above call, so
// src/members/policy.ts and the ride-scoping check on a subgroup id are decided
// in exactly one place. A JSON arm that re-implemented either gate is the drift
// this file's header warns about.
//
// GATED BY OWNERSHIP RATHER THAN MEMBERSHIP, and keyed by ride id rather than by
// slug, because these serve the builder and only an owner reaches it — the same
// gate and the same key as /api/rides/:id/rendezvous. A rider who is on the ride
// but does not own it has the page.

/** One rider, as the builder's tab draws them. */
type RiderJson = {
  riderId: number
  displayName: string
  username: string | null
  role: RideRole
  rsvp: Rsvp
  /** The subgroup they are on, by id — `ride_members.subgroup_id`. Null is a
   *  real state: unassigned, or a ride with no subgroups at all. */
  subgroupId: number | null
  bike: string | null
  canRemove: boolean
}

rosterRoutes.get('/api/rides/:id/riders', requireActiveApi, async (c) => {
  const user = currentUser(c)
  const ride = await ownRide(user.id, c.req.param('id'))
  if (!ride) return c.json({ error: 'not found' }, 404)

  const [members, groups, range, riding] = await Promise.all([
    roster(ride.id),
    subgroupsOf(ride.id),
    groupRange(ride.id),
    bikesOnRide(ride.id),
  ])
  const bikeOf = new Map(riding.map((r) => [r.riderId, r.bike ? bikeLabel(r.bike) : null]))

  const riders: RiderJson[] = members.map((m) => ({
    riderId: m.riderId,
    displayName: m.displayName,
    username: m.username,
    role: m.role,
    rsvp: m.rsvp,
    subgroupId: m.subgroupId,
    bike: bikeOf.get(m.riderId) ?? null,
    // From the policy rather than from `role !== 'owner'`, which is the same
    // answer today and stops being one the moment canRemove grows a case. Note
    // it is false for the owner themselves — a ride with no owner has nobody who
    // can invite, resolve a vote or delete it.
    canRemove: canRemove(user.id, 'owner', m),
  }))

  // BY UID AS WELL AS BY ID. The builder holds subgroups by uid — it mints them
  // client-side and `reconcileSubgroups` matches on uid — while a member row
  // points at one by id. The tab's picker is the only place the two meet, so it
  // needs both, and a group the rider added since the last save appears in
  // neither list until the autosave lands.
  return c.json({
    riders,
    groups: groups.map((g) => ({ id: g.id, uid: g.uid, name: g.name, color: g.color })),
    range,
    coming: members.filter(isComing).length,
  })
})

rosterRoutes.post('/api/rides/:id/riders/group', requireActiveApi, requireSameOrigin, async (c) => {
  const user = currentUser(c)
  const ride = await ownRide(user.id, c.req.param('id'))
  if (!ride) return c.json({ error: 'not found' }, 404)

  const body = (await c.req.json().catch(() => null)) as { rider?: unknown; group?: unknown } | null
  const rider = Number(body?.rider)
  // `null` is the answer for "on no approach", and it arrives as JSON null
  // rather than as the empty string the form arm uses.
  const groupId = body?.group == null ? null : Number(body.group)
  if (!Number.isInteger(rider) || (groupId !== null && !Number.isInteger(groupId))) {
    return c.json({ error: 'bad request' }, 400)
  }
  // The same ride-scoping check the form handler makes, and for the same reason:
  // the FK points at ride_subgroups rather than at THIS ride's rows, so it would
  // accept an id from somebody else's ride and every reader downstream would
  // then see a rider on an approach that is not part of their ride.
  const mine = (await subgroupsOf(ride.id)).some((g) => g.id === groupId)
  if (groupId !== null && !mine) return c.json({ error: 'unknown group' }, 400)
  // Only somebody already on the roster: assignRider's UPDATE matches no row
  // otherwise, which is silent, so the check is here rather than in the service.
  if (!(await roleOf(ride.id, rider))) return c.json({ error: 'not a member' }, 404)

  await assignRider(ride.id, rider, groupId)
  return c.json({ ok: true })
})

rosterRoutes.post('/api/rides/:id/riders/remove', requireActiveApi, requireSameOrigin, async (c) => {
  const user = currentUser(c)
  const ride = await ownRide(user.id, c.req.param('id'))
  if (!ride) return c.json({ error: 'not found' }, 404)

  const body = (await c.req.json().catch(() => null)) as { rider?: unknown } | null
  const rider = Number(body?.rider)
  if (!Number.isInteger(rider)) return c.json({ error: 'bad request' }, 400)
  // removeMember re-reads the viewer's own row and runs canRemove itself, so the
  // owner-may-not-remove-themselves rule is enforced once, in policy.ts. A
  // refusal here is a 403 rather than a 400 because the request was well formed.
  if (!(await removeMember(ride.id, user.id, rider))) return c.json({ error: 'refused' }, 403)
  return c.json({ ok: true })
})
