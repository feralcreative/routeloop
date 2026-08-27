// The roster: who is on a ride, what they said, and how they vote.
//
// ONE PAGE PER RIDE at /m/:slug/riders, rather than a panel inside the builder.
// Three reasons, in order of weight: a rider who is NOT the owner has no builder
// to open and still needs somewhere to RSVP and vote; the builder's panel is
// already the densest surface in the app; and the roster is about people rather
// than about the route, which is what every other thing in that panel is.
//
// SERVER-RENDERED FORMS, NOT THE JSON API — the same choice /trash and /friends
// made and for the same reason. Every verb here is one button press with no
// state to keep in sync, and a redirect back to the page is the interaction.
//
// The rules are src/members/policy.ts and src/votes/policy.ts. Nothing in this
// file decides whether a verb is allowed; it decides what to show.
import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import { db } from '../db/index'
import { days as daysTable, rides, rsvpEnum, type RideRow, type Rsvp } from '../db/schema'
import { currentUser, requireActive, requireSameOrigin, type AuthEnv } from '../auth/middleware'
import { canInvite, canRemove, canRsvp, isComing, RSVP_LABELS, type MemberFields } from '../members/policy'
import { invitableFriends, invite, removeMember, roleOf, roster, setRsvp, type RosterEntry } from '../members/service'
import { applyTallies, castVote, voteGroups, type VoteGroup } from '../votes/service'
import { hasVotes, votingOpen } from '../votes/policy'
import { LIVE_RIDE } from '../trash/service'
import { fmtDateFull } from '../views/date-format'
import { dateFormatFor } from '../views/prefs'
import type { DateFormat } from '../views/date-format'
import { page } from '../views/layout'

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
}: {
  m: RosterEntry
  slug: string
  viewerId: number
  viewerRole: 'owner' | 'rider'
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

rosterRoutes.get('/m/:slug/riders', requireActive, async (c) => {
  const user = currentUser(c)
  const found = await memberRide(c.req.param('slug'), user.id)
  if (!found) return c.text('Not found', 404)
  const { ride, role } = found

  const [members, groups, dayRows, friends, dateFormat] = await Promise.all([
    roster(ride.id),
    voteGroups(ride.id, user.id),
    db
      .select({ uid: daysTable.uid, title: daysTable.title, position: daysTable.position })
      .from(daysTable)
      .where(eq(daysTable.rideId, ride.id)),
    canInvite(role) ? invitableFriends(ride.id, user.id) : Promise.resolve([]),
    dateFormatFor(c),
  ])
  const dayTitles = new Map(dayRows.map((d) => [d.uid, d.title || `Day ${d.position + 1}`]))
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

      <ul class="rider-list roster-list">
        {members.map((m) => (
          <MemberRow m={m} slug={ride.slug} viewerId={user.id} viewerRole={role} />
        ))}
      </ul>

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
