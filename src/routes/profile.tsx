// The rider's own profile. Everything here is a plain HTML form POST rather than
// the fetch+JSON APIs the rest of the app uses: a settings page should not stop
// working without JavaScript, and a form plus one re-render is less code than an
// endpoint plus a client script. Validation still runs through the same zod
// helpers as the ride APIs so the two paths cannot drift.
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db/index'
import { userProfiles, users, type UserProfileRow, type UserRow } from '../db/schema'
import { currentUser, requireActive, type AuthEnv } from '../auth/middleware'
import { sanitizeText } from '../maps/kml'
import { page } from '../views/layout'
import { asset } from '../views/assets'
import { checkAvailability, claimUsername, usernameHistoryFor, USERNAME_HOLD_DAYS } from '../auth/username'
import { usernameSchema } from '../auth/username'
import type { UsernameHistoryRow } from '../db/schema'

export const profileRoutes = new Hono<AuthEnv>()

// Same shape as `fields` in routes/maps.ts. A browser submits every text input
// even when empty, but an absent field must mean "empty" rather than a 400 —
// otherwise one omitted key rejects the whole form. The handler then maps blank
// to null so clearing a field actually clears it.
const optionalText = (max: number) => z.string().trim().max(max).default('')

const profileFields = {
  // Rules live in auth/username.ts: the signup prompt applies the same ones, and
  // two copies of the reserved list would drift.
  username: z.union([z.literal(''), usernameSchema]).default(''),
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
  startLabel: optionalText(120),
  startAddressLine: optionalText(255),
  startCity: optionalText(120),
  startState: optionalText(80),
  startPostalCode: optionalText(20),
  startLat: coord(-90, 90),
  startLng: coord(-180, 180),
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
  // Absent on the error paths, which re-render from submitted values without
  // another round trip. The block simply does not draw.
  history?: UsernameHistoryRow[]
}

function Field(o: {
  name: string
  label: string
  values: Record<string, unknown>
  errors?: FieldErrors
  type?: string
  hint?: string
  autocomplete?: string
}) {
  const err = o.errors?.[o.name as keyof ProfileValues]
  const raw = o.values[o.name]
  const value = raw == null ? '' : String(raw)
  return (
    <p class={`field${err ? ' has-error' : ''}`}>
      <label for={`f-${o.name}`}>{o.label}</label>
      <input
        id={`f-${o.name}`}
        name={o.name}
        type={o.type ?? 'text'}
        value={value}
        autocomplete={o.autocomplete}
        aria-invalid={err ? 'true' : undefined}
        aria-describedby={err ? `e-${o.name}` : undefined}
      />
      {err && (
        <span class="field-error" id={`e-${o.name}`}>
          {err}
        </span>
      )}
      {o.hint && <span class="field-hint">{o.hint}</span>}
    </p>
  )
}

function Check(o: { name: string; label: string; values: Record<string, unknown> }) {
  const on = o.values[o.name] === true || o.values[o.name] === 'on'
  return (
    <label class="check">
      <input type="checkbox" name={o.name} checked={on} />
      <span>{o.label}</span>
    </label>
  )
}

