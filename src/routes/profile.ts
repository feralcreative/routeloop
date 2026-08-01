// The rider's own profile. Everything here is a plain HTML form POST rather than
// the fetch+JSON APIs the rest of the app uses: a settings page should not stop
// working without JavaScript, and a form plus one re-render is less code than an
// endpoint plus a client script. Validation still runs through the same zod
// helpers as the ride APIs so the two paths cannot drift.
import { Hono } from 'hono'
import { eq, ne, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db/index'
import { userProfiles, users, type UserProfileRow, type UserRow } from '../db/schema'
import { currentUser, requireActive, type AuthEnv } from '../auth/middleware'
import { MAPBOX_TOKEN } from '../config'
import { sanitizeText } from '../maps/kml'
import { esc, page } from '../views/layout'
import { asset } from '../views/assets'

export const profileRoutes = new Hono<AuthEnv>()

// Reserved because a username is the natural basis for a future public profile
// URL, and because the rider-list lookup will accept usernames. Claiming "api"
// or "builder" now would poison that later.
const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
  'admin',
  'api',
  'builder',
  'dashboard',
  'favicon',
  'img',
  'js',
  'login',
  'logout',
  'm',
  'places',
  'profile',
  'static',
  'style',
  'video',
  'welcome',
])

// Same shape as `fields` in routes/maps.ts. A browser submits every text input
// even when empty, but an absent field must mean "empty" rather than a 400 —
// otherwise one omitted key rejects the whole form. The handler then maps blank
// to null so clearing a field actually clears it.
const optionalText = (max: number) => z.string().trim().max(max).default('')

const profileFields = {
  username: z
    .union([
      z.literal(''),
      z
        .string()
        .trim()
        .min(3, 'username must be at least 3 characters')
        .max(30, 'username must be 30 characters or fewer')
        .regex(/^[a-zA-Z0-9_]+$/, 'username may use only letters, numbers and underscores')
        .refine((v) => !RESERVED_USERNAMES.has(v.toLowerCase()), 'that username is reserved'),
    ])
    .default(''),
  displayName: z.string().trim().min(1, 'display name is required').max(255),
  firstName: optionalText(80),
  lastName: optionalText(80),
  addressLine: optionalText(255),
  city: optionalText(120),
  state: optionalText(80),
  postalCode: optionalText(20),
  cashApp: optionalText(120),
  venmo: optionalText(120),
  paypal: optionalText(120),
  zelle: optionalText(120),
}

// An unchecked checkbox is simply absent from the body, so presence is the value.
const checkbox = z.preprocess((v) => v === 'on' || v === 'true' || v === '1', z.boolean())

// Written by public/js/profile.js from the geocoder. Nonsense or absent means
// null coordinates — never a validation failure, because a bad geocode must not
// block someone from saving their address as text.
const coord = (min: number, max: number) =>
  z.preprocess(
    (v) => (v === '' || v == null ? null : Number(v)),
    z.number().min(min).max(max).nullable().catch(null),
  )

const profileSchema = z.object({
  ...profileFields,
  homeLat: coord(-90, 90),
  homeLng: coord(-180, 180),
  shareLastName: checkbox,
  addHomeToRides: checkbox,
  sharePaymentHandles: checkbox,
})

type ProfileValues = z.infer<typeof profileSchema>
type FieldErrors = Partial<Record<keyof ProfileValues, string>>

// Field-keyed rather than routes/maps.ts's firstIssue(), because a form shows
// every bad field at once instead of the first one.
function fieldErrors(e: z.ZodError): FieldErrors {
  const out: FieldErrors = {}
  for (const issue of e.issues) {
    const key = issue.path[0]
    if (typeof key === 'string' && !(key in out)) out[key as keyof ProfileValues] = issue.message
  }
  return out
}

function loadProfile(userId: number): Promise<UserProfileRow | undefined> {
  return db
    .select()
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId))
    .limit(1)
    .then((r) => r[0])
}

