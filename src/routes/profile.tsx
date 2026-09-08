// The rider's own profile. Everything here is a plain HTML form POST rather than
// the fetch+JSON APIs the rest of the app uses: a settings page should not stop
// working without JavaScript, and a form plus one re-render is less code than an
// endpoint plus a client script. Validation still runs through the same zod
// helpers as the ride APIs so the two paths cannot drift.
import { Hono, type Context } from 'hono'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db/index'
import { userProfiles, users, type UserProfileRow, type UserRow } from '../db/schema'
import { currentUser, requireActive, requireActiveApi, requireSameOrigin, type AuthEnv } from '../auth/middleware'
import { sanitizeText } from '../maps/kml'
import { accountPage } from '../views/account-page'
import { asset } from '../views/assets'
import { checkAvailability, claimUsername, usernameHistoryFor, USERNAME_HOLD_DAYS } from '../auth/username'
import { usernameSchema } from '../auth/username'
import type { UsernameHistoryRow } from '../db/schema'
import { fromAcceptLanguage } from '../views/date-format'
import { bodyLimit } from 'hono/body-limit'
import { MAX_IMAGE_BYTES, UPLOAD_REFUSAL_MESSAGES, checkUpload } from '../images/policy'
import { PROCESSED_MIME } from '../images/process'
import { deleteAvatar, processAvatar, readAvatar, writeAvatar } from '../account/avatar'
import { avatarSrc, fieldHelp } from '../views/layout'
// ALIASED, BECAUSE `Field` ALREADY HAS A LOCAL `raw` — the unparsed value out
// of the values map. A bare import would be shadowed inside exactly the function
// that needs it, and the failure is a type error rather than anything readable.
import { raw as rawHtml } from 'hono/html'
import { SEP } from '../views/sep'

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
  homeLabel: optionalText(120),
  addressLine: optionalText(255),
  city: optionalText(120),
  state: optionalText(80),
  postalCode: optionalText(20),
  cashApp: optionalText(120),
  venmo: optionalText(120),
  paypal: optionalText(120),
  zelle: optionalText(120),
  // Free text and deliberately unvalidated beyond a length cap (#183). The same
  // argument as `state` above, which the schema keeps loose because the labels
  // are US-shaped and nothing should reject a rider outside them — it holds
  // harder here. E.164 normalization rejects perfectly good international input
  // and every extension anyone writes down, and a rider whose number this app
  // refuses has no way to tell it it is wrong.
  phone: optionalText(40),
  // HANDLES, NOT URLS, which is the security half of this block. A rider-supplied
  // `href` needs a scheme allow-list or `javascript:` is stored XSS, and JSX
  // escaping does not save an attribute. A handle cannot carry a scheme, so
  // composing the link at render time removes the class of bug rather than
  // defending against it. Same shape as the four payment handles above.
  instagram: optionalText(120),
  facebook: optionalText(120),
  youtube: optionalText(120),
  strava: optionalText(120),
}

// An unchecked checkbox is simply absent from the body, so presence is the value.
const checkbox = z.preprocess((v) => v === 'on' || v === 'true' || v === '1', z.boolean())

// Written by public/js/profile.js from the geocoder. Nonsense or absent means
// null coordinates — never a validation failure, because a bad geocode must not
// block someone from saving their address as text.
const coord = (min: number, max: number) =>
  z.preprocess((v) => (v === '' || v == null ? null : Number(v)), z.number().min(min).max(max).nullable().catch(null))

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
  // TWO FLAGS AND NOT ONE (#183). `sharePaymentHandles` covers four fields
  // because the four are the same kind of thing. A phone number is not the same
  // kind of thing as an Instagram handle, and one flag over both would mean a
  // rider who wants their socials seen has to publish their phone to do it.
  sharePhone: checkbox,
  shareSocials: checkbox,
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

