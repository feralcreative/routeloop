// The import page.
//
// `POST /api/maps` has existed and worked since the pivot, and until now it was
// reachable only by API — nothing in the app rendered a file input. So a rider
// with a folder of route files had no way to get them in.
//
// A plain multipart form, not fetch+JSON, for the same reason profile.ts and
// admin.ts are plain forms: this should not stop working without JavaScript, and
// a form plus one redirect is less code than an endpoint and a client script.
// The form posts to the existing /api/maps and sets `redirect=1`, which makes
// that handler answer with a redirect instead of JSON. See the note there.
import { Hono } from 'hono'
import { z } from 'zod'
import { and, desc, eq, exists, gte, ilike, lt, or, sql } from 'drizzle-orm'
import { db } from '../db/index'
import { days as daysTable, rides } from '../db/schema'
import { currentUser, requireActive, requireActiveApi, requireSameOrigin, type AuthEnv } from '../auth/middleware'
import { page } from '../views/layout'
import { asset } from '../views/assets'
import { TURNSTILE_SITE_KEY, turnstileEnabled } from '../maps/turnstile'
import { FORMAT_INFO, SUPPORTED_FORMATS } from '../maps/kml'
import { LIVE_RIDE } from '../trash/service'
import { DOWNLOADS, DOWNLOAD_FORMATS } from '../maps/downloads'
import { buildNativeJson, loadNativeRide, loadRideForExport, rideStartDate } from '../maps/export'
import { detailsForViewer } from '../maps/point-details'
import { buildExportName, uniqueName, NATIVE_EXT } from '../maps/filename'
import { parseRideQuery } from '../maps/ride-search'
import { buildZip } from '../maps/zip'

export const importRoutes = new Hono<AuthEnv>()

const MB = 1024 * 1024

// Read from the pipeline rather than restated, so the form cannot offer a
// format the server refuses — or omit one it accepts.
const FORMATS = SUPPORTED_FORMATS.map((ext) => ({ ext, ...FORMAT_INFO[ext] }))
const MAX_BYTES = Math.max(...FORMATS.map((f) => f.maxBytes))

// The formats a ride can leave as, for the cart's per-row picker. Built from
// DOWNLOAD_FORMATS plus the native one rather than listed by hand, so the page
// cannot offer a format /export/zip refuses — the two read the same constants.
//
// routeloop.json is last because it is the lossless one; the others all drop
// something (see maps/export.ts).
const LABELS: Record<string, string> = { gpx: 'GPX', kml: 'KML', geojson: 'GeoJSON', csv: 'CSV' }
const EXPORTS = [
  ...DOWNLOAD_FORMATS.map((f) => ({ format: f as string, label: LABELS[f] })),
  { format: NATIVE_EXT, label: 'Routeloop (lossless)' },
]

