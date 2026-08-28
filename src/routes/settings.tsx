// Settings.
//
// docs/main-menu.md puts Settings in the account menu, and a menu item pointing
// at a 404 is worse than one pointing at an honest empty page. It was that empty
// page until 2026-08-15; the stop-duration format is its first real content, and
// units, default ride visibility and email preferences remain the obvious
// untaken candidates.
//
// TWO `saved` STATES, and they are not the same thing — `?saved` with no value
// is Save Me confirming an account is no longer scheduled for deletion, and
// `?saved=duration` is this page's own form. The first was here before the
// second and its bare-query shape is what the account route already redirects
// to, so the new one carries a value rather than moving it.
import { Hono } from 'hono'
import { currentUser, requireActive, requireSameOrigin, type AuthEnv } from '../auth/middleware'
import { eq } from 'drizzle-orm'
import { DELETION_HOLD_DAYS } from '../account/policy'
import { db } from '../db/index'
import { userProfiles } from '../db/schema'
import { DURATION_FORMAT_CHOICES, toDurationFormat } from '../maps/duration'
import { DATE_FORMAT_CHOICES, fromAcceptLanguage, toDateFormat } from '../views/date-format'
import { dateFormatFor } from '../views/prefs'
import { SCHEME_CHOICES, THEME_CHOICES, toScheme, toTheme } from '../views/appearance'
import { MOTION_CHOICES, toMotion } from '../views/motion'
import { UNITS_CHOICES, toUnits } from '../views/units'
import { page } from '../views/layout'

export const settingsRoutes = new Hono<AuthEnv>()

// ONE QUERY FOR EVERY PREFERENCE THIS PAGE OWNS, rather than one per setting.
// They are columns on a single row, so a second `select` is a second round trip
// for a value already fetched — and this page renders all of them at once, every
// time. `theme` and `scheme` come off the session instead and are not here.
//
// A rider who has never opened their profile has no row at all, so every field
// is `undefined` as often as it is a value. Each coercer answers that with its
// own column default, which is why nothing here has a null to interpret.
async function prefsFor(userId: number) {
  const [p] = await db
    .select({
      durationFormat: userProfiles.durationFormat,
      units: userProfiles.units,
      motion: userProfiles.motion,
    })
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId))
    .limit(1)
  return {
    durationFormat: toDurationFormat(p?.durationFormat),
    units: toUnits(p?.units),
    motion: toMotion(p?.motion),
  }
}

