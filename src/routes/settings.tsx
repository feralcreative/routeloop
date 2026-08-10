// Settings — a stub, on purpose.
//
// docs/main-menu.md puts Settings in the account menu, and a menu item pointing
// at a 404 is worse than one pointing at an honest empty page. What belongs here
// is undecided; units, default ride visibility and email preferences are the
// obvious candidates and none of them is agreed.
//
// It is deliberately not a fake: no disabled controls, no "coming soon" toggles
// that imply the setting exists and is off. It says there is nothing here yet and
// points at the page that does hold your details today.
import { Hono } from 'hono'
import { currentUser, requireActive, type AuthEnv } from '../auth/middleware'
import { page } from '../views/layout'

export const settingsRoutes = new Hono<AuthEnv>()

settingsRoutes.get('/settings', requireActive, (c) => {
  const user = currentUser(c)

  const body = (
    <>
      <h1>Settings</h1>
      <p class="lede">Nothing to set yet. This page exists so the menu link goes somewhere honest.</p>
      <p>
        What you can change today lives on <a href="/profile">your profile</a>: your name, username, home address and
        what of it is shared.
      </p>
    </>
  ).toString()

  return c.html(page({ title: 'Settings', user, navKey: 'settings', body }))
})