// --- Rendering --------------------------------------------------------------

type RenderArgs = {
  user: UserRow
  values: Record<string, unknown>
  errors?: FieldErrors
  saved?: boolean
}

function field(o: {
  name: string
  label: string
  values: Record<string, unknown>
  errors?: FieldErrors
  type?: string
  hint?: string
  autocomplete?: string
}): string {
  const err = o.errors?.[o.name as keyof ProfileValues]
  const raw = o.values[o.name]
  const value = raw == null ? '' : String(raw)
  return `<p class="field${err ? ' has-error' : ''}">
    <label for="f-${o.name}">${esc(o.label)}</label>
    <input id="f-${o.name}" name="${o.name}" type="${o.type ?? 'text'}" value="${esc(value)}"
      ${o.autocomplete ? `autocomplete="${o.autocomplete}"` : ''}
      ${err ? `aria-invalid="true" aria-describedby="e-${o.name}"` : ''}>
    ${err ? `<span class="field-error" id="e-${o.name}">${esc(err)}</span>` : ''}
    ${o.hint ? `<span class="field-hint">${esc(o.hint)}</span>` : ''}
  </p>`
}

function check(o: { name: string; label: string; values: Record<string, unknown> }): string {
  const on = o.values[o.name] === true || o.values[o.name] === 'on'
  return `<label class="check">
    <input type="checkbox" name="${o.name}"${on ? ' checked' : ''}>
    <span>${esc(o.label)}</span>
  </label>`
}

function renderProfile({ user, values, errors, saved }: RenderArgs): string {
  const v = values
  const body = `<h1>Your profile</h1>
    ${saved ? '<p class="notice">Profile saved.</p>' : ''}
    ${errors && Object.keys(errors).length ? '<p class="notice is-error">Some fields need attention.</p>' : ''}

    <form class="profile-form" method="post" action="/profile">
      <fieldset>
        <legend>Who you are</legend>
        ${field({ name: 'displayName', label: 'Display name', values: v, errors, autocomplete: 'nickname' })}
        ${field({ name: 'username', label: 'Username', values: v, errors, hint: 'Letters, numbers and underscores. Leave blank to skip.' })}
        ${field({ name: 'firstName', label: 'First name', values: v, errors, autocomplete: 'given-name' })}
        ${field({ name: 'lastName', label: 'Last name', values: v, errors, autocomplete: 'family-name' })}
        ${check({ name: 'shareLastName', label: 'Show my last name to other riders', values: v })}
      </fieldset>

      <fieldset>
        <legend>Home base</legend>
        ${field({ name: 'addressLine', label: 'Address', values: v, errors, autocomplete: 'street-address' })}
        ${field({ name: 'city', label: 'City', values: v, errors, autocomplete: 'address-level2' })}
        ${field({ name: 'state', label: 'State or region', values: v, errors, autocomplete: 'address-level1' })}
        ${field({ name: 'postalCode', label: 'Postal code', values: v, errors, autocomplete: 'postal-code' })}
        <input type="hidden" name="homeLat" id="f-homeLat" value="${esc(v.homeLat == null ? '' : String(v.homeLat))}">
        <input type="hidden" name="homeLng" id="f-homeLng" value="${esc(v.homeLng == null ? '' : String(v.homeLng))}">
        <p class="field-hint" id="geocode-status" role="status"></p>
        ${check({ name: 'addHomeToRides', label: 'Start new rides at my home address', values: v })}
      </fieldset>

      <fieldset>
        <legend>Splitting costs</legend>
        <p class="field-hint">Optional. For settling up on hotels, gas and meals along a trip.</p>
        ${field({ name: 'cashApp', label: 'Cash App', values: v, errors })}
        ${field({ name: 'venmo', label: 'Venmo', values: v, errors })}
        ${field({ name: 'paypal', label: 'PayPal', values: v, errors })}
        ${field({ name: 'zelle', label: 'Zelle', values: v, errors })}
        ${check({ name: 'sharePaymentHandles', label: 'Share these with riders on my rides', values: v })}
      </fieldset>

      <fieldset ${user.canManageRiders ? '' : 'disabled'}>
        <legend>Your riders</legend>
        ${
          user.canManageRiders
            ? '<p class="field-hint">Rider management is enabled for your account — <a href="/admin">approve and manage riders</a>.</p>'
            : '<p class="field-hint">Adding riders is closed during the alpha.</p>'
        }
      </fieldset>

      <fieldset disabled>
        <legend>Your places</legend>
        <p class="field-hint">Saved places are coming in the next release.</p>
      </fieldset>

      <p><button class="btn" type="submit">Save profile</button></p>
    </form>`

  return page({
    title: 'Your profile',
    user,
    navKey: 'profile',
    body,
    // Only the token: profile.js geocodes the address so the builder can read
    // coordinates straight off the profile instead of looking them up per ride.
    tb: { token: MAPBOX_TOKEN },
    scripts: `<script src="${asset('/js/profile.js')}" defer></script>`,
  })
}