// Previously held names, newest first, with anything still inside its window
// saying when it frees up — that date is the only reason the hold exists, so
// showing the list without it would be showing the wrong half.
function HistoryBlock({ rows }: { rows: UsernameHistoryRow[] }) {
  if (rows.length < 2) return <></> // nothing to show a rider who has only ever had one
  const now = Date.now()
  const day = (d: Date) => d.toISOString().slice(0, 10)
  const released = rows.filter((r) => r.releasedAt)
  if (released.length === 0) return <></>
  return (
    <div class="handle-history">
      <p class="field-hint">
        Names you have used before. A name you release is held for {USERNAME_HOLD_DAYS} days, so nobody else can take
        it while you think it over.
      </p>
      <ul>
        {released.map((r) => {
          const until = new Date(r.releasedAt!.getTime() + USERNAME_HOLD_DAYS * 86400000)
          const held = until.getTime() > now
          return (
            <li>
              <span class="handle">@{r.username}</span>{' '}
              <span class="handle-dates">
                {day(r.claimedAt)} – {day(r.releasedAt!)}
                {held ? ` · yours to reclaim until ${day(until)}` : ''}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function renderProfile({ user, values, errors, saved, history }: RenderArgs): string {
  const v = values
  const body = (
    <>
      <h1>Your profile</h1>
      {saved && <p class="notice">Profile saved.</p>}
      {errors && Object.keys(errors).length > 0 && <p class="notice is-error">Some fields need attention.</p>}

      <form class="profile-form" method="post" action="/profile">
        <fieldset>
          <legend>Who you are</legend>
          <Field name="displayName" label="Display name" values={v} errors={errors} autocomplete="nickname" />
          <Field
            name="username"
            label="Username"
            values={v}
            errors={errors}
            hint={`Letters, numbers and underscores. Change it whenever — the old one stays yours for ${USERNAME_HOLD_DAYS} days.`}
          />
          <HistoryBlock rows={history ?? []} />
          <Field name="firstName" label="First name" values={v} errors={errors} autocomplete="given-name" />
          <Field name="lastName" label="Last name" values={v} errors={errors} autocomplete="family-name" />
          <Check name="shareLastName" label="Show my last name to other riders" values={v} />
        </fieldset>

        <fieldset>
          <legend>Home base</legend>
          <Field name="addressLine" label="Address" values={v} errors={errors} autocomplete="street-address" />
          <Field name="city" label="City" values={v} errors={errors} autocomplete="address-level2" />
          <Field name="state" label="State or region" values={v} errors={errors} autocomplete="address-level1" />
          <Field name="postalCode" label="Postal code" values={v} errors={errors} autocomplete="postal-code" />
          <input type="hidden" name="homeLat" id="f-homeLat" value={v.homeLat == null ? '' : String(v.homeLat)} />
          <input type="hidden" name="homeLng" id="f-homeLng" value={v.homeLng == null ? '' : String(v.homeLng)} />
          <p class="field-hint" id="geocode-status" role="status"></p>
          <Check name="addHomeToRides" label="Start new rides at my home address" values={v} />
        </fieldset>

        <fieldset>
          <legend>Public starting point</legend>
          <p class="field-hint">
            Where a <em>shared</em> ride starts instead of your front door. Pick somewhere a few minutes away that you
            would not mind strangers seeing on a map—a gas station, a coffee shop, a trailhead, a supermarket car
            park. Somewhere you can actually meet people is ideal.
          </p>
          <p class="field-hint">
            Without this, a ride you started at home and then shared publicly is drawn from your house, with a pin on
            it.
          </p>
          <Field
            name="startLabel"
            label="Name it"
            values={v}
            errors={errors}
            hint={'What it shows up as. “Chevron on Main”, “Peet’s at the plaza”.'}
          />
          <Field name="startAddressLine" label="Address" values={v} errors={errors} autocomplete="off" />
          <Field name="startCity" label="City" values={v} errors={errors} autocomplete="off" />
          <Field name="startState" label="State or region" values={v} errors={errors} autocomplete="off" />
          <Field name="startPostalCode" label="Postal code" values={v} errors={errors} autocomplete="off" />
          <input type="hidden" name="startLat" id="f-startLat" value={v.startLat == null ? '' : String(v.startLat)} />
          <input type="hidden" name="startLng" id="f-startLng" value={v.startLng == null ? '' : String(v.startLng)} />
          <p class="field-hint" id="start-geocode-status" role="status"></p>
        </fieldset>

        <fieldset>
          <legend>Splitting costs</legend>
          <p class="field-hint">Optional. For settling up on hotels, gas and meals along a ride.</p>
          <Field name="cashApp" label="Cash App" values={v} errors={errors} />
          <Field name="venmo" label="Venmo" values={v} errors={errors} />
          <Field name="paypal" label="PayPal" values={v} errors={errors} />
          <Field name="zelle" label="Zelle" values={v} errors={errors} />
          <Check name="sharePaymentHandles" label="Share these with riders on my rides" values={v} />
        </fieldset>

        <fieldset disabled={!user.canManageRiders}>
          <legend>Your riders</legend>
          {user.canManageRiders ? (
            <p class="field-hint">
              Rider management is enabled for your account—<a href="/admin/approvals">approve and manage riders</a>.
            </p>
          ) : (
            <p class="field-hint">Adding riders is closed during the alpha.</p>
          )}
        </fieldset>

        {/*
          Saved places. NOT part of the profile form's own submit — every write
          goes through /api/places as JSON, so this is a region inside the
          fieldset rather than fields on it. A nested <form> would be invalid
          HTML and the outer submit would swallow it.

          Places are CREATED from the builder ("Save to my places" on a stop),
          because a place needs a pin and the builder is where the map is. This
          screen is for organizing what is already there: rename, refile, delete.
          A create-from-scratch flow here wants the address picker from roadmap
          item 19 and should wait for it rather than ship a lat/lng text box.
        */}
        <fieldset>
          <legend>Your places</legend>
          <p class="field-hint">
            Save a stop from the ride builder and it turns up here, and in the builder&rsquo;s search box on every ride
            after&nbsp;that.
          </p>
          <div id="places-manager" data-places-manager>
            <p class="field-hint">Loading&hellip;</p>
          </div>
        </fieldset>

        <p>
          <button class="btn" type="submit">
            Save profile
          </button>
        </p>
      </form>
    </>
  ).toString()

  return page({
    title: 'Your profile',
    user,
    navKey: 'profile',
    body,
    // Only the token: profile.js geocodes the address so the builder can read
    // coordinates straight off the profile instead of looking them up per ride.
    scripts: `<script src="${asset('/js/profile.js')}" defer></script>
  <script src="${asset('/js/places.js')}" defer></script>`,
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
      history: await usernameHistoryFor(user.id),
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

  // Only a real change goes through the claim path: re-saving the form with the
  // same name must not release and re-take it, which would reset the hold and
  // litter the history with a row per save.
  const changing = username !== null && username.toLowerCase() !== (user.username ?? '').toLowerCase()

  // Checked before the write so the rider gets a field error instead of a 500
  // from uq_username_lower. Still racy under simultaneous signups, which is why
  // the write below is also wrapped — the index stays the real authority.
  if (changing) {
    const free = await checkAvailability(username, user.id)
    if (!free.ok) {
      const message =
        free.reason === 'taken'
          ? 'that username is taken'
          : `that username was released recently and is held until ${free.until.toISOString().slice(0, 10)}`
      return c.html(renderProfile({ user, values: raw, errors: { username: message } }), 400)
    }
  }

  try {
    await db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ displayName: sanitizeText(p.displayName), updatedAt: new Date() })
        .where(eq(users.id, user.id))

      // claimUsername owns the history: it closes out the outgoing name and
      // opens the incoming one in this same transaction, so users.username and
      // username_history can never disagree. Clearing the field is deliberately
      // not a claim — there is nothing to record and nothing to hold.
      if (changing) await claimUsername(tx, user, username)
      else if (username === null && user.username) {
        await tx.update(users).set({ username: null }).where(eq(users.id, user.id))
      }

      const profile = {
        firstName: text(p.firstName),
        lastName: text(p.lastName),
        addressLine: text(p.addressLine),
        city: text(p.city),
        state: text(p.state),
        postalCode: text(p.postalCode),
        homeLat: p.homeLat,
        homeLng: p.homeLng,
        startLabel: text(p.startLabel),
        startAddressLine: text(p.startAddressLine),
        startCity: text(p.startCity),
        startState: text(p.startState),
        startPostalCode: text(p.startPostalCode),
        startLat: p.startLat,
        startLng: p.startLng,
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
