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
import { currentUser, requireActive, type AuthEnv } from '../auth/middleware'
import { page } from '../views/layout'
import { asset } from '../views/assets'
import { TURNSTILE_SITE_KEY, turnstileEnabled } from '../maps/turnstile'
import { FORMAT_INFO, SUPPORTED_FORMATS } from '../maps/kml'

export const importRoutes = new Hono<AuthEnv>()

const MB = 1024 * 1024

// Read from the pipeline rather than restated, so the form cannot offer a
// format the server refuses — or omit one it accepts.
const FORMATS = SUPPORTED_FORMATS.map((ext) => ({ ext, ...FORMAT_INFO[ext] }))
const MAX_BYTES = Math.max(...FORMATS.map((f) => f.maxBytes))

importRoutes.get('/import', requireActive, (c) => {
  const user = currentUser(c)
  const error = c.req.query('error')

  return c.html(
    page({
      title: 'Import a route',
      user,
      navKey: 'import',
      body: (
        <>
          <h1>Import a route</h1>
          <p class="lede">
            Bring in a route you already have. It becomes a ride you can open, edit and share like any other.
          </p>

          {error && <p class="notice is-error">{error}</p>}

          <form class="import-form" method="post" action="/api/maps" enctype="multipart/form-data">
            {/*
              Tells /api/maps to answer with a redirect rather than JSON. A
              hidden field rather than sniffing the Accept header: an API client
              that happens to send text/html should still get JSON, and being
              explicit means the two behaviours cannot be triggered by accident.
            */}
            <input type="hidden" name="redirect" value="1" />

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
              What the filenames were read as, filled in by import.js. Shown
              before the upload rather than after, because a wrong day order
              costs one glance here and a rebuild in the builder.
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
              <summary>File names can carry the day and date (optional)</summary>
              <div class="naming-help-body">
                <p>
                  Anything you download from Tankbag is already named this way, so a folder you exported here drops
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
                    tankbag_<b class="f-ride">big-sur-run</b>_<b class="f-day">d02</b>_
                    <b class="f-date">2026-08-14</b>_<b class="f-label">lost-coast</b>.gpx
                  </code>
                </p>

                <ul class="naming-fields">
                  <li>
                    <code>tankbag_</code> is literal, and it is what marks the name as structured. Without it none of
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
                <option value="unlisted">Unlisted—anyone with the link</option>
                <option value="public">Public—listed in Explore</option>
              </select>
            </p>

            {turnstileEnabled() && TURNSTILE_SITE_KEY && (
              <div class="cf-turnstile" data-sitekey={TURNSTILE_SITE_KEY}></div>
            )}

            <p>
              <button class="btn" type="submit">
                Import
              </button>
            </p>
          </form>
        </>
      ).toString(),
      head:
        turnstileEnabled() && TURNSTILE_SITE_KEY
          ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" defer></script>'
          : undefined,
      // filename.js first: import.js reads window.TBFilename at load and bails
      // if it is not there, which is the correct behaviour for a missing
      // dependency and the wrong one for a race.
      scripts: [
        `<script src="${asset('/js/filename.js')}"></script>`,
        `<script src="${asset('/js/import.js')}"></script>`,
      ].join('\n'),
    }),
  )
})
