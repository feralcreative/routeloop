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
import { Hono, type Context } from 'hono'
import { eq } from 'drizzle-orm'
import { currentUser, requireActive, requireActiveApi, requireSameOrigin, type AuthEnv } from '../auth/middleware'
import { db } from '../db/index'
import { userProfiles } from '../db/schema'
import { toDurationFormat } from '../maps/duration'
import { fromAcceptLanguage, toDateFormat } from '../views/date-format'
import { toMapScheme, toScheme, toTheme } from '../views/appearance'
import { toMotion } from '../views/motion'
import { toUnits } from '../views/units'
import { toClock } from '../views/clock'
import { toVolumeUnits } from '../views/volume'
import { toTips } from '../views/tips'
import { clampDivert } from '../subgroups/rendezvous'
import { TERMS, toJargon, toPower, toVehicle, vocabOf, wordsFor } from '../views/vocab'
import { GROUPS, eventsInGroup, type GroupId } from '../notifications/catalog'
import { checkedKeys, rowsFromForm } from '../notifications/policy'
import { savePrefs } from '../notifications/service'
import { accountPage, type AccountTab } from '../views/account-page'
import { loadProfile, profilePanel, PROFILE_SCRIPTS } from './profile'
import { usernameHistoryFor } from '../auth/username'

export const settingsRoutes = new Hono<AuthEnv>()

/** The account page with one tab open. `/profile` renders the same page from
 *  profile.tsx, which owns that form's error re-render. */
async function renderAccount(c: Context<AuthEnv>, tab: AccountTab): Promise<string> {
  const user = currentUser(c)
  return accountPage(c, {
    tab,
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
  })
}

// `/account` IS THE PAGE AND `/settings` REDIRECTS TO IT (#320). Ziad's call,
// 2026-09-13: one My Account item in the menu instead of Profile and
// Preferences, and the page is titled Account settings. The redirect is a 301
// with the query carried over, so a `?saved=` that reached the old URL still
// shows its chip; the fragment survives on its own, browsers keep it across a
// redirect. THE POST ACTIONS STAY AT `/settings/*` — a 301 turns a redirected
// POST into a GET and the save silently does nothing, which is the trap
// docs/main-menu.md recorded for the rename that never shipped. They are form
// actions, not pages, and nothing a rider types or reads names them.
settingsRoutes.get('/account', requireActive, async (c) => c.html(await renderAccount(c, 'preferences')))
settingsRoutes.get('/settings', (c) => {
  const q = new URL(c.req.url).search
  return c.redirect('/account' + q, 301)
})
// Two more doors into the same page (#319), the `/riders` + `/friends` shape.
settingsRoutes.get('/places', requireActive, async (c) => c.html(await renderAccount(c, 'places')))
settingsRoutes.get('/paddock', requireActive, async (c) => c.html(await renderAccount(c, 'paddock')))

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
  return c.redirect('/account?saved=duration#stop-durations', 303)
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

  return c.redirect('/account?saved=dates#dates', 303)
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
  const mapScheme = toMapScheme(body.mapScheme)

  // ONE HANDLER FOR ALL FOUR AXES, unlike the date, duration and units
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
      mapScheme,
      dateFormat: fromAcceptLanguage(c.req.header('Accept-Language')),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: userProfiles.userId,
      set: { theme, scheme, motion, mapScheme, updatedAt: new Date() },
    })

  return c.redirect('/account?saved=appearance#appearance', 303)
})

// What the app calls things (#321): the two presets and the rider's words.
//
// THREE HANDLERS, THREE COLUMNS, like units and clock below. The vehicle picker
// coerces the stored power against the new vehicle — Bicycle turns Gas into
// Pedal — and writes both, or the pair on the row could be one vocab.ts refuses.
settingsRoutes.post('/settings/vehicle', requireActive, requireSameOrigin, async (c) => {
  const user = currentUser(c)
  const body = await c.req.parseBody()
  const stored = await vocabRow(user.id)
  const vehicle = toVehicle(body.vehicle)
  const power = toPower(stored?.power, vehicle)
  await upsertProfile(c, user.id, { vehicle, power })
  return c.redirect('/account?saved=vehicle#vehicle', 303)
})

settingsRoutes.post('/settings/power', requireActive, requireSameOrigin, async (c) => {
  const user = currentUser(c)
  const body = await c.req.parseBody()
  const stored = await vocabRow(user.id)
  const power = toPower(body.power, toVehicle(stored?.vehicle))
  await upsertProfile(c, user.id, { power })
  return c.redirect('/account?saved=power#power', 303)
})