settingsRoutes.get('/settings', requireActive, async (c) => {
  const user = currentUser(c)
  const savedQuery = c.req.query('saved')
  // THE BARE `?saved` IS SAVE ME, and every named one is a form on this page. The
  // list has to grow with the forms: a value missing from it falls through to
  // `saved` and renders the account-restored banner instead of a Saved chip,
  // which is a wrong and rather alarming answer to "I changed my units".
  const FORM_SAVED = ['duration', 'dates', 'appearance', 'units']
  const saved = savedQuery !== undefined && !FORM_SAVED.includes(savedQuery)
  const savedDuration = savedQuery === 'duration'
  const savedDates = savedQuery === 'dates'
  const savedAppearance = savedQuery === 'appearance'
  const savedUnits = savedQuery === 'units'
  const { durationFormat, units, motion } = await prefsFor(user.id)
  const dateFormat = await dateFormatFor(c)
  // Straight off the session rather than a second query — validateSessionToken
  // already left-joins user_profiles for exactly this, and the values are
  // coerced there so there is no null to interpret here.
  const theme = user.theme
  const scheme = user.scheme

  const body = (
    <>
      <h1>Settings</h1>
      <p class="lede">How the app looks, and how it writes things down. Your account is at the bottom.</p>

      {saved ? (
        <p class="form-ok">
          Welcome back. Your account is no longer scheduled for deletion, and everything is exactly where you left it.
        </p>
      ) : null}

      {/*
        TWO TOPICS, NOT FOUR PEERS (#178). Appearance is one topic and "How
        things read" is the other, and the copy is what said so: the duration
        and date settings each promise, in nearly the same words, that they
        change the WRITING and not the number. Two settings making the same
        promise are one topic.

        THE OLD PAGE'S GAPS WERE THE GRID, NOT THE SPACING. Four `.setting`
        blocks sat in a fixed two-column `.two-col` with `align-items: start`,
        so every cell kept its own height and the shorter column simply ended
        early — Appearance is six palettes plus a light/dark pair and is far the
        tallest, while "Your profile" was one sentence occupying a whole cell.
        Nothing was misaligned; the columns were just different lengths.

        So the fix is not margins. Every control on this page is a short radio
        group of three, so each topic is a ROW OF THREE and the page becomes two
        tidy rows. `.three-col` keeps `align-items: start` for the same reason
        `.two-col` does, and with three equal groups there is nothing left for it
        to expose.

        GTFO stays outside both topics: it is a boxed-off danger area and half a
        page is not where it belongs.
      */}
      <section class="setting-topic" id="appearance">
        <h2>Appearance</h2>
        <p>
          How the app looks, and how much it moves. The palette decides which colors it uses, light or dark decides how
          bright it is, and every palette comes in&nbsp;both.
        </p>

        {/*
          ONE FORM FOR ALL THREE AXES, which is what the appearance handler
          already did for two. A rider has ONE appearance and would be surprised
          if saving the palette reverted the light/dark choice they made in the
          same breath; motion is the same kind of answer to the same question and
          joins them rather than getting a fourth endpoint.

          The page renders in the rider's CURRENT palette while they choose.
          There is no live preview and deliberately so — a preview would need
          script on a page that has none, and the choice applies on save, which
          is one click away and unambiguous.
        */}
        <form method="post" action="/settings/appearance" class="setting-form">
          <div class="three-col">
            <fieldset class="choice-set">
              <legend class="choice-legend">Palette</legend>
              {THEME_CHOICES.map((choice) => (
                <label class="choice">
                  <input type="radio" name="theme" value={choice.id} checked={choice.id === theme} />
                  <span class="choice-label">{choice.label}</span>
                  <span class="choice-example">{choice.hint}</span>
                </label>
              ))}
            </fieldset>

            <fieldset class="choice-set">
              <legend class="choice-legend">Light or dark</legend>
              {SCHEME_CHOICES.map((choice) => (
                <label class="choice">
                  <input type="radio" name="scheme" value={choice.id} checked={choice.id === scheme} />
                  <span class="choice-label">{choice.label}</span>
                  <span class="choice-example">{choice.hint}</span>
                </label>
              ))}
            </fieldset>

            {/*
              MOTION IS AN APPEARANCE AXIS AND NOT A NEW PREFERENCE (#174).
              `prefers-reduced-motion` is already honored in six SCSS blocks and
              four client files, so a rider with the OS toggle on already gets a
              still page — what was missing is the control for someone who wants
              motion off HERE, or who does not know the OS setting exists.
            */}
            <fieldset class="choice-set">
              <legend class="choice-legend">Motion</legend>
              {MOTION_CHOICES.map((choice) => (
                <label class="choice">
                  <input type="radio" name="motion" value={choice.id} checked={choice.id === motion} />
                  <span class="choice-label">{choice.label}</span>
                  <span class="choice-example">{choice.hint}</span>
                </label>
              ))}
            </fieldset>
          </div>

          <div class="setting-actions">
            <button type="submit" class="btn btn-sign arrow-right arrow-n">
              Save
            </button>
            {savedAppearance ? <span class="form-ok">Saved</span> : null}
          </div>
        </form>
      </section>

      <section class="setting-topic" id="how-things-read">
        <h2>How things read</h2>
        <p>
          Three choices about writing rather than about data. Every one of them changes how a figure is printed and
          none of them changes the figure — your rides, the roadbook and every export are unaffected, and you can
          switch back whenever you&nbsp;like.
        </p>

        <div class="three-col">
          {/*
            THREE FORMS, NOT ONE, and the split is deliberate rather than left
            over. Unlike the appearance axes these are unrelated questions with
            unrelated answers, and each handler writes only its own column — so
            saving one cannot revert another. See the note on the handlers below.
          */}
          <section class="setting" id="units">
            <h3>Distances</h3>
            <form method="post" action="/settings/units" class="setting-form">
              <fieldset class="choice-set">
                <legend class="visually-hidden">Units</legend>
                {UNITS_CHOICES.map((choice) => (
                  <label class="choice">
                    <input type="radio" name="units" value={choice.id} checked={choice.id === units} />
                    <span class="choice-label">{choice.label}</span>
                    {/* The SAME road in both, which is the question being asked.
                      Twistiness comes along with the distance: degrees per
                      kilometer is a smaller number than degrees per mile. */}
                    <span class="choice-example">
                      reads <b>{choice.example}</b>
                    </span>
                  </label>
                ))}
              </fieldset>
              <div class="setting-actions">
                <button type="submit" class="btn btn-sign arrow-right arrow-n">
                  Save
                </button>
                {savedUnits ? <span class="form-ok">Saved</span> : null}
              </div>
            </form>
          </section>

          <section class="setting" id="dates">
            <h3>Dates and times</h3>
            <form method="post" action="/settings/date-format" class="setting-form">
              <fieldset class="choice-set">
                <legend class="visually-hidden">Date format</legend>
                {DATE_FORMAT_CHOICES.map((choice) => (
                  <label class="choice">
                    <input type="radio" name="dateFormat" value={choice.id} checked={choice.id === dateFormat} />
                    <span class="choice-label">{choice.label}</span>
                    {/* The same instant in all three, which is the question being
                      asked. The clock comes along with the date order — day-first
                      locales run to twenty-four. */}
                    <span class="choice-example">
                      reads <b>{choice.example}</b>
                    </span>
                  </label>
                ))}
              </fieldset>
              <div class="setting-actions">
                <button type="submit" class="btn btn-sign arrow-right arrow-n">
                  Save
                </button>
                {savedDates ? <span class="form-ok">Saved</span> : null}
              </div>
            </form>

          </section>

          <section class="setting" id="stop-durations">
            <h3>Stop durations</h3>
            <form method="post" action="/settings/duration-format" class="setting-form">
              <fieldset class="choice-set">
                <legend class="visually-hidden">Duration format</legend>
                {DURATION_FORMAT_CHOICES.map((choice) => (
                  <label class="choice">
                    <input
                      type="radio"
                      name="durationFormat"
                      value={choice.id}
                      checked={choice.id === durationFormat}
                    />
                    <span class="choice-label">{choice.label}</span>
                    <span class="choice-example">
                      reads <b>{choice.example}</b>
                    </span>
                  </label>
                ))}
              </fieldset>
              <div class="setting-actions">
                <button type="submit" class="btn btn-sign arrow-right arrow-n">
                  Save
                </button>
                {savedDuration ? <span class="form-ok">Saved</span> : null}
              </div>
            </form>
          </section>
        </div>

      </section>

      <section class="gtfo">
        <h2>GTFO</h2>
        <p class="lede">Your account is yours. Take it with you, or take it away.</p>

        <div class="gtfo-item">
          <div>
            <h3>Download Me</h3>
            <p>
              Everything the app holds about you, in one zip: your profile, and every ride in all five formats plus the
              original files you uploaded. The <code>.routeloop.json</code> in each ride folder is the lossless one.
            </p>
          </div>
          <a class="btn btn-sign arrow-left" href="/account/download">
            Download Me
          </a>
        </div>

        <div class="gtfo-item">
          <div>
            <h3>Delete Me</h3>
            <p>
              Hide your profile and every ride from the site straight away, and schedule the lot to be destroyed in{' '}
              {DELETION_HOLD_DAYS} days. Nothing is destroyed before then, and Save Me undoes it at any point.
            </p>
          </div>
          <a class="btn btn-sign btn-stop" href="/account/delete">
            Delete Me
          </a>
        </div>

        <div class="gtfo-item">
          <div>
            <h3>Save Me</h3>
            <p>
              Change your mind after Delete Me. Any time inside the {DELETION_HOLD_DAYS} days it is one click and
              nothing was ever lost — you will find it waiting on the page you land on when you sign in.
            </p>
          </div>
          <span class="gtfo-note">Nothing to restore</span>
        </div>
      </section>
    </>
  ).toString()

  return c.html(page({ title: 'Settings', user, navKey: 'settings', body }))
})