importRoutes.get('/import', requireActive, async (c) => {
  const user = currentUser(c)
  const error = c.req.query('error')

  // The export half asks ONE question of the database and it is "do you have
  // any": the rides themselves arrive through /api/export/search, capped and on
  // demand. This page used to select every ride the rider owned, unpaginated,
  // and render one row per ride times one button per format — see #131.
  const [{ n: owned }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(rides)
    .where(and(eq(rides.ownerId, user.id), LIVE_RIDE))

  return c.html(
    page({
      title: 'Import a route',
      user,
      navKey: 'import',
      body: (
        <>
          <h1>Import / Export</h1>
          <p class="lede">Bring a route in from another app, or take one of yours out. Both directions, one page.</p>

          <h2 class="transfer-head">Import</h2>

          {error && <p class="notice is-error">{error}</p>}

          <form class="import-form" method="post" action="/api/maps" enctype="multipart/form-data">
            {/*
              Tells /api/maps to answer with a redirect rather than JSON. A
              hidden field rather than sniffing the Accept header: an API client
              that happens to send text/html should still get JSON, and being
              explicit means the two behaviors cannot be triggered by accident.
            */}
            <input type="hidden" name="redirect" value="1" />

            {/*
              The rider's corrections to what the filenames were read as, filled
              in by import.js at submit time and empty otherwise — which is what
              keeps this form working with JavaScript off, blocked or broken:
              no manifest means the server derives everything from the filenames,
              exactly as it always did. See src/maps/manifest.ts.
            */}
            <input type="hidden" name="manifest" id="f-manifest" value="" />

            <p class="field">
              <label for="f-route">Route files</label>
              {/*
                The drop zone is `hidden` in the markup and unhidden by
                import.js, so a rider without JavaScript is never shown a box
                that does nothing. The file input inside it is the real control
                either way — everything below is enhancement over a form that
                already works.
              */}
              <span class="dropzone" id="dropzone" hidden>
                <span class="dropzone-hint">Drop your route files here</span>
                <span class="dropzone-sub">or click to choose</span>
              </span>
              {/*
                `multiple` because a rider with a multi-day ride has one file
                per day, and importing them one at a time makes a separate ride
                out of each day. Several files become several days of one ride.
                Order comes from the day field in the filename where the files
                carry one, and from the browser's listing otherwise.
              */}
              <input
                id="f-route"
                name="route"
                type="file"
                multiple
                required
                accept={[...FORMATS.map((f) => `.${f.ext}`), '.zip'].join(',')}
              />
              <span class="field-hint">
                Up to {MAX_BYTES / MB} MB each, depending on the format. Pick several and each becomes a day, or drop a{' '}
                <strong>.zip</strong> of them.
              </span>
            </p>

            {/*
              THE REVIEW TABLE (#129). What the filenames were read as, shown
              before the upload rather than after — and editable, which is the
              half that makes the guessing worth doing. A wrong day order costs
              one drag here and a rebuild in the builder.

              Empty in the markup and filled by import.js, so a rider without
              JavaScript is never shown a table that cannot be edited. Their
              import still works; it just takes the filenames at their word.
            */}
            <div class="import-plan" id="import-plan" hidden></div>

            {/*
              The convention, where the rider is actually about to use it.
              Collapsed by default and marked optional, because it is: every
              file that ignores it imports exactly as it always did, and a form
              that opens with a naming spec reads like a requirement.

              A <details> rather than a link to the FAQ alone. Sending someone
              off the page to learn how to name the files they are holding is
              how it goes unread — the FAQ link is still here for the longer
              answer.
            */}
            <details class="naming-help">
              <summary>File names can carry metadata like the ride date (optional)</summary>
              <div class="naming-help-body">
                <p>
                  Anything you download from Routeloop is already named this way, so a folder you exported here drops
                  straight back in and comes out as the same ride.
                </p>

                {/*
                  A color per field, carried from the example down to the line
                  that defines it, so which part of the name is being described
                  needs no counting of underscores.

                  The colors are their own tokens ($ride, $day, $date, $label)
                  rather than the existing palette: every color already defined
                  means something — $gpx, $kml and $pending are format and state
                  — and a field that borrowed one would inherit a meaning it does
                  not have. See the note in _tokens.scss for how they are picked.

                  The definitions stay in the order of the example, and each one
                  still names its field in words, because color cannot be the
                  only cue: $day and $label converge under protanopia.
                */}
                <p class="naming-example">
                  <code>
                    routeloop_<b class="f-ride">big-sur-run</b>_<b class="f-day">d02</b>_
                    <b class="f-date">2026-08-14</b>_<b class="f-label">lost-coast</b>.gpx
                  </code>
                </p>

                <ul class="naming-fields">
                  <li>
                    <code>routeloop_</code> is literal, and it is what marks the name as structured. Without it none of
                    this applies and your file imports the way it always did.
                  </li>
                  <li>
                    Then <b class="f-ride">the ride</b>, <b class="f-day">d plus the day number</b>,{' '}
                    <b class="f-date">the date</b> that day starts, and <b class="f-label">what you call it</b>.
                    Everything after the ride name is optional.
                  </li>
                  <li>Underscores separate the parts, so hyphens are what go inside one.</li>
                </ul>

                <p>
                  <strong>The date is the part worth having.</strong> A GPX or KML file has nowhere inside it to put
                  one, so if you plan a ride here, export it for your GPS and bring it back, the schedule is the one
                  thing that would otherwise be lost.
                </p>

                <p>
                  <a href="/faq#file-names" target="_blank" rel="noopener">
                    More about file names
                  </a>
                </p>
              </div>
            </details>

            {/*
              The cap is per format and they differ, so each row carries its
              own rather than the hint above quoting the largest and being
              wrong for the rest.
            */}
            <p class="field-formats">
              {FORMATS.map((f) => (
                <span class="format">
                  <strong>.{f.ext}</strong>
                  <span class="format-note">{f.note}</span>
                  <span class="format-cap">{f.maxBytes / MB} MB</span>
                </span>
              ))}
            </p>

            {/*
              The two short fields pair up at >=992px rather than each running
              the width of an uncapped form (#130). The form itself is NOT a
              grid: import is a sequence — drop the files, name it, choose who
              sees it — and columns would break that order.
            */}
            <div class="two-col">
              <p class="field">
                <label for="f-title">Name it</label>
                <input id="f-title" name="title" type="text" maxlength={150} required autocomplete="off" />
                <span class="field-hint">What it shows up as in your rides.</span>
              </p>

              <p class="field">
                <label for="f-visibility">Who can see it</label>
                <select id="f-visibility" name="visibility">
                  <option value="private" selected>
                    Private—only you
                  </option>
                  <option value="friends">Friends—riders you have added</option>
                  <option value="unlisted">Unlisted—anyone with the link</option>
                  <option value="public">Public—listed in Explore</option>
                </select>
              </p>
            </div>

            {turnstileEnabled() && TURNSTILE_SITE_KEY && (
              <div class="cf-turnstile" data-sitekey={TURNSTILE_SITE_KEY}></div>
            )}

            <p>
              <button class="btn" type="submit">
                Import
              </button>
            </p>
          </form>

          <h2 class="transfer-head">Export</h2>
          {owned === 0 ? (
            <p class="empty">Nothing to export yet — import a route above, or plan one.</p>
          ) : (
            <>
              <p class="lede">
                Find the rides you want, pick a format for each, and take the lot as one zip. A multi-day ride can also
                come down as a zip of one file per day, from the ride's own page.
              </p>

              {/*
                A plain form posting to /export/zip. A download is the one thing
                a form does better than fetch: the browser handles the
                attachment and the save dialog, where fetch would have to buffer
                the whole archive into a blob and fake a click on an anchor.
              */}
              <form class="export-cart" method="post" action="/export/zip" data-formats={JSON.stringify(EXPORTS)}>
                <input type="hidden" name="cart" id="f-cart" value="" />

                <p class="field ex-search-field">
                  <label for="ex-search">Find a ride</label>
                  <input
                    id="ex-search"
                    type="search"
                    autocomplete="off"
                    placeholder="Name, or when you rode — August, 2026-08-14"
                  />
                  {/*
                    The results land in here, absolutely positioned over what
                    follows rather than pushing it down the page — a list that
                    shoves the cart around on every keystroke is unusable with a
                    mouse. Empty and hidden until there is something to show.
                  */}
                  <span class="ex-results" id="ex-results" hidden></span>
                  <span class="field-hint">
                    Searches the names of your rides and the dates you rode them, not when you made the record.
                  </span>
                </p>

                <ul class="ex-cart" id="ex-cart"></ul>

                <p>
                  <button class="btn" type="submit" id="ex-go" disabled>
                    Download
                  </button>
                </p>
              </form>

              {/*
                The export half is the one part of this page that genuinely
                needs JavaScript — a search box and a cart cannot be anything
                else. Rather than also rendering the old list of every ride,
                which is the unbounded query #131 exists to remove, this points
                at the place those downloads already live.
              */}
              <noscript>
                <p class="notice">
                  Searching needs JavaScript. Every ride's own page has its downloads — <a href="/rides">your rides</a>.
                </p>
              </noscript>
            </>
          )}
        </>
      ).toString(),
      head:
        turnstileEnabled() && TURNSTILE_SITE_KEY
          ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" defer></script>'
          : undefined,
      // filename.js first: import.js reads window.TBFilename at load and bails
      // if it is not there, which is the correct behavior for a missing
      // dependency and the wrong one for a race.
      scripts: [
        // The same pinned SortableJS the builder uses — exact version, SRI hash,
        // crossorigin, approved 2026-08-15. `defer` scripts run in document
        // order, so window.Sortable exists by the time import.js looks for it.
        // **If the CDN fails, the review table still works**: initDrag() checks
        // for the global and returns quietly, and every row carries Move up and
        // Move down, which are also the keyboard path because a drag handle is
        // not one.
        '<script src="https://cdn.jsdelivr.net/npm/sortablejs@1.15.7/Sortable.min.js" integrity="sha384-DgmC6Xe2bSN2WjTDXzWYbUbxyhNP+NNkGDR/g78pCXV7E7rcVTGxVg0uIVCUUcBc" crossorigin="anonymous" defer></script>',
        `<script src="${asset('/js/filename.js')}"></script>`,
        `<script src="${asset('/js/import.js')}"></script>`,
        `<script src="${asset('/js/export-cart.js')}" defer></script>`,
      ].join('\n'),
    }),
  )
})

// --- The export cart (#131) ---------------------------------------------------
//
// The export half of this page used to select EVERY ride the owner had,
// unpaginated, and render one row per ride carrying one button per format. The
// DOM was rides × formats: a wall at a dozen rides, a page nobody can use at a
// hundred, and a query nobody should run. There was also no way to take two
// rides at once.
//
// So: a search box, a cart, and one zip. The two routes below are that, and the
// interaction is in public/js/export-cart.js.

/** How many results one search returns. Short on purpose — this is a picker,
 *  not a browse surface, and /rides is where a rider goes to look at a list. */
const SEARCH_LIMIT = 12

/** How many rides one zip may hold. Each one is loaded, serialized and held in
 *  memory at once, so this is a real bound rather than a tidy number. */
const CART_MAX = 20

/** `%` and `_` are wildcards in LIKE, so a rider searching for "day_1" must not
 *  silently match "day-1". Backslash is the escape and has to go first. */
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`)

/**
 * Owner-scoped ride search: name and date, capped.
 *
 * THE DATE IS THE DAYS' DATES AND NOT `rides.created_at`, which is #131's one
 * explicit instruction and worth restating where the query is: a rider
 * searching "August" means when they rode. The two are routinely months apart.
 *
 * An EXISTS rather than a join, because a ride with four days in August must
 * come back once. A join would return it four times and need a distinct that
 * fights the leftJoin below it.
 */
/*
 * `/api/export/search` AND NOT `/api/rides/search`, which is what this was for
 * about ten minutes. `builderRoutes.get('/api/rides/:id')` is registered ahead
 * of this module and matches that path with `id = "search"`, so the endpoint
 * answered `{"error":"not found"}` with nothing in the log to say why — a
 * lookup for a ride whose id is a word.
 *
 * Ordering the mounts around it would work and is the wrong fix: the collision
 * would come back the moment somebody moved a line in index.tsx. A path that
 * cannot collide is one that stays fixed. Same lesson the zip route records in
 * index.tsx, arrived at the other way round.
 */
importRoutes.get('/api/export/search', requireActiveApi, async (c) => {
  const user = currentUser(c)
  const q = parseRideQuery(c.req.query('q') ?? '')

  const titleTerm = q.text ? ilike(rides.title, `%${escapeLike(q.text)}%`) : null

  const dayMatch =
    q.from && q.to
      ? and(gte(daysTable.startAt, q.from), lt(daysTable.startAt, q.to))
      : q.month !== null
        ? sql`extract(month from ${daysTable.startAt}) = ${q.month}`
        : null

  const dateTerm = dayMatch
    ? exists(
        db
          .select({ one: sql`1` })
          .from(daysTable)
          .where(and(eq(daysTable.rideId, rides.id), dayMatch)),
      )
    : null

  // AND normally, OR for a bare month name — see `loose` in maps/ride-search.ts.
  // Both terms present and AND-ed is what "coast august" plainly means; a
  // one-word month has two honest readings and hiding either is worse.
  const terms = [titleTerm, dateTerm].filter((t) => t !== null)
  const where = terms.length === 0 ? undefined : terms.length === 1 ? terms[0] : q.loose ? or(...terms) : and(...terms)

  const rows = await db
    .select({ slug: rides.slug, title: rides.title, startAt: daysTable.startAt })
    .from(rides)
    .leftJoin(daysTable, and(eq(daysTable.rideId, rides.id), eq(daysTable.position, 0)))
    .where(and(eq(rides.ownerId, user.id), LIVE_RIDE, where))
    .orderBy(desc(rides.updatedAt))
    .limit(SEARCH_LIMIT)

  return c.json({
    rides: rows.map((r) => ({ slug: r.slug, title: r.title, date: r.startAt?.toISOString() ?? null })),
  })
})

const cartSchema = z
  .array(
    z.object({
      slug: z.string().min(1).max(22),
      // The four generated formats plus the lossless one. Read from
      // DOWNLOAD_FORMATS rather than restated, so a fifth format cannot be
      // offered here and refused there.
      format: z.enum([...DOWNLOAD_FORMATS, NATIVE_EXT]),
    }),
  )
  .min(1)
  .max(CART_MAX)

/**
 * One zip of whatever is in the cart.
 *
 * A PLAIN FORM POST, not fetch. A download is the one thing a form does better
 * than JavaScript: the browser handles the attachment, the progress and the
 * save dialog, where a fetch would have to buffer the whole archive into a blob
 * and fake a click on an anchor. The cart script writes one hidden field and
 * lets the form go — the same reasoning as the import form above.
 *
 * OWNERSHIP IS RE-CHECKED PER SLUG and not inherited from the search that
 * produced it. The cart is a rider-supplied list of slugs whatever the page put
 * in it, and a slug is the only thing standing between somebody else's private
 * ride and this response.
 */
importRoutes.post('/export/zip', requireActive, requireSameOrigin, async (c) => {
  const user = currentUser(c)
  const body = await c.req.parseBody()

  let items: z.infer<typeof cartSchema>
  try {
    items = cartSchema.parse(JSON.parse(typeof body.cart === 'string' ? body.cart : ''))
  } catch {
    return c.redirect('/import?error=' + encodeURIComponent('that export list could not be read'), 302)
  }

  const files: Array<{ name: string; body: Buffer }> = []
  // Two rides with the same title, the same start date and the same format get
  // the same filename out of the convention, and two entries in one zip cannot
  // share a name. uniqueName() numbers the second — see the note there for why
  // something this rare is worth guarding against.
  const used = new Set<string>()
  const unique = (name: string) => uniqueName(used, name)

  for (const item of items) {
    const [ride] = await db
      .select()
      .from(rides)
      .where(and(eq(rides.slug, item.slug), eq(rides.ownerId, user.id), LIVE_RIDE))
      .limit(1)
    // A slug that is not the rider's own is skipped rather than refused: a stale
    // cart holding a ride they have since binned should still export the rest.
    if (!ride) continue

    const meta = { title: ride.title, description: ride.description }
    const date = await rideStartDate(ride.id)

    if (item.format === NATIVE_EXT) {
      const native = await loadNativeRide(
        ride.id,
        {
          title: ride.title,
          description: ride.description,
          visibility: ride.visibility,
          externalUrl: ride.externalUrl,
          timeAnchor: ride.timeAnchor,
        },
        // The owner's own backup carries their reservations. This route is
        // owner-only by the query above, so the details are theirs by
        // construction — detailsForViewer is still what decides it, rather than
        // a second rule here that could disagree.
        await detailsForViewer(ride.id, ride.ownerId, user),
      )
      if ((native.ride as { days: unknown[] }).days.length === 0) continue
      files.push({
        name: unique(buildExportName({ ride: ride.title, date, ext: NATIVE_EXT })),
        body: Buffer.from(buildNativeJson(native), 'utf8'),
      })
      continue
    }

    const spec = DOWNLOADS[item.format]
    const loaded = await loadRideForExport(ride.id, meta)
    if (loaded.days.length === 0) continue
    files.push({
      name: unique(buildExportName({ ride: ride.title, date, ext: item.format })),
      body: Buffer.from(spec.build(loaded), 'utf8'),
    })
  }

  if (files.length === 0) {
    return c.redirect('/import?error=' + encodeURIComponent('nothing in that list could be exported'), 302)
  }

  // NAMED FOR THE EXPORT, NOT FOR ANY RIDE IN IT. #131's instruction, and it is
  // right: an archive of six rides named after the first one is a file a rider
  // will not find again. It still carries the marker, so the convention holds
  // and the archive drags back into the drop box — where it expands to whatever
  // is inside, each entry named for its own ride.
  const zip = buildZip(files)
  // Midnight UTC rather than `new Date()`, so the name carries a DATE and not a
  // date plus the minute the button was pressed — fmtDate writes `T2205` for any
  // non-midnight time, which is real information about a day's departure and
  // noise about a download. UTC because every other date in this convention is.
  const now = new Date()
  const stamp = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const name = buildExportName({ ride: 'export', date: stamp, ext: 'zip' })

  return new Response(zip, {
    headers: {
      'Content-Type': 'application/zip',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `attachment; filename="${name}"`,
    },
  })
})