// --- Routes -----------------------------------------------------------------

profileRoutes.get('/profile', requireActive, async (c) => {
  const user = currentUser(c)
  const profile = await loadProfile(user.id)

  return c.html(
    renderProfile({
      user,
      saved: c.req.query('saved') === '1',
      values: { ...profile, username: user.username ?? '', displayName: user.displayName },
    }),
  )
})

profileRoutes.post('/profile', requireActive, async (c) => {
  const user = currentUser(c)
  const raw = await c.req.parseBody()
  const parsed = profileSchema.safeParse(raw)

  // Re-render with what they typed, not with what is in the database — losing a
  // form's worth of input to one bad field is the thing this avoids.
  if (!parsed.success) {
    return c.html(renderProfile({ user, values: raw, errors: fieldErrors(parsed.error) }), 400)
  }

  const p = parsed.data
  const text = (s: string) => sanitizeText(s) || null
  const username = p.username ? sanitizeText(p.username) : null

  // Checked before the write so the rider gets a field error instead of a 500
  // from uq_username_lower. Still racy under simultaneous signups, which is why
  // the insert below is also wrapped — the index stays the real authority.
  if (username) {
    const [clash] = await db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.username}) = lower(${username}) and ${ne(users.id, user.id)}`)
      .limit(1)
    if (clash) {
      return c.html(
        renderProfile({ user, values: raw, errors: { username: 'that username is taken' } }),
        400,
      )
    }
  }

  try {
    await db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ displayName: sanitizeText(p.displayName), username, updatedAt: new Date() })
        .where(eq(users.id, user.id))

      const profile = {
        firstName: text(p.firstName),
        lastName: text(p.lastName),
        addressLine: text(p.addressLine),
        city: text(p.city),
        state: text(p.state),
        postalCode: text(p.postalCode),
        homeLat: p.homeLat,
        homeLng: p.homeLng,
        shareLastName: p.shareLastName,
        addHomeToRides: p.addHomeToRides,
        sharePaymentHandles: p.sharePaymentHandles,
        cashApp: text(p.cashApp),
        venmo: text(p.venmo),
        paypal: text(p.paypal),
        zelle: text(p.zelle),
        updatedAt: new Date(),
      }

      await tx
        .insert(userProfiles)
        .values({ userId: user.id, ...profile })
        .onConflictDoUpdate({ target: userProfiles.userId, set: profile })
    })
  } catch (err) {
    // The unique index is the last line of defense on a concurrent claim.
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('uq_username_lower')) {
      return c.html(
        renderProfile({ user, values: raw, errors: { username: 'that username is taken' } }),
        409,
      )
    }
    throw err
  }

  // Redirect rather than re-render so a refresh cannot resubmit the form.
  return c.redirect('/profile?saved=1', 302)
})
