// The signed-in user's own maps. Read-only in Phase 2 — upload, delete, and
// visibility changes arrive in Phase 3.
import { Hono } from 'hono'
import { desc, eq } from 'drizzle-orm'
import { db } from '../db/index'
import { maps as mapsTable } from '../db/schema'
import { currentUser, requireAuth, type AuthEnv } from '../auth/middleware'
import { esc, page } from '../views/layout'

export const dashboardRoutes = new Hono<AuthEnv>()

const MB = 1024 * 1024

dashboardRoutes.get('/dashboard', requireAuth, async (c) => {
  const user = currentUser(c)

  const rows = await db
    .select()
    .from(mapsTable)
    .where(eq(mapsTable.ownerId, user.id))
    .orderBy(desc(mapsTable.createdAt))

  // Unlike the public listing, this shows every visibility — they are the
  // owner's own maps.
  const cards = rows
    .map(
      (m) =>
        `<li><a class="card" href="/m/${esc(m.slug)}">
           <span class="swatch" style="background:${esc(m.color)}"></span>
           <span>${esc(m.title)}</span>
           <span class="pill">${esc(m.visibility)}</span>
           <span class="meta">${m.waypointCount} stops &middot; ${Number(m.totalMiles)} mi</span>
         </a></li>`,
    )
    .join('')

  const usedMb = (user.usedBytes / MB).toFixed(1)
  const quotaMb = Math.round(user.quotaBytes / MB)

  const body = `<h1>Your maps</h1>
    <div class="sub">${usedMb} MB of ${quotaMb} MB used</div>
    ${rows.length ? `<ul class="cards">${cards}</ul>` : '<p class="empty">No maps yet. Uploading arrives in the next phase.</p>'}`

  return c.html(page({ title: 'Your maps — tankbag', user, body }))
})
