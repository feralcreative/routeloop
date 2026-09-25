// Settings and Profile as ONE page with two tabs (#269) — FOUR since #319:
// Preferences, Profile, Places and Paddock. Ziad's call, 2026-09-13.
//
// They were two pages and two account-menu items, and the split answered no
// question a rider was asking: both are "the things about me I can change", so
// somebody looking for one had to already know which page it was filed on.
// Places and the Paddock were regions at the foot of the Profile form until
// #319; neither was ever part of that form's submit, so moving them changed
// nothing about saving.
//
// **THE PRECEDENT IS `/riders` AND `/friends`.** Four URLs, one page, each
// opening its own tab — `/profile` is not redirected, because it is linked from
// the account menu and from bookmarks.
//
// **THIS FILE COMPOSES; IT DOES NOT IMPORT EITHER ROUTE MODULE.** The profile
// panel arrives as an already-rendered string, which keeps the imports
// one-directional: rendering both here would need a module cycle that happens to
// work only because every binding is called at request time.
//
// **BOTH PANELS ARE IN THE DOM, HIDDEN WITH `hidden`**, which is what tabs.js
// requires and what find-in-page and assistive tech both read.
import type { Context } from 'hono'
import { raw } from 'hono/html'
import { currentUser, type AuthEnv } from '../auth/middleware'
import { eq } from 'drizzle-orm'
import { db } from '../db/index'
import { userProfiles } from '../db/schema'
import { DELETION_HOLD_DAYS } from '../account/policy'
import { DURATION_FORMAT_CHOICES, toDurationFormat } from '../maps/duration'
import { dateFormatChoices } from './date-format'
import { CLOCK_CHOICES, resolveClock, toClock } from './clock'
import { VOLUME_CHOICES, toVolumeUnits } from './volume'
import { MOTION_CHOICES, toMotion } from './motion'
import { UNITS_CHOICES, toUnits } from './units'
import {
  POWER_CHOICES,
  TERMS,
  VEHICLE_CHOICES,
  Wd,
  cap,
  toPower,
  vocabOf,
  wd,
  wds,
  wordsFor,
  type Words,
} from './vocab'
import { MAP_SCHEME_CHOICES, SCHEME_CHOICES, THEME_CHOICES } from './appearance'
import { GROUPS, eventsInGroup } from '../notifications/catalog'
import { channelsFor } from '../notifications/policy'
import { prefsOf } from '../notifications/service'
import { dateFormatFor } from './prefs'
import { listBin } from '../trash/service'
import { binPlacesHtml } from './bin'
import { fieldHelp, page } from './layout'
import { DEFAULT_DIVERT_MI, MAX_DIVERT_MI, MIN_DIVERT_MI } from '../subgroups/rendezvous'
import { tourAssets } from './tour-assets'
import { asset } from './assets'

export type AccountTab = 'preferences' | 'profile' | 'paddock' | 'places'

// The Paddock and Places tabs are static markup driven by paddock.js and
// places.js against their APIs, so they render here rather than arriving from a
// route module. Each sits in a `.profile-form` div so the fieldset takes the card
// styling without being a form.
//
// Places are CREATED from the builder, because a place needs a pin and the
// builder is where the map is. This tab is for organizing what is there. A
// create-from-scratch flow wants the address picker from roadmap item 19 rather
// than a lat/lng text box.
// THE PLACES BIN IS A FOLD UNDER THE LIST (#343): binned things sit beside the
// list they left. An empty bin renders no fold at all, because a heading over an
// empty list is a question and not an answer. Closed to start with.
// ONE RADIO CARD, AND ITS EXPLANATION IS A TOOLTIP. Ziad's call, 2026-09-21: the
// line under every label made a three-option group 270px tall, and the label is
// what a rider picks from. The card carries it as `title` — the browser's own
// tooltip with script off — and as `data-tip-inline`, which tells tips.js the
// title IS the body. The same words stay inside the label as hidden text, so the
// accessible name is unchanged. The cost to state: on a phone there is no hover.
const Choice = (props: {
  name: string
  id: string
  checked: boolean
  label: string
  tip: string
  disabled?: boolean
}) => (
  <label class="choice" title={props.tip} data-tip-inline>
    <input type="radio" name={props.name} value={props.id} checked={props.checked} disabled={props.disabled} />
    <span class="choice-label">{props.label}</span>
    <span class="choice-example visually-hidden">{props.tip}</span>
  </label>
)