// THE TABLE POSTS A PICK PER ROW AND STORES ONLY WHAT DIFFERS FROM THE PRESET.
// A radio equal to the word the rider's own preset would give is "follows the
// pickers" and stores nothing, so changing the vehicle later moves it; any
// other radio, or a typed word, is stored as the rider's own and wins on every
// ride. A regional row's first option is its default and stores nothing too.
settingsRoutes.post('/settings/jargon', requireActive, requireSameOrigin, async (c) => {
  const user = currentUser(c)
  const body = await c.req.parseBody()
  const stored = vocabOf(await vocabRow(user.id))
  const preset = wordsFor({ ...stored, jargon: {} })
  const jargon: Record<string, string> = {}
  for (const t of TERMS) {
    const pick = body[`pick-${t.id}`]
    if (typeof pick !== 'string') continue
    const word = pick === 'custom' ? body[`custom-${t.id}`] : pick
    if (typeof word !== 'string') continue
    const follows = t.axis === 'regional' ? t.options?.[0]?.one : preset[t.id]?.one
    if (word.trim() && word.trim() !== follows) jargon[t.id] = word
  }
  await upsertProfile(c, user.id, { jargon: toJargon(jargon) })
  return c.redirect('/account?saved=jargon#words', 303)
})

async function vocabRow(userId: number) {
  const [row] = await db
    .select({ vehicle: userProfiles.vehicle, power: userProfiles.power, jargon: userProfiles.jargon })
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId))
    .limit(1)
  return row ?? null
}

/** The lazily-created-row upsert every handler here performs, with the
 *  Accept-Language seeding trap handled once. */
async function upsertProfile(
  c: Context<AuthEnv>,
  userId: number,
  set: Partial<{ vehicle: string; power: string; jargon: Record<string, string> }>,
): Promise<void> {
  await db
    .insert(userProfiles)
    .values({ userId, ...set, dateFormat: fromAcceptLanguage(c.req.header('Accept-Language')), updatedAt: new Date() })
    .onConflictDoUpdate({ target: userProfiles.userId, set: { ...set, updatedAt: new Date() } })
}

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

  return c.redirect('/account?saved=units#units', 303)
})

// Whether a control explains itself (#133).
//
// Its own handler and its own column, like units and the date format: a rider
// answers this at a different moment from everything else on the page, and each
// handler writing only itself is what stops saving one reverting another.
//
// `dateFormat` is seeded on INSERT and left out of the update set, exactly as
// every handler above does it, and it matters slightly more here than usual —
// this is the one preference a rider is likely to reach for on their FIRST
// visit, which is precisely when they have no `user_profiles` row and their
// dates are still coming from Accept-Language for free.
settingsRoutes.post('/settings/tips', requireActive, requireSameOrigin, async (c) => {
  const user = currentUser(c)
  const body = await c.req.parseBody()
  // Same contract as every other handler here: anything unrecognized lands on
  // the default rather than 400ing. Note the default is `on`, so a hand-crafted
  // request cannot turn this off by sending nonsense — it has to say `off`.
  const tips = toTips(body.tips)

  await db
    .insert(userProfiles)
    .values({
      userId: user.id,
      tips,
      dateFormat: fromAcceptLanguage(c.req.header('Accept-Language')),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: userProfiles.userId,
      set: { tips, updatedAt: new Date() },
    })

  return c.redirect('/profile?saved=tips#tips', 303)
})

