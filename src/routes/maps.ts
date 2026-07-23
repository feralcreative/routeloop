// Owner API: upload, edit, delete. The upload pipeline runs its checks
// cheapest-first (auth → origin → Turnstile → size caps → parse/sanitize →
// transactional quota → file writes named only from integer ids), per the
// security spec carried over from the PHP-era plan.
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db/index'
import { maps as mapsTable, users as usersTable } from '../db/schema'
import { currentUser, requireAuthApi, requireSameOrigin, type AuthEnv } from '../auth/middleware'
import { GPX_MAX_BYTES, KML_MAX_BYTES, processKml, RouteFileError, validateGpx } from '../maps/kml'
import { generateSlug } from '../maps/slug'
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

// Scalar form fields, shared by upload (with defaults) and PATCH (all
// optional). external_url: http(s) only — never javascript:, never data:.
const externalUrl = z.union([z.literal(''), z.url({ protocol: /^https?$/ }).max(2048)])
const fields = {
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

const firstIssue = (e: z.ZodError): string => {
  const i = e.issues[0]
  return i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message
}

// --- Upload ----------------------------------------------------------------

mapsRoutes.post(
  '/api/maps',
  requireAuthApi,
  requireSameOrigin,
  bodyLimit({ maxSize: BODY_LIMIT, onError: (c) => c.json({ error: 'upload too large' }, 413) }),
  async (c) => {
    const user = currentUser(c)
    const body = await c.req.parseBody()

    // Bot defense before any file is touched (enforced once keys are set).
    if (turnstileEnabled()) {
      const token = typeof body['cf-turnstile-response'] === 'string' ? body['cf-turnstile-response'] : ''
      if (!(await verifyTurnstile(token, c.req.header('CF-Connecting-IP')))) {
        return c.json({ error: 'bot check failed — reload and try again' }, 403)
      }
    }

    const parsed = uploadSchema.safeParse({
      title: body.title,
      description: body.description ?? '',
      color: body.color || '#0000cc',
      visibility: body.visibility || 'private',
      external_url: body.external_url ?? '',
    })
    if (!parsed.success) return c.json({ error: firstIssue(parsed.error) }, 400)
    const meta = parsed.data

    const kmlFile = body.kml
    if (!(kmlFile instanceof File) || kmlFile.size === 0) return c.json({ error: 'a KML file is required' }, 400)
    if (!/\.kml$/i.test(kmlFile.name)) return c.json({ error: 'route file must be a .kml' }, 400)
    if (kmlFile.size > KML_MAX_BYTES) return c.json({ error: `KML exceeds ${KML_MAX_BYTES / MB} MB` }, 413)

    const gpxFile = body.gpx instanceof File && body.gpx.size > 0 ? body.gpx : undefined
    if (gpxFile) {
      if (!/\.gpx$/i.test(gpxFile.name)) return c.json({ error: 'track file must be a .gpx' }, 400)
      if (gpxFile.size > GPX_MAX_BYTES) return c.json({ error: `GPX exceeds ${GPX_MAX_BYTES / MB} MB` }, 413)
    }

    // Parse, extract, sanitize. A RouteFileError is the user's problem (400);
    // anything else is ours (500).
    let kml
    let gpxBuf: Buffer | undefined
    try {
      kml = processKml(await kmlFile.text())
      if (gpxFile) {
        validateGpx(await gpxFile.text())
        gpxBuf = Buffer.from(await gpxFile.arrayBuffer())
      }
    } catch (e) {
      if (e instanceof RouteFileError) return c.json({ error: e.message }, 400)
      throw e
    }
    const kmlBuf = Buffer.from(kml.storedKml, 'utf8')
    const incoming = kmlBuf.byteLength + (gpxBuf?.byteLength ?? 0)

    // Quota + insert + file writes in one transaction: the quota row is locked
    // (FOR UPDATE) so concurrent uploads cannot both squeeze under the cap, and
    // a failed file write rolls the row back.
    let fileMapId: number | null = null
    try {
      const created = await db.transaction(async (tx) => {
        const [q] = await tx
          .select({ quotaBytes: usersTable.quotaBytes, usedBytes: usersTable.usedBytes })
          .from(usersTable)
          .where(eq(usersTable.id, user.id))
          .for('update')
        if (q.usedBytes + incoming > q.quotaBytes) throw new QuotaExceeded(q.usedBytes, q.quotaBytes)

        const [m] = await tx
          .insert(mapsTable)
          .values({
            ownerId: user.id,
            slug: generateSlug(),
            title: meta.title,
            description: meta.description || null,
            color: meta.color,
            visibility: meta.visibility,
            externalUrl: meta.external_url || null,
            gpxPresent: Boolean(gpxBuf),
            kmlBytes: kmlBuf.byteLength,
            gpxBytes: gpxBuf?.byteLength ?? 0,
            waypointCount: kml.waypointCount,
            totalMiles: kml.totalMiles.toFixed(1),
          })
          .returning()

        fileMapId = m.id
        await writeMapFile(user.id, m.id, 'kml', kmlBuf)
        if (gpxBuf) await writeMapFile(user.id, m.id, 'gpx', gpxBuf)

        await tx
          .update(usersTable)
          .set({ usedBytes: q.usedBytes + incoming, updatedAt: new Date() })
          .where(eq(usersTable.id, user.id))
        return m
      })
      console.log(`[maps] user ${user.id} uploaded map ${created.id} (${incoming} bytes, ${created.visibility})`)
      return c.json({ id: created.id, slug: created.slug, title: created.title, visibility: created.visibility }, 201)
    } catch (e) {
      if (e instanceof QuotaExceeded) {
        return c.json(
          {
            error: `over quota: ${(e.usedBytes / MB).toFixed(1)} MB used of ${Math.round(e.quotaBytes / MB)} MB, upload is ${(incoming / MB).toFixed(1)} MB`,
          },
          413,
        )
      }
      // The insert rolled back; sweep any file that was written before the failure.
      if (fileMapId !== null) await deleteMapFiles(user.id, fileMapId)
      throw e
    }
  },
)

// --- Edit / delete ---------------------------------------------------------

// Owner-scoped lookup: someone else's map id (or an unknown one) is a plain
// 404 — never confirm that the map exists.
async function ownMap(userId: number, idParam: string) {
  const id = Number(idParam)
  if (!Number.isInteger(id) || id <= 0) return undefined
  const [m] = await db
    .select()
    .from(mapsTable)
    .where(and(eq(mapsTable.id, id), eq(mapsTable.ownerId, userId)))
    .limit(1)
  return m
}

mapsRoutes.patch('/api/maps/:id', requireAuthApi, requireSameOrigin, async (c) => {
  const user = currentUser(c)
  const m = await ownMap(user.id, c.req.param('id'))
  if (!m) return c.json({ error: 'not found' }, 404)

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
    .update(mapsTable)
    .set({
      ...(p.title !== undefined && { title: p.title }),
      ...(p.description !== undefined && { description: p.description || null }),
      ...(p.color !== undefined && { color: p.color }),
      ...(p.visibility !== undefined && { visibility: p.visibility }),
      ...(p.external_url !== undefined && { externalUrl: p.external_url || null }),
      updatedAt: new Date(),
    })
    .where(eq(mapsTable.id, m.id))
    .returning()
  return c.json({ id: updated.id, slug: updated.slug, title: updated.title, visibility: updated.visibility })
})

mapsRoutes.delete('/api/maps/:id', requireAuthApi, requireSameOrigin, async (c) => {
  const user = currentUser(c)
  const m = await ownMap(user.id, c.req.param('id'))
  if (!m) return c.json({ error: 'not found' }, 404)

  await db.transaction(async (tx) => {
    await tx.delete(mapsTable).where(eq(mapsTable.id, m.id))
    // Clamped at zero: a drifted cache must never wedge the account negative.
    await tx
      .update(usersTable)
      .set({
        usedBytes: sql`GREATEST(0, ${usersTable.usedBytes} - ${m.sizeBytes ?? 0})`,
        updatedAt: new Date(),
      })
      .where(eq(usersTable.id, user.id))
  })
  // Row is gone; file removal is best-effort cleanup.
  await deleteMapFiles(user.id, m.id)
  console.log(`[maps] user ${user.id} deleted map ${m.id} (freed ${m.sizeBytes ?? 0} bytes)`)
  return c.json({ ok: true })
})
