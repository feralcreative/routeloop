// Rider management for accounts holding users.can_manage_riders. Every new
// account starts `pending` (resolveUser writes it on the insert path) and cannot
// use the app until someone here flips it to `active`; before this page that was
// a hand-written `UPDATE users SET status='active'` over SSH.
//
// Plain HTML form POSTs, not the fetch+JSON APIs the ride surface uses — the same
// reasoning as profile.ts: an owner-only settings page should not stop working
// without JavaScript, and a form plus one re-render is less code than an endpoint
// and a client script. requireSameOrigin still guards the write because changing
// a rider's status is privileged in a way saving your own profile is not.
import { Hono } from 'hono'
import { and, desc, eq, ne, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db/index'
import { users } from '../db/schema'
import { currentUser, requireManageRiders, requireSameOrigin, type AuthEnv } from '../auth/middleware'
import { sendTemplateDetached } from '../auth/mailer'
import { approvedEmail } from '../emails/approved'
import { shouldSendApproval } from '../emails/rules'
import { page } from '../views/layout'

export const adminRoutes = new Hono<AuthEnv>()

// The two transitions the UI can drive. `pending` is only ever set by the signup
// path, never here — a manager approves or blocks, they do not un-approve back to
// a limbo state.
const statusSchema = z.object({ status: z.enum(['active', 'blocked']) })

type RiderRow = {
  id: number
  email: string | null
  displayName: string
  username: string | null
  status: 'pending' | 'active' | 'blocked'
  canManageRiders: boolean
  createdAt: Date
  lastLoginAt: Date | null
}

const fmtDate = (d: Date | null): string => (d ? d.toISOString().slice(0, 10) : '—')

// A single status-changing button, as its own form so it works without script.
function ActionForm({ id, status, label, cls }: { id: number; status: 'active' | 'blocked'; label: string; cls: string }) {
  return (
    <form method="post" action={`/admin/riders/${id}`}>
      <input type="hidden" name="status" value={status} />
      <button class={`btn btn-sm ${cls}`} type="submit">
        {label}
      </button>
    </form>
  )
}

// The actions offered depend on where the rider currently is. A pending rider can
// be approved or blocked; an active rider blocked; a blocked rider reinstated.
function ActionsFor({ rider }: { rider: RiderRow }) {
  switch (rider.status) {
    case 'pending':
      return (
        <>
          <ActionForm id={rider.id} status="active" label="Approve" cls="btn-approve" />
          <ActionForm id={rider.id} status="blocked" label="Block" cls="btn-danger" />
        </>
      )
    case 'active':
      return <ActionForm id={rider.id} status="blocked" label="Block" cls="btn-danger" />
    case 'blocked':
      return <ActionForm id={rider.id} status="active" label="Reinstate" cls="btn-approve" />
  }
}

function RiderRowView({ rider, meId }: { rider: RiderRow; meId: number }) {
  const handle = rider.username ? `@${rider.username}` : ''
  return (
    <li class="rider">
      <span class="rider-id">#{rider.id}</span>
      <span class="rider-main">
        <span class="rider-name">
          {rider.displayName} {rider.canManageRiders && <span class="pill is-manager">manager</span>}
        </span>
        <span class="rider-email">
          {rider.email ?? '—'}
          {handle ? ` · ${handle}` : ''}
        </span>
        <span class="rider-meta">
          joined {fmtDate(rider.createdAt)} · last seen {fmtDate(rider.lastLoginAt)}
        </span>
      </span>
      <span class="rider-status">
        <span class={`pill is-${rider.status}`}>{rider.status}</span>
      </span>
      {/*
        A manager never gets action buttons on their own row: the page exists to
        keep at least one active manager, so self-blocking is not on offer.
      */}
      <span class="rider-actions">
        {rider.id === meId ? <span class="rider-you">you</span> : <ActionsFor rider={rider} />}
      </span>
    </li>
  )
}

function Notice({ query }: { query: (k: string) => string | undefined }) {
  if (query('updated') === '1') return <p class="notice">Rider updated.</p>
  if (query('error') === 'self') return <p class="notice is-error">You can’t change your own account here.</p>
  if (query('error') === 'bad') return <p class="notice is-error">That action wasn’t recognized.</p>
  return <></>
}

adminRoutes.get('/admin/approvals', requireManageRiders, async (c) => {
  const me = currentUser(c)

  // Pending first (they are the ones waiting on an action), then active, then
  // blocked; newest within each group.
  const riders: RiderRow[] = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      username: users.username,
      status: users.status,
      canManageRiders: users.canManageRiders,
      createdAt: users.createdAt,
      lastLoginAt: users.lastLoginAt,
    })
    .from(users)
    .orderBy(
      sql`case ${users.status} when 'pending' then 0 when 'active' then 1 else 2 end`,
      desc(users.createdAt),
    )

  const pending = riders.filter((r) => r.status === 'pending').length

  const body = (
    <>
      <h1>Approvals</h1>
      <div class="sub">
        {riders.length} account{riders.length === 1 ? '' : 's'}
        {pending ? ` · ${pending} waiting for approval` : ''}
      </div>
      <Notice query={(k) => c.req.query(k)} />
      {riders.length > 0 ? (
        <ul class="cards rider-list">
          {riders.map((r) => (
            <RiderRowView rider={r} meId={me.id} />
          ))}
        </ul>
      ) : (
        <p class="empty">No riders yet.</p>
      )}
    </>
  ).toString()

  return c.html(page({ title: 'Approvals', user: me, navKey: 'approvals', body }))
})