// One preference, one route, one column.
//
// It writes user_profiles directly rather than going through the profile form's
// POST, because that handler validates and rewrites the whole profile: posting
// this preference through it would need every other field carried along, and a
// missing one would blank an address. A preference and a profile edit are
// different writes and this keeps them that way.
//
// The upsert matters — a rider who has never opened /profile has no row, and the
// first thing they change must not silently do nothing.
settingsRoutes.post('/settings/duration-format', requireActive, requireSameOrigin, async (c) => {
  const user = currentUser(c)
  const body = await c.req.parseBody()
  // Anything unrecognised lands on the default rather than 400ing. The only way
  // to send a bad value here is to hand-craft the request, and the honest answer
  // to that is the same as the answer to a missing profile row.
  const durationFormat = toDurationFormat(body.durationFormat)

  // dateFormat is seeded ON INSERT ONLY, and is absent from the update set.
  //
  // Profile rows are created lazily, right here, so a rider saving a DURATION
  // preference is often the moment their first row appears — and the column's
  // default would stamp 'en-US' over whatever Accept-Language had been giving
  // them for free. Seeding from the header keeps what they were already seeing.
  // Leaving it out of `set` is what stops this handler overwriting a date choice
  // they made deliberately.
  await db
    .insert(userProfiles)
    .values({
      userId: user.id,
      durationFormat,
      dateFormat: fromAcceptLanguage(c.req.header('Accept-Language')),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: userProfiles.userId,
      set: { durationFormat, updatedAt: new Date() },
    })

  // Redirect rather than re-render so a refresh cannot resubmit.
  return c.redirect('/settings?saved=duration#stop-durations', 303)
})

