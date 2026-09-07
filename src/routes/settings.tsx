// The preference handlers, and the entry point at /settings.
//
// **THE PAGE ITSELF IS src/views/account-page.tsx AS OF 2026-09-07 (#269).**
// Settings and Profile are one page with two tabs, so what is left here is the
// six POSTs — one per preference — plus the GET that opens the Preferences tab.
// `/profile` opens the other one and lives in routes/profile.tsx, which is the
// `/riders` and `/friends` arrangement exactly.
//
// TWO `saved` STATES, and they are not the same thing — `?saved` with no value
// is Save Me confirming an account is no longer scheduled for deletion, and
// `?saved=duration` is one of this page's own forms. The first was here before
// the second and its bare-query shape is what the account route already
// redirects to, so the named ones carry a value rather than moving it. That list
// lives in account-page.tsx now, and `1` had to join it: the profile form
// redirects to `?saved=1` and always has, so merging the pages merged the query
// string with it.
import { Hono } from 'hono'
import { currentUser, requireActive, requireSameOrigin, type AuthEnv } from '../auth/middleware'
import { db } from '../db/index'
import { userProfiles } from '../db/schema'
import { toDurationFormat } from '../maps/duration'
import { fromAcceptLanguage, toDateFormat } from '../views/date-format'
import { toScheme, toTheme } from '../views/appearance'
import { toMotion } from '../views/motion'
import { toUnits } from '../views/units'
import { toClock } from '../views/clock'
import { toVolumeUnits } from '../views/volume'
import { accountPage } from '../views/account-page'
import { loadProfile, profilePanel, PROFILE_SCRIPTS } from './profile'
import { usernameHistoryFor } from '../auth/username'

export const settingsRoutes = new Hono<AuthEnv>()

settingsRoutes.get('/settings', requireActive, async (c) => {
  const user = currentUser(c)
  return c.html(
    await accountPage(c, {
      tab: 'preferences',
      // THE PROFILE PANEL IS RENDERED EVEN WHEN ITS TAB IS SHUT, because
      // tabs.js swaps `hidden` client-side with no round trip — a panel that is
      // not in the DOM is a tab that does nothing. Its cost is one query.
      profile: profilePanel({
        user,
        values: {
          ...(await loadProfile(user.id)),
          username: user.username ?? '',
          displayName: user.displayName,
        },
        history: await usernameHistoryFor(user.id),
      }),
      scripts: PROFILE_SCRIPTS,
    }),
  )
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
  // Anything unrecognized lands on the default rather than 400ing. The only way
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
  // Same contract as the duration handler: anything unrecognized lands on the
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

// Twelve- or twenty-four-hour time (#270).
//
// Its own handler and its own column, like the date, duration and units
// preferences and unlike the three appearance axes: this is an unrelated
// question a rider answers at a different time, and each handler writing only
// itself is what stops saving one reverting another.
//
// dateFormat is seeded ON INSERT ONLY and is absent from the update set — the
// same obligation every other upsert here carries, and the one the appearance
// handler skipped for three weeks. Profile rows are created lazily, so this may
// be the moment a rider's first row appears, and the column's default would
// stamp 'en-US' over whatever Accept-Language had been giving them for free.
settingsRoutes.post('/settings/clock', requireActive, requireSameOrigin, async (c) => {
  const user = currentUser(c)
  const body = await c.req.parseBody()
  const clock = toClock(body.clock)

  await db
    .insert(userProfiles)
    .values({
      userId: user.id,
      clock,
      dateFormat: fromAcceptLanguage(c.req.header('Accept-Language')),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({ target: userProfiles.userId, set: { clock, updatedAt: new Date() } })

  return c.redirect('/settings?saved=clock#clock', 303)
})

// Gallons or liters (#270). Same contract as every handler above, `dateFormat`
// seeding included.
settingsRoutes.post('/settings/volume', requireActive, requireSameOrigin, async (c) => {
  const user = currentUser(c)
  const body = await c.req.parseBody()
  const volumeUnits = toVolumeUnits(body.volumeUnits)

  await db
    .insert(userProfiles)
    .values({
      userId: user.id,
      volumeUnits,
      dateFormat: fromAcceptLanguage(c.req.header('Accept-Language')),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({ target: userProfiles.userId, set: { volumeUnits, updatedAt: new Date() } })

  return c.redirect('/settings?saved=volume#volume', 303)
})

// The places a rider would rather not stop at (#271).
//
// STORED AS THEY TYPED IT, never as parsed terms. What they get back in the box
// is what they put in it — normalizing on save would rewrite a rider's own list
// under them, and the parsing is one pure function away at every read. See
// src/places/avoid.ts.
//
// The column caps at 1,000 characters and the textarea says so; anything longer
// is truncated rather than refused, because the only way to send more is to
// hand-craft the request and the honest answer to that is the same as the answer
// to an unrecognized enum value above.
settingsRoutes.post('/settings/avoid', requireActive, requireSameOrigin, async (c) => {
  const user = currentUser(c)
  const body = await c.req.parseBody()
  const typed = typeof body.avoidPlaces === 'string' ? body.avoidPlaces.trim().slice(0, 1000) : ''
  // Empty to null, so clearing the box removes the value rather than storing ''.
  // Two representations of "nothing here" means every reader has to test for
  // both — the same rule the places writer follows.
  const avoidPlaces = typed === '' ? null : typed

  await db
    .insert(userProfiles)
    .values({
      userId: user.id,
      avoidPlaces,
      dateFormat: fromAcceptLanguage(c.req.header('Accept-Language')),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({ target: userProfiles.userId, set: { avoidPlaces, updatedAt: new Date() } })

  return c.redirect('/settings?saved=avoid#avoid', 303)
})
