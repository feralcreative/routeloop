// Handing out access, and taking it.
//
// THE RULE THIS FILE IS BUILT AROUND: `GET /i/:token` NEVER REDEEMS.
//
// A link pasted into a Discord channel is fetched immediately, unbidden, by
// Discord's own unfurler, by every client that draws the preview card, by mail
// scanners, and by browser prefetch-on-hover. None of those carry a session, so
// none of them could complete a redemption today — but a design that depends on
// that is one refactor away from a group link whose seats are eaten by robots
// before a rider sees it. So the GET validates, sets a cookie that only decides
// where to send the browser after sign-in, and renders. `POST /i/accept` is the
// redemption. The cookie is a redirect hint, never a credential.
//
// The second thing shaping this file is smaller and just as load-bearing:
// GOOGLE SIGN-IN DOES NOT WORK INSIDE DISCORD'S IN-APP BROWSER. A rider tapping
// the link on their phone lands in an embedded webview and Google refuses with
// `disallowed_useragent`. That will happen to a large share of the traffic on
// the path that matters most, so the email form comes FIRST on this page and the
// webview note is not decoration.
import { Hono } from 'hono'
import { z } from 'zod'
import { APP_ORIGIN, MAGIC_LINK_ENABLED, isAllowedOrigin } from '../config'
import { GOOGLE_ENABLED } from '../auth/google'
import { currentUser, requireAuth, requireManageRiders, requireSameOrigin, type AuthEnv } from '../auth/middleware'
import { clearInviteCookie, readInviteCookie, setInviteCookie } from '../invites/cookie'
import { allow, clientIp } from '../auth/ratelimit'
import { sendTemplate, sendTemplateDetached } from '../auth/mailer'
import { approvedEmail, inviteEmail } from '../emails/index'
import { normalizeEmail } from '../auth/magic'
import { page } from '../views/layout'
import { SplashPage } from '../views/splash'
import {
  createInvite,
  findInviteByToken,
  InviteError,
  listInvites,
  redeemInvite,
  redeemersOf,
  regenerateInvite,
  revokeInvite,
} from '../invites/service'
import { grantsLabel, inviteStatus, inviteUrl, seatsLeft } from '../invites/policy'
import type { InviteListRow } from '../invites/service'
import type { InviteRow } from '../db/schema'
import { SEP } from '../views/sep'

export const inviteRoutes = new Hono<AuthEnv>()

// --- Copy --------------------------------------------------------------------

/** What the invite is for, in a sentence the recipient reads before signing in. */
function grantsSentence(inv: { grantsBeta: boolean; grantsSurvey: boolean }): string {
  if (inv.grantsBeta && inv.grantsSurvey) return 'the Routeloop beta and the rider survey'
  if (inv.grantsBeta) return 'the Routeloop beta'
  return 'the Routeloop rider survey'
}

const REFUSALS: Record<string, string> = {
  invalid: 'That invitation link is not valid. Check you copied all of it, or ask for another.',
  revoked: 'That invitation was withdrawn.',
  expired: 'That invitation has expired. Ask for another and I will send one.',
  exhausted: 'That invitation has been taken up by as many riders as it was good for.',
}

// --- GET /i/:token — inert ---------------------------------------------------

