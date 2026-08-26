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
import { rides, days as daysTable, points, routeLegs, users as usersTable } from '../db/schema'
import { currentUser, requireActiveApi, requireSameOrigin, type AuthEnv } from '../auth/middleware'
import { newUid } from '../maps/uid'
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
  type SupportedFormat,
  nearestTrackIndex,
  type ExtractedPoint,
  type Track,
} from '../maps/kml'
import { splitDayTrack } from '../maps/track-split'
import { processCsv } from '../maps/csv'
import { processGeoJson } from '../maps/geojson'
import { isNativeRide, nativeVersion, NATIVE_FORMAT_VERSION, upgradeNativeRide } from '../maps/export'
import { MAX_DAYS, insertRideGraph, normalize, ridePayload, rideTotals } from '../maps/ride-graph'
import { extractKmlFromKmz } from '../maps/kmz'
import { parseExportName, titleFromSlug, type ParsedName } from '../maps/filename'
import { readZipEntries } from '../maps/zip'
import { fields, firstIssue } from '../maps/fields'
import { dayColor } from '../maps/palette'
import { generateSlug } from '../maps/slug'
import { MAX_SOURCE_FILES, type StoredExt } from '../maps/storage'
import { twistiness } from '../maps/twist'
import { deleteMapFiles, writeMapFile } from '../maps/storage'
import { turnstileEnabled, verifyTurnstile } from '../maps/turnstile'
import { LIVE_RIDE, restoreRide, trashRide } from '../trash/service'
import { RESTORE_REFUSAL_MESSAGES } from '../trash/policy'

// Re-exported: rides.ts has imported these from here since before they had
// a module of their own.
export { fields, firstIssue }

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

// A day's name from the file it came from: "day-2-coast.gpx" reads better in
// the legend than "Day 2", and a rider who named their files named them for a
// reason. Falls back to the position when the name says nothing useful.
//
// A name following the convention (maps/filename.ts) is read by the caller
// before this is reached, so what lands here is a name nobody structured.
function dayTitle(fileName: string, index: number): string {
  const base = fileName
    .replace(/\.[A-Za-z0-9]+$/, '')
    .replace(/[_-]+/g, ' ')
    .trim()
    .slice(0, 120)
  return base || `Day ${index + 1}`
}

// A zip is a container, not a route format: it is expanded before anything asks
// what format a file is, so nothing downstream ever sees one.
//
// It exists because the per-day export writes one, and a rider who downloads an
// archive should be able to drag it straight back in. Caps are the point of the
// options rather than an afterthought — a per-entry cap alone does not bound an
// archive, so maxTotalBytes bounds the sum as it accumulates.
const ZIP_UPLOAD_MAX_TOTAL = 32 * MB

const zipReadOptions = {
  label: 'Zip',
  maxEntryBytes: Math.max(...SUPPORTED_FORMATS.map((f) => FORMAT_INFO[f].maxBytes)),
  maxTotalBytes: ZIP_UPLOAD_MAX_TOTAL,
  maxEntries: MAX_SOURCE_FILES,
  // Only files this app could import. A .zip inside a .zip is excluded here
  // rather than by a depth counter, so there is no recursion to bound.
  keep: (name: string) => isSupportedFormat((name.match(/\.([A-Za-z0-9]+)$/)?.[1] ?? '').toLowerCase()),
  oversize: (max: number) => `a file inside the zip exceeds ${max / MB} MB`,
  tooMany: (max: number) => `that zip holds more than ${max} route files`,
  tooLarge: (max: number) => `that zip unpacks to more than ${max / MB} MB`,
  error: (m: string) => new RouteFileError(m),
}

// --- Import ----------------------------------------------------------------

