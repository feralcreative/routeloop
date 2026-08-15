// Settings.
//
// docs/main-menu.md puts Settings in the account menu, and a menu item pointing
// at a 404 is worse than one pointing at an honest empty page. What belongs at
// the top is still undecided; units, default ride visibility and email
// preferences are the obvious candidates and none of them is agreed.
//
// It is deliberately not a fake: no disabled controls, no "coming soon" toggles
// that imply the setting exists and is off. What it does have is GTFO, which is
// real and works.
import { Hono } from 'hono'
import { currentUser, requireActive, type AuthEnv } from '../auth/middleware'
import { DELETION_HOLD_DAYS } from '../account/policy'
import { page } from '../views/layout'

export const settingsRoutes = new Hono<AuthEnv>()

settingsRoutes.get('/settings', requireActive, (c) => {
  const user = currentUser(c)
  const saved = c.req.query('saved') !== undefined

  const body = (
    <>
      <h1>Settings</h1>
      <p class="lede">Not much to set yet. What you can change today lives on your profile.</p>
      <p>
        <a href="/profile">Your profile</a> holds your name, username, home address and what of it is shared.
      </p>

      {saved ? (
        <p class="form-ok">
          Welcome back. Your account is no longer scheduled for deletion, and everything is exactly where you left it.
        </p>
      ) : null}

      <section class="gtfo">
        <h2>GTFO</h2>
        <p class="lede">Your account is yours. Take it with you, or take it away.</p>

        <div class="gtfo-item">
          <div>
            <h3>Download Me</h3>
            <p>
              Everything the app holds about you, in one zip: your profile, and every ride in all five formats plus the
              original files you uploaded. The <code>.routeloop.json</code> in each ride folder is the lossless one.
            </p>
          </div>
          <a class="btn" href="/account/download">
            Download Me
          </a>
        </div>

        <div class="gtfo-item">
          <div>
            <h3>Delete Me</h3>
            <p>
              Hide your profile and every ride from the site straight away, and schedule the lot to be destroyed in{' '}
              {DELETION_HOLD_DAYS} days. Nothing is destroyed before then, and Save Me undoes it at any point.
            </p>
          </div>
          <a class="btn btn-danger" href="/account/delete">
            Delete Me
          </a>
        </div>

        <div class="gtfo-item">
          <div>
            <h3>Save Me</h3>
            <p>
              Change your mind after Delete Me. Any time inside the {DELETION_HOLD_DAYS} days it is one click and
              nothing was ever lost — you will find it waiting on the page you land on when you sign in.
            </p>
          </div>
          <span class="gtfo-note">Nothing to restore</span>
        </div>
      </section>
    </>
  ).toString()

  return c.html(page({ title: 'Settings', user, navKey: 'settings', body }))
})
