// Settings.
//
// docs/main-menu.md puts Settings in the account menu, and a menu item pointing
// at a 404 is worse than one pointing at an honest empty page. It was that empty
// page until 2026-08-15; the stop-duration format is its first real content, and
// units, default ride visibility and email preferences remain the obvious
// untaken candidates.
//
// It is deliberately not a fake: no disabled controls, no "coming soon" toggles
// that imply the setting exists and is off. Everything on it works.
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
import { page } from '../views/layout'

export const settingsRoutes = new Hono<AuthEnv>()

async function durationFormatFor(userId: number) {
  const [p] = await db
    .select({ durationFormat: userProfiles.durationFormat })
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId))
    .limit(1)
  // A rider who has never opened their profile has no row at all, so this is
  // undefined rather than a value — the same default the column carries.
  return toDurationFormat(p?.durationFormat)
}

settingsRoutes.get('/settings', requireActive, async (c) => {
  const user = currentUser(c)
  const savedQuery = c.req.query('saved')
  const saved = savedQuery !== undefined && savedQuery !== 'duration' && savedQuery !== 'dates'
  const savedDuration = savedQuery === 'duration'
  const savedDates = savedQuery === 'dates'
  const durationFormat = await durationFormatFor(user.id)
  const dateFormat = await dateFormatFor(c)

  const body = (
    <>
      <h1>Settings</h1>
      <p class="lede">A short list, and it grows as things get decided.</p>

      {saved ? (
        <p class="form-ok">
          Welcome back. Your account is no longer scheduled for deletion, and everything is exactly where you left it.
        </p>
      ) : null}

      <section class="setting" id="stop-durations">
        <h2>Stop durations</h2>
        <p>
          How long you stop somewhere, as it reads in the builder. This changes the writing and not the number —
          your rides, the roadbook and every export are unaffected, and you can switch back whenever you like.
        </p>

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
                {/* An hour and a half in each format. It is the value that looks
                    different in all three, which is the question being asked. */}
                <span class="choice-example">
                  an hour and a half reads <b>{choice.example}</b>
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

        <p class="setting-note">
          Whichever you pick, the field understands the others: type <code>90m</code>, <code>1.5h</code>,{' '}
          <code>1h 30m</code> or <code>1:30</code> and it will take all four.
        </p>
      </section>

      <section class="setting" id="dates">
        <h2>Dates and times</h2>
        <p>
          Which way round a date reads, and whether a clock runs to twelve or twenty-four. This changes the writing and
          not the times themselves — your days start when they always did, and every export is unaffected.
        </p>

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

        <p class="setting-note">
          The builder's own date fields already follow your browser, whatever this says — that part is your operating
          system's business and not ours. This is for the printed roadbook and the pages we render ourselves.
        </p>
      </section>

      <section class="setting">
        <h2>Your profile</h2>
        <p>
          <a href="/profile">Your profile</a> holds your name, username, home address and what of it is shared.
        </p>
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
