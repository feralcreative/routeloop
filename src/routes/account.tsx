// GTFO — the account's own exits.
//
// Everything here is about a rider taking their data elsewhere or asking for it
// to be destroyed. src/content/privacy.html promised both by hand "until there
// is a button"; this is the button.
//
// Three of them: Download Me packages the account, Delete Me starts a 30-day
// hold, Save Me undoes it. There is deliberately no fourth button that skips the
// hold — see DELETION_HOLD_DAYS in ../account/policy.ts for why.
import { Hono } from 'hono'
import { currentUser, requireAuth, requireActive, requireSameOrigin, type AuthEnv } from '../auth/middleware'
import { allow } from '../auth/ratelimit'
import { ArchiveTooLargeError, buildAccountArchive } from '../account/export'
import { checkCanDelete, cancelDeletion, requestDeletion } from '../account/service'
import { confirmsDeletion, daysUntilPurge, DELETION_HOLD_DAYS, REFUSAL_MESSAGES } from '../account/policy'
import { page } from '../views/layout'

export const accountRoutes = new Hono<AuthEnv>()

// Packaging an account reads every ride and holds the archive in memory, so this
// is limited per rider rather than per IP: the cost is driven by whose account
// it is, and a shared address should not make one rider's exports another's
// problem. Three an hour is well past any honest use.
const DOWNLOAD_LIMIT = { max: 3 }

const fmtDate = (d: Date): string =>
  d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })

// --- Download Me -----------------------------------------------------------

// requireAuth, not requireActive, and that is the whole point: requireActive
// redirects a leaving rider to /account/gone, and the hold is exactly when
// somebody most needs their data out. A pending rider gets it too — it is their
// data whether or not they were ever let in.
accountRoutes.get('/account/download', requireAuth, async (c) => {
  const user = currentUser(c)

  if (!allow('account-download', String(user.id), DOWNLOAD_LIMIT)) {
    return c.text('You have downloaded your account a few times just now. Try again in an hour.', 429)
  }

  let archive
  try {
    archive = await buildAccountArchive(user, new Date())
  } catch (err) {
    if (err instanceof ArchiveTooLargeError) return c.text(err.message, 413)
    throw err
  }

  console.log(`[account] packaged user ${user.id}: ${archive.manifest.rides.length} rides, ${archive.body.length} bytes`)

  return new Response(archive.body, {
    headers: {
      'Content-Type': 'application/zip',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `attachment; filename="${archive.fileName}"`,
    },
  })
})

// --- Delete Me -------------------------------------------------------------

// The confirmation screen. Its own page rather than a modal, because the thing
// being confirmed is worth a page: what happens, when, and what undoes it.
accountRoutes.get('/account/delete', requireActive, async (c) => {
  const user = currentUser(c)
  const check = await checkCanDelete(user)

  const body = (
    <>
      <h1>Delete Me</h1>

      {!check.ok ? (
        <>
          <p class="lede">{REFUSAL_MESSAGES[check.reason]}</p>
          <p>
            <a href="/settings">Back to settings</a>
          </p>
        </>
      ) : (
        <>
          <p class="lede">
            This hides your profile and every ride from the site straight away, and schedules everything you have here
            to be destroyed in {DELETION_HOLD_DAYS} days.
          </p>

          <h2>What happens now</h2>
          <ul>
            <li>Every link you have shared stops working immediately. Anyone opening one gets a not-found page.</li>
            <li>You are taken off Explore and the rider list, and your @handle stops resolving.</li>
            <li>Your handle stays reserved for you the whole time. Nobody else can take it.</li>
            <li>You can still sign in, and you can still download your data.</li>
          </ul>

          <h2>What happens in {DELETION_HOLD_DAYS} days</h2>
          <ul>
            <li>Your account, your profile, your rides and every file you uploaded are deleted for good.</li>
            <li>There is no undo after that. If you want a copy, take it now.</li>
          </ul>

          <p>
            <strong>Changed your mind at any point in those {DELETION_HOLD_DAYS} days?</strong> Sign in and hit Save
            Me. Nothing is destroyed until the time is up, so everything comes back exactly as it was.
          </p>

          <p>
            <a class="btn" href="/account/download">
              Download Me first
            </a>
          </p>

          <form method="post" action="/account/delete" class="gtfo-confirm">
            <label for="confirm">
              To confirm, type your email address — <code>{user.email}</code>
            </label>
            <input type="text" id="confirm" name="confirm" autocomplete="off" spellcheck={false} required />
            {c.req.query('error') === 'confirm' ? (
              <p class="form-error">That did not match your email address. Nothing has been changed.</p>
            ) : null}
            <div class="gtfo-actions">
              <button type="submit" class="btn btn-danger">
                Delete Me
              </button>
              <a href="/settings">Cancel</a>
            </div>
          </form>
        </>
      )}
    </>
  ).toString()

  return c.html(page({ title: 'Delete Me', user, navKey: 'settings', body }))
})

