// The Paddock's API — a rider's bikes.
//
// A JSON API rather than server-rendered forms, matching places.ts: the profile
// page manages the list with JavaScript, and a garage is a list of records
// rather than a document. The photo routes are the exception and take multipart,
// because that is what a file input posts.
//
// **There is no public surface here and there should not be one yet.** A bike is
// currently private to its owner: every route is behind `requireActiveApi` (or
// `requireActive` for the image), and every query in service.ts folds the owner
// id into its WHERE clause. Whether a rider can SHOW their paddock on a public
// profile is a real product question and a deliberate non-decision — see the
// serving route below.
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { currentUser, requireActive, requireActiveApi, requireSameOrigin, type AuthEnv } from '../auth/middleware'
import { bikeInput, bikeLabel, canAddBike, MAX_BIKES, metersToMiles } from '../bikes/policy'
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
const serialize = (bike: BikeRow) => ({
  id: bike.id,
  label: bikeLabel(bike),
  nickname: bike.nickname,
  make: bike.make,
  model: bike.model,
  year: bike.year,
  fuelType: bike.fuelType,
  usableRangeMi: bike.usableRangeM == null ? null : metersToMiles(bike.usableRangeM),
  comfortRangeMi: bike.comfortRangeM == null ? null : metersToMiles(bike.comfortRangeM),
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
  const rows = await listBikes(user.id)
  return c.json({ bikes: rows.map(serialize), max: MAX_BIKES })
})

bikesRoutes.post('/api/bikes', requireActiveApi, requireSameOrigin, async (c) => {
  const user = currentUser(c)
  const parsed = bikeInput.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'invalid bike' }, 400)
  if (!canAddBike(await countBikes(user.id))) return c.json({ error: `Bike limit reached (${MAX_BIKES})` }, 409)

  const row = await createBike(user.id, parsed.data)
  return row ? c.json(serialize(row), 201) : c.json({ error: 'could not add that bike' }, 500)
})

bikesRoutes.put('/api/bikes/:id', requireActiveApi, requireSameOrigin, async (c) => {
  const user = currentUser(c)
  const id = idOf(c.req.param('id'))
  if (!id) return c.json({ error: 'not found' }, 404)
  const parsed = bikeInput.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'invalid bike' }, 400)

  const row = await updateBike(user.id, id, parsed.data)
  // Undefined covers both "no such bike" and "not yours", and answers the same
  // way for each — a 403 would confirm the row exists.
  return row ? c.json(serialize(row)) : c.json({ error: 'not found' }, 404)
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
    return row ? c.json(serialize(row)) : c.json({ error: 'not found' }, 404)
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
 * OWNER ONLY, for now, and that is a non-decision rather than a decision: a bike
 * is not currently shown anywhere but its owner's own profile, so the narrow
 * gate is the one that cannot leak. Letting a rider show their paddock publicly
 * — or to the people on a ride with them — is a real question that belongs with
 * ride membership (#71), and widening this route is where it would be answered.
 *
 * IMMUTABLE, because the URL carries the fingerprint. A changed photo is a
 * different `?v=`, so a year is safe and a re-upload is visible immediately.
 * Private in the cache-control sense for the same reason a feedback screenshot
 * is: a shared cache holding one rider's file is the same leak as showing it to
 * the wrong person.
 */
bikesRoutes.get('/bikes/:id/photo', requireActive, async (c) => {
  const user = currentUser(c)
  const id = idOf(c.req.param('id'))
  if (!id) return c.notFound()

  const bike = await getBike(user.id, id)
  if (!bike || !bike.photoHash) return c.notFound()

  const data = await readBikePhoto(user.id, id)
  if (!data) return c.notFound()

  return new Response(new Uint8Array(data), {
    headers: {
      'Content-Type': PROCESSED_MIME,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=31536000, immutable',
    },
  })
})