inviteRoutes.get('/i/:token', async (c) => {
  const token = c.req.param('token')
  const invite = await findInviteByToken(token)
  const user = c.get('user')

  const refusal = !invite ? 'invalid' : inviteStatus(invite, new Date())
  const dead = refusal !== 'ok'

  // Set even on a dead invite: harmless, and it means a rider who signs in from
  // this page still lands somewhere that explains itself rather than on a bare
  // home page. Not set for a robot, because a robot never gets this far into a
  // response it does not parse.
  if (!dead) setInviteCookie(c, token)

  const what = invite ? grantsSentence(invite) : ''

  const body = (
    <SplashPage eyebrow={dead ? 'Invitation' : 'You’re invited'} heading={dead ? 'That link is closed.' : 'Come ride.'}>
      {dead ? (
        <p class="splash-gate">
          <strong>Sorry:</strong> {REFUSALS[refusal] ?? REFUSALS.invalid}
        </p>
      ) : (
        <>
          <div class="splash-gate">
            <p>
              <strong>Hey:</strong> you’ve been invited to {what}. Sign in and it’s yours—there’s no password to pick.
            </p>
          </div>
          {user ? (
            // Signed in already: one button, one POST, no ambiguity about what
            // the click does.
            <form class="providers" method="post" action="/i/accept">
              <input type="hidden" name="token" value={token} />
              <button class="btn" type="submit">
                Accept the invitation
              </button>
            </form>
          ) : (
            <div class="providers">
              {/*
                Email FIRST, and not for tidiness. Most of these links get tapped
                inside Discord's in-app browser, where Google's OAuth refuses to
                run at all. The form below works there; the button under it does
                not.
              */}
              {MAGIC_LINK_ENABLED && (
                <form class="magic-form" method="post" action="/auth/magic">
                  <label class="visually-hidden" for="invite-email">
                    Email address
                  </label>
                  <input
                    id="invite-email"
                    name="email"
                    type="email"
                    required
                    autocomplete="email"
                    placeholder="you@example.com"
                  />
                  <button class="btn" type="submit">
                    Send me a link
                  </button>
                </form>
              )}
              {GOOGLE_ENABLED && (
                <a class="provider provider-google" href="/auth/google">
                  <img class="provider-mark" src="/img/logos/google.svg" alt="" width="268" height="274" />
                  <span>Continue with Google</span>
                </a>
              )}
              {GOOGLE_ENABLED && (
                <p class="provider-alt">
                  Reading this inside another app? <strong>Google sign-in only works in a real browser</strong>—use the
                  email form, or open this page in Safari or Chrome.
                </p>
              )}
            </div>
          )}
        </>
      )}
    </SplashPage>
  ).toString()

  return c.html(
    page({
      title: dead ? 'Invitation' : 'You’re invited',
      user: user ?? null,
      variant: 'splash',
      body,
      // Discord renders this as an embed card in the channel. A generic title
      // and no indexing keeps a link that is meant for one channel from being
      // catalogued more widely than it already will be.
      head: '<meta name="robots" content="noindex,nofollow">',
    }),
  )
})

// --- POST /i/accept — the redemption ----------------------------------------

// requireAuth, NOT requireActive: a pending rider is exactly who this is for,
// and requireActive would bounce them to /welcome — the page that exists to say
// they cannot use the app yet.
inviteRoutes.post('/i/accept', requireAuth, async (c) => {
  // The strict form, not the lenient one used on /auth/magic. This grants
  // access, so a missing Origin is not something to be generous about.
  if (!isAllowedOrigin(c.req.header('Origin'))) return c.text('Bad origin', 403)

  const user = currentUser(c)

  // Cheap, per-process, and layered on top of the seat budget rather than
  // instead of it — one person with three Google accounts is a limit max_uses
  // enforces, not this.
  if (!allow('invite-accept', clientIp(c.req.raw.headers), { max: 10, windowMs: 60 * 60 * 1000 })) {
    return c.text('Slow down a moment.', 429)
  }

  const body = await c.req.parseBody()
  const token = String(body.token ?? '') || readInviteCookie(c)

  try {
    const result = await redeemInvite(token, user)
    clearInviteCookie(c)

    // After the commit, never inside it: mail must not hold a pooled connection.
    if (result.outcome === 'granted' && result.notifyEmail) {
      sendTemplateDetached(result.notifyEmail, approvedEmail, { displayName: result.displayName })
    }

    // Always a redirect, so withSession re-reads the row — c.get('user') in this
    // request still says `pending` even though the transaction has committed.
    const survey = result.outcome === 'granted' ? result.survey : Boolean(result.invite.grantsSurvey)
    return c.redirect(survey ? '/survey?welcome=1' : '/?welcome=1', 302)
  } catch (err) {
    if (err instanceof InviteError) {
      clearInviteCookie(c)
      return c.redirect(`/welcome?invite=${err.reason}`, 302)
    }
    throw err
  }
})

// --- Admin -------------------------------------------------------------------

const MAX_SEATS = 50
const MAX_DAYS = 90

const createSchema = z
  .object({
    kind: z.enum(['email', 'link', 'group']),
    grantsBeta: z.preprocess((v) => v === 'on', z.boolean()),
    grantsSurvey: z.preprocess((v) => v === 'on', z.boolean()),
    email: z.string().trim().max(255).default(''),
    label: z.string().trim().max(120).default(''),
    maxUses: z.coerce.number().int().min(1).max(MAX_SEATS).default(1),
    days: z.coerce.number().int().min(1).max(MAX_DAYS).default(14),
  })
  .refine((v) => v.grantsBeta || v.grantsSurvey, { message: 'Pick at least one thing to grant', path: ['grants'] })
  .refine((v) => v.kind !== 'email' || normalizeEmail(v.email) !== '', {
    message: 'An emailed invite needs an address',
    path: ['email'],
  })

const fmtDate = (d: Date | null): string => (d ? d.toISOString().slice(0, 10) : '—')