accountRoutes.post('/account/delete', requireActive, requireSameOrigin, async (c) => {
  const user = currentUser(c)

  // Re-checked on the way in, not trusted from the GET that rendered the form.
  const check = await checkCanDelete(user)
  if (!check.ok) return c.redirect('/account/delete', 302)

  const form = await c.req.parseBody()
  const typed = typeof form.confirm === 'string' ? form.confirm : ''
  if (!confirmsDeletion(typed, user.email)) return c.redirect('/account/delete?error=confirm', 302)

  await requestDeletion(user.id)
  return c.redirect('/account/gone', 302)
})

// --- The hold --------------------------------------------------------------

// Where requireActive sends a leaving rider. On requireAuth so that redirect
// cannot loop back into itself.
accountRoutes.get('/account/gone', requireAuth, (c) => {
  const user = currentUser(c)
  if (!user.deletionRequestedAt) return c.redirect('/settings', 302)

  const days = daysUntilPurge(user, new Date())

  const body = (
    <>
      <h1>Your account is scheduled for deletion</h1>
      <p class="lede">
        {user.purgeAfter
          ? `Everything you have here will be destroyed on ${fmtDate(user.purgeAfter)} — ${days} ${
              days === 1 ? 'day' : 'days'
            } from now.`
          : 'Everything you have here is scheduled to be destroyed.'}
      </p>

      <p>
        Your rides are already hidden from the site. Nothing has been destroyed yet, and nothing will be until that
        date.
      </p>

      <section class="gtfo">
        <div class="gtfo-item">
          <div>
            <h3>Save Me</h3>
            <p>Change your mind. Everything comes back exactly as it was — your rides, your handle, your profile.</p>
          </div>
          <form method="post" action="/account/save">
            <button type="submit" class="btn btn-sign">
              Save Me
            </button>
          </form>
        </div>

        <div class="gtfo-item">
          <div>
            <h3>Download Me</h3>
            <p>
              Take a copy before the date. Your profile and every ride, in all five formats, plus the original files you
              uploaded.
            </p>
          </div>
          <a class="btn" href="/account/download">
            Download Me
          </a>
        </div>
      </section>

      <p>
        <a href="/logout">Sign out</a>
      </p>
    </>
  ).toString()

  return c.html(page({ title: 'Scheduled for deletion', user, navKey: 'settings', body }))
})

// --- Save Me ---------------------------------------------------------------

// Deliberately a POST and deliberately not automatic on sign-in. A stale session
// on a phone that background-refreshes a tab would otherwise silently undo a
// deliberate deletion. Signing in is what OFFERS the undo; this is what performs
// it.
accountRoutes.post('/account/save', requireAuth, requireSameOrigin, async (c) => {
  const user = currentUser(c)
  const restored = await cancelDeletion(user.id, 'rider')
  return c.redirect(restored ? '/settings?saved=1' : '/account/gone', 302)
})
