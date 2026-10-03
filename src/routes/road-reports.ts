// Rider-reported road conditions (#48) and seasonal closures (#53), plus the
// "near me" list for /explore (#37) — the three things PostGIS is here for.
//
// A report names no rider to anybody but its reporter: `mine` is the only
// identity a response carries. Reading needs only sight of the ride; making a
// report needs an approved account, and taking one down needs to be its reporter
// or somebody who manages riders.
import { Hono } from 'hono'
import type { AuthEnv } from '../auth/middleware'
import { currentUser, requireActiveApi, requireSameOrigin } from '../auth/middleware'
import { viewableRide } from '../access/query'
import { canViewAsMember } from '../members/policy'
import { builderRide } from './builder'
import { canWithdraw, parseReport } from '../road-reports/policy'
import { createReport, deleteReport, findReport, reportsAlongRide } from '../road-reports/service'
import { ridesNear, validPoint } from '../rides/near'
import { rideCards } from '../views/cards'
import { unitsFor } from '../views/prefs'
import { wordsOf } from '../views/layout'

export const roadReportRoutes = new Hono<AuthEnv>()

roadReportRoutes.get('/m/:slug/road-reports.json', async (c) => {
  const viewer = c.get('user') ?? null
  const ride = await viewableRide(c.req.param('slug'), viewer)
  if (!ride) return c.json({ error: 'not found' }, 404)
  c.header('Cache-Control', 'no-store')
  return c.json({ reports: await reportsAlongRide(ride.id, viewer?.id ?? null) })
})

roadReportRoutes.get('/api/rides/:id/road-reports', requireActiveApi, async (c) => {
  const user = currentUser(c)
  const found = await builderRide(user.id, c.req.param('id'))
  if (!found || !canViewAsMember(found.member)) return c.json({ error: 'not found' }, 404)
  c.header('Cache-Control', 'no-store')
  return c.json({ reports: await reportsAlongRide(found.ride.id, user.id) })
})

roadReportRoutes.post('/api/road-reports', requireActiveApi, requireSameOrigin, async (c) => {
  const parsed = parseReport(await c.req.json().catch(() => null))
  if (!parsed.ok) return c.json({ error: parsed.error }, 400)
  const id = await createReport(currentUser(c).id, parsed.value)
  return c.json({ id })
})

roadReportRoutes.post('/api/road-reports/:id/withdraw', requireActiveApi, requireSameOrigin, async (c) => {
  const id = Number(c.req.param('id'))
  const report = Number.isInteger(id) ? await findReport(id) : null
  // A report somebody else made answers exactly like one that does not exist.
  if (!report || !canWithdraw(report, currentUser(c))) return c.json({ error: 'not found' }, 404)
  await deleteReport(id)
  return c.json({ ok: true })
})

// A fetch rather than a page URL, so a rider's coordinates never sit in an address
// that analytics records (see the privacy page): the Explore tab asks for its
// list with this and swaps it in.
roadReportRoutes.get('/api/explore/near', async (c) => {
  const at = validPoint(c.req.query('lng'), c.req.query('lat'))
  if (!at) return c.json({ error: 'bad point' }, 400)
  const rows = await ridesNear(at)
  c.header('Cache-Control', 'no-store')
  const html = rideCards(rows, false, { units: await unitsFor(c), words: wordsOf({ user: c.get('user') ?? null }) })
  return c.json({ count: rows.length, html })
})