function Notice({ query, link }: { query: (k: string) => string | undefined; link?: string }) {
  if (link) {
    return (
      <div class="notice invite-fresh">
        <p>
          <strong>Copy this now.</strong> Only the hash is stored, so this is the one time the link exists. Lost it?
          Regenerate—that kills the old one and keeps the seats.
        </p>
        <input class="invite-link" type="text" readonly value={link} onclick="this.select()" />
      </div>
    )
  }
  if (query('sent') === '1') return <p class="notice">Invitation sent.</p>
  if (query('revoked') === '1') return <p class="notice">Invitation revoked.</p>
  if (query('error') === 'send') {
    return (
      <p class="notice is-error">
        The invite was created but the email did not go out. Use Regenerate to get a link you can paste.
      </p>
    )
  }
  if (query('error') === 'bad') return <p class="notice is-error">That did not look right—check the fields.</p>
  if (query('error') === 'gone') return <p class="notice is-error">That invitation no longer exists.</p>
  return <></>
}

function InviteCard({ inv }: { inv: InviteListRow }) {
  const live = inviteStatus(inv, new Date())
  const pill = live === 'ok' ? 'is-active' : live === 'exhausted' ? 'is-pending' : 'is-blocked'
  return (
    <li class="invite">
      <div class="invite-main">
        <div class="invite-name">
          {inv.label || inv.email || `${inv.kind} invite`}
          <span class={`pill ${pill}`}>{live === 'ok' ? 'open' : live}</span>
        </div>
        <div class="invite-meta">
          {inv.kind}
          {SEP}grants {grantsLabel(inv)}
          {SEP}expires {fmtDate(inv.expiresAt)}
          {inv.email ? `${SEP}${inv.email}` : ''}
        </div>
        <div class="invite-meta">
          {inv.usedCount} of {inv.maxUses} {inv.maxUses === 1 ? 'seat' : 'seats'} used
          {inv.redeemed !== inv.usedCount ? `${SEP}${inv.redeemed} opened it` : ''}
        </div>
        {/* A meter rather than a number alone: a group link filling up is the
            thing you want to notice from across the page. */}
        <div class="seat-meter" aria-hidden="true">
          <span style={`width:${Math.round((inv.usedCount / inv.maxUses) * 100)}%`}></span>
        </div>
      </div>
      <div class="invite-actions">
        <form method="post" action={`/admin/invites/${inv.id}/regenerate`}>
          <button class="btn btn-sm" type="submit">
            Regenerate
          </button>
        </form>
        {!inv.revokedAt && (
          <form method="post" action={`/admin/invites/${inv.id}/revoke`}>
            <button class="btn btn-sm btn-danger" type="submit">
              Revoke
            </button>
          </form>
        )}
      </div>
    </li>
  )
}

function CreateForm() {
  return (
    <form class="profile-form invite-form" method="post" action="/admin/invites">
      <fieldset>
        <legend>New invitation</legend>
        <p class="field">
          <label for="f-kind">How is it going out?</label>
          <select id="f-kind" name="kind">
            <option value="group">Group link—paste it into a channel</option>
            <option value="link">Private link—hand it to one person</option>
            <option value="email">Email—I send it for you</option>
          </select>
          <span class="field-hint">A group link is the only one that takes more than one rider.</span>
        </p>
        <p class="field">
          <label for="f-label">What is it for?</label>
          <input id="f-label" name="label" type="text" maxlength={120} placeholder="MC Discord #general" />
          <span class="field-hint">Only you see this. It is what tells you which link leaked.</span>
        </p>
        <p class="field">
          <label for="f-email">Address, for an emailed invite</label>
          <input id="f-email" name="email" type="email" autocomplete="off" placeholder="rider@example.com" />
        </p>
        <label class="check">
          <input type="checkbox" name="grantsBeta" checked />
          <span>Lets them into the beta</span>
        </label>
        <label class="check">
          <input type="checkbox" name="grantsSurvey" checked />
          <span>Lets them take the rider survey</span>
        </label>
        <p class="field">
          <label for="f-maxUses">Seats</label>
          <input id="f-maxUses" name="maxUses" type="number" min={1} max={MAX_SEATS} value="25" />
          <span class="field-hint">
            Ignored for anything but a group link. A seat is only spent when the invite actually changes something for
            that rider.
          </span>
        </p>
        <p class="field">
          <label for="f-days">Good for, in days</label>
          <input id="f-days" name="days" type="number" min={1} max={MAX_DAYS} value="14" />
        </p>
        <p>
          <button class="btn" type="submit">
            Create invitation
          </button>
        </p>
      </fieldset>
    </form>
  )
}

