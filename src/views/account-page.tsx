// Settings and Profile as ONE page with two tabs (#269).
//
// They were two pages and two account-menu items, and the split did not answer a
// question a rider was asking: both are "the things about me I can change", so
// somebody looking for one had to already know which page it had been filed on.
// Ziad's call, 2026-09-07.
//
// **THE PRECEDENT IS `/riders` AND `/friends`, AND THIS FOLLOWS IT EXACTLY.**
// Two URLs, one page, each opening its own tab — `/profile` is not redirected,
// because it is linked from the account menu and from bookmarks, and a redirect
// would put a hop in front of a page the rider already had. Both set
// `navKey: 'settings'`, and the `profile` NavKey is gone under the rule already
// on that union: a key no NavItem carries is an `aria-current` that is wired and
// can never fire.
//
// **THIS FILE COMPOSES; IT DOES NOT IMPORT EITHER ROUTE MODULE.** The profile
// panel arrives as an already-rendered string, which is what keeps the imports
// one-directional — `settings.tsx` and `profile.tsx` both import this, and this
// imports neither. Rendering both here would need it to import profile.tsx while
// profile.tsx imports it, and an ES module cycle that happens to work because
// every binding is called at request time is a cycle waiting to stop working.
//
// **BOTH PANELS ARE IN THE DOM, HIDDEN WITH `hidden`.** That is what tabs.js
// requires — it swaps the attribute client-side with no round trip — and what
// find-in-page and assistive tech both read. It also means the profile's forms
// are present and submittable from either tab, which is correct: a rider who
// switches tabs has not navigated anywhere.
import type { Context } from 'hono'
import { raw } from 'hono/html'
import { currentUser, type AuthEnv } from '../auth/middleware'
import { eq } from 'drizzle-orm'
import { db } from '../db/index'
import { userProfiles } from '../db/schema'
import { DELETION_HOLD_DAYS } from '../account/policy'
import { DURATION_FORMAT_CHOICES, toDurationFormat } from '../maps/duration'
import { DATE_FORMAT_CHOICES } from './date-format'
import { CLOCK_CHOICES, resolveClock, toClock } from './clock'
import { VOLUME_CHOICES, toVolumeUnits } from './volume'
import { MOTION_CHOICES, toMotion } from './motion'
import { UNITS_CHOICES, toUnits } from './units'
import { TIPS_CHOICES, toTips } from './tips'
import { SCHEME_CHOICES, THEME_CHOICES } from './appearance'
import { GROUPS, eventsInGroup } from '../notifications/catalog'
import { channelsFor } from '../notifications/policy'
import { prefsOf } from '../notifications/service'
import { dateFormatFor } from './prefs'
import { fieldHelp, page } from './layout'
import { tourAssets } from './tour-assets'
import { asset } from './assets'

export type AccountTab = 'preferences' | 'profile'

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
      clock: userProfiles.clock,
      volumeUnits: userProfiles.volumeUnits,
      tips: userProfiles.tips,
      hideTour: userProfiles.hideTour,
      avoidPlaces: userProfiles.avoidPlaces,
      favorPlaces: userProfiles.favorPlaces,
    })
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId))
    .limit(1)
  return {
    durationFormat: toDurationFormat(p?.durationFormat),
    units: toUnits(p?.units),
    motion: toMotion(p?.motion),
    clock: toClock(p?.clock),
    volumeUnits: toVolumeUnits(p?.volumeUnits),
    tips: toTips(p?.tips),
    hideTour: p?.hideTour ?? false,
    avoidPlaces: p?.avoidPlaces ?? '',
    favorPlaces: p?.favorPlaces ?? '',
  }
}

/**
 * The whole page, with one of its two tabs open.
 *
 * `profile` is the rendered Profile panel, `scripts` what it needs loaded. Both
 * come from profile.tsx, which owns that form's validation and its error
 * re-render — this file only decides where it sits.
 */