// AND ONE `?` PER GROUP, LISTING EVERY OPTION WITH ITS SENTENCE. Ziad asked, the
// same evening, why the sentences were tooltips and not the `?` bubble every
// other explanation on this page uses — and the bubble has the edge on a phone,
// where a tooltip is a long-press or nothing, and it needs no script. One per
// GROUP rather than one per card, because 33 dots would put back the noise the
// tooltips took away; the hover tooltips stay for a pointer. The rows are the
// cards' own labels and sentences, so the two cannot disagree. `raw()` because
// `fieldHelp` renders its text as-is and this is markup, the `twistKey()`
// arrangement on the dashboard.
const choiceKey = (name: string, label: string, rows: { label: string; tip: string }[]): string =>
  fieldHelp(
    `key-${name}`,
    label,
    raw(
      (
        <span class="choice-key">
          {rows.map((r) => (
            <span class="choice-key-row">
              <b>{r.label}</b> {r.tip}
            </span>
          ))}
        </span>
      ).toString(),
    ) as unknown as string,
  )

const placesPanel = (bin?: { html: string; count: number; error?: string }): string =>
  (
    <div class="profile-form">
      <fieldset>
        <legend>Your places</legend>
        <p class="field-hint">
          Save a stop from the ride builder and it turns up here, and in the builder&rsquo;s search box on every ride
          after&nbsp;that.
        </p>
        <div id="places-manager" data-places-manager>
          <p class="field-hint">Loading&hellip;</p>
        </div>
        {bin && (bin.count > 0 || bin.error) && (
          <details class="places-bin" open={!!bin.error}>
            <summary>
              Recycle bin <span class="friend-count">{bin.count}</span>
            </summary>
            {raw(bin.html)}
          </details>
        )}
      </fieldset>
    </div>
  ).toString()

const paddockPanel = (w: Words): string =>
  (
    <div class="profile-form">
      <fieldset>
        <legend>{Wd(w, 'storage')}</legend>
        <p class="field-hint">
          The {wds(w, 'vehicle')} you take. A range here is what the app plans {w.fuel ? wd(w, 'fuel') : 'fuel'} stops
          around, and the tour&rsquo;s fuel part points at&nbsp;it.
        </p>
        <div id="paddock" data-paddock>
          <p class="field-hint">Loading&hellip;</p>
        </div>
      </fieldset>
    </div>
  ).toString()

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
      favorPlaces: userProfiles.favorPlaces,
      meetDivertMi: userProfiles.meetDivertMi,
      vehicle: userProfiles.vehicle,
      power: userProfiles.power,
      jargon: userProfiles.jargon,
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
    favorPlaces: p?.favorPlaces ?? '',
    // Null is "never set", and the box shows the app's default as a placeholder
    // rather than as a value — see the column.
    meetDivertMi: p?.meetDivertMi ?? null,
    vocab: vocabOf(p),
  }
}