mapsRoutes.post(
  '/api/maps',
  requireActiveApi,
  requireSameOrigin,
  bodyLimit({ maxSize: BODY_LIMIT, onError: (c) => c.json({ error: 'upload too large' }, 413) }),
  async (c) => {
    const user = currentUser(c)
    // `all: true` so several files posted under the same field name arrive as
    // an array rather than the last one silently winning.
    const body = await c.req.parseBody({ all: true })

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
    //
    // Several files become several days of one ride, in the order given. That
    // is what a rider with a folder of per-day GPX files actually has, and
    // importing them one at a time would make a separate ride per day rather than one ride with days.
    const asFiles = (v: unknown): File[] =>
      (Array.isArray(v) ? v : [v]).filter((f): f is File => f instanceof File && f.size > 0)
    const posted = asFiles(body.route).length > 0 ? asFiles(body.route) : asFiles(body.kml)
    if (posted.length === 0) return fail('a route file is required', 400)

    // A zip becomes the files inside it, before anything asks what format
    // anything is. This is the other half of the per-day zip download: an
    // archive this app wrote drags straight back in and comes out as the ride
    // it left as.
    const uploads: File[] = []
    try {
      for (const f of posted) {
        if (!/\.zip$/i.test(f.name)) {
          uploads.push(f)
          continue
        }
        const entries = readZipEntries(Buffer.from(await f.arrayBuffer()), zipReadOptions)
        if (entries.length === 0) return fail(`${f.name}: no route files in that zip`, 400)
        // The entry name is used for its extension and its day fields and for
        // nothing else — it never becomes a path. readZipEntries has already
        // reduced it to a basename.
        for (const e of entries) uploads.push(new File([e.data], e.name))
      }
    } catch (e) {
      if (e instanceof RouteFileError) return fail(e.message, 400)
      throw e
    }

    if (uploads.length > MAX_SOURCE_FILES) {
      return fail(`too many files — ${MAX_SOURCE_FILES} is the limit for one ride`, 400)
    }

    // Validate every file before parsing any, so a bad tenth file fails the
    // upload rather than leaving nine days half-imported.
    const sources: Array<{ file: File; ext: SupportedFormat; planned: ParsedName | null }> = []
    for (const file of uploads) {
      const e = (file.name.match(/\.([A-Za-z0-9]+)$/)?.[1] ?? '').toLowerCase()
      if (!isSupportedFormat(e)) {
        return fail(`unsupported file type "${e || file.name}" — accepted: ${SUPPORTED_FORMATS.join(', ')}`, 400)
      }
      const cap = FORMAT_INFO[e].maxBytes
      if (file.size > cap) return fail(`${file.name}: ${e.toUpperCase()} exceeds ${cap / MB} MB`, 413)
      sources.push({ file, ext: e, planned: parseExportName(file.name) })
    }

    // Day order comes from the filenames when every one of them carries a day,
    // and from the upload order otherwise. Partial is deliberately not handled:
    // interleaving numbered and unnumbered files needs a rule nobody asked for,
    // and the upload order is the answer this endpoint has always given.
    //
    // This matters most for a zip, where entry order is whatever the archive
    // happened to store, and for a folder selection on a browser that does not
    // sort. A d01/d02/d03 set comes out right either way.
    if (sources.length > 1 && sources.every((s) => s.planned?.day != null)) {
      sources.sort((a, b) => a.planned!.day! - b.planned!.day!)
    }

    // The single-file case keeps every behavior it had, including the
    // companion-GPX path below, which only ever made sense for one route file.
    const single = sources.length === 1 ? sources[0] : null
    const ext = single?.ext ?? 'mixed'

    // A native Routeloop JSON is a different door entirely: it is the builder's
    // own save payload, so it skips extraction and goes through the same schema
    // and the same insert a save does. Nothing about it is a route *file* — it
    // is a ride, restored. It arrives as .json like GeoJSON does, so the two
    // are told apart by the version field rather than by extension.
    if (single && (single.ext === 'json' || single.ext === 'geojson')) {
      const text = await single.file.text()
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        return fail('that file is not valid JSON', 400)
      }
      if (isNativeRide(parsed)) {
        const version = nativeVersion(parsed)
        if (version > NATIVE_FORMAT_VERSION) {
          return fail(`this file was written by a newer version of Routeloop (format ${version})`, 400)
        }
        const check = ridePayload.safeParse({ ...upgradeNativeRide(parsed), title: meta.title })
        if (!check.success) return fail(firstIssue(check.error), 400)
        const payload = check.data
        // The uploader owns what they upload, and a restored ride lands
        // private regardless of what the file says — publishing is a decision
        // taken here, not one carried in from a file someone was sent.
        payload.visibility = meta.visibility
        normalize(payload)
        const totals = rideTotals(payload)

        // No file is stored and no quota is charged: a native ride is rows, and
        // the caps that bound it are structural (MAX_DAYS, MAX_STOPS, the
        // per-ride point ceiling) rather than byte-based. That is exactly how a
        // ride built in the builder is treated.
        const created = await db.transaction(async (tx) => {
          const [ride] = await tx
            .insert(rides)
            .values({
              ownerId: user.id,
              slug: generateSlug(),
              title: payload.title,
              description: payload.description || null,
              visibility: payload.visibility,
              source: 'native',
              externalUrl: payload.external_url || null,
              ...totals,
            })
            .returning()
          await insertRideGraph(tx, ride.id, payload)
          return ride
        })
        console.log(`[import] user ${user.id} restored native ride ${created.id} (${created.visibility})`)
        return wantsRedirect
          ? c.redirect(`/m/${created.slug}`, 302)
          : c.json({ id: created.id, slug: created.slug, title: created.title, visibility: created.visibility }, 201)
      }
    }

    // A GPX may still arrive as a companion to a KML, which is what this
    // endpoint accepted before it took anything but KML. In that case the KML
    // is the route and the GPX is kept only so it can be downloaded again.
    const companionGpx =
      single && single.ext !== 'gpx' && body.gpx instanceof File && body.gpx.size > 0 ? body.gpx : undefined
    if (companionGpx) {
      if (!/\.gpx$/i.test(companionGpx.name)) return fail('track file must be a .gpx', 400)
      if (companionGpx.size > GPX_MAX_BYTES) return fail(`GPX exceeds ${GPX_MAX_BYTES / MB} MB`, 413)
    }

    // Parse, sanitize, extract structure. A RouteFileError is the user's
    // problem (400); anything else is ours (500).
    //
    // Every branch yields the same ExtractedRoute plus the bytes to keep, and
    // every format keeps its original. That last part was not always true:
    // GeoJSON and CSV briefly stored nothing on the theory that the rows were a
    // complete record of the upload. They are not — import flattens a multi-day
    // file to one route, so the day structure would have existed in the upload
    // and then existed nowhere. The file is the only copy of what was actually
    // sent, which is the whole reason to keep one.
    //
    // KML is stored re-serialized after sanitizing (processKml returns
    // storedKml); everything else is stored as uploaded. All of it streams back
    // with an explicit non-HTML content type and nosniff, so none of it can be
    // coaxed into rendering.
    // One day per *track*, not per file. A file holding several — a GPX with a
    // <trk> per day, a KML with a Placemark per day — becomes that many days,
    // because the alternative is keeping one and discarding the rest, which is
    // the data loss this pipeline used to ship (#70).
    //
    // `buf` is the stored original and belongs to the file, so only the first
    // day out of a file carries it. Every day counting the same bytes would
    // charge a rider's quota three times for one upload.
    type Day = {
      points: ExtractedPoint[]
      track: Track
      trackMeters: number
      title: string | null // the file's own name for this day, if it had one
      ext: StoredExt
      // The stored original and its slot on disk. Both belong to the file, so
      // only the first day out of a file carries them; the rest write nothing.
      buf: Buffer | null
      fileIndex: number
      name: string
      // Read off the filename, when it followed the convention. Both belong to
      // the file, so a file that produced several days gives them to the first
      // only: one filename cannot date three days, and stamping them all with
      // the same start would be an invention rather than a recovery.
      fileTitle: string | null
      startAt: Date | null
    }
    const days: Day[] = []

    // Waypoints arrive at document level with nothing tying them to a track, so
    // when a file holds several they are assigned by proximity — a stop sitting
    // on day 3's road belongs to day 3. With one track the question does not
    // arise and every point goes to it, which is what always happened.
    const addDays = (
      route: ExtractedRoute,
      ext: StoredExt,
      buf: Buffer,
      name: string,
      fileIndex: number,
      planned: ParsedName | null,
    ) => {
      const fileTitle = planned?.title ? titleFromSlug(planned.title) : null
      if (route.tracks.length <= 1) {
        days.push({
          points: route.points,
          track: route.track,
          trackMeters: route.trackMeters,
          title: route.tracks[0]?.name ?? null,
          ext,
          buf,
          fileIndex,
          name,
          fileTitle,
          startAt: planned?.date ?? null,
        })
        return
      }
      const buckets: ExtractedPoint[][] = route.tracks.map(() => [])
      for (const p of route.points) buckets[nearestTrackIndex(route.tracks, p)].push(p)
      route.tracks.forEach((t, i) => {
        days.push({
          points: buckets[i],
          track: t.track,
          trackMeters: t.meters,
          title: t.name,
          ext,
          // Only the first day of the file owns the bytes.
          buf: i === 0 ? buf : null,
          fileIndex,
          name,
          // A file naming one day cannot name three, so the tracks' own names
          // stand and only the first inherits the filename's date.
          fileTitle: i === 0 ? fileTitle : null,
          startAt: i === 0 ? (planned?.date ?? null) : null,
        })
      })
    }

    let gpxBuf: Buffer | undefined
    try {
      for (const [fileIndex, { file, ext: e, planned }] of sources.entries()) {
        if (e === 'geojson' || e === 'json') {
          const text = await file.text()
          addDays(processGeoJson(text), e, Buffer.from(text, 'utf8'), file.name, fileIndex, planned)
        } else if (e === 'csv') {
          // Stops and nothing else — no track, so no legs, no mileage and no
          // twistiness. The ride gets its line when it is routed in the builder.
          const text = await file.text()
          addDays(processCsv(text), 'csv', Buffer.from(text, 'utf8'), file.name, fileIndex, planned)
        } else if (e === 'gpx') {
          const buf = Buffer.from(await file.arrayBuffer())
          addDays(processGpx(await file.text()), 'gpx', buf, file.name, fileIndex, planned)
          if (single) gpxBuf = buf
        } else {
          // Unzipping first means the KMZ path converges on processKml before
          // anything is parsed, so DOCTYPE rejection, sanitizing and extraction
          // are the same code for both — a KMZ cannot route around them. The
          // archive is stored as the KML pulled out of it; `source_format`
          // remembers it arrived zipped.
          const text = e === 'kmz' ? extractKmlFromKmz(Buffer.from(await file.arrayBuffer())) : await file.text()
          const kml = processKml(text)
          addDays(kml, 'kml', Buffer.from(kml.storedKml, 'utf8'), file.name, fileIndex, planned)
        }
      }
      if (companionGpx) {
        validateGpx(await companionGpx.text())
        gpxBuf = Buffer.from(await companionGpx.arrayBuffer())
      }
    } catch (e) {
      // Name the file, or a folder import that fails says only "no <kml> root"
      // and leaves the rider to work out which of thirty files it meant.
      if (e instanceof RouteFileError) {
        return fail(sources.length > 1 ? `${sources[days.length]?.file.name ?? 'file'}: ${e.message}` : e.message, 400)
      }
      throw e
    }

    // A file can now produce more days than files were uploaded, so the ride's
    // route cap has to be checked here rather than being implied by
    // MAX_SOURCE_FILES. Refused rather than truncated: dropping days 32+ is the
    // silent data loss this whole change exists to remove, and a rider who is
    // told the number can split the file themselves. A merge step in the
    // importer is the real answer (#70) and this is what holds until then.
    if (days.length > MAX_DAYS) {
      return fail(
        `that import comes to ${days.length} days and the limit is ${MAX_DAYS} — split it and import the parts as separate rides`,
        400,
      )
    }

    // Which byte column each stored original lands in. KML and GPX have their
    // own for historical reasons and because "how big is the KML" stays a
    // question worth answering; everything else shares source_bytes.
    const bytesIn = (want: (d: Day) => boolean) => days.filter(want).reduce((n, d) => n + (d.buf?.byteLength ?? 0), 0)
    const kmlBytes = bytesIn((d) => d.ext === 'kml')
    const gpxBytes = bytesIn((d) => d.ext === 'gpx') + (companionGpx ? (gpxBuf?.byteLength ?? 0) : 0)
    const sourceBytes = bytesIn((d) => d.ext !== 'kml' && d.ext !== 'gpx')

    // Must equal the generated `size_bytes` the delete path subtracts. The two
    // are computed by different sides — the app on the way in, the database on
    // the way out — and quota drifts permanently if they ever disagree, so this
    // is the same sum as the column expression and nothing else.
    const incoming = kmlBytes + gpxBytes + sourceBytes

    const totalMeters = days.reduce((m, d) => m + d.trackMeters, 0)
    const totalMiles = (totalMeters / METERS_PER_MILE).toFixed(1)
    const stopCount = days.reduce((n, d) => n + d.points.filter((p) => p.kind !== 'poi').length, 0)

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
            // The extension as uploaded, so a KMZ is remembered as a KMZ even
            // though what sits on disk is the KML from inside it.
            sourceFormat: ext,
            kmlBytes,
            gpxBytes,
            sourceBytes,
            totalMiles,
            stopCount,
          })
          .returning()

        // One day per file, in the order they were given. A single upload is
        // the same code path with one day in the list.
        for (const [i, day] of days.entries()) {
          const distM = Math.round(day.trackMeters)

          // An imported ride never touches the router, so this is the only shape
          // information it will ever have — which is exactly why twistiness is
          // computed from geometry rather than from routing maneuvers. It is
          // per-day: averaging a whole ride would bury the good road in the
          // straight one that got you there.
          const twist = twistiness(day.track)
          const [dayRow] = await tx
            .insert(daysTable)
            .values({
              rideId: ride.id,
              position: i,
              // Every day the same color would make the viewer's legend
              // useless, so a multi-file import walks the palette the builder
              // uses. A single file keeps exactly the color that was asked for.
              color: days.length > 1 ? dayColor(i) : meta.color,
              // '' is this column's no-title value (notNull, default ''),
              // and the viewer already falls back to "Day N" when it is empty.
              //
              // Precedence, and the reason for it: the file's own name for the
              // day wins — a GPX <trk><name>Day 2</name> is what the rider
              // typed, where a filename title survived a trip through slugField
              // and comes back capitalised by guess. A conforming filename is
              // next, since it at least meant to say something. Mangling the
              // raw filename is last and only for a multi-day import.
              title: day.title ?? day.fileTitle ?? (days.length > 1 ? dayTitle(day.name, i) : ''),
              // The one field a filename is authoritative for. Neither GPX nor
              // KML can carry a date at all, so for those formats this is the
              // only way a planned schedule survives a round trip.
              startAt: day.startAt,
              distanceM: distM,
              twistinessDpm: twist?.dpm ?? null,
              twistinessBestDpm: twist?.bestDpm ?? null,
            })
            .returning()

          // ONE LEG PER PAIR OF POINTS, cut from the imported track.
          //
          // This used to write a single leg holding the whole track, which is
          // what made an imported ride impossible to open in the builder: the
          // builder's model — and `daySchema` in ride-graph.ts — is N points and
          // exactly N−1 legs. An imported ride could not satisfy that, so
          // /builder/:id answered 409 and the FAQ's promise of "an editable
          // ride, not a picture of one" was false.
          //
          // Nothing is re-routed and no coordinate is invented: the legs are
          // slices of the geometry that arrived, sharing their joint vertices,
          // so concatenating them gives the original track back exactly. Every
          // reader concatenates, which is why the map line, all four
          // track-based export formats and twistiness are unaffected. See
          // src/maps/track-split.ts for the rules, including what happens at
          // the ends and to a file with no waypoints at all.
          //
          // BOTH KINDS ARE PLACED as of 2026-08-24. The split used to pass POIs
          // through untouched and this line appended them after the stops, which
          // was right while a POI anchored no leg. It would now draw a road out
          // to a viewpoint that sat halfway along the day and back again.
          const split = splitDayTrack(day.track, day.points)
          const ordered = split.points

          // Deliberately still measured against the whole track rather than
          // summed from the legs. `days.distance_m` and `rides.total_miles`
          // have always been the haversine of the imported line and there is no
          // reason for a change in how it is sliced to move a stored mileage.
          //
          // With no track to project onto, distFromStartAlongTrack answers 0
          // for every point. That is a claim — "this stop is at the start" —
          // and it is false for all but the first. A trackless import stores
          // null instead, the same null-is-not-zero distinction twistiness
          // makes: null means nothing measured it, 0 means it measured zero.
          const stopDists: Array<number | null> =
            day.track.length > 0 ? distFromStartAlongTrack(day.track, ordered) : ordered.map(() => null)

          if (ordered.length > 0) {
            // EVERY point carries a position, both kinds, dense from 0 —
            // matching what the builder writes. `ordered` is one list in
            // ALONG-TRACK order, which is the order their legs connect them in.
            // It is not necessarily the order they appeared in the file: GPX
            // writes <wpt> elements at document level with nothing tying them to
            // a track.
            await tx.insert(points).values(
              ordered.map((p, n) => {
                const isPoi = p.kind === 'poi'
                return {
                  dayId: dayRow.id,
                  kind: isPoi ? ('poi' as const) : ('stop' as const),
                  position: n,
                  lat: p.lat,
                  lng: p.lng,
                  name: p.name,
                  description: p.description,
                  roles: p.roles,
                  durationMin: p.durationMin ?? null,
                  distFromStartM: stopDists[n],
                  // A file from another app carries no uid, so one is minted
                  // here. This is the second place points are inserted —
                  // insertRideGraph is the other — and both have to mint them or
                  // the NOT NULL fails at runtime with nothing to say why.
                  uid: newUid(),
                }
              }),
            )
          }
          if (split.legs.length > 0) {
            await tx.insert(routeLegs).values(
              split.legs.map((leg, n) => ({
                dayId: dayRow.id,
                position: n,
                geometry: leg.geometry,
                distanceM: leg.distanceM,
              })),
            )
          }

          fileRideId = ride.id
          // Indexed by file, not by day: one file that produced three days is
          // still one original on disk, and writing it three times would both
          // waste the slots and disagree with the bytes charged to quota.
          if (day.buf) await writeMapFile(user.id, ride.id, day.ext, day.buf, day.fileIndex)
        }
        if (companionGpx && gpxBuf) await writeMapFile(user.id, ride.id, 'gpx', gpxBuf)

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
// IMPORTED RIDES ARE NOT EXCLUDED ANY MORE. They were, and the reason was
// mechanical rather than principled: an imported day was stored as one leg
// holding the whole track, which the builder's N stops / N−1 legs model cannot
// represent, so /builder/:id answered 409. The import splits the track into real
// legs now (src/maps/track-split.ts), so there is nothing left to refuse — and
// the FAQ had been promising "an editable ride, not a picture of one" the whole
// time this returned false.
//
// `source` stays on the ride as provenance and is deliberately NOT consulted
// here: it records where the ride came from, which `source_format`, the byte
// columns and the GTFO archive all depend on. It was never a statement about
// what may be done with the ride.
export function canEditRide(ride: { ownerId: number }, viewer: { id: number; status: string } | null): boolean {
  if (!viewer || viewer.status !== 'active') return false
  return ride.ownerId === viewer.id
}

