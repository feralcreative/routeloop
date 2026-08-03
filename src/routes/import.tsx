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
                `multiple` because a rider with a multi-day trip has one file
                per day, and importing them one at a time makes one ride per day
                and no trip. Several files become several days of one ride, in
                the order the browser lists them — which for a folder selection
                is filename order, so day-1/day-2/day-3 comes out right.
              */}
              <input
                id="f-route"
                name="route"
                type="file"
                multiple
                required
                accept={FORMATS.map((f) => `.${f.ext}`).join(',')}
              />
              <span class="field-hint">
                Up to {MAX_BYTES / MB} MB each, depending on the format. Pick several and each becomes a day.
              </span>
            </p>

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
                  Private — only you
                </option>
                <option value="unlisted">Unlisted — anyone with the link</option>
                <option value="public">Public — listed in Explore</option>
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
    }),
  )
})
