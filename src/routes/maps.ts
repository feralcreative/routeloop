// Import API: bring routes in from other apps (KML today, +GPX-only/KMZ/CSV
// later), plus meta edit and delete. The upload pipeline runs its checks
// cheapest-first (auth → origin → Turnstile → size caps → parse/sanitize →
// transactional quota → file writes named only from integer ids), per the
// security spec carried over from the PHP-era plan.
//
// An import lands as: one rides row (source 'imported') + one route + the
// file's placemarks as ordered stops + a single leg holding the whole track —
// the same structured shape the builder produces, so every viewer renders
// from one model.
import { Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { bodyLimit } from 'hono/body-limit'
import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db/index'
import { rides, routes, points, routeLegs, users as usersTable } from '../db/schema'
import { currentUser, requireActiveApi, requireSameOrigin, type AuthEnv } from '../auth/middleware'
import {
  FORMAT_INFO,
  GPX_MAX_BYTES,
  METERS_PER_MILE,
  distFromStartAlongTrack,
  isSupportedFormat,
  processGpx,
  processKml,
  SUPPORTED_FORMATS,
  RouteFileError,
  validateGpx,
  type ExtractedRoute,
} from '../maps/kml'
import { processGeoJson } from '../maps/geojson'
import { extractKmlFromKmz } from '../maps/kmz'
import { generateSlug } from '../maps/slug'
import { twistiness } from '../maps/twist'
import { deleteMapFiles, writeMapFile } from '../maps/storage'
import { turnstileEnabled, verifyTurnstile } from '../maps/turnstile'

export const mapsRoutes = new Hono<AuthEnv>()

// Multipart backstop just above the per-file caps (5 MB KML + 10 MB GPX).
const BODY_LIMIT = 16 * 1024 * 1024

const MB = 1024 * 1024

class QuotaExceeded extends Error {
  constructor(
    public usedBytes: number,
    public quotaBytes: number,
  ) {
    super('quota exceeded')
  }
}

// Scalar form fields, shared by import (with defaults), PATCH here, and the
// ride API. external_url: http(s) only — never javascript:, never data:.
const externalUrl = z.union([z.literal(''), z.url({ protocol: /^https?$/ }).max(2048)])
export const fields = {
  title: z.string().trim().min(1, 'title is required').max(150),
  description: z.string().trim().max(2000),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'color must be #rrggbb'),
  visibility: z.enum(['public', 'unlisted', 'private']),
  external_url: externalUrl,
}
const uploadSchema = z.object({
  title: fields.title,
  description: fields.description.default(''),
  color: fields.color.default('#0000cc'),
  visibility: fields.visibility.default('private'),
  external_url: fields.external_url.default(''),
})
const patchSchema = z
  .object({
    title: fields.title.optional(),
    description: fields.description.optional(),
    color: fields.color.optional(),
    visibility: fields.visibility.optional(),
    external_url: fields.external_url.optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: 'nothing to update' })

export const firstIssue = (e: z.ZodError): string => {
  const i = e.issues[0]
  return i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message
}

// --- Import ----------------------------------------------------------------