/**
 * The rider's own ride, or undefined.
 *
 * EXCLUDES THE RECYCLE BIN BY DEFAULT, and that default is doing most of the
 * work in this feature: the builder, the PATCH, the delete, the exports, the
 * roadbook and the hand-off all resolve a ride through here, so a trashed ride
 * stops being editable, exportable and printable in one place rather than
 * fifteen. `includeTrashed` is for the bin's own restore path, which is the only
 * caller that has any business finding one.
 */
export async function ownRide(userId: number, idParam: string, opts: { includeTrashed?: boolean } = {}) {
  const id = Number(idParam)
  if (!Number.isInteger(id) || id <= 0) return undefined
  const [r] = await db
    .select()
    .from(rides)
    .where(and(eq(rides.id, id), eq(rides.ownerId, userId), ...(opts.includeTrashed ? [] : [LIVE_RIDE])))
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
  // Color lives on days now; a meta-level color change recolors the whole
  // ride (one day for imports; per-day colors are edited in the builder).
  if (p.color !== undefined) {
    await db.update(daysTable).set({ color: p.color }).where(eq(daysTable.rideId, ride.id))
  }
  return c.json({ id: updated.id, slug: updated.slug, title: updated.title, visibility: updated.visibility })
})

/**
 * "Delete" a ride, which now means MOVE IT TO THE RECYCLE BIN.
 *
 * The route keeps its verb and its path deliberately. A rider pressing Delete
 * means "get this out of my way", not "destroy this irrecoverably", and every
 * caller — including any that predates the bin — gets the safer behavior with no
 * change. Nothing here destroys anything any more: the row stays, the files stay
 * on disk, and only the purge removes either.
 *
 * The quota still frees immediately. That half is unchanged from the hard
 * delete, and it is why trashRide() is a transaction rather than one UPDATE.
 */