adminRoutes.post('/admin/riders/:id', requireManageRiders, requireSameOrigin, async (c) => {
  const me = currentUser(c)
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return c.notFound()

  // Guard self-lockout before touching the body: whatever was posted, a manager
  // cannot flip their own status here.
  if (id === me.id) return c.redirect('/admin/approvals?error=self', 302)

  const parsed = statusSchema.safeParse(await c.req.parseBody())
  if (!parsed.success) return c.redirect('/admin/approvals?error=bad', 302)

  const [target] = await db
    .select({
      id: users.id,
      status: users.status,
      email: users.email,
      displayName: users.displayName,
      approvedEmailAt: users.approvedEmailAt,
    })
    .from(users)
    .where(eq(users.id, id))
    .limit(1)
  if (!target) return c.notFound()

  const next = parsed.data.status
  const notify = shouldSendApproval(target.status, next, target.approvedEmailAt)

  // Conditional, and the WHERE is the point. `ne(status, next)` plus the
  // returning() means the DATABASE decides whether this request is the one that
  // made the change — two managers clicking Approve in the same instant, or one
  // double-submitting, cannot both come back with a row. Reading the status
  // above and branching on it in JavaScript would let both through.
  //
  // approvedEmailAt is stamped in the same statement rather than a follow-up
  // write, so there is no window where the status is active and the flag is
  // still null.
  const [changed] = await db
    .update(users)
    .set({ status: next, updatedAt: new Date(), ...(notify ? { approvedEmailAt: new Date() } : {}) })
    .where(and(eq(users.id, id), ne(users.status, next)))
    .returning({ email: users.email, displayName: users.displayName })

  // Detached: an approval that committed must not 500 because mail is down.
  if (changed && notify) {
    sendTemplateDetached(changed.email, approvedEmail, { displayName: changed.displayName })
  }

  // Redirect rather than re-render so a refresh cannot resubmit the change.
  return c.redirect('/admin/approvals?updated=1', 302)
})

// --- Overview ----------------------------------------------------------------
//
// /admin used to *be* the approvals screen. It became a landing page when the
// menu grew an Admin group (docs/main-menu.md): the group's first item needs
// somewhere to point, and four sibling screens with no shared entry is how you
// end up navigating by URL.
//
// Deliberately thin. It lists what is there and the one number worth surfacing
// before you click — how many riders are waiting — and nothing else. A dashboard
// that duplicates each page's own summary goes stale the day one of them changes.
adminRoutes.get('/admin', requireManageRiders, async (c) => {
  const me = currentUser(c)

  const [counts] = await db
    .select({
      riders: sql<number>`count(*)::int`,
      pending: sql<number>`count(*) filter (where ${users.status} = 'pending')::int`,
    })
    .from(users)

  const cards: { href: string; title: string; note: string }[] = [
    {
      href: '/admin/approvals',
      title: 'Approvals',
      note: counts.pending
        ? `${counts.pending} rider${counts.pending === 1 ? '' : 's'} waiting`
        : `${counts.riders} account${counts.riders === 1 ? '' : 's'}, none waiting`,
    },
    { href: '/admin/invites', title: 'Invitations', note: 'Create, revoke and regenerate invite links' },
    { href: '/admin/survey', title: 'Survey results', note: 'Responses from invited riders' },
    { href: '/brand', title: 'Brand', note: 'Every color the app defines, read live from the SCSS' },
  ]

  const body = (
    <>
      <h1>Admin</h1>
      <p class="lede">Everything that manages the app rather than a ride.</p>
      <ul class="cards admin-cards">
        {cards.map((card) => (
          <li>
            <a href={card.href}>
              <strong>{card.title}</strong>
              <span>{card.note}</span>
            </a>
          </li>
        ))}
      </ul>
    </>
  ).toString()

  return c.html(page({ title: 'Admin', user: me, navKey: 'admin', body }))
})