mapsRoutes.post(
  '/api/maps',
  requireActiveApi,
  requireSameOrigin,
  bodyLimit({ maxSize: BODY_LIMIT, onError: (c) => c.json({ error: 'upload too large' }, 413) }),
  async (c) => {
    const user = currentUser(c)
    const body = await c.req.parseBody()

    // The import page posts a plain form and cannot render JSON, so it sets
    // `redirect=1` and gets a redirect instead. Everything else — anything
    // calling this as an API — is unaffected and still gets JSON.
    const wantsRedirect = body.redirect === '1'
    const fail = (message: string, status: ContentfulStatusCode) =>
      wantsRedirect
        ? c.redirect(`/import?error=${encodeURIComponent(message)}`, 302)
        : c.json({ error: message }, status)

    // Bot defense before any file is touched (enforced once keys are set).
    if (turnstileEnabled()) {
      const token = typeof body['cf-turnstile-response'] === 'string' ? body['cf-turnstile-response'] : ''
      if (!(await verifyTurnstile(token, c.req.header('CF-Connecting-IP')))) {
        return fail('bot check failed—reload and try again', 403)
      }
    }

    const parsed = uploadSchema.safeParse({
      title: body.title,
      description: body.description ?? '',
      color: body.color || '#0000cc',
      visibility: body.visibility || 'private',
      external_url: body.external_url ?? '',
    })
    if (!parsed.success) return fail(firstIssue(parsed.error), 400)
    const meta = parsed.data

    // `route` is the field the import page posts, and the name every format
    // arrives under. `kml` is still read so anything already posting to this
    // endpoint keeps working — the two are the same field, differently named.
    const upload = body.route instanceof File && body.route.size > 0 ? body.route : body.kml
    if (!(upload instanceof File) || upload.size === 0) return fail('a route file is required', 400)

    const ext = (upload.name.match(/\.([A-Za-z0-9]+)$/)?.[1] ?? '').toLowerCase()
    if (!isSupportedFormat(ext)) {
      return fail(`unsupported file type "${ext || upload.name}" — accepted: ${SUPPORTED_FORMATS.join(', ')}`, 400)
    }
    const cap = FORMAT_INFO[ext].maxBytes
    if (upload.size > cap) return fail(`${ext.toUpperCase()} exceeds ${cap / MB} MB`, 413)

    // A GPX may still arrive as a companion to a KML, which is what this
    // endpoint accepted before it took anything but KML. In that case the KML
    // is the route and the GPX is kept only so it can be downloaded again.
    const companionGpx =
      ext !== 'gpx' && body.gpx instanceof File && body.gpx.size > 0 ? body.gpx : undefined
    if (companionGpx) {
      if (!/\.gpx$/i.test(companionGpx.name)) return fail('track file must be a .gpx', 400)
      if (companionGpx.size > GPX_MAX_BYTES) return fail(`GPX exceeds ${GPX_MAX_BYTES / MB} MB`, 413)
    }

    // Parse, sanitize, extract structure. A RouteFileError is the user's
    // problem (400); anything else is ours (500).
    //
    // Each branch yields the same ExtractedRoute, plus the bytes to keep. KML is
    // stored re-serialized after sanitizing (processKml returns storedKml);
    // GPX is stored as uploaded, which is what the companion path already did.
    // Both stream back with an explicit non-HTML content type and nosniff, so
    // neither can be coaxed into rendering.
    //
    // A KMZ becomes its inner KML and is stored as one — the archive itself is
    // a container, not content, and keeping it would mean a second stored form
    // of the same route that nothing can render.
    //
    // GeoJSON stores nothing, and that is a decision rather than an omission.
    // The original is kept for the other formats because they carry more than
    // this app models — KML has styling and folders, GPX has per-point time and
    // elevation — so the file is the only lossless copy. GeoJSON carries a
    // geometry and a properties bag, both of which land in the database whole,
    // so a stored copy would be a second, staler version of rows we already
    // have. A ride with no file is a shape the app already handles: every
    // native ride built in the builder has none, and costs no quota for the
    // same reason. The one thing given up is unmodelled `properties` keys,
    // which no part of the app has ever read.
    let extracted: ExtractedRoute
    let storedExt: 'kml' | 'gpx' | null
    let storedBuf: Buffer | null
    let gpxBuf: Buffer | undefined
    try {
      if (ext === 'geojson' || ext === 'json') {
        extracted = processGeoJson(await upload.text())
        storedExt = null
        storedBuf = null
      } else if (ext === 'gpx') {
        const text = await upload.text()
        extracted = processGpx(text)
        storedExt = 'gpx'
        storedBuf = Buffer.from(await upload.arrayBuffer())
        gpxBuf = storedBuf
      } else {
        // Unzipping first means the KMZ path converges on processKml before
        // anything is parsed, so DOCTYPE rejection, sanitizing and extraction
        // are the same code for both — a KMZ cannot route around them.
        const text =
          ext === 'kmz'
            ? extractKmlFromKmz(Buffer.from(await upload.arrayBuffer()))
            : await upload.text()
        const kml = processKml(text)
        extracted = kml
        storedExt = 'kml'
        storedBuf = Buffer.from(kml.storedKml, 'utf8')
        if (companionGpx) {
          validateGpx(await companionGpx.text())
          gpxBuf = Buffer.from(await companionGpx.arrayBuffer())
        }
      }
    } catch (e) {
      if (e instanceof RouteFileError) return fail(e.message, 400)
      throw e
    }

    // A GPX-only import stores one file, so its bytes are counted once even
    // though storedBuf and gpxBuf point at the same buffer. A format that
    // stores nothing counts nothing, which keeps this in step with the
    // `size_bytes` the delete path subtracts — they are computed by different
    // sides (app on the way in, generated column on the way out) and quota
    // drifts permanently if they ever disagree.
    const incoming = (storedBuf?.byteLength ?? 0) + (storedExt === 'kml' ? (gpxBuf?.byteLength ?? 0) : 0)
    const distM = Math.round(extracted.trackMeters)
    const totalMiles = (extracted.trackMeters / METERS_PER_MILE).toFixed(1)
    const stopDists = distFromStartAlongTrack(extracted.track, extracted.points)

    // Quota + inserts + file writes in one transaction: the quota row is
    // locked (FOR UPDATE) so concurrent imports cannot both squeeze under the
    // cap, and a failed file write rolls every row back.
    let fileRideId: number | null = null
    try {
      const created = await db.transaction(async (tx) => {
        const [q] = await tx
          .select({ quotaBytes: usersTable.quotaBytes, usedBytes: usersTable.usedBytes })
          .from(usersTable)
          .where(eq(usersTable.id, user.id))
          .for('update')
        if (q.usedBytes + incoming > q.quotaBytes) throw new QuotaExceeded(q.usedBytes, q.quotaBytes)

        const [ride] = await tx
          .insert(rides)
          .values({
            ownerId: user.id,
            slug: generateSlug(),
            title: meta.title,
            description: meta.description || null,
            visibility: meta.visibility,
            source: 'imported',
            externalUrl: meta.external_url || null,
            gpxPresent: Boolean(gpxBuf),
            kmlBytes: storedExt === 'kml' ? (storedBuf?.byteLength ?? 0) : 0,
            gpxBytes: storedExt === 'gpx' ? (storedBuf?.byteLength ?? 0) : (gpxBuf?.byteLength ?? 0),
            totalMiles,
            stopCount: extracted.points.filter((p) => p.kind !== 'poi').length,
          })
          .returning()

        // An imported ride never touches the router, so this is the only shape
        // information it will ever have — which is exactly why twistiness is
        // computed from geometry rather than from routing maneuvers.
        const twist = twistiness(extracted.track)
        const [route] = await tx
          .insert(routes)
          .values({
            rideId: ride.id,
            position: 0,
            color: meta.color,
            distanceM: distM,
            twistinessDpm: twist?.dpm ?? null,
            twistinessBestDpm: twist?.bestDpm ?? null,
          })
          .returning()

        if (extracted.points.length > 0) {
          // Stops carry a position and POIs carry null, matching what the
          // builder writes — a POI is not a routing anchor and has no place in
          // the stop order. So the counter advances only for stops.
          let stopPos = 0
          await tx.insert(points).values(
            extracted.points.map((p, i) => {
              const isPoi = p.kind === 'poi'
              return {
                routeId: route.id,
                kind: isPoi ? ('poi' as const) : ('stop' as const),
                position: isPoi ? null : stopPos++,
                lat: p.lat,
                lng: p.lng,
                name: p.name,
                description: p.description,
                roles: p.roles,
                durationMin: p.durationMin ?? null,
                distFromStartM: stopDists[i],
              }
            }),
          )
        }
        if (extracted.track.length > 0) {
          await tx
            .insert(routeLegs)
            .values({ routeId: route.id, position: 0, geometry: extracted.track, distanceM: distM })
        }

        if (storedExt && storedBuf) {
          fileRideId = ride.id
          await writeMapFile(user.id, ride.id, storedExt, storedBuf)
          if (storedExt === 'kml' && gpxBuf) await writeMapFile(user.id, ride.id, 'gpx', gpxBuf)
        }

        await tx
          .update(usersTable)
          .set({ usedBytes: q.usedBytes + incoming, updatedAt: new Date() })
          .where(eq(usersTable.id, user.id))
        return ride
      })
      console.log(`[import] user ${user.id} imported ride ${created.id} (${incoming} bytes, ${created.visibility})`)
      return wantsRedirect
        ? c.redirect(`/m/${created.slug}`, 302)
        : c.json({ id: created.id, slug: created.slug, title: created.title, visibility: created.visibility }, 201)
    } catch (e) {
      if (e instanceof QuotaExceeded) {
        return fail(
          `over quota: ${(e.usedBytes / MB).toFixed(1)} MB used of ${Math.round(e.quotaBytes / MB)} MB, upload is ${(incoming / MB).toFixed(1)} MB`,
          413,
        )
      }
      // The inserts rolled back; sweep any file written before the failure.
      if (fileRideId !== null) await deleteMapFiles(user.id, fileRideId)
      throw e
    }
  },
)