mapsRoutes.delete('/api/maps/:id', requireActiveApi, requireSameOrigin, async (c) => {
  const user = currentUser(c)
  const ride = await ownRide(user.id, c.req.param('id'))
  if (!ride) return c.json({ error: 'not found' }, 404)

  const trashed = await trashRide(user.id, ride.id)
  if (!trashed) return c.json({ error: 'not found' }, 404)
  return c.json({ ok: true, purgeAfter: trashed.purgeAfter.toISOString() })
})

/**
 * Out of the bin again. Refuses when the restore would put the rider over their
 * quota — trashing freed the allowance, and they may have spent it since.
 *
 * `includeTrashed` is the ONLY place that flag is passed, which is what keeps
 * ownRide()'s default honest everywhere else.
 */
mapsRoutes.post('/api/maps/:id/restore', requireActiveApi, requireSameOrigin, async (c) => {
  const user = currentUser(c)
  const ride = await ownRide(user.id, c.req.param('id'), { includeTrashed: true })
  if (!ride) return c.json({ error: 'not found' }, 404)

  const result = await restoreRide(user.id, ride.id)
  if (result.ok) return c.json({ ok: true })
  if (result.reason === 'not-found') return c.json({ error: 'not found' }, 404)
  // 409 rather than 400: the request was well-formed and the answer is about
  // the account's state, not the request's shape.
  return c.json({ error: RESTORE_REFUSAL_MESSAGES[result.reason] ?? 'cannot restore' }, 409)
})
