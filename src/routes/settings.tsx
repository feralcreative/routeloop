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
import { page } from '../views/layout'

export const settingsRoutes = new Hono<AuthEnv>()

settingsRoutes.get('/settings', requireActive, (c) => {
  const user = currentUser(c)

  const body = (
    <>
      <h1>Settings</h1>
      <p class="lede">Not much to set yet. What you can change today lives on your profile.</p>
      <p>
        <a href="/profile">Your profile</a> holds your name, username, home address and what of it is shared.
      </p>

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
      </section>
    </>
  ).toString()

  return c.html(page({ title: 'Settings', user, navKey: 'settings', body }))
})