// --- Edit / delete ---------------------------------------------------------

// Owner-scoped lookup: someone else's ride id (or an unknown one) is a plain
// 404 — never confirm that the ride exists.
// Who may edit a ride. Ownership today; shared and invited editing is #32, and
// this is the one place that has to change when it lands — the viewer's button
// and the builder's gate must never disagree about the answer, or the app
// offers an action it then refuses.
//
// Imported rides are excluded because the builder genuinely cannot open one yet:
// the /builder/:id route answers 409 for them. Offering the button there would
// be a link straight to an error page.
export function canEditRide(
  ride: { ownerId: number; source: string },
  viewer: { id: number; status: string } | null,
): boolean {
  if (!viewer || viewer.status !== 'active') return false
  if (ride.source !== 'native') return false
  return ride.ownerId === viewer.id
}

export async function ownRide(userId: number, idParam: string) {
  const id = Number(idParam)
  if (!Number.isInteger(id) || id <= 0) return undefined
  const [r] = await db
    .select()
    .from(rides)
    .where(and(eq(rides.id, id), eq(rides.ownerId, userId)))
    .limit(1)
  return r
}

mapsRoutes.patch('/api/maps/:id', requireActiveApi, requireSameOrigin, async (c) => {
  const user = currentUser(c)
  const ride = await ownRide(user.id, c.req.param('id'))
  if (!ride) return c.json({ error: 'not found' }, 404)

  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400)
  }
  const parsed = patchSchema.safeParse(raw)
  if (!parsed.success) return c.json({ error: firstIssue(parsed.error) }, 400)
  const p = parsed.data

  const [updated] = await db
    .update(rides)
    .set({
      ...(p.title !== undefined && { title: p.title }),
      ...(p.description !== undefined && { description: p.description || null }),
      ...(p.visibility !== undefined && { visibility: p.visibility }),
      ...(p.external_url !== undefined && { externalUrl: p.external_url || null }),
      updatedAt: new Date(),
    })
    .where(eq(rides.id, ride.id))
    .returning()
  // Color lives on routes now; a meta-level color change recolors the whole
  // ride (single-route for imports; per-route colors are edited in the builder).
  if (p.color !== undefined) {
    await db.update(routes).set({ color: p.color }).where(eq(routes.rideId, ride.id))
  }
  return c.json({ id: updated.id, slug: updated.slug, title: updated.title, visibility: updated.visibility })
})

mapsRoutes.delete('/api/maps/:id', requireActiveApi, requireSameOrigin, async (c) => {
  const user = currentUser(c)
  const ride = await ownRide(user.id, c.req.param('id'))
  if (!ride) return c.json({ error: 'not found' }, 404)

  await db.transaction(async (tx) => {
    await tx.delete(rides).where(eq(rides.id, ride.id)) // routes/points/legs cascade
    // Clamped at zero: a drifted cache must never wedge the account negative.
    await tx
      .update(usersTable)
      .set({
        usedBytes: sql`GREATEST(0, ${usersTable.usedBytes} - ${ride.sizeBytes ?? 0})`,
        updatedAt: new Date(),
      })
      .where(eq(usersTable.id, user.id))
  })
  // Row is gone; file removal is best-effort cleanup.
  await deleteMapFiles(user.id, ride.id)
  console.log(`[rides] user ${user.id} deleted ride ${ride.id} (freed ${ride.sizeBytes ?? 0} bytes)`)
  return c.json({ ok: true })
})
