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
import { CLOCK_CHOICES, toClock } from './clock'
import { VOLUME_CHOICES, toVolumeUnits } from './volume'
import { MOTION_CHOICES, toMotion } from './motion'
import { UNITS_CHOICES, toUnits } from './units'
import { SCHEME_CHOICES, THEME_CHOICES } from './appearance'
import { dateFormatFor } from './prefs'
import { fieldHelp, page } from './layout'
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
      avoidPlaces: userProfiles.avoidPlaces,
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
    avoidPlaces: p?.avoidPlaces ?? '',
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
  const FORM_SAVED = ['duration', 'dates', 'appearance', 'units', 'clock', 'volume', 'avoid', '1']
  const restored = savedQuery !== undefined && !FORM_SAVED.includes(savedQuery)
  const on = (name: string) => savedQuery === name
  const { durationFormat, units, motion, clock, volumeUnits, avoidPlaces } = await prefsFor(user.id)
  const dateFormat = await dateFormatFor(c)
  // Straight off the session rather than a second query — validateSessionToken
  // already left-joins user_profiles for exactly this, and the values are
  // coerced there so there is no null to interpret here.
  const theme = user.theme
  const scheme = user.scheme

  const tabOn = (t: AccountTab) => opts.tab === t

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
          TWO TOPICS, NOT FOUR PEERS (#178). Appearance is one topic and Units is
          the other, and the copy is what said so: the duration and date settings
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
            ONE FORM FOR ALL THREE AXES, which is what the appearance handler
            already did for two. A rider has ONE appearance and would be
            surprised if saving the palette reverted the light/dark choice they
            made in the same breath; motion is the same kind of answer to the
            same question and joins them rather than getting a fourth endpoint.

            The page renders in the rider's CURRENT palette while they choose.
            There is no live preview and deliberately so — a preview would need
            script this page does not otherwise want, and the choice applies on
            save, which is one click away and unambiguous.
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
              <button type="submit" class="btn btn-sign arrow-right arrow-n">
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
              <form method="post" action="/settings/units" class="setting-form">
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
                  <button type="submit" class="btn btn-sign arrow-right arrow-n">
                    Save
                  </button>
                  <Saved when={on('units')} />
                </div>
              </form>
            </section>

            <section class="setting" id="dates">
              <h3>Dates</h3>
              <form method="post" action="/settings/date-format" class="setting-form">
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
                  <button type="submit" class="btn btn-sign arrow-right arrow-n">
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
              <form method="post" action="/settings/clock" class="setting-form">
                <fieldset class="choice-set">
                  <legend class="visually-hidden">Clock</legend>
                  {CLOCK_CHOICES.map((choice) => (
                    <label class="choice">
                      <input type="radio" name="clock" value={choice.id} checked={choice.id === clock} />
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
                  <Saved when={on('clock')} />
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
              <form method="post" action="/settings/volume" class="setting-form">
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
                  <button type="submit" class="btn btn-sign arrow-right arrow-n">
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
        <section class="setting-topic" id="avoid">
          <h2>Places to avoid</h2>
          {/*
            THE PROMISE STAYS VISIBLE AND THE FORMAT GOES IN THE BUBBLE, which is
            the line the `?` affordance is drawn on everywhere (#268): what a
            rider needs to read BEFORE they act stays as prose, and how to fill
            one box in goes behind the dot. A rider who believes this HIDES a
            station will not use it near empty — which is exactly when a station
            they dislike is still the right answer — so that sentence can never
            be a click away.
          */}
          <p>
            Somewhere you would rather not stop? Name it here and it drops to the bottom of every place search — the gas
            chips, the category searches, the search along a route. <b>Nothing is ever hidden</b>: the one time you are
            out of fuel with one in front of you is the time this must not have taken it&nbsp;away.
          </p>
          <form method="post" action="/settings/avoid" class="setting-form">
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
              <button type="submit" class="btn btn-sign arrow-right arrow-n">
                Save
              </button>
              <Saved when={on('avoid')} />
            </div>
          </form>
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
    scripts: `<script src="${asset('/js/tabs.js')}" defer></script>\n  ${opts.scripts ?? ''}`,
  })
}