export function loadProfile(userId: number): Promise<UserProfileRow | undefined> {
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
  /**
   * A sigil drawn INSIDE the field, ahead of what the rider types — `$` for a
   * Cashtag, `@` for a Venmo handle.
   *
   * IT IS NOT PART OF THE VALUE, and the POST handler strips a leading one for
   * exactly that reason: a rider who types the `$` they can already see would
   * otherwise store `$ziad` in a field the app renders a `$` in front of, and
   * every surface that ever prints it reads `$$ziad`. Same argument as the
   * social handles, which strip a leading `@` and a pasted URL.
   *
   * `aria-hidden`, because it is decoration over an input the label already
   * names. What it says in words belongs in `hint`, which is announced.
   */
  prefix?: string
  /**
   * Instructions for THIS field, behind a `?` beside its label (#268).
   *
   * `help` VS `hint`, AND THE LINE BETWEEN THEM IS WHAT A RIDER NEEDS BEFORE
   * THEY ACT. Instructions — what shape a Cashtag is, what a name defaults to —
   * are what somebody looks for when they are stuck, so they go behind the dot
   * and stop taking up a line under every field forever. A DISCLOSURE is the
   * opposite: what a section does with an address, or who a value is shared
   * with, has to be read before the rider fills the box in, and behind a click
   * is where most people never see it. Those stay as `hint`, or as prose above
   * the fields.
   */
  help?: string
  /**
   * What the help button is CALLED, when the field's own label is not enough on
   * its own.
   *
   * Home base and Public starting point both label their name field "Name it",
   * which is right under a section heading and ambiguous the moment a screen
   * reader lists the page's buttons — two of them reading "More about Name it"
   * and neither saying which. Found in the accessibility tree, not by eye.
   */
  helpLabel?: string
}) {
  const err = o.errors?.[o.name as keyof ProfileValues]
  const raw = o.values[o.name]
  const value = raw == null ? '' : String(raw)
  const input = (
    <input
      id={`f-${o.name}`}
      name={o.name}
      type={o.type ?? 'text'}
      value={value}
      autocomplete={o.autocomplete}
      aria-invalid={err ? 'true' : undefined}
      aria-describedby={err ? `e-${o.name}` : undefined}
    />
  )
  return (
    <p class={`field${err ? ' has-error' : ''}`}>
      {/* THE DOT IS INSIDE THE LABEL ELEMENT AND THE BUTTON IS NOT A LABEL FOR
          THE INPUT. A <label> forwards a click to the control it names, so a
          `?` sitting loose inside one would focus the field instead of opening
          the bubble — the button's own handler runs first and `popovertarget`
          still fires, but focus lands in the box behind it, which reads as the
          dot being broken. `pointer-events` cannot fix it either, since the
          button has to be pressable. So the label wraps only its text and the
          help sits beside it in a flex row. */}
      <span class="label-row">
        <label for={`f-${o.name}`}>{o.label}</label>
        {o.help ? rawHtml(fieldHelp(o.name, o.helpLabel ?? o.label, o.help)) : null}
      </span>
      {o.prefix ? (
        <span class="field-prefixed">
          <span class="field-prefix" aria-hidden="true">
            {o.prefix}
          </span>
          {input}
        </span>
      ) : (
        input
      )}
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
        Names you have used before. A name you release is held for {USERNAME_HOLD_DAYS} days, so nobody else can take it
        while you think it over.
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
                {held ? `${SEP}yours to reclaim until ${day(until)}` : ''}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/**
 * The Profile PANEL, not a page (#269).
 *
 * Settings and Profile are one page with two tabs now, so this returns markup
 * for a panel and src/views/account-page.tsx wraps it. The split is what keeps
 * the imports one-directional: that module takes this as a string and imports
 * nothing from here, so there is no cycle to reason about.
 *
 * `<h1>` became `<h2>` with the move — the page already has one, and two would
 * be two documents in one.
 */
export function profilePanel({ user, values, errors, saved, history }: RenderArgs): string {
  const v = values
  // The session carries `avatarBytes` so the nav can prefer an upload over the
  // provider picture; the same value is what decides whether Remove is offered.
  const hasUpload = ((user as { avatarBytes?: number }).avatarBytes ?? 0) > 0
  return (
    <>
      {/* NO HEADING OF ITS OWN. account-page.tsx heads the page "Your profile"
          when this tab is the one open, and the tab itself is labelled Profile —
          a third copy inside the panel is the same words three times. */}
      {saved && <p class="notice">Profile saved.</p>}
      {errors && Object.keys(errors).length > 0 && <p class="notice is-error">Some fields need attention.</p>}

      {/*
        `two-col` puts the fieldsets two-up at >=992px — see _chrome.scss. Every
        direct child is a grid cell, which is why the submit row below carries
        `full-span`: it belongs to the whole form, not to the left column.
      */}
      <form class="profile-form two-col" method="post" action="/profile">
        {/*
          THE PICTURE IS IN HERE NOW, AND ITS OWN COMMENT SAID IT SHOULD BE.
          Ziad's call, 2026-09-07: it sat between Splitting costs and Phone, six
          fieldsets down from the name it is a picture OF, under a note reading
          "AT THE TOP, BESIDE THE NAME". It had drifted from the place #99 put it.

          FULL-SPAN, WHICH IS ALSO WHAT PAIRS THE TWO ADDRESSES BELOW. `two-col`
          places its children in order, so with this taking a whole row Home base
          and Public starting point become the next pair — and those two are the
          one place on this form where a rider is genuinely comparing two answers
          side by side. Without it they land in different rows with unrelated
          blocks beside them.
        */}
        <fieldset class="full-span who-you-are">
          <legend>Who you are</legend>
          <div class="who-grid">
            <div class="who-fields">
              {/* TWO UP, because these are four short answers rather than four
                  paragraphs and a column of full-width boxes makes them read as
                  a longer form than they are. The pairs are the ones a rider
                  fills in together. `.field-pair` stacks below 768px. */}
              <div class="field-pair">
                <Field name="displayName" label="Display name" values={v} errors={errors} autocomplete="nickname" />
                <Field
                  name="username"
                  label="Username"
                  values={v}
                  errors={errors}
                  help={`Letters, numbers and underscores. Change it whenever — the old one stays yours for ${USERNAME_HOLD_DAYS} days.`}
                />
              </div>
              {/* FULL WIDTH AND OUTSIDE THE PAIR. It belongs to the username
                  above it, but it is a list rather than a field — put in the
                  pair it would stretch the row to its own height and leave the
                  display name floating beside a column of dates. */}
              <HistoryBlock rows={history ?? []} />
              <div class="field-pair">
                <Field name="firstName" label="First name" values={v} errors={errors} autocomplete="given-name" />
                <Field name="lastName" label="Last name" values={v} errors={errors} autocomplete="family-name" />
              </div>
              <Check name="shareLastName" label="Show my last name to other riders" values={v} />
            </div>

            {/*
            #99. AT THE TOP, BESIDE THE NAME, because that is what it is a picture
            OF — and because a rider looking for it looks where their face already
            appears in the nav.

            THE WHOLE BLOCK IS PROGRESSIVE. With script off there is no crop box
            and no upload: the file input and its buttons live inside
            #avatar-crop's controls, which avatar.js reveals. What a no-script
            rider sees is their current picture and nothing that lies about being
            usable. An upload needs a canvas to crop in, and there is no honest
            server-side fallback for "position this circle".
          */}
            <div class="avatar-block">
              <h3>Your picture</h3>
              <div class="avatar-now">
                {avatarSrc(user) ? (
                  <img
                    id="avatar-current"
                    class="avatar-preview"
                    src={avatarSrc(user)!}
                    alt=""
                    width="96"
                    height="96"
                  />
                ) : (
                  <>
                    <img id="avatar-current" class="avatar-preview" alt="" width="96" height="96" hidden />
                    <span id="avatar-initials" class="avatar-preview is-initials" aria-hidden="true">
                      {(user.displayName || '?').trim().charAt(0).toUpperCase()}
                    </span>
                  </>
                )}
                <div class="avatar-acts">
                  {/* Hidden and clicked by the button, so the control reads as a
                    button rather than as a file input — and so it can sit beside
                    Remove without the two looking like different kinds of thing. */}
                  <input type="file" id="avatar-file" accept="image/jpeg,image/png" hidden />
                  <button type="button" class="btn btn-quiet" id="avatar-open" hidden>
                    Choose a picture
                  </button>
                  <button type="button" class="btn btn-quiet" id="avatar-remove" hidden={!hasUpload}>
                    Remove
                  </button>
                  <p class="field-hint">
                    JPEG or PNG, up to 1&nbsp;MB. Stored square and shown round; we re-encode it and strip the location
                    your camera put&nbsp;in&nbsp;it.
                  </p>
                </div>
              </div>

              <div id="avatar-crop" hidden>
                {/* 320 is the canvas's PIXEL size and the stylesheet may display it
                  smaller — avatar.js scales pointer deltas by the ratio, so the
                  two are allowed to differ. */}
                <canvas id="avatar-canvas" width="320" height="320"></canvas>
                <label class="avatar-zoom-row">
                  <span>Zoom</span>
                  <input type="range" id="avatar-zoom" min="1" max="4" step="0.01" value="1" />
                </label>
                <div class="avatar-acts">
                  <button type="button" class="btn" id="avatar-save">
                    Use this
                  </button>
                  <button type="button" class="btn btn-quiet" id="avatar-cancel">
                    Cancel
                  </button>
                </div>
              </div>
              <p class="save-status" id="avatar-status" role="status" aria-live="polite"></p>
            </div>
          </div>
        </fieldset>

        <fieldset>
          <legend>Home base</legend>
          {/*
            WHAT IT SAYS IS WHAT THE CODE DOES, and the difference matters more
            here than anywhere else on this form. Ziad asked for copy saying a
            ride going public "automatically swaps" the home address for the
            public starting point. `offerPublicStart()` in builder.js does not:
            it ASKS, with a confirm; it fires on any level above private rather
            than on public alone; and it does nothing at all when no public
            starting point is set. Promising an automatic swap that is really a
            dialog somebody can dismiss is how a rider publishes their house
            believing the app had handled it.

            SO THE THIRD SENTENCE IS THE LOAD-BEARING ONE. The offer needs a
            public starting point to exist, and a rider with none gets no
            prompt — which is exactly the rider most in need of one.
          */}
          <p class="field-hint">
            Only ever on rides you keep private or friends-only, and only if you ask for it below. Share a ride any
            wider and the builder offers to swap your home for your public starting point before anyone sees&nbsp;it —
            so set one up on the right, because with none there is nothing to offer and the pin stays on
            your&nbsp;house.
          </p>
          {/* NAMED, LIKE THE PUBLIC STARTING POINT BELOW. Ziad's call,
              2026-09-07: the builder seeds a rider's first point from this
              address and called it "Home", hardcoded — which is right for most
              people and wrong for anyone whose home base is the shop, a
              storage unit, or somebody else's garage.

              THE FALLBACK LIVES IN CODE AND NOT IN A COLUMN DEFAULT, so a rider
              who clears the field goes back to "Home" rather than having it
              written into their profile as though they had typed it. Same
              arrangement `start_label` has with "Meeting point". */}
          <Field
            name="homeLabel"
            label="Name it"
            values={v}
            errors={errors}
            help={'What a stop here is called on a ride. “Bill’s apartment”, “the shop”. Defaults to Home.'}
            helpLabel="the name of your home base"
            autocomplete="off"
          />
          <Field name="addressLine" label="Address" values={v} errors={errors} autocomplete="street-address" />
          <Field name="city" label="City" values={v} errors={errors} autocomplete="address-level2" />
          <Field name="state" label="State or region" values={v} errors={errors} autocomplete="address-level1" />
          <Field name="postalCode" label="Postal code" values={v} errors={errors} autocomplete="postal-code" />
          <input type="hidden" name="homeLat" id="f-homeLat" value={v.homeLat == null ? '' : String(v.homeLat)} />
          <input type="hidden" name="homeLng" id="f-homeLng" value={v.homeLng == null ? '' : String(v.homeLng)} />
          <p class="field-hint" id="geocode-status" role="status"></p>
          <Check name="addHomeToRides" label="Start new private/friends-only rides at my home address" values={v} />
        </fieldset>

        <fieldset>
          <legend>Public starting point</legend>
          <p class="field-hint">
            Where a <em>shared</em> ride starts instead of your front door. Pick somewhere a few minutes away that you
            would not mind strangers seeing on a map—a gas station, a coffee shop, a trailhead, a supermarket parking
            lot. Somewhere you can actually meet people is ideal.
          </p>
          {/* "SHARED", NOT "SHARED PUBLICLY". offerPublicStart() fires on any
              level above private — unlisted and friends-only included — and a
              rider reading "publicly" would reasonably conclude a friends-only
              ride was covered by the private case. It is not. */}
          <p class="field-hint">
            Without this there is nothing to swap in, so a ride you started at home keeps the pin on your&nbsp;house the
            moment you share it with anyone.
          </p>
          <Field
            name="startLabel"
            label="Name it"
            values={v}
            errors={errors}
            help={'What it shows up as. “Chevron on Main”, “Peet’s at the plaza”.'}
            helpLabel="the name of your public starting point"
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
          {/*
            THE SIGIL EACH SERVICE ACTUALLY USES, drawn in the field rather than
            asked for (#183 follow-up, Ziad's call 2026-09-07). Cash App writes a
            Cashtag as `$name` and Venmo writes a handle as `@name`, so a rider
            typing one into a field that already shows it stores it twice — which
            is why the handler strips a leading sigil, the same way it strips one
            off a social handle.

            ZELLE GETS NONE, AND THAT IS THE ANSWER RATHER THAN AN OMISSION: a
            Zelle account is reached by US mobile number or email address, not by
            a handle, so there is no sigil to draw and the hint says what to put
            there instead.

            EVERY ONE OF THEM IS `autocomplete="off"`, AND THAT IS A DATA FIX
            RATHER THAN A PREFERENCE. Chrome autofills a field it cannot place by
            guessing from the label, and an autofill fires a real `input` event —
            which profile.js's idle autosave cannot tell from typing. So a rider
            who merely OPENED this page had their display name written into Cash
            App and a saved username into Venmo, silently, and the next thing to
            read those handles would have offered strangers a payment address
            nobody chose. Seen live, on this page, during the browser pass that
            added the sigils. The socials block carries it for the same reason,
            and the Public starting point block already did.
          */}
          <Field
            name="cashApp"
            label="Cash App"
            values={v}
            errors={errors}
            prefix="$"
            help="Your Cashtag."
            autocomplete="off"
          />
          <Field
            name="venmo"
            label="Venmo"
            values={v}
            errors={errors}
            prefix="@"
            help="Your Venmo username."
            autocomplete="off"
          />
          <Field
            name="paypal"
            label="PayPal"
            values={v}
            errors={errors}
            prefix="@"
            help="Your PayPal.Me name."
            autocomplete="off"
          />
          <Field
            name="zelle"
            label="Zelle"
            values={v}
            errors={errors}
            help="The phone number or email your Zelle is registered to."
            autocomplete="off"
          />
          <Check name="sharePaymentHandles" label="Share these with riders on my rides" values={v} />
        </fieldset>

        {/*
          TWO BLOCKS AND TWO FLAGS, not one of each (#183). Splitting costs above
          covers four fields with a single checkbox because the four are the same
          kind of thing. A phone number and an Instagram handle are not, and one
          flag over both would mean a rider who wants their socials seen has to
          publish their phone to do it.

          Both default to OFF and stay off until asked. Filling a field in is not
          the same as agreeing to publish it, which is the whole reason the
          existing block works the way it does.
        */}

        <fieldset>
          <legend>Phone</legend>
          <p class="field-hint">Optional. For riders on a ride with you, if you let&nbsp;them.</p>
          {/*
            NOT VALIDATED INTO A SHAPE. `state` above is free text with a comment
            saying the labels are US-shaped and nothing should reject a rider
            outside them, and that argument holds harder here — E.164 rejects
            good international input and every extension anyone writes down.
          */}
          <Field name="phone" label="Phone number" values={v} errors={errors} autocomplete="tel" />
          <Check name="sharePhone" label="Share this with riders on my rides" values={v} />
        </fieldset>

        <fieldset>
          <legend>Elsewhere</legend>
          <p class="field-hint">
            Optional. Your handle, not the whole link — paste a URL and we will take the handle out&nbsp;of&nbsp;it.
          </p>
          <Field name="instagram" label="Instagram" values={v} errors={errors} autocomplete="off" />
          <Field name="facebook" label="Facebook" values={v} errors={errors} autocomplete="off" />
          <Field name="youtube" label="YouTube" values={v} errors={errors} autocomplete="off" />
          <Field name="strava" label="Strava" values={v} errors={errors} autocomplete="off" />
          <Check name="shareSocials" label="Show these on my profile" values={v} />
        </fieldset>

        {/*
          #181. NO CLUB FIELDS, DELIBERATELY, and this note is what stands in for
          them until there is somewhere real to put one.

          Club name, chapter and icon stored per rider means fifteen members of
          one chapter produce fifteen spellings and fifteen images, and the
          eventual "show me this club" is unbuildable on free text — so the
          migration out of it would be a hand de-duplication across everyone who
          had already typed one. Nothing is stored until a club is its own record.

          The feedback thread is the interim collection and it is better than a
          column would be: it carries which club, which chapter, and who should
          hold it, which no form field here could ask.
        */}
        <fieldset>
          <legend>Clubs</legend>
          <p class="field-hint">
            Clubs are not built yet. If you ride with one, <a href="/feedback?area=account">tell us about it</a> and we
            will find you when they&nbsp;are.
          </p>
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
        {/*
          THE PADDOCK. Same arrangement as Your places below: a region inside
          this form that is not part of its submit, driven by paddock.js against
          /api/bikes. A nested <form> would be invalid markup and the outer
          submit would swallow its controls.

          Full-span rather than sharing the two-up grid, because a bike row is a
          photo plus seven fields and half a column is not enough for it.
        */}
        <fieldset class="full-span">
          <legend>Paddock</legend>
          <p class="field-hint">
            The bikes you ride. A range here is what the app will plan fuel stops around&nbsp;later.
          </p>
          <div id="paddock" data-paddock>
            <p class="field-hint">Loading&hellip;</p>
          </div>
        </fieldset>

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

        {/*
          THE BUTTON STAYS (#100). Autosave relabels this row rather than
          replacing it: with script off the button is the only way to save, and
          with script on it is still the way to commit a username or an address,
          neither of which autosaves. Silent saving with no affordance at all is
          worse than an explicit button, not better.

          The indicator is empty until profile.js writes to it, so a page with no
          script shows a button and nothing else — which is exactly what it did
          before.
        */}
        <p class="full-span profile-save">
          <button class="btn" type="submit">
            Save profile
          </button>
          <span class="save-status" id="profile-autosave" role="status" aria-live="polite"></span>
        </p>
      </form>
    </>
  ).toString()
}

/**
 * What the Profile panel needs loaded.
 *
 * LOADED WHICHEVER TAB IS OPEN, because both panels are in the DOM and a rider
 * can switch to Profile without a round trip — deferring these until the tab
 * opens would mean a first click into the Paddock that does nothing.
 *
 * profile.js geocodes the address so the builder can read coordinates straight
 * off the profile instead of looking them up per ride.
 */
export const PROFILE_SCRIPTS = `<script src="${asset('/js/profile.js')}" defer></script>
  <script src="${asset('/js/avatar.js')}" defer></script>
  <script src="${asset('/js/places.js')}" defer></script>
  <script src="${asset('/js/paddock.js')}" defer></script>`

/** The whole page with the Profile tab open. */
const renderProfile = (args: RenderArgs, c: Context<AuthEnv>): Promise<string> =>
  accountPage(c, { tab: 'profile', profile: profilePanel(args), scripts: PROFILE_SCRIPTS })

// --- Routes -----------------------------------------------------------------

profileRoutes.get('/profile', requireActive, async (c) => {
  const user = currentUser(c)
  const profile = await loadProfile(user.id)

  return c.html(
    await renderProfile(
      {
        user,
        saved: c.req.query('saved') === '1',
        values: { ...profile, username: user.username ?? '', displayName: user.displayName },
        history: await usernameHistoryFor(user.id),
      },
      c,
    ),
  )
})

profileRoutes.post('/profile', requireActive, async (c) => {
  const user = currentUser(c)
  const raw = await c.req.parseBody()
  const parsed = profileSchema.safeParse(raw)

  // Re-render with what they typed, not with what is in the database — losing a
  // form's worth of input to one bad field is the thing this avoids.
  if (!parsed.success) {
    return c.html(await renderProfile({ user, values: raw, errors: fieldErrors(parsed.error) }, c), 400)
  }

  const p = parsed.data
  const text = (s: string) => sanitizeText(s) || null

  // A SOCIAL HANDLE, NORMALIZED TO THE BARE NAME (#183).
  //
  // Riders paste whatever is in front of them — a full profile URL, an @, a
  // trailing slash — and the app composes `https://instagram.com/<handle>` at
  // render time, so anything left in the stored value ends up inside that URL.
  // A pasted `instagram.com/ziad` would compose to `instagram.com/instagram.com/ziad`.
  //
  // This is a convenience, NOT the security boundary. The boundary is that the
  // column holds a handle rather than a URL at all: a handle cannot carry a
  // `javascript:` scheme, so no allow-list is needed on the way out. Stripping
  // the last path segment out of a URL is just being kind to the paste.
  const handle = (s: string) => {
    const t = sanitizeText(s)
    if (!t) return null
    // Take the last non-empty path segment of anything URL-shaped, then drop a
    // leading @ and anything after a ? or #.
    const bare = t
      .replace(/^https?:\/\//i, '')
      .split(/[?#]/)[0]
      .split('/')
      .filter(Boolean)
      .pop()
    // Null rather than falling back to `t`: a string that is nothing but
    // separators ("///", "https://") has no handle in it, and returning the
    // original would store the separators as though they were one.
    return bare ? bare.replace(/^@+/, '') || null : null
  }

  // A PAYMENT HANDLE, WITHOUT THE SIGIL THE FIELD ALREADY DRAWS.
  //
  // Cash App writes a Cashtag as `$name` and Venmo writes a handle as `@name`,
  // and those fields render the character ahead of the input — so a rider who
  // types the one they can see would store it, and every surface that ever
  // prints the value reads `$$ziad`. Stripping it here is the same reasoning as
  // the social handles above, one character further out.
  //
  // IT REUSES `handle()` RATHER THAN BEING A SECOND NORMALIZER, because a rider
  // pastes `cash.app/$ziad` and `venmo.com/u/ziad` exactly as readily as they
  // paste an Instagram URL, and one implementation is one thing to get right.
  //
  // ZELLE DOES NOT GO THROUGH IT, and that is deliberate: a Zelle account is
  // reached by phone number or email address, and `handle()` is built to take
  // the last path segment of a URL. It would leave an email alone today, but the
  // field is not a handle and treating it as one is the kind of thing that
  // stops being harmless the first time somebody widens the helper.
  const money = (s: string) => {
    const bare = handle(s)
    return bare ? bare.replace(/^[$@]+/, '') || null : null
  }
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
      return c.html(await renderProfile({ user, values: raw, errors: { username: message } }, c), 400)
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
        homeLabel: text(p.homeLabel),
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
        cashApp: money(p.cashApp),
        venmo: money(p.venmo),
        paypal: money(p.paypal),
        // Plain text: a phone number or an email, not a handle. See money() above.
        zelle: text(p.zelle),
        sharePhone: p.sharePhone,
        phone: text(p.phone),
        shareSocials: p.shareSocials,
        instagram: handle(p.instagram),
        facebook: handle(p.facebook),
        youtube: handle(p.youtube),
        strava: handle(p.strava),
        updatedAt: new Date(),
      }

      // dateFormat IS SEEDED ON INSERT AND IS ABSENT FROM THE UPDATE SET, which
      // is why `profile` is not simply spread into both halves.
      //
      // This is the same obligation the three handlers in settings.tsx carry and
      // for the same reason: `user_profiles` rows are created lazily, so this
      // upsert is often the moment a rider's first row appears — and until it
      // does, `dateFormatFor` has been giving them day-first off Accept-Language
      // for free. Without the seed the column's own default stamps 'en-US' over
      // that, permanently and silently, the first time they save their name.
      // Leaving it out of `set` is what stops this handler overwriting a date
      // choice they made deliberately on /settings.
      await tx
        .insert(userProfiles)
        .values({
          userId: user.id,
          ...profile,
          dateFormat: fromAcceptLanguage(c.req.header('Accept-Language')),
        })
        .onConflictDoUpdate({ target: userProfiles.userId, set: profile })
    })
  } catch (err) {
    // The unique index is the last line of defense on a concurrent claim.
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('uq_username_lower')) {
      return c.html(await renderProfile({ user, values: raw, errors: { username: 'that username is taken' } }, c), 409)
    }
    throw err
  }

  // Redirect rather than re-render so a refresh cannot resubmit the form.
  return c.redirect('/profile?saved=1', 302)
})

