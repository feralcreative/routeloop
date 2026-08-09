// The signed-in user's own rides. The builder CTA and per-ride actions land
// with the builder MVP (Phase 2 of the pivot plan).
import { Hono } from 'hono'
import { and, desc, eq } from 'drizzle-orm'
import { db } from '../db/index'
import { rides, routes as routesTable, type RideRow } from '../db/schema'
import { currentUser, requireActive, type AuthEnv } from '../auth/middleware'
import { page } from '../views/layout'

export const dashboardRoutes = new Hono<AuthEnv>()

// Deliberately not views/cards.tsx: this row carries a visibility pill and an
// edit link that the public card must never show. Same shape, different
// contract — merging them would mean a flag that only ever means "am I the
// owner", which is the thing the two separate components already say.
function OwnRideRow({ ride, color }: { ride: RideRow; color: string | null }) {
  return (
    <li class="cardrow">
      <a class="card" href={`/m/${ride.slug}`}>
        <span class="swatch" style={{ background: color ?? '#0000cc' }}></span>
        <span>{ride.title}</span>
        <span class="pill">{ride.visibility}</span>
        <span class="meta">
          {ride.stopCount} stops · {Number(ride.totalMiles)} mi
        </span>
      </a>
      {ride.source === 'native' && (
        <a class="editlink" href={`/builder/${ride.id}`}>
          Edit
        </a>
      )}
    </li>
  )
}

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
  const body = (
    <>
      <h1>Your rides</h1>
      {/*
        The storage figure moved to the home page, where it is a meter beside the
        rest of the rider's numbers and is hidden entirely when nothing has been
        imported. It read "0.0 MB of 250 MB" forever for anyone who only used the
        builder, which is most people.
      */}
      <div class="sub">
        {rows.length} {rows.length === 1 ? 'ride' : 'rides'}
      </div>
      <p>
        <a class="btn" href="/builder">
          Plan a ride
        </a>
      </p>
      {rows.length > 0 ? (
        <ul class="cards">
          {rows.map((r) => (
            <OwnRideRow {...r} />
          ))}
        </ul>
      ) : (
        <p class="empty">No rides yet—plan your first one.</p>
      )}
    </>
  ).toString()

  return c.html(page({ title: 'Your rides', user, navKey: 'rides', body }))
})