/**
 * The whole page, with one of its four tabs open.
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
    'meet',
    'tips',
    'tour-button',
    'vehicle',
    'power',
    'jargon',
    // One per notification group, DERIVED rather than typed: five hand-written
    // strings is five chances to add a group and forget one, and the symptom of
    // forgetting is a rider being told their account is no longer scheduled for
    // deletion because they ticked a checkbox.
    ...GROUPS.map((g) => `notify-${g.id}`),
    '1',
  ]
  const restored = savedQuery !== undefined && !FORM_SAVED.includes(savedQuery)
  const on = (name: string) => savedQuery === name
  const {
    durationFormat,
    units,
    motion,
    clock,
    volumeUnits,
    avoidPlaces,
    favorPlaces,
    meetDivertMi,
    vocab,
  } = await prefsFor(user.id)
  // The words the presets alone would give, with no Custom row — what each
  // jargon row marks as "default".
  const presetWords = wordsFor({ ...vocab, jargon: {} })
  // Today, written three ways — resolved once per render so all three read the
  // same date even across midnight.
  const dateChoices = dateFormatChoices()
  // The page's own words: the rider's default preset with their Custom rows,
  // which is what every surface with no ride on it reads.
  const w = wordsFor(vocab)
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
  const mapScheme = user.mapScheme

  const tabOn = (t: AccountTab) => opts.tab === t

  // The places bin, only when the tab is the one that shows it: one more
  // query for a fold most riders never open is fine on /places and waste on
  // the other three doors.
  const placesBin = tabOn('places')
    ? await (async () => {
        const bin = await listBin(user.id)
        const count = bin.places.length + bin.groups.length
        const error = c.req.query('error')
        // A refusal opens the fold, or the message a restore came back with
        // is inside a closed box.
        return { html: binPlacesHtml(bin, dateFormat, error), count, error }
      })()
    : undefined

  // THE CHIP IS THE NO-SCRIPT PATH NOW. With autosave running, the border on the
  // group says dirty/saving/saved and this never renders — a `?saved=` query only
  // comes back from a real form POST, which happens with script off or after an
  // autosave failure has handed the button back. Kept for those two cases rather
  // than deleted.
  const Saved = ({ when }: { when: boolean }) => (when ? <span class="form-ok">Saved</span> : <></>)

  const body = (
    <>
      {/* THE HEADING FOLLOWS THE DOOR, like the title and the nav key (#269). A
          rider who pressed "Your profile" and landed on a page headed Account
          settings has been told they went somewhere else — which is the
          confusion the merge exists to remove, arriving from the other side.
          The tab strip under it says which of the four they are on either way.
          "Account settings" rather than "Settings" since #320, when the menu
          item became My Account.

          The panel's own heading went with this: the tab, the H1 and a third
          "Your profile" inside the panel is the same words three times. */}
      {tabOn('profile') ? (
        <>
          <h1>Your profile</h1>
          <p class="lede">
            Who you are and where you set off from. Your preferences, places, and {wds(w, 'vehicle')} are on the tabs
            beside&nbsp;this.
          </p>
        </>
      ) : (
        <>
          <h1>Account settings</h1>
          <p class="lede">How the app looks, how it writes things down, and everything it knows about&nbsp;you.</p>
        </>
      )}

      {restored ? (
        <p class="form-ok">
          Welcome back. Your account is no longer scheduled for deletion, and everything is exactly where you left it.
        </p>
      ) : null}

      <div class="page-tabs" role="tablist" aria-label="Account settings" data-tabs>
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
        <button
          type="button"
          class={`page-tab${tabOn('paddock') ? ' is-active' : ''}`}
          role="tab"
          id="tab-paddock"
          aria-controls="panel-paddock"
          aria-selected={tabOn('paddock') ? 'true' : 'false'}
          tabindex={tabOn('paddock') ? undefined : -1}
        >
          {Wd(w, 'storage')}
        </button>
        <button
          type="button"
          class={`page-tab${tabOn('places') ? ' is-active' : ''}`}
          role="tab"
          id="tab-places"
          aria-controls="panel-places"
          aria-selected={tabOn('places') ? 'true' : 'false'}
          tabindex={tabOn('places') ? undefined : -1}
        >
          Places
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
          TWO TOPICS, NOT FOUR PEERS (#178) — THREE SINCE #133. Appearance is one topic
          and Units the other: the duration and date settings each promise, in nearly the
          same words, that they change the WRITING and not the number.
        
          THE OLD PAGE'S GAPS WERE THE GRID, NOT THE SPACING. Four `.setting` blocks sat
          in a two-column `.two-col` with `align-items: start`, so the shorter column
          ended early. Every control here is a short radio group, so a topic is a ROW —
          and on a desktop, since 2026-09-21, the row holds the whole topic: four across
          for Appearance, five for Units.
        
          GTFO stays outside both: it is a boxed-off danger area.
        */}

        <section class="setting-topic" id="appearance">
          <h2>Appearance</h2>
          <p>
            How the app looks, and how much it moves. The palette decides which colors it uses, light or dark decides
            how bright it is, and every palette comes in&nbsp;both.
          </p>

          {/*
              THE PALETTE ITSELF, UNDER THE LEDE AND ABOVE THE CONTROLS. Ziad's call,
              2026-09-07 — it sat above the Save row inside the form, which put the thing
              being changed BELOW the controls that change it.
            
              OUTSIDE THE FORM, which it can be because it carries no input.
            
              NO JAVASCRIPT AT ALL: every swatch is a `var()` and the palettes are one
              stylesheet keyed on the attributes restamp() writes, so the bar cannot disagree
              with what the app is painting, because it IS what the app is painting.
            
              THE SIGN FIELDS, IN SIGNAL ORDER, because those are the colors a rider meets.
              The neutrals are left out — a strip of greys says nothing about which palette is
              on. `aria-hidden`, because the radio labels carry the meaning.
            */}
          <p class="palette-bar" aria-hidden="true">
            {['stop', 'detour', 'warning', 'yield', 'go', 'interstate', 'disabled', 'recreation', 'tarmac'].map(
              (token) => (
                <span class="palette-chip" style={`background: var(--${token})`}></span>
              ),
            )}
          </p>

          {/*
              ONE FORM FOR ALL THREE AXES: a rider has ONE appearance and would be surprised
              if saving the palette reverted the light/dark choice made in the same breath.
            
              THERE IS A LIVE PREVIEW NOW, AND THAT REVERSES THE NOTE THAT WAS HERE. It read:
              no live preview, because "a preview would need script this page does not want,
              and the choice applies on save". Both halves stopped being true on 2026-09-07 —
              the page autosaves and re-stamps <html>, so the whole page IS the preview.
            */}
          <form method="post" action="/settings/appearance" class="setting-form" data-autosave>
            <div class="three-col three-col--four">
              <fieldset class="choice-set">
                <legend class="choice-legend">
                  Palette
                  {raw(
                    choiceKey(
                      'theme',
                      'the palette',
                      THEME_CHOICES.map((c) => ({ label: c.label, tip: c.hint })),
                    ),
                  )}
                </legend>
                {THEME_CHOICES.map((choice) => (
                  <Choice
                    name="theme"
                    id={choice.id}
                    checked={choice.id === theme}
                    label={choice.label}
                    tip={choice.hint}
                  />
                ))}
              </fieldset>

              <fieldset class="choice-set">
                <legend class="choice-legend">
                  Light or dark
                  {raw(
                    choiceKey(
                      'scheme',
                      'light or dark',
                      SCHEME_CHOICES.map((c) => ({ label: c.label, tip: c.hint })),
                    ),
                  )}
                </legend>
                {SCHEME_CHOICES.map((choice) => (
                  <Choice
                    name="scheme"
                    id={choice.id}
                    checked={choice.id === scheme}
                    label={choice.label}
                    tip={choice.hint}
                  />
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
                <legend class="choice-legend">
                  Motion
                  {raw(
                    choiceKey(
                      'motion',
                      'motion',
                      MOTION_CHOICES.map((c) => ({ label: c.label, tip: c.hint })),
                    ),
                  )}
                </legend>
                {MOTION_CHOICES.map((choice) => (
                  <Choice
                    name="motion"
                    id={choice.id}
                    checked={choice.id === motion}
                    label={choice.label}
                    tip={choice.hint}
                  />
                ))}
              </fieldset>

              {/*
                THE MAP HAS ITS OWN LIGHT/DARK (2026-09-14). Ziad's call: a dark
                page must not force dark tiles on anyone, because the tiles are
                what a planner reads and a dark basemap is a taste. It defaults
                to following the page, so the control changes nothing for the
                rider who never touches it. The fourth cell is the fourth
                column on a desktop (`.three-col--four`) and wraps under the
                three at smaller widths.
              */}
              <fieldset class="choice-set">
                <legend class="choice-legend">
                  Map theme
                  {raw(
                    choiceKey(
                      'mapScheme',
                      'the map theme',
                      MAP_SCHEME_CHOICES.map((c) => ({ label: c.label, tip: c.hint })),
                    ),
                  )}
                </legend>
                {MAP_SCHEME_CHOICES.map((choice) => (
                  <Choice
                    name="mapScheme"
                    id={choice.id}
                    checked={choice.id === mapScheme}
                    label={choice.label}
                    tip={choice.hint}
                  />
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

          <div class="three-col three-col--five">
            {/*
              A FORM EACH, NOT ONE, and the split is deliberate rather than left
              over. Unlike the appearance axes these are unrelated questions with
              unrelated answers, and each handler writes only its own column — so
              saving one cannot revert another. See the note on the handlers in
              routes/settings.tsx.
            */}
            <section class="setting" id="units">
              <h3>
                Distances
                {raw(
                  choiceKey(
                    'units',
                    'distances',
                    UNITS_CHOICES.map((c) => ({ label: c.label, tip: `reads ${c.example}` })),
                  ),
                )}
              </h3>
              <form method="post" action="/settings/units" class="setting-form" data-autosave>
                <fieldset class="choice-set">
                  <legend class="visually-hidden">Units</legend>
                  {/* The SAME road in both, which is the question being
                    asked. Twistiness comes along with the distance: degrees
                    per kilometer is a smaller number than degrees per mile. */}
                  {UNITS_CHOICES.map((choice) => (
                    <Choice
                      name="units"
                      id={choice.id}
                      checked={choice.id === units}
                      label={choice.label}
                      tip={`reads ${choice.example}`}
                    />
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
              <h3>
                Dates
                {raw(
                  choiceKey(
                    'dateFormat',
                    'dates',
                    dateChoices.map((c) => ({ label: c.label, tip: c.tip })),
                  ),
                )}
              </h3>
              <form method="post" action="/settings/date-format" class="setting-form" data-autosave>
                <fieldset class="choice-set">
                  <legend class="visually-hidden">Date format</legend>
                  {dateChoices.map((choice) => (
                    <Choice
                      name="dateFormat"
                      id={choice.id}
                      checked={choice.id === dateFormat}
                      label={choice.label}
                      tip={choice.tip}
                    />
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
              <h3>
                Clock
                {raw(
                  choiceKey(
                    'clock',
                    'the clock',
                    CLOCK_CHOICES.map((c) => ({ label: c.label, tip: `reads ${c.example}` })),
                  ),
                )}
              </h3>
              <form method="post" action="/settings/clock" class="setting-form" data-autosave>
                <fieldset class="choice-set">
                  <legend class="visually-hidden">Clock</legend>
                  {/* CHECKED AGAINST THE RESOLVED VALUE, not the stored one.
                      Every rider who has never touched this carries `locale`,
                      which is no longer offered — so without resolving, none
                      of the two would be selected and the control would look
                      broken on the page most riders open first. */}
                  {CLOCK_CHOICES.map((choice) => (
                    <Choice
                      name="clock"
                      id={choice.id}
                      checked={choice.id === resolvedClock}
                      label={choice.label}
                      tip={`reads ${choice.example}`}
                    />
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
              <h3>
                Stop durations
                {raw(
                  choiceKey(
                    'durationFormat',
                    'stop durations',
                    DURATION_FORMAT_CHOICES.map((c) => ({ label: c.label, tip: `reads ${c.example}` })),
                  ),
                )}
              </h3>
              <form method="post" action="/settings/duration-format" class="setting-form" data-autosave>
                <fieldset class="choice-set">
                  <legend class="visually-hidden">Duration format</legend>
                  {DURATION_FORMAT_CHOICES.map((choice) => (
                    <Choice
                      name="durationFormat"
                      id={choice.id}
                      checked={choice.id === durationFormat}
                      label={choice.label}
                      tip={`reads ${choice.example}`}
                    />
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
            {/* NOTHING TO PLAN FUEL AROUND ON A PEDAL BIKE (#321): the volume
                preference is for a tank, and a rider whose default is pedal has
                none. The column keeps its value for the day they switch. */}
            {w.fuel ? (
              <section class="setting" id="volume">
                <h3>
                  {Wd(w, 'fuel')} volume
                  {raw(
                    choiceKey(
                      'volumeUnits',
                      `${wd(w, 'fuel')} volume`,
                      VOLUME_CHOICES.map((c) => ({ label: c.label, tip: c.example })),
                    ),
                  )}
                </h3>
                <form method="post" action="/settings/volume" class="setting-form" data-autosave>
                  <fieldset class="choice-set">
                    <legend class="visually-hidden">Fuel volume</legend>
                    {VOLUME_CHOICES.map((choice) => (
                      <Choice
                        name="volumeUnits"
                        id={choice.id}
                        checked={choice.id === volumeUnits}
                        label={choice.label}
                        tip={choice.example}
                      />
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
            ) : null}
          </div>
        </section>

        {/*
            WHAT THE APP CALLS THINGS (#321). Ziad's call, 2026-09-13: Routeloop is for
            every vehicle a rider owns, and the words were a motorcycle's. Two pickers — the
            PRESETS — and a table of one row per term. A ride carries its own pair, set in
            the builder, and wins over the pickers; a row set here wins over both.
          
            THREE FORMS, THREE COLUMNS, like every other topic: each writes its own column,
            so saving a word cannot revert the vehicle.
          
            Third on the page (#338): the two topics everybody touches come first.
          */}
        <section class="setting-topic" id="jargon">
          <h2>Vocabulary</h2>
          <p>
            A ride, a rider, a bike, a paddock—those are a motorcyclist&rsquo;s words. The two defaults below decide
            which set every page starts from; a ride can carry its own pair in the builder. Under them, any single word
            can be overridden with one you would rather&nbsp;say.
          </p>
          <div class="three-col">
            <section class="setting" id="vehicle">
              <h3>
                What makes you go?
                {raw(
                  choiceKey(
                    'vehicle',
                    'what makes you go',
                    VEHICLE_CHOICES.map((c) => ({ label: c.label, tip: c.example })),
                  ),
                )}
              </h3>
              <form method="post" action="/settings/vehicle" class="setting-form" data-autosave data-jargon-preset>
                <fieldset class="choice-set">
                  <legend class="visually-hidden">Vehicle</legend>
                  {VEHICLE_CHOICES.map((choice) => (
                    <Choice
                      name="vehicle"
                      id={choice.id}
                      checked={choice.id === vocab.vehicle}
                      label={choice.label}
                      tip={choice.example}
                    />
                  ))}
                </fieldset>
                <div class="setting-actions">
                  <button type="submit" class="btn btn-sign arrow-right arrow-n" data-js-hide>
                    Save
                  </button>
                  <Saved when={on('vehicle')} />
                </div>
              </form>
            </section>

            <section class="setting" id="power">
              <h3>
                What makes <em>it</em> go?
                {raw(
                  choiceKey(
                    'power',
                    'what makes it go',
                    POWER_CHOICES.map((c) => ({ label: c.label, tip: c.example })),
                  ),
                )}
              </h3>
              <form method="post" action="/settings/power" class="setting-form" data-autosave data-jargon-preset>
                <fieldset class="choice-set">
                  <legend class="visually-hidden">Power</legend>
                  {/* THE POWER FOLLOWS THE VEHICLE, GRAYED RATHER THAN GONE. Ziad's
                         call, 2026-09-21: a power the vehicle cannot use is disabled, so
                         the option is still there to be read and the vehicle is the one
                         thing to change. One direction only — gating the vehicles on the
                         power as well was built first and was too convoluted. The rule is
                         toPower()'s own, and a vehicle change that leaves the checked
                         power impossible moves it. */}
                  {POWER_CHOICES.map((choice) => (
                    <Choice
                      name="power"
                      id={choice.id}
                      checked={choice.id === vocab.power}
                      disabled={toPower(choice.id, vocab.vehicle) !== choice.id}
                      label={choice.label}
                      tip={choice.example}
                    />
                  ))}
                </fieldset>
                <div class="setting-actions">
                  <button type="submit" class="btn btn-sign arrow-right arrow-n" data-js-hide>
                    Save
                  </button>
                  <Saved when={on('power')} />
                </div>
              </form>
            </section>
          </div>

          <section class="setting setting--wide" id="words">
            <h3>Overrides: your own words</h3>
            <p class="setting-hint">
              The default comes from the two choices above and moves with them. Type your own in the box beside it, and
              that word is used everywhere whatever the defaults say—a slash gives it a plural, like{' '}
              <code>person/people</code>.
            </p>
            {/*
                TWO PILLS BESIDE THE TERM: THE DEFAULT, AND THE BOX, WITH NO WORD ON IT — the
                Custom column heading says what it is. Ziad's call, 2026-09-21, replacing a pill
                for every preset's word. The default pill's word comes from the two pickers and
                jargon.js moves it when they change; the alternatives the other pills offered
                are just words a rider types. The stored shape is unchanged.
              
                A ROW UNDER PEDAL KEEPS ITS PILLS IN THE DOM, hidden, so the word a rider typed
                for their e-bike's fuel survives a save made while the pedal preset blanks the
                row — the old form rendered no input there and every save dropped it.
              */}
            <form method="post" action="/settings/jargon" class="setting-form" data-autosave data-jargon>
              {/*
                ONE TABLE, FOUR COLUMNS: the term, where it shows up, the
                default pill and the custom box. Ziad's call, 2026-09-21, after
                a two-column split of the same rows was tried for an hour: the
                example under the term was the thing making every row two
                lines tall, and given its own column the table is one line a
                term and fills a wide page on its own.
              */}
              <table class="jargon-table">
                <thead>
                  <tr>
                    <th scope="col">Term</th>
                    <th scope="col">Example</th>
                    {/* The head names the pair the defaults come from, and
                        jargon.js rewrites it as the pickers change. */}
                    <th scope="col">
                      Default{' '}
                      <span class="jargon-preset">
                        ({VEHICLE_CHOICES.find((c) => c.id === vocab.vehicle)?.label},{' '}
                        {POWER_CHOICES.find((c) => c.id === vocab.power)?.label})
                      </span>
                    </th>
                    <th scope="col">Custom</th>
                  </tr>
                </thead>
                <tbody>
                  {TERMS.map((t) => {
                    const follows = t.axis === 'regional' ? t.options?.[0] : presetWords[t.id]
                    const custom = vocab.jargon[t.id] ?? ''
                    const off = t.axis === 'power' && vocab.power === 'pedal'
                    return (
                      <tr class={off ? 'is-off' : ''} data-term={t.id} data-axis={t.axis}>
                        <th scope="row">{t.label}</th>
                        <td class="jargon-where">{t.where}</td>
                        <td class="jargon-default">
                          <label class="jargon-pick">
                            <input type="radio" name={`pick-${t.id}`} value="default" checked={!custom} />
                            <span class="jargon-word">{follows ? cap(follows.one) : ''}</span>
                          </label>
                          <span class="jargon-off">Nothing to plan fuel around on a pedal bike.</span>
                        </td>
                        <td class="jargon-custom">
                          <label class="jargon-pick jargon-pick--custom">
                            <input type="radio" name={`pick-${t.id}`} value="custom" checked={!!custom} />
                            <input
                              type="text"
                              name={`custom-${t.id}`}
                              maxlength={40}
                              value={custom}
                              placeholder="Your word"
                              aria-label={`Your word for ${t.label.toLowerCase()}`}
                            />
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
                <Saved when={on('jargon')} />
              </div>
            </form>
          </section>
        </section>

        {/*
            SHOW ME AROUND IS FIRST, AND ITS OWN TOPIC (#133).
          
            First because it is the one preference that exists for somebody who has never
            used the app: everything below answers "how do you want this written", which
            presumes a rider who already knows what the controls are.
          
            ITS OWN TOPIC RATHER THAN A FOURTH APPEARANCE AXIS: appearance is three answers
            to one question, and whether the app talks to you is a different question.
            Folding it in would also mean folding it into that handler, which is the thing
            the per-column split exists to prevent.
          
            A ONE-SETTING TOPIC IS NOT THE THING `reports` WAS — that rendered as a heading,
            two column labels and a single row. This is a heading, a lede that explains a
            feature, and the control.
          */}
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
          MEETING POINTS (#370). Where the builder's detour dial starts, and the
          one number in the meeting-point proposer a rider can set once rather
          than per press. Its own topic for the reason Places is: everything in
          Units is about how a figure is WRITTEN, and this changes what a press
          of Find meeting points ANSWERS.

          ONE FIELD, EMPTY BY DEFAULT, WITH THE DEFAULT AS ITS PLACEHOLDER. The
          column is nullable and the default lives in code, so a rider who
          clears the box goes back to whatever the app's default is rather than
          carrying the number it was the day they cleared it. A number box saves
          on `change`, so the autosave fires on blur or Enter rather than on
          each digit of "120".
        */}
        <section class="setting-topic" id="meet">
          <h2>Meeting points</h2>
          <p>
            When groups set off from different places, the builder proposes where they should meet on the main group’s
            road. A joining group is never sent farther out of their way than this beyond the nearest point where their
            road meets it—meeting sooner has to be worth the detour. This is where the builder’s dial starts; you can
            change it for any one press on the Groups&nbsp;tab.
          </p>
          <section class="setting" id="meet-divert">
            <h3>Extra detour a joining group will accept</h3>
            <form method="post" action="/settings/meet" class="setting-form" data-autosave>
              <p class="field">
                <span class="label-row">
                  <label for="f-meet">Beyond the nearest meeting point (mi)</label>
                  {raw(
                    fieldHelp(
                      'meet',
                      'how the detour allowance works',
                      `Measured from the cheapest place each group could join, not from zero, so a group whose road never comes near the main one still gets an answer. Leave it empty for the default of ${DEFAULT_DIVERT_MI} miles.`,
                    ),
                  )}
                </span>
                <input
                  type="number"
                  id="f-meet"
                  name="meetDivertMi"
                  min={MIN_DIVERT_MI}
                  max={MAX_DIVERT_MI}
                  step={1}
                  inputmode="numeric"
                  placeholder={String(DEFAULT_DIVERT_MI)}
                  value={meetDivertMi === null ? '' : String(meetDivertMi)}
                />
              </p>
              <div class="setting-actions">
                <button type="submit" class="btn btn-sign arrow-right arrow-n" data-js-hide>
                  Save
                </button>
                <Saved when={on('meet')} />
              </div>
            </form>
          </section>
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
          <p>
            <b>Mute</b> a kind you are tired of and it still shows up in your notifications, but it never adds to the
            count, never pops up, and never emails. You can also mute a kind straight from your&nbsp;notifications.
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
                        {/* A TICK-ALL PER COLUMN, per group. Hidden until
                            notif-columns.js reveals it, because with no script
                            it would be a box that does nothing. Nameless, so it
                            is never posted. */}
                        {(['email', 'browser', 'mute'] as const).map((col) => (
                          <th scope="col">
                            <span class="notif-col-head">
                              <input
                                type="checkbox"
                                class="notif-col-all"
                                data-col={col}
                                hidden
                                aria-label={`All ${col === 'email' ? 'Email' : col === 'browser' ? 'Browser' : 'Mute'} in ${group.label}`}
                              />
                              {col === 'email' ? 'Email' : col === 'browser' ? 'Browser' : 'Mute'}
                            </span>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {eventsInGroup(group.id).map((e) => {
                        const want = channelsFor(notifPrefs, e.key)
                        return (
                          <tr class={want.muted ? 'is-muted' : undefined}>
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
                                <span class="visually-hidden">Email me {e.label} notifications</span>
                              </label>
                            </td>
                            <td>
                              <label class="notif-box">
                                <input type="checkbox" name={`${e.key}:browser`} checked={want.browser} />
                                <span class="visually-hidden">
                                  Show {e.label} notifications in the browser
                                </span>
                              </label>
                            </td>
                            {/* MUTE KEEPS IT IN THE CENTER, QUIETLY: no badge, no
                                popup, no email. The two channel boxes keep their
                                own values underneath, so unmuting restores them. */}
                            <td>
                              <label class="notif-box">
                                <input type="checkbox" name={`${e.key}:mute`} checked={want.muted} />
                                <span class="visually-hidden">Mute {e.label} notifications</span>
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

      <div
        class="page-tabpanel"
        id="panel-paddock"
        role="tabpanel"
        aria-labelledby="tab-paddock"
        hidden={!tabOn('paddock')}
      >
        {raw(paddockPanel(w))}
      </div>

      <div
        class="page-tabpanel"
        id="panel-places"
        role="tabpanel"
        aria-labelledby="tab-places"
        hidden={!tabOn('places')}
      >
        {raw(placesPanel(placesBin))}
      </div>
    </>
  ).toString()

  return page({
    title: opts.tab === 'profile' ? 'Your profile' : 'Account settings',
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
  <script src="${asset('/js/autosave.js')}" defer></script>
  <script src="${asset('/js/jargon.js')}" defer></script>
  <script src="${asset('/js/notif-columns.js')}" defer></script>\n  ${opts.scripts ?? ''}\n  ${tourAssets(user).scripts}`,
    // The tour's paddock beat lands on the Paddock tab, so the page carries
    // the tour's assets while one is running.
    head: tourAssets(user).head,
  })
}