// --- Autosave (#100) ---------------------------------------------------------
//
// The profile saved on a button, so a rider who edited a field and navigated away
// lost it silently. This is the JSON half: the form's own POST is untouched and
// still works with script off.
//
// **THREE THINGS THIS DELIBERATELY WILL NOT SAVE, and each for its own reason.**
//
// `username` — claiming one is not a field write. It closes out the old name in
// `username_history`, opens the new one, and holds it. On an idle timer that
// fires mid-typing, "zia" gets claimed and held before the rider finishes typing
// "ziad", and the name they wanted is now taken by their own abandoned keystroke.
// The button is the right affordance for a write with a side effect.
//
// The two ADDRESS BLOCKS — #100 says why and #101 is the other half: autosave and
// address autocomplete both act on a pause in typing, so a rider who stops to
// read the suggestion list gets "123 Ma" saved and geocoded underneath them. The
// address fields are owned by the selection trigger instead, never by a timer.
//
// **A FIELD THAT FAILS VALIDATION DOES NOT BLOCK THE ONES THAT PASSED.** A ride is
// one object and a bad leg invalidates it; a profile is independent fields, so a
// postal code with a typo in it must not stop a display name from persisting.
// Each field is parsed on its own and only the ones that passed are written —
// which is also why this cannot reuse the whole-form schema in one call.
const AUTOSAVE_FIELDS = [
  'displayName',
  'firstName',
  'lastName',
  'homeLabel',
  'cashApp',
  'venmo',
  'paypal',
  'zelle',
  'phone',
  'instagram',
  'facebook',
  'youtube',
  'strava',
] as const