export async function accountPage(
  c: Context<AuthEnv>,
  opts: { tab: AccountTab; profile: string; scripts?: string },
): Promise<string> {
  const user = currentUser(c)
  const savedQuery = c.req.query('saved')
  // THE BARE `?saved` IS SAVE ME, and every named one is a form on this page. The
  // list has to grow with the forms: a value missing from it falls through to
  // `saved` and renders the account-restored banner instead of a Saved chip,
  // which is a wrong and rather alarming answer to "I changed my units".
  //
  // `1` IS ON IT BECAUSE THE PROFILE FORM REDIRECTS TO `?saved=1` and always
  // has. Merging the pages merged the query string with it, and leaving it off
  // told every rider who saved their profile that their account was no longer
  // scheduled for deletion.
  const FORM_SAVED = [
    'duration',
    'dates',
    'appearance',
    'units',
    'clock',
    'volume',
    'avoid',
    'favor',
    'tips',
    'tour-button',
    // One per notification group, DERIVED rather than typed: five hand-written
    // strings is five chances to add a group and forget one, and the symptom of
    // forgetting is a rider being told their account is no longer scheduled for
    // deletion because they ticked a checkbox.
    ...GROUPS.map((g) => `notify-${g.id}`),
    '1',
  ]
  const restored = savedQuery !== undefined && !FORM_SAVED.includes(savedQuery)
  const on = (name: string) => savedQuery === name
  const { durationFormat, units, motion, clock, volumeUnits, avoidPlaces, favorPlaces, tips, hideTour } = await prefsFor(
    user.id,
  )
  const dateFormat = await dateFormatFor(c)
  // ONE QUERY FOR ALL THIRTEEN EVENTS ACROSS BOTH CHANNELS, like prefsFor above
  // and for the same reason: they are rows of one table for one rider, and this
  // page renders every one of them at once.
  const notifPrefs = await prefsOf(user.id)
  // `locale` is stored and not offered — see resolveClock in views/clock.ts.
  const resolvedClock = resolveClock(clock, dateFormat)
  // Straight off the session rather than a second query — validateSessionToken
  // already left-joins user_profiles for exactly this, and the values are
  // coerced there so there is no null to interpret here.
  const theme = user.theme
  const scheme = user.scheme

  const tabOn = (t: AccountTab) => opts.tab === t

  // THE CHIP IS THE NO-SCRIPT PATH NOW. With autosave running, the border on the
  // group says dirty/saving/saved and this never renders — a `?saved=` query only
  // comes back from a real form POST, which happens with script off or after an
  // autosave failure has handed the button back. Kept for those two cases rather
  // than deleted.
  const Saved = ({ when }: { when: boolean }) => (when ? <span class="form-ok">Saved</span> : <></>)

  const body = (
    <>
      {/* THE HEADING FOLLOWS THE DOOR, like the title and the nav key (#269). A
          rider who pressed "Your profile" and landed on a page headed Settings
          has been told they went somewhere else — which is the confusion the
          merge exists to remove, arriving from the other side. The tab strip
          under it says which of the two they are on either way.

          The panel's own heading went with this: the tab, the H1 and a third
          "Your profile" inside the panel is the same words three times. */}
      {tabOn('profile') ? (
        <>
          <h1>Your profile</h1>
          <p class="lede">
            Who you are, where you set off from, and what you ride. Your preferences are on the tab beside&nbsp;this.
          </p>
        </>
      ) : (
        <>
          <h1>Settings</h1>
          <p class="lede">How the app looks, how it writes things down, and everything it knows about&nbsp;you.</p>
        </>
      )}

      {restored ? (
        <p class="form-ok">
          Welcome back. Your account is no longer scheduled for deletion, and everything is exactly where you left it.
        </p>
      ) : null}

      <div class="page-tabs" role="tablist" aria-label="Settings" data-tabs>
        <button
          type="button"
          class={`page-tab${tabOn('preferences') ? ' is-active' : ''}`}
          role="tab"
          id="tab-preferences"
          aria-controls="panel-preferences"
          aria-selected={tabOn('preferences') ? 'true' : 'false'}
          tabindex={tabOn('preferences') ? undefined : -1}
        >
          Preferences
        </button>
        <button
          type="button"
          class={`page-tab${tabOn('profile') ? ' is-active' : ''}`}
          role="tab"
          id="tab-profile"
          aria-controls="panel-profile"
          aria-selected={tabOn('profile') ? 'true' : 'false'}
          tabindex={tabOn('profile') ? undefined : -1}
        >
          Profile
        </button>
      </div>

      <div
        class="page-tabpanel"
        id="panel-preferences"
        role="tabpanel"
        aria-labelledby="tab-preferences"
        hidden={!tabOn('preferences')}
      >
        {/*
          SHOW ME AROUND IS FIRST, AND ITS OWN TOPIC (#133).

          First because it is the one preference here that exists for somebody
          who has never used the app: everything below answers "how do you want
          this written", which presumes a rider who already knows what the
          controls are. This one is what tells them.

          ITS OWN TOPIC RATHER THAN A FOURTH APPEARANCE AXIS, although it very
          nearly fits — appearance is one form and one handler on the stated
          reasoning that a rider has ONE appearance and would be surprised if
          saving the palette reverted the light/dark choice made in the same
          breath. That argument is about three answers to one question, and this
          is a different question: whether the app talks to you is not how it
          looks. Folding it in would also mean folding it into that handler,
          which is the thing the per-column split exists to prevent.

          A ONE-SETTING TOPIC IS NOT THE THING `reports` WAS. That notification
          group was folded into `account` because it rendered as a heading, two
          column labels and a single row — furniture around nothing. This is a
          heading, a lede that explains a feature, and the control. The section
          is complete; it is just short.
        */}
        <section class="setting-topic" id="tips">
          <h2>Show me around</h2>
          <p>
            Two things, for somebody new. The tour walks you through the builder once, step by step, and waits while you
            build a real route. The tips are what stay behind it: point at anything and get a sentence on what it is for
            and why you would touch it. Both are on to start with, and neither turns itself&nbsp;off.
          </p>

          {/*
            THE TOUR IS A LINK, NOT A FORM. There is nothing to store from here —
            it runs on the builder, and finishing or skipping it is what writes
            `tour_done_at`, from the builder, through its own endpoint. This is
            the same `/builder?tour` the account menu carries, so a rider has two
            doors to one room and both open the same one.
          */}
          <p class="setting-actions">
            <a class="btn" href="/builder?tour" data-tour-start>
              Take the tour
            </a>
          </p>

          {/*
            ONE FIELDSET IN THE THREE-COLUMN GRID, which is what keeps it to a
            third of the page rather than letting two radios run the full width
            of a desktop window. The grid is the page's rhythm and a lone cell
            still sits on it; a full-bleed choice set does not, and reads as a
            different kind of control from the five below.
          */}
          <form method="post" action="/settings/tips" class="setting-form" data-autosave>
            <div class="three-col">
              <fieldset class="choice-set">
                <legend class="visually-hidden">Show me around</legend>
                {TIPS_CHOICES.map((choice) => (
                  <label class="choice">
                    <input type="radio" name="tips" value={choice.id} checked={choice.id === tips} />
                    <span class="choice-label">{choice.label}</span>
                    <span class="choice-example">{choice.example}</span>
                  </label>
                ))}
              </fieldset>
            </div>
            <div class="setting-actions">
              <button type="submit" class="btn btn-sign arrow-right arrow-n" data-js-hide>
                Save
              </button>
              <Saved when={on('tips')} />
            </div>
          </form>

          {/*
            THE HEADER'S SIGN HAS A SWITCH, AND IT IS ITS OWN FORM. Ziad's call,
            2026-09-11. The sign sits beside the account chip on every page,
            builder included, which a rider who has taken the tour twice does
            not need to keep seeing; the account menu's own item stays, so this
            hides an affordance and never the feature. Its own handler and its
            own column, like every form on this page, so saving it cannot
            revert the radios above.

            A HIDDEN `present` FIELD, because an unticked checkbox sends
            nothing and the handler has to tell "unticked" from "not this
            form" — the same shape the notification forms carry as `group`.
          */}
          <form method="post" action="/settings/tour-button" class="setting-form" data-autosave>
            <input type="hidden" name="present" value="1" />
            <label class="check">
              <input type="checkbox" name="hideTour" checked={hideTour} />
              <span>Hide the Take the tour button in the header</span>
            </label>
            <div class="setting-actions">
              <button type="submit" class="btn btn-sign arrow-right arrow-n" data-js-hide>
                Save
              </button>
              <Saved when={on('tour-button')} />
            </div>
          </form>
        </section>

        {/*
          TWO TOPICS, NOT FOUR PEERS (#178) — THREE SINCE #133, and the count in
          this note is what changed rather than its reasoning. Appearance is one
          topic and Units is the other, and the copy is what said so: the duration and date settings
          each promise, in nearly the same words, that they change the WRITING
          and not the number. Two settings making the same promise are one topic.

          THE OLD PAGE'S GAPS WERE THE GRID, NOT THE SPACING. Four `.setting`
          blocks sat in a fixed two-column `.two-col` with `align-items: start`,
          so every cell kept its own height and the shorter column simply ended
          early. Every control here is a short radio group, so a topic is a ROW
          OF THREE and `.three-col` wraps the rest onto a second row of its own.

          GTFO stays outside both topics: it is a boxed-off danger area and half
          a page is not where it belongs.
        */}
        <section class="setting-topic" id="appearance">
          <h2>Appearance</h2>
          <p>
            How the app looks, and how much it moves. The palette decides which colors it uses, light or dark decides
            how bright it is, and every palette comes in&nbsp;both.
          </p>

          {/*
            THE PALETTE ITSELF, UNDER THE LEDE AND ABOVE THE CONTROLS. Ziad's
            call, 2026-09-07 — it sat above the Save row inside the form, which
            put the thing being changed BELOW the controls that change it, so a
            rider picking a palette was looking at the wrong half of the section.
            It reads as an illustration of the sentence above it now, which is
            what it is.

            OUTSIDE THE FORM, which it can be because it carries no input — nine
            `aria-hidden` swatches and nothing to post. Keeping it inside would
            have meant a decoration sitting in the middle of a form for no reason
            beyond where it started.

            NO JAVASCRIPT AT ALL. Every swatch is a `var()`, and the palettes are
            one stylesheet keyed on the attributes restamp() writes — so the bar
            changes with the choice for free, and it cannot disagree with what
            the app is actually painting, because it IS what the app is painting.

            THE SIGN FIELDS, IN SIGNAL ORDER, because those are the colors a
            rider meets: red on a road they cannot ride, amber on advice, green
            on a guide sign. The neutrals are left out — a strip of greys says
            nothing about which palette is on.

            `aria-hidden`, and the radio labels are what carry the meaning. Nine
            unlabelled swatches announce as nothing useful, and each option
            already says what it is in words.
          */}
          <p class="palette-bar" aria-hidden="true">
            {['stop', 'detour', 'warning', 'yield', 'go', 'interstate', 'disabled', 'recreation', 'tarmac'].map(
              (token) => (
                <span class="palette-chip" style={`background: var(--${token})`}></span>
              ),
            )}
          </p>

          {/*
            ONE FORM FOR ALL THREE AXES, which is what the appearance handler
            already did for two. A rider has ONE appearance and would be
            surprised if saving the palette reverted the light/dark choice they
            made in the same breath; motion is the same kind of answer to the
            same question and joins them rather than getting a fourth endpoint.

  THERE IS A LIVE PREVIEW NOW, AND THAT REVERSES THE NOTE THAT WAS HERE.
            It read: no live preview, deliberately, because "a preview would need
            script this page does not otherwise want, and the choice applies on
            save". Both halves stopped being true on 2026-09-07 — the page
            autosaves and re-stamps <html>, so the whole page IS the preview and
            the palette bar above is the part of it a rider can point at.
          */}
          <form method="post" action="/settings/appearance" class="setting-form" data-autosave>
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
                `prefers-reduced-motion` is already honored in six SCSS blocks
                and four client files, so a rider with the OS toggle on already
                gets a still page — what was missing is the control for someone
                who wants motion off HERE, or who does not know the OS setting
                exists.
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
              <button type="submit" class="btn btn-sign arrow-right arrow-n" data-js-hide>
                Save
              </button>
              <Saved when={on('appearance')} />
            </div>
          </form>
        </section>

        {/*
          "UNITS", NOT "HOW THINGS READ" (#270). Ziad's call, 2026-09-07: the
          old heading described none of the three settings under it, and it is
          the kind of heading that reads well in a design and is unsearchable in
          use. Units is the word a rider goes looking for.

          The id stays `how-things-read` for one release, because the four
          handlers redirect to `#units`, `#dates`, `#stop-durations` and so on —
          the section id is what a bookmark or an old redirect lands on, and a
          renamed anchor is a scroll that silently does nothing.
        */}
        <section class="setting-topic" id="how-things-read">
          <h2>Units</h2>
          <p>
            Choices about writing rather than about data. Every one of them changes how a figure is printed and none of
            them changes the figure — your rides, the roadbook and every export are unaffected, and you can switch back
            whenever you&nbsp;like.
          </p>

          <div class="three-col">
            {/*
              A FORM EACH, NOT ONE, and the split is deliberate rather than left
              over. Unlike the appearance axes these are unrelated questions with
              unrelated answers, and each handler writes only its own column — so
              saving one cannot revert another. See the note on the handlers in
              routes/settings.tsx.
            */}
            <section class="setting" id="units">
              <h3>Distances</h3>
              <form method="post" action="/settings/units" class="setting-form" data-autosave>
                <fieldset class="choice-set">
                  <legend class="visually-hidden">Units</legend>
                  {UNITS_CHOICES.map((choice) => (
                    <label class="choice">
                      <input type="radio" name="units" value={choice.id} checked={choice.id === units} />
                      <span class="choice-label">{choice.label}</span>
                      {/* The SAME road in both, which is the question being
                        asked. Twistiness comes along with the distance: degrees
                        per kilometer is a smaller number than degrees per mile. */}
                      <span class="choice-example">
                        reads <b>{choice.example}</b>
                      </span>
                    </label>
                  ))}
                </fieldset>
                <div class="setting-actions">
                  <button type="submit" class="btn btn-sign arrow-right arrow-n" data-js-hide>
                    Save
                  </button>
                  <Saved when={on('units')} />
                </div>
              </form>
            </section>

            <section class="setting" id="dates">
              <h3>Dates</h3>
              <form method="post" action="/settings/date-format" class="setting-form" data-autosave>
                <fieldset class="choice-set">
                  <legend class="visually-hidden">Date format</legend>
                  {DATE_FORMAT_CHOICES.map((choice) => (
                    <label class="choice">
                      <input type="radio" name="dateFormat" value={choice.id} checked={choice.id === dateFormat} />
                      <span class="choice-label">{choice.label}</span>
                      <span class="choice-example">
                        reads <b>{choice.example}</b>
                      </span>
                    </label>
                  ))}
                </fieldset>
                <div class="setting-actions">
                  <button type="submit" class="btn btn-sign arrow-right arrow-n" data-js-hide>
                    Save
                  </button>
                  <Saved when={on('dates')} />
                </div>
              </form>
            </section>

            {/*
              THE CLOCK IS ITS OWN CONTROL NOW, AND THAT REVERSES A RECORDED
              CALL (#270). Ziad's call, 2026-09-07. The date format stores real
              locale tags precisely so Intl decides digit order, padding and the
              clock together — which left an American who wants 24-hour time no
              way to get one except `en-GB`, and 24/08/2026 with it. The override
              is `hour12` alone; see src/views/clock.ts for how narrow it is.
            */}
            <section class="setting" id="clock">
              <h3>Clock</h3>
              <form method="post" action="/settings/clock" class="setting-form" data-autosave>
                <fieldset class="choice-set">
                  <legend class="visually-hidden">Clock</legend>
                  {CLOCK_CHOICES.map((choice) => (
                    <label class="choice">
                      {/* CHECKED AGAINST THE RESOLVED VALUE, not the stored one.
                          Every rider who has never touched this carries `locale`,
                          which is no longer offered — so without resolving, none
                          of the two would be selected and the control would look
                          broken on the page most riders open first. */}
                      <input type="radio" name="clock" value={choice.id} checked={choice.id === resolvedClock} />
                      <span class="choice-label">{choice.label}</span>
                      <span class="choice-example">
                        reads <b>{choice.example}</b>
                      </span>
                    </label>
                  ))}
                </fieldset>
                <div class="setting-actions">
                  <button type="submit" class="btn btn-sign arrow-right arrow-n" data-js-hide>
                    Save
                  </button>
                  <Saved when={on('clock')} />
                </div>
              </form>
            </section>

            <section class="setting" id="stop-durations">
              <h3>Stop durations</h3>
              <form method="post" action="/settings/duration-format" class="setting-form" data-autosave>
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
                  <button type="submit" class="btn btn-sign arrow-right arrow-n" data-js-hide>
                    Save
                  </button>
                  <Saved when={on('duration')} />
                </div>
              </form>
            </section>

            {/*
              FUEL VOLUME, AND IT HAS SOMEWHERE TO PRINT AS OF THIS CHANGE
              (#270). It arrived with a surface rather than ahead of one: nothing
              in the app rendered a volume until `bikes.tank_ml` landed beside
              it, and a preference that prints nowhere is a control that does
              nothing. The Paddock's Tank field is what reads it.
            */}
            <section class="setting" id="volume">
              <h3>Fuel volume</h3>
              <form method="post" action="/settings/volume" class="setting-form" data-autosave>
                <fieldset class="choice-set">
                  <legend class="visually-hidden">Fuel volume</legend>
                  {VOLUME_CHOICES.map((choice) => (
                    <label class="choice">
                      <input type="radio" name="volumeUnits" value={choice.id} checked={choice.id === volumeUnits} />
                      <span class="choice-label">{choice.label}</span>
                      <span class="choice-example">{choice.example}</span>
                    </label>
                  ))}
                </fieldset>
                <div class="setting-actions">
                  <button type="submit" class="btn btn-sign arrow-right arrow-n" data-js-hide>
                    Save
                  </button>
                  <Saved when={on('volume')} />
                </div>
              </form>
            </section>
          </div>
        </section>

        {/*
          PLACES TO AVOID (#271). Its own topic rather than a fourth cell in the
          grid above: everything in Units is a radio group about how a figure is
          WRITTEN, and this is free text that changes what a search ANSWERS.
        */}
        {/*
          TWO LISTS, 50/50, AND THEY ARE TWO GROUPS RATHER THAN ONE. Ziad's call,
          2026-09-07. A single field with a leading `-` or `+` would be one box
          and a syntax to learn; the point of these is that a rider types "ARCO,
          Costco Gas" the way they would say it, so two boxes ask two plain
          questions. It also means each saves on its own — the autosave posts
          whichever group changed, and the border says which.
        */}
        <section class="setting-topic" id="places">
          <h2>Places and brands</h2>
          <p>
            Somewhere you always head for, or would rather not stop at? Name it and every place search puts it where you
            want it — the gas chips, the category searches, the search along a route. <b>Nothing is added or hidden</b>:
            the one time you are out of fuel with a station in front of you is the time this must not have taken
            it&nbsp;away.
          </p>

          <div class="two-col">
            <section class="setting" id="avoid">
              <h3>Places and brands to avoid</h3>
              <form method="post" action="/settings/avoid" class="setting-form" data-autosave>
                <p class="field">
                  <span class="label-row">
                    <label for="f-avoid">One per line, or separated by commas</label>
                    {raw(
                      fieldHelp(
                        'avoid',
                        'what to put in your avoid list',
                        'A brand or a kind of place, either works — ARCO, Costco Gas, fast food. Matched loosely against the name, so short words catch more than you mean.',
                      ),
                    )}
                  </span>
                  <textarea id="f-avoid" name="avoidPlaces" rows={4} maxlength={1000}>
                    {avoidPlaces}
                  </textarea>
                </p>
                <div class="setting-actions">
                  <button type="submit" class="btn btn-sign arrow-right arrow-n" data-js-hide>
                    Save
                  </button>
                  <Saved when={on('avoid')} />
                </div>
              </form>
            </section>

            <section class="setting" id="favor">
              <h3>Places and brands to favor</h3>
              <form method="post" action="/settings/favor" class="setting-form" data-autosave>
                <p class="field">
                  <span class="label-row">
                    <label for="f-favor">One per line, or separated by commas</label>
                    {raw(
                      fieldHelp(
                        'favor',
                        'what to put in your favor list',
                        'A brand or a kind of place, either works — Shell, In-N-Out, diner. Matched loosely against the name, so short words catch more than you mean.',
                      ),
                    )}
                  </span>
                  <textarea id="f-favor" name="favorPlaces" rows={4} maxlength={1000}>
                    {favorPlaces}
                  </textarea>
                </p>
                <div class="setting-actions">
                  <button type="submit" class="btn btn-sign arrow-right arrow-n" data-js-hide>
                    Save
                  </button>
                  <Saved when={on('favor')} />
                </div>
              </form>
            </section>
          </div>
        </section>

        {/*
          NOTIFICATIONS. Email on, browser off — Ziad's call, 2026-09-07 — and
          the DEFAULT LIVES IN CODE rather than in a column, so a rider who has
          never touched this page has no rows at all and every box below is drawn
          from src/notifications/policy.ts. See that file for why.

          **THE BROWSER COLUMN IS A REQUEST, NOT A GUARANTEE.** Chrome raises
          nothing until the rider grants permission, and it only fires while a
          Routeloop tab is open — this is the browser's own notification rather
          than a push, so there is no service worker and nothing arrives with the
          site closed. Ticking a box says what they want; the line under the
          heading says what that can actually deliver, because a control that
          quietly does nothing is worse than no control at all.

          **ONE FORM PER GROUP AND NOT ONE PER EVENT.** The autosave posts the
          form the change happened in, so a form per event would be thirteen
          round trips for a rider going down the list — and one form for all of
          them would make every save rewrite every answer, which is a race
          between two open tabs. A group is the unit a rider thinks in anyway.
        */}
        <section class="setting-topic" id="notifications">
          <h2>Notifications</h2>
          <p>
            What we tell you about, and where. <b>Email is on to start with and the browser is off</b> — a browser
            notification needs Chrome’s permission and only appears while you have Routeloop open in a tab, so it is a
            nudge while you are here rather than a way to be reached when you are&nbsp;not.
          </p>
          <p class="notif-permission" data-notif-permission hidden>
            <button type="button" class="btn btn-sign arrow-right arrow-n" data-notif-ask>
              Allow browser notifications
            </button>
            <span class="notif-permission-state" data-notif-state></span>
          </p>

          {/* TWO COLUMNS, NOT A STACK. Five groups laid out one under another
              made the longest section on the page by a distance — Ziad's call,
              2026-09-07 — and every one of them is a narrow table, so half the
              width costs them nothing. `align-items: start` is what lets the
              one-row Reports group sit beside a four-row one without stretching. */}
          <div class="two-col two-col--equal">
            {GROUPS.map((group) => (
              <section class="setting" id={`notify-${group.id}`}>
                {/* `--boxed` paints the resting border that every .setting-form
                    already reserves but leaves transparent. The save states
                    still win on specificity, so the edge goes gray → amber →
                    green → gray rather than appearing out of nothing. */}
                <form
                  method="post"
                  action="/settings/notifications"
                  class="setting-form setting-form--boxed"
                  data-autosave
                >
                  {/* WITHOUT THIS THE FORM CANNOT SAY WHAT IT WAS SHOWING. An
                      unticked checkbox sends nothing, so the body alone cannot
                      tell "off" from "not on this form" — and saving one group
                      would switch off the other four. See rowsFromForm. */}
                  <input type="hidden" name="group" value={group.id} />
                  <table class="notif-table">
                    <thead>
                      <tr>
                        {/* THE GROUP NAME IS THE FIRST COLUMN'S HEADER, which
                            is what puts it inside the box and on the same
                            baseline as Email and Browser — Ziad's call,
                            2026-09-07. It was an <h3> above the form, so every
                            group cost a heading row plus the gap under it, and
                            the box opened on a border with nothing in it.

                            It is genuinely that column's header as well as the
                            name of the set: the rows under it are the things
                            that happen, and "People" labels them. A screen
                            reader announcing the column now says the group,
                            which is more use than the "What happens" it
                            replaces — and it is still an <h3>, so heading
                            navigation still lands on every group. */}
                        <th scope="col">
                          <h3>{group.label}</h3>
                        </th>
                        <th scope="col">Email</th>
                        <th scope="col">Browser</th>
                      </tr>
                    </thead>
                    <tbody>
                      {eventsInGroup(group.id).map((e) => {
                        const want = channelsFor(notifPrefs, e.key)
                        return (
                          <tr>
                            <th scope="row">
                              <span class="label-row">
                                <span class="notif-label">{e.label}</span>
                                {/* THE EXPLANATION IS A `?` AND NOT A SECOND
                                    LINE, which is the rule already written down
                                    for this: instructions for ONE field go in a
                                    bubble, and a disclosure that must be read
                                    before acting stays visible. Every one of
                                    these says who triggers the event and when —
                                    useful, and not something a rider needs in
                                    front of them to tick a box. As two lines it
                                    doubled the height of all thirteen rows. */}
                                {raw(fieldHelp(`n-${e.key}`, e.label, e.detail))}
                              </span>
                            </th>
                            {/* The checkbox name IS the "<event>:<channel>" key
                                the policy reads, so neither side has to parse a
                                naming scheme of its own. */}
                            <td>
                              <label class="notif-box">
                                <input type="checkbox" name={`${e.key}:email`} checked={want.email} />
                                <span class="visually-hidden">Email me when {e.label.toLowerCase()}</span>
                              </label>
                            </td>
                            <td>
                              <label class="notif-box">
                                <input type="checkbox" name={`${e.key}:browser`} checked={want.browser} />
                                <span class="visually-hidden">
                                  Show a browser notification when {e.label.toLowerCase()}
                                </span>
                              </label>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                  <div class="setting-actions">
                    <button type="submit" class="btn btn-sign arrow-right arrow-n" data-js-hide>
                      Save
                    </button>
                    <Saved when={on(`notify-${group.id}`)} />
                  </div>
                </form>
              </section>
            ))}
          </div>

          <p class="setting-note">
            Signing in, joining the waitlist, and being let in are not on this list and cannot be switched off. They are
            how you get into your account, and an account you cannot get into is not a preference we are willing
            to&nbsp;offer.
          </p>
        </section>

        <section class="gtfo">
          <h2>GTFO</h2>
          <p class="lede">Your account is yours. Take it with you, or take it away.</p>

          <div class="gtfo-item">
            <div>
              <h3>Download Me</h3>
              <p>
                Everything the app holds about you, in one zip: your profile, and every ride in all five formats plus
                the original files you uploaded. The <code>.routeloop.json</code> in each ride folder is the lossless
                one.
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
                nothing was ever lost — you will find it waiting on the page you land on when you sign&nbsp;in.
              </p>
            </div>
            <span class="gtfo-note">Nothing to restore</span>
          </div>
        </section>
      </div>

      <div
        class="page-tabpanel"
        id="panel-profile"
        role="tabpanel"
        aria-labelledby="tab-profile"
        hidden={!tabOn('profile')}
      >
        {/* Rendered by profile.tsx, which owns this form's validation and its
            error re-render. Raw because it is already a string of markup this
            application produced — the same arrangement views/content.ts uses. */}
        {raw(opts.profile)}
      </div>
    </>
  ).toString()

  return page({
    title: opts.tab === 'profile' ? 'Your profile' : 'Settings',
    user,
    // THE KEY FOLLOWS THE DOOR, NOT THE PAGE (#269). Two account-menu items
    // point here and exactly one may be marked current — see the note on NavKey
    // in views/layout.tsx. The TITLE follows it for the same reason: a rider who
    // pressed "Your profile" should not find a tab called Settings in their
    // browser history where their profile ought to be.
    navKey: opts.tab === 'profile' ? 'profile' : 'settings',
    body,
    // tabs.js FIRST AND ALWAYS, whichever tab is open. It is what the strip's
    // `data-tabs` attribute is read by, and without it the two tabs are two
    // buttons that do nothing — the panels are server-rendered into the right
    // state, so a missing script fails silently rather than loudly.
    scripts: `<script src="${asset('/js/tabs.js')}" defer></script>
  <script src="${asset('/js/autosave.js')}" defer></script>\n  ${opts.scripts ?? ''}\n  ${tourAssets(user).scripts}`,
    // The tour's paddock beat lands on the Profile tab, so the page carries
    // the tour's assets while one is running.
    head: tourAssets(user).head,
  })
}