// Whether the header's Take the tour sign is shown. Ziad's call, 2026-09-11.
//
// A CHECKBOX, so the body carries `hideTour` only when ticked; `present` is
// what says the form was submitted at all, so a request with neither writes
// nothing — the notification handler's `group` field by another name. Its own
// column and its own handler for the reason every form on the page has one.
settingsRoutes.post('/settings/tour-button', requireActive, requireSameOrigin, async (c) => {
  const user = currentUser(c)
  const body = await c.req.parseBody()
  if (body.present !== '1') return c.redirect('/profile#tips', 303)
  const hideTour = body.hideTour === 'on'

  await db
    .insert(userProfiles)
    .values({
      userId: user.id,
      hideTour,
      dateFormat: fromAcceptLanguage(c.req.header('Accept-Language')),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: userProfiles.userId,
      set: { hideTour, updatedAt: new Date() },
    })

  return c.redirect('/profile?saved=tour-button#tips', 303)
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

  return c.redirect('/account?saved=clock#clock', 303)
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

  return c.redirect('/account?saved=volume#volume', 303)
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
//
// TWO HANDLERS AND NOT ONE TAKING A DIRECTION, because they are two boxes with
// two Save states and the autosave posts whichever group changed. One endpoint
// would have to be told which column it was writing, and a request that named
// the wrong one would move a rider's list from one side to the other.
const writeList = (column: 'avoidPlaces' | 'favorPlaces', anchor: string) => async (c: Context<AuthEnv>) => {
  const user = currentUser(c)
  const body = await c.req.parseBody()
  const raw = body[column]
  const typed = typeof raw === 'string' ? raw.trim().slice(0, 1000) : ''
  // Empty to null, so clearing the box removes the value rather than storing
  // ''. Two representations of "nothing here" means every reader has to test
  // for both — the same rule the places writer follows.
  const value = typed === '' ? null : typed

  await db
    .insert(userProfiles)
    .values({
      userId: user.id,
      [column]: value,
      dateFormat: fromAcceptLanguage(c.req.header('Accept-Language')),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({ target: userProfiles.userId, set: { [column]: value, updatedAt: new Date() } })

  return c.redirect(`/settings?saved=${anchor}#${anchor}`, 303)
}

settingsRoutes.post('/settings/avoid', requireActive, requireSameOrigin, writeList('avoidPlaces', 'avoid'))
settingsRoutes.post('/settings/favor', requireActive, requireSameOrigin, writeList('favorPlaces', 'favor'))

// How much further out of their way than necessary a joining group may be sent
// to meet sooner (#370). Where the builder's meeting-point dial starts.
//
// THE SAME CLAMP THE ROUTE APPLIES TO THE DIAL, so the two cannot disagree
// about what a legal number is: `clampDivert` answers undefined for anything
// unusable — an empty box included — and undefined is stored as NULL, which
// every reader turns back into the app's default. A rider who clears the field
// is back on the default, not on 1 and not on whatever the default was the day
// they cleared it.
settingsRoutes.post('/settings/meet', requireActive, requireSameOrigin, async (c) => {
  const user = currentUser(c)
  const body = await c.req.parseBody()
  const clamped = clampDivert(body.meetDivertMi)
  const meetDivertMi = clamped === undefined ? null : Math.round(clamped)

  await db
    .insert(userProfiles)
    .values({
      userId: user.id,
      meetDivertMi,
      dateFormat: fromAcceptLanguage(c.req.header('Accept-Language')),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({ target: userProfiles.userId, set: { meetDivertMi, updatedAt: new Date() } })

  return c.redirect('/settings?saved=meet#meet', 303)
})

/**
 * Notification preferences — one handler, five forms.
 *
 * **ONE ROUTE AND NOT ONE PER GROUP, WHICH IS THE OPPOSITE OF EVERY OTHER
 * HANDLER IN THIS FILE.** The others are one route per COLUMN, because each
 * writes a different column and merging them would let saving the units revert
 * the dates. Here there is one table and one shape, and the five groups differ
 * only in which rows a form carries — so five handlers would be five copies of
 * the same four lines, and the group name is data rather than a route.
 *
 * **THE `group` FIELD IS LOAD-BEARING AND NOT DECORATION.** An unticked checkbox
 * sends NOTHING, so the body cannot say which events the form was showing — and
 * without that, "absent" would mean both "turned off" and "not on this form",
 * and saving the Rides group would silently switch off every event in the other
 * four. The hidden field is what makes the absence readable. See rowsFromForm.
 *
 * `dateFormat` is NOT seeded here, and this is the one upsert in the file that
 * does not owe that: it writes `notification_prefs`, not `user_profiles`, so it
 * cannot stamp `en-US` over what Accept-Language was giving a rider for free.
 * That obligation belongs to anything touching the profile row and to nothing
 * else — stating it because the rule as written says "any FOURTH upsert", and
 * this is a seventh that correctly does not apply it.
 */
settingsRoutes.post('/settings/notifications', requireActive, requireSameOrigin, async (c) => {
  const user = currentUser(c)
  const body = await c.req.parseBody()
  const raw = typeof body.group === 'string' ? body.group : ''
  const group = GROUPS.find((g) => g.id === raw)
  // Anything unrecognized lands back on the page having written nothing, which
  // is the same contract every other handler here follows: the only way to send
  // a bad value is to hand-craft the request.
  if (!group) return c.redirect('/account#notifications', 303)

  const events = eventsInGroup(group.id as GroupId).map((e) => e.key)
  await savePrefs(user.id, rowsFromForm(events, checkedKeys(body as Record<string, unknown>)))

  const anchor = `notify-${group.id}`
  return c.redirect(`/settings?saved=${anchor}#${anchor}`, 303)
})
