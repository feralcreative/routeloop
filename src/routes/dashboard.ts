// The signed-in user's own rides. The builder CTA and per-ride actions land
// with the builder MVP (Phase 2 of the pivot plan).
import { Hono } from 'hono'
import { and, desc, eq } from 'drizzle-orm'
import { db } from '../db/index'
import { rides, routes as routesTable } from '../db/schema'
import { currentUser, requireActive, type AuthEnv } from '../auth/middleware'
import { esc, page } from '../views/layout'

export const dashboardRoutes = new Hono<AuthEnv>()

const MB = 1024 * 1024

dashboardRoutes.get('/dashboard', requireActive, async (c) => {
  const user = currentUser(c)

  const rows = await db
    .select({ ride: rides, color: routesTable.color })
    .from(rides)
    .leftJoin(routesTable, and(eq(routesTable.rideId, rides.id), eq(routesTable.position, 0)))
    .where(eq(rides.ownerId, user.id))
    .orderBy(desc(rides.createdAt))

  // Unlike the public listing, this shows every visibility — they are the
  // owner's own rides.
  const cards = rows
    .map(
      ({ ride: m, color }) =>
        `<li class="cardrow">
           <a class="card" href="/m/${esc(m.slug)}">
             <span class="swatch" style="background:${esc(color ?? '#0000cc')}"></span>
             <span>${esc(m.title)}</span>
             <span class="pill">${esc(m.visibility)}</span>
             <span class="meta">${m.stopCount} stops &middot; ${Number(m.totalMiles)} mi</span>
           </a>
           ${m.source === 'native' ? `<a class="editlink" href="/builder/${m.id}">Edit</a>` : ''}
         </li>`,
    )
    .join('')

  const usedMb = (user.usedBytes / MB).toFixed(1)
  const quotaMb = Math.round(user.quotaBytes / MB)

  const body = `<h1>Your rides</h1>
    <div class="sub">${usedMb} MB of ${quotaMb} MB used</div>
    <p><a class="btn" href="/builder">Plan a ride</a></p>
    ${rows.length ? `<ul class="cards">${cards}</ul>` : '<p class="empty">No rides yet — plan your first one.</p>'}`

  return c.html(page({ title: 'Your rides', user, navKey: 'rides', body }))
})