const AUTOSAVE_FLAGS = ['shareLastName', 'addHomeToRides', 'sharePaymentHandles', 'sharePhone', 'shareSocials'] as const

/**
 * Which stored column each text field writes, and how its value is cleaned.
 *
 * THIS TABLE HAS TO MATCH THE WHOLE-FORM HANDLER'S, and the payment handles are
 * why that is written down rather than assumed. They were added with a `$`/`@`
 * drawn in the field and a `money()` strip on `POST /profile` — and this path
 * cleaned them as plain text, so the SAME typed value stored `$ziad` from the
 * autosave and `ziad` from the Save button. Two write paths for one form means
 * every normalizer has to appear in both, and the failure is silent: the field
 * looks right until something prints it.
 */
const AUTOSAVE_CLEAN: Record<string, 'text' | 'handle' | 'money'> = {
  cashApp: 'money',
  venmo: 'money',
  paypal: 'money',
  // NOT zelle: a phone number or an email, not a handle. See money() below.
  instagram: 'handle',
  facebook: 'handle',
  youtube: 'handle',
  strava: 'handle',
}

profileRoutes.post('/api/profile', requireActiveApi, requireSameOrigin, async (c) => {
  const user = currentUser(c)
  const body = await c.req.parseBody()

  const text = (s: string) => sanitizeText(s) || null
  const handle = (s: string) => {
    const t = sanitizeText(s)
    if (!t) return null
    const bare = t
      .replace(/^https?:\/\//i, '')
      .split(/[?#]/)[0]
      .split('/')
      .filter(Boolean)
      .pop()
    return bare ? bare.replace(/^@+/, '') || null : null
  }
  // The sigil the field already draws. Mirrors money() in the whole-form handler
  // above — see the note on AUTOSAVE_CLEAN for why both paths need it.
  const money = (s: string) => {
    const bare = handle(s)
    return bare ? bare.replace(/^[$@]+/, '') || null : null
  }

  const set: Record<string, unknown> = {}
  const errors: Record<string, string> = {}

  for (const name of AUTOSAVE_FIELDS) {
    // Absent means the caller did not send it, which is not the same as an empty
    // string — an empty string is a rider clearing a field and IS a write.
    if (!(name in body)) continue
    const parsed = profileFields[name].safeParse(body[name])
    if (!parsed.success) {
      errors[name] = parsed.error.issues[0]?.message ?? 'invalid'
      continue
    }
    const v = parsed.data as string
    const mode = AUTOSAVE_CLEAN[name]
    set[name] = mode === 'handle' ? handle(v) : mode === 'money' ? money(v) : text(v)
  }

  // A checkbox absent from the body is unchecked, but only if the caller was
  // sending checkboxes at all — otherwise every partial save would silently clear
  // every flag. The client posts the whole form, so `_flags` says so explicitly
  // rather than being inferred from what happens to be present.
  if (body._flags === '1') {
    for (const name of AUTOSAVE_FLAGS) set[name] = body[name] === 'on' || body[name] === 'true'
  }

  // displayName is the one required field, and an empty one is a rider mid-edit
  // rather than an error worth writing. Refusing to store it is right; reporting
  // it as a failure while they are still typing is not.
  if ('displayName' in set && !set.displayName) {
    delete set.displayName
    errors.displayName = 'display name is required'
  }

  if (Object.keys(set).length === 0) {
    return c.json({ ok: Object.keys(errors).length === 0, saved: [], errors }, 200)
  }

  // displayName lives on `users`, not on `user_profiles`, so it is lifted out.
  const displayName = set.displayName as string | undefined
  delete set.displayName

  await db.transaction(async (tx) => {
    if (displayName) {
      await tx.update(users).set({ displayName, updatedAt: new Date() }).where(eq(users.id, user.id))
    }
    if (Object.keys(set).length > 0) {
      const values = { ...set, updatedAt: new Date() }
      // THE FOURTH UPSERT, AND IT CARRIES THE SAME OBLIGATION AS THE OTHER THREE.
      // Profile rows are created lazily, so this is often where a rider's first
      // row appears — and the column default would stamp 'en-US' over whatever
      // Accept-Language had been giving them. Seeded on INSERT, absent from the
      // update set. See the note in src/routes/settings.tsx.
      await tx
        .insert(userProfiles)
        .values({
          userId: user.id,
          ...values,
          dateFormat: fromAcceptLanguage(c.req.header('Accept-Language')),
        })
        .onConflictDoUpdate({ target: userProfiles.userId, set: values })
    }
  })

  return c.json({
    ok: Object.keys(errors).length === 0,
    saved: [...(displayName ? ['displayName'] : []), ...Object.keys(set)],
    errors,
  })
})

// --- Avatar (#99) ------------------------------------------------------------
//
// `users.avatar_url` exists but is WRITE-ONCE FROM GOOGLE SIGN-IN, so a
// magic-link rider has never had one and never could. This is the upload.
//
// **THE FIRST USER-SUPPLIED BINARY THIS APP SERVES PUBLICLY**, and that is what
// makes it a different risk profile from a stored ride original — the nav
// renders it on every page, to anyone. The rules, all of them enforced here and
// not by the browser:
//
//   RASTER ONLY, NEVER SVG. An SVG can carry script and would be stored XSS from
//   this origin. `checkUpload` sniffs the magic number and accepts only JPEG and
//   PNG, so an SVG is refused whatever it is named or what Content-Type it
//   claims. This is a security boundary, not a format preference.
//
//   RE-ENCODED ALWAYS. The client-side crop is convenience; browser output is
//   attacker-controlled, so the server decodes, orients, crops, resizes and
//   re-encodes to WebP regardless of what arrived.
//
//   EXIF STRIPPED, which sharp does by default and processAvatar() documents.
//   A phone photo carries GPS and an avatar should not publish where it was
//   taken.
//
//   SERVED THROUGH A ROUTE, never a static path. src/maps/storage.ts writes
//   outside the web root deliberately and avatars live in the same place.
profileRoutes.post(
  '/api/profile/avatar',
  requireActiveApi,
  requireSameOrigin,
  // TWO LIMITS AND THEY ARE NOT THE SAME LIMIT, exactly as the bike photo route
  // says: bodyLimit refuses an oversized REQUEST before Hono buffers it,
  // checkUpload refuses an oversized FILE. The body allowance is larger because
  // the multipart framing and the three crop fields ride along with it.
  bodyLimit({ maxSize: MAX_IMAGE_BYTES * 2, onError: (c) => c.json({ error: 'That image is too large.' }, 413) }),
  async (c) => {
    const user = currentUser(c)
    const body = await c.req.parseBody().catch(() => null)
    const file = body?.avatar
    if (!(file instanceof File)) return c.json({ error: 'No image was sent.' }, 400)

    const raw = new Uint8Array(await file.arrayBuffer())
    const check = checkUpload(raw)
    if (!check.ok) return c.json({ error: UPLOAD_REFUSAL_MESSAGES[check.reason] }, 400)

    // A HINT, NOT AN INSTRUCTION. clampCrop puts it inside the image whatever
    // arrives, because these are three numbers from a multipart body and a
    // hand-crafted one can say anything — see test/avatar.test.ts.
    const num = (v: unknown) => (typeof v === 'string' ? Number(v) : NaN)
    const crop =
      'cropSize' in (body ?? {}) ? { x: num(body?.cropX), y: num(body?.cropY), size: num(body?.cropSize) } : null

    let processed
    try {
      processed = await processAvatar(Buffer.from(raw), crop)
    } catch {
      // Sniffed as a JPEG and will not decode: corrupt, or deliberately
      // malformed. Either way a refusal rather than a 500.
      return c.json({ error: 'That image could not be read.' }, 400)
    }

    // File first, row second, matching the bike photo: a row pointing at an
    // avatar that was never written renders broken, where a file with no row is
    // invisible and swept up by the account purge.
    await writeAvatar(user.id, processed.data)
    const values = { avatarBytes: processed.data.length, updatedAt: new Date() }
    await db
      .insert(userProfiles)
      .values({
        userId: user.id,
        ...values,
        // The fifth upsert, same obligation as the other four. See settings.tsx.
        dateFormat: fromAcceptLanguage(c.req.header('Accept-Language')),
      })
      .onConflictDoUpdate({ target: userProfiles.userId, set: values })

    // The hash is the cache-buster in the URL, so a new picture is a new URL and
    // the route can serve it immutable.
    return c.json({ ok: true, url: `/profile/avatar/${user.id}?v=${processed.hash}` })
  },
)

/**
 * Remove the uploaded avatar and fall back.
 *
 * FALL BACK, NOT GO BLANK. `users.avatar_url` may still hold the picture Google
 * gave them at sign-in, and clearing the upload should reveal it again rather
 * than replace one picture with initials. `avatar_bytes = 0` is what says "no
 * upload", which is why it is the flag as well as the size.
 */
profileRoutes.delete('/api/profile/avatar', requireActiveApi, requireSameOrigin, async (c) => {
  const user = currentUser(c)
  await deleteAvatar(user.id)
  await db.update(userProfiles).set({ avatarBytes: 0, updatedAt: new Date() }).where(eq(userProfiles.userId, user.id))
  return c.json({ ok: true })
})

/**
 * Serving it.
 *
 * PUBLIC, unlike the bike photo's owner-only gate, and deliberately: this is
 * rendered in the nav and beside a rider's name on a roster, an explore card and
 * a public profile. A gate here would mean those surfaces could not show it,
 * which is the entire feature.
 *
 * What that costs is one fact — that a given rider id has an avatar — which is
 * already visible to anyone who can see the rider at all. It is NOT a way to
 * enumerate accounts: an id with no avatar 404s exactly like an id that does not
 * exist, which is the same answer /@handle gives for a pending or blocked
 * account.
 *
 * IMMUTABLE, because the hash is in the query string. A new picture is a new URL,
 * so a year is safe and a rider never sees a stale face.
 */
profileRoutes.get('/profile/avatar/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return c.notFound()
  const data = await readAvatar(id)
  if (!data) return c.notFound()
  // `new Response(new Uint8Array(...))` rather than `c.body(buffer)`, matching
  // the bike photo route — a Node Buffer's ArrayBufferLike does not satisfy the
  // BodyInit overload and the error it produces names SharedArrayBuffer, which
  // is not a clue anybody wants twice.
  return new Response(new Uint8Array(data), {
    headers: {
      'Content-Type': PROCESSED_MIME,
      // IMMUTABLE ONLY WITH THE HASH IN THE URL. Without `?v=` this is a plain
      // /profile/avatar/7, which is a stable URL whose CONTENT changes the next
      // time the rider uploads — caching that for a year would show a stale face
      // until the browser was cleared. Five minutes is the honest answer there.
      'Cache-Control': c.req.query('v') ? 'public, max-age=31536000, immutable' : 'public, max-age=300',
      // The bytes are ours — decoded and re-encoded by sharp — but this is a
      // user-supplied picture served from the app's own origin, so the sniffing
      // opt-out costs nothing and closes the question.
      'X-Content-Type-Options': 'nosniff',
    },
  })
})