inviteRoutes.get('/admin/invites', requireManageRiders, async (c) => {
  const me = currentUser(c)
  const rows = await listInvites()
  const open = rows.filter((r) => inviteStatus(r, new Date()) === 'ok').length

  const body = (
    <>
      <h1>Invitations</h1>
      <div class="sub">
        {rows.length} issued{open ? `${SEP}${open} still open` : ''}
      </div>
      <Notice query={(k) => c.req.query(k)} />
      <CreateForm />
      {rows.length === 0 ? (
        <p class="empty">No invitations yet.</p>
      ) : (
        <ul class="cards invite-list">
          {rows.map((inv) => (
            <InviteCard inv={inv} />
          ))}
        </ul>
      )}
    </>
  ).toString()

  return c.html(page({ title: 'Invitations', user: me, navKey: 'invites', body }))
})

// Renders at 200 rather than redirecting, which is a deliberate break from the
// post-redirect-get every other admin write uses. The response body carries the
// plaintext link, and that value exists nowhere else — a redirect would throw it
// away. The cost is that a refresh creates a second invite; it is a manager-only
// page and the answer is one Revoke click.
inviteRoutes.post('/admin/invites', requireManageRiders, requireSameOrigin, async (c) => {
  const me = currentUser(c)
  const parsed = createSchema.safeParse(await c.req.parseBody())
  if (!parsed.success) return c.redirect('/admin/invites?error=bad', 302)

  const v = parsed.data
  const email = v.kind === 'email' ? normalizeEmail(v.email) : null
  const { invite, token } = await createInvite({
    kind: v.kind,
    grantsBeta: v.grantsBeta,
    grantsSurvey: v.grantsSurvey,
    email,
    label: v.label || null,
    // Seats only mean anything for a group link. Forcing 1 for the other two
    // kinds in the WRITE rather than in the form means a hand-built POST cannot
    // turn a "private link" into a 50-seat one.
    maxUses: v.kind === 'group' ? v.maxUses : 1,
    expiresAt: new Date(Date.now() + v.days * 24 * 60 * 60 * 1000),
    createdBy: me.id,
  })

  const url = inviteUrl(APP_ORIGIN, token)

  if (email) {
    try {
      // sendTemplate, which THROWS, rather than the detached version. For a
      // notification, failing quietly is right; for an invitation the manager
      // has to know, because the recipient is waiting on it.
      await sendTemplate(email, inviteEmail, {
        url,
        what: grantsSentence(invite),
        expiry: `${v.days} ${v.days === 1 ? 'day' : 'days'}`,
      })
    } catch (err) {
      console.error('[invite] send failed:', err instanceof Error ? err.message : err)
      // The invite exists and is valid; only the delivery failed. Regenerate
      // gives a link to paste, so this is recoverable rather than lost.
      return c.redirect('/admin/invites?error=send', 302)
    }
  }

  const rows = await listInvites()
  const body = (
    <>
      <h1>Invitations</h1>
      <div class="sub">{rows.length} issued</div>
      <Notice query={(k) => c.req.query(k)} link={url} />
      <CreateForm />
      <ul class="cards invite-list">
        {rows.map((inv) => (
          <InviteCard inv={inv} />
        ))}
      </ul>
    </>
  ).toString()

  return c.html(page({ title: 'Invitations', user: me, navKey: 'invites', body }))
})

inviteRoutes.post('/admin/invites/:id/revoke', requireManageRiders, requireSameOrigin, async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return c.notFound()
  const ok = await revokeInvite(id)
  return c.redirect(ok ? '/admin/invites?revoked=1' : '/admin/invites?error=gone', 302)
})

inviteRoutes.post('/admin/invites/:id/regenerate', requireManageRiders, requireSameOrigin, async (c) => {
  const me = currentUser(c)
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return c.notFound()

  const token = await regenerateInvite(id)
  if (!token) return c.redirect('/admin/invites?error=gone', 302)

  const rows = await listInvites()
  const body = (
    <>
      <h1>Invitations</h1>
      <div class="sub">{rows.length} issued</div>
      <Notice query={(k) => c.req.query(k)} link={inviteUrl(APP_ORIGIN, token)} />
      <CreateForm />
      <ul class="cards invite-list">
        {rows.map((inv) => (
          <InviteCard inv={inv} />
        ))}
      </ul>
    </>
  ).toString()

  return c.html(page({ title: 'Invitations', user: me, navKey: 'invites', body }))
})

export { grantsSentence, redeemersOf, seatsLeft }
export type { InviteRow }