settingsRoutes.post('/settings/date-format', requireActive, requireSameOrigin, async (c) => {
  const user = currentUser(c)
  const body = await c.req.parseBody()
  // Same contract as the duration handler: anything unrecognised lands on the
  // default rather than 400ing, because the only way to send a bad value is to
  // hand-craft the request.
  const dateFormat = toDateFormat(body.dateFormat)

  // durationFormat is NOT in the update set here, mirroring the handler above —
  // each preference writes only itself, so saving one cannot revert the other.
  // The insert has to supply it because the column is NOT NULL, and the value it
  // supplies is that column's own default.
  await db
    .insert(userProfiles)
    .values({ userId: user.id, dateFormat, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: userProfiles.userId,
      set: { dateFormat, updatedAt: new Date() },
    })

  return c.redirect('/settings?saved=dates#dates', 303)
})

settingsRoutes.post('/settings/appearance', requireActive, requireSameOrigin, async (c) => {
  const user = currentUser(c)
  const body = await c.req.parseBody()
  // Same contract as the two handlers above: anything unrecognized lands on the
  // default rather than 400ing, because the only way to send a bad value is to
  // hand-craft the request.
  const theme = toTheme(body.theme)
  const scheme = toScheme(body.scheme)
  const motion = toMotion(body.motion)

  // ONE HANDLER FOR ALL THREE AXES, unlike the date, duration and units
  // preferences which each write themselves alone. They are three questions but
  // one answer: a rider has one appearance, sees all three controls at once, and
  // would be surprised if saving the palette silently reverted the light/dark or
  // motion choice they made in the same breath. All three are in the update set
  // for exactly that reason.
  //
  // Neither theme nor scheme is seeded from a header, unlike dateFormat, and that
  // asymmetry is deliberate: there is no header for a palette, and `system`
  // already delegates the one axis a browser has an opinion about.
  //
  // dateFormat IS seeded here, and it was not until 2026-08-27 — this handler was
  // the third settings upsert and it skipped the rule the other two follow. The
  // failure is silent and permanent: profile rows are created lazily, so a rider
  // with no row is being served day-first off Accept-Language for free, and the
  // first time they touched the theme this INSERT created their row with the
  // column's own default. Their dates flipped from 27.08.2026 to 8/27/2026 and
  // nothing said so — dateFormatFor() returns the row's value the moment a row
  // exists and never consults the header again. Any FOURTH upsert has the same
  // obligation.
  await db
    .insert(userProfiles)
    .values({
      userId: user.id,
      theme,
      scheme,
      motion,
      dateFormat: fromAcceptLanguage(c.req.header('Accept-Language')),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: userProfiles.userId,
      set: { theme, scheme, motion, updatedAt: new Date() },
    })

  return c.redirect('/settings?saved=appearance#appearance', 303)
})

// Miles or kilometers.
//
// Its own handler and its own column, mirroring the date and duration
// preferences: each writes only itself, so saving one cannot revert another.
// That is the opposite of the appearance handler above and the difference is
// real — units, dates and durations are unrelated questions a rider answers at
// different times, where the three appearance axes are one answer given at once.
//
// dateFormat is seeded ON INSERT ONLY and is absent from the update set, the
// same obligation the other three handlers carry. Profile rows are created
// lazily, so this upsert is often the moment a rider's first row appears, and
// the column's default would stamp 'en-US' over whatever Accept-Language had
// been giving them for free.
settingsRoutes.post('/settings/units', requireActive, requireSameOrigin, async (c) => {
  const user = currentUser(c)
  const body = await c.req.parseBody()
  // Same contract as every other handler here: anything unrecognized lands on
  // the default rather than 400ing, because the only way to send a bad value is
  // to hand-craft the request.
  const units = toUnits(body.units)

  await db
    .insert(userProfiles)
    .values({
      userId: user.id,
      units,
      dateFormat: fromAcceptLanguage(c.req.header('Accept-Language')),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: userProfiles.userId,
      set: { units, updatedAt: new Date() },
    })

  return c.redirect('/settings?saved=units#units', 303)
})
