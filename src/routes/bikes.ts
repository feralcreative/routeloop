// The Paddock's API — a rider's bikes.
//
// A JSON API rather than server-rendered forms, matching places.ts: the profile
// page manages the list with JavaScript, and a garage is a list of records
// rather than a document. The photo routes are the exception and take multipart,
// because that is what a file input posts.
//
// Every API route is behind `requireActiveApi` and every query in service.ts folds
// the owner id into its WHERE clause. The one public surface is the photo, served
// to whoever the rider shows their Paddock to on /@handle — see the route below.
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { currentUser, requireActiveApi, requireSameOrigin, type AuthEnv } from '../auth/middleware'
import { bikeInput, bikeLabel, canAddBike, MAX_BIKES, metersToMiles, mlToTank, tankRefusal } from '../bikes/policy'
import { volumeFor } from '../views/prefs'
import { volumeUnit } from '../views/volume'
import {
  clearBikePhoto,
  countBikes,
  createBike,
  deleteBike,
  getBike,
  listBikes,
  setBikePhoto,
  setDefaultBike,
  updateBike,
} from '../bikes/service'
import { readBikePhoto, writeBikePhoto } from '../bikes/photo'
import { checkUpload, MAX_IMAGE_BYTES, UPLOAD_REFUSAL_MESSAGES } from '../images/policy'
import { BIKE_PHOTO_BOX, processImage, PROCESSED_MIME } from '../images/process'
import type { BikeRow } from '../db/schema'
import { bikeForPhoto, profileGateOf } from '../profiles/service'
import { canSeePaddock } from '../profiles/policy'

export const bikesRoutes = new Hono<AuthEnv>()

/**
 * What the client sees. METERS NEVER LEAVE THE SERVER.
 *
 * The column stores meters so #150 can switch the site to metric without a
 * migration; the form and every rider-facing surface speak miles. Converting
 * here rather than in the client is what keeps that a server decision — a
 * browser that had to know the storage unit would be a second place to change
 * when #150 lands.
 *
 * `label` is computed rather than sent as three fields for the client to
 * assemble, so the fallback rule lives in exactly one place.
 */
const serialize = (bike: BikeRow, liters: boolean) => ({
  id: bike.id,
  label: bikeLabel(bike),
  nickname: bike.nickname,
  make: bike.make,
  model: bike.model,
  year: bike.year,
  fuelType: bike.fuelType,
  usableRangeMi: bike.usableRangeM == null ? null : metersToMiles(bike.usableRangeM),
  comfortRangeMi: bike.comfortRangeM == null ? null : metersToMiles(bike.comfortRangeM),
  // THE TANK GOES OUT IN THE RIDER'S OWN UNIT WITH ITS LABEL BESIDE IT, so the
  // Paddock renders "4.2 gal" without owning a conversion — the same reason the
  // ranges go out in miles. A browser that had to know the storage unit is a
  // second place to change when #150 lands.
  tank: bike.tankMl == null ? null : mlToTank(bike.tankMl, liters),
  tankUnit: volumeUnit(liters ? 'liters' : 'gallons'),
  isDefault: bike.isDefault,
  // `?v=` is the fingerprint, which is what lets the route below serve the image
  // immutable: a changed picture is a changed URL. Same trick as a ride card's
  // thumbnail.
  photoUrl: bike.photoHash ? `/bikes/${bike.id}/photo?v=${bike.photoHash}` : null,
})

const idOf = (raw: string): number | null => {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : null
}

bikesRoutes.get('/api/bikes', requireActiveApi, async (c) => {
  const user = currentUser(c)
  const liters = (await volumeFor(c)) === 'liters'
  const rows = await listBikes(user.id)
  // `tankUnit` at the list level as well as per bike: an empty paddock draws a
  // blank row before any bike exists to carry the unit (#319).
  return c.json({
    bikes: rows.map((b) => serialize(b, liters)),
    max: MAX_BIKES,
    tankUnit: volumeUnit(liters ? 'liters' : 'gallons'),
  })
})

bikesRoutes.post('/api/bikes', requireActiveApi, requireSameOrigin, async (c) => {
  const user = currentUser(c)
  const parsed = bikeInput.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'invalid bike' }, 400)
  if (!canAddBike(await countBikes(user.id))) return c.json({ error: `Bike limit reached (${MAX_BIKES})` }, 409)

  const liters = (await volumeFor(c)) === 'liters'
  // THE UNIT-AWARE HALF OF THE TANK CHECK. bikeInput validates against the
  // looser ceiling because it does not know the rider's unit; this is where it
  // is known, and skipping it hands a gallons rider a 500 from ck_bike_tank for
  // a number the form appeared to accept.
  const tankBad = tankRefusal(parsed.data.tank, liters)
  if (tankBad) return c.json({ error: tankBad }, 400)
  const row = await createBike(user.id, parsed.data, liters)
  return row ? c.json(serialize(row, liters), 201) : c.json({ error: 'could not add that bike' }, 500)
})

bikesRoutes.put('/api/bikes/:id', requireActiveApi, requireSameOrigin, async (c) => {
  const user = currentUser(c)
  const id = idOf(c.req.param('id'))
  if (!id) return c.json({ error: 'not found' }, 404)
  const parsed = bikeInput.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'invalid bike' }, 400)

  const liters = (await volumeFor(c)) === 'liters'
  const tankBad = tankRefusal(parsed.data.tank, liters)
  if (tankBad) return c.json({ error: tankBad }, 400)
  const row = await updateBike(user.id, id, parsed.data, liters)
  // Undefined covers both "no such bike" and "not yours", and answers the same
  // way for each — a 403 would confirm the row exists.
  return row ? c.json(serialize(row, liters)) : c.json({ error: 'not found' }, 404)
})

bikesRoutes.delete('/api/bikes/:id', requireActiveApi, requireSameOrigin, async (c) => {
  const user = currentUser(c)
  const id = idOf(c.req.param('id'))
  if (!id) return c.json({ error: 'not found' }, 404)
  return (await deleteBike(user.id, id)) ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404)
})

bikesRoutes.post('/api/bikes/:id/default', requireActiveApi, requireSameOrigin, async (c) => {
  const user = currentUser(c)
  const id = idOf(c.req.param('id'))
  if (!id) return c.json({ error: 'not found' }, 404)
  return (await setDefaultBike(user.id, id)) ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404)
})

/**
 * The photo upload.
 *
 * TWO LIMITS, AND THEY ARE NOT THE SAME LIMIT. `bodyLimit` refuses an oversized
 * REQUEST before Hono buffers it, which is what stops a 500 MB post costing
 * memory; `checkUpload` refuses an oversized FILE, which is the rule #99
 * actually stated. The body allowance is deliberately larger than the file one,
 * because multipart framing and any other field in the form ride along with it.
 *
 * The bytes are then sniffed and re-encoded before anything is written. Nothing
 * a client sends reaches the disk unchanged — see src/images/process.ts.
 */
bikesRoutes.post(
  '/api/bikes/:id/photo',
  requireActiveApi,
  requireSameOrigin,
  bodyLimit({ maxSize: MAX_IMAGE_BYTES * 2, onError: (c) => c.json({ error: 'That image is too large.' }, 413) }),
  async (c) => {
    const user = currentUser(c)
    const id = idOf(c.req.param('id'))
    if (!id) return c.json({ error: 'not found' }, 404)
    if (!(await getBike(user.id, id))) return c.json({ error: 'not found' }, 404)

    const body = await c.req.parseBody().catch(() => null)
    const file = body?.photo
    if (!(file instanceof File)) return c.json({ error: 'No image was sent.' }, 400)

    const raw = new Uint8Array(await file.arrayBuffer())
    const check = checkUpload(raw)
    if (!check.ok) return c.json({ error: UPLOAD_REFUSAL_MESSAGES[check.reason] }, 400)

    let processed
    try {
      processed = await processImage(Buffer.from(raw), BIKE_PHOTO_BOX)
    } catch {
      // A file that sniffed as a JPEG and will not decode is corrupt or
      // deliberately malformed. Either way the rider gets a refusal, not a 500.
      return c.json({ error: 'That image could not be read.' }, 400)
    }

    // File first, row second: a row pointing at a photo that was never written
    // renders a broken image, where a file with no row is invisible and swept up
    // by the account purge.
    await writeBikePhoto(user.id, id, processed.data)
    const row = await setBikePhoto(user.id, id, { hash: processed.hash, bytes: processed.data.length })
    return row ? c.json(serialize(row, (await volumeFor(c)) === 'liters')) : c.json({ error: 'not found' }, 404)
  },
)

bikesRoutes.delete('/api/bikes/:id/photo', requireActiveApi, requireSameOrigin, async (c) => {
  const user = currentUser(c)
  const id = idOf(c.req.param('id'))
  if (!id) return c.json({ error: 'not found' }, 404)
  return (await clearBikePhoto(user.id, id)) ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404)
})

/**
 * Serving the photo.
 *
 * THE OWNER, OR ANYONE THE PADDOCK IS SHOWN TO on the public profile
 * (`canSeePaddock` in src/profiles/policy.ts). Anything else 404s exactly like a
 * bike that does not exist, so the route does not confirm one.
 *
 * IMMUTABLE, because the URL carries the fingerprint. Private in the
 * cache-control sense, so a shared cache never holds a photo a later viewer may
 * not be allowed.
 */
bikesRoutes.get('/bikes/:id/photo', async (c) => {
  const viewer = c.get('user') ?? null
  const id = idOf(c.req.param('id'))
  if (!id) return c.notFound()

  const bike = await bikeForPhoto(id)
  if (!bike || !bike.photoHash) return c.notFound()
  if (viewer?.id !== bike.ownerId) {
    const gate = await profileGateOf(bike.ownerId)
    if (!canSeePaddock(gate.visibility, gate.sharePaddock, bike.ownerId, viewer)) return c.notFound()
  }

  const data = await readBikePhoto(bike.ownerId, id)
  if (!data) return c.notFound()

  return new Response(new Uint8Array(data), {
    headers: {
      'Content-Type': PROCESSED_MIME,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=31536000, immutable',
    },
  })
})
