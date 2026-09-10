// Whether a given rider gets a given notification on a given channel.
//
// Pure — a function of a stored override list and nothing else — so it is
// testable under the house rule that governs test/. The queries live in
// ./service.ts, which is the only module here that touches the database.
//
// **THE DEFAULT LIVES HERE AND THE COLUMN STORES ONLY THE DEVIATION.** Ziad's
// call, 2026-09-07: email on, browser off. A row in `notification_prefs` means a
// rider said something; the ABSENCE of one means they have not been asked yet,
// and those are two different states that a `boolean not null default true`
// column cannot tell apart. Same arrangement as `home_label`'s "Home" and
// `clock`'s `locale` — the fallback is code, so changing our mind about a
// default reaches every rider who never expressed an opinion, and reaches none
// of the riders who did.
//
// The failure this prevents is the one a defaults-in-the-column design walks
// into on the FIRST new event: adding `new_follower` with `default true` writes
// nothing for existing riders (the row does not exist), so the default has to be
// in code anyway — and now it is in two places, which is one place too many.
//
// **BROWSER OFF IS NOT THE SAME KIND OF DEFAULT AS EMAIL ON.** Email off would
// be a rider not hearing something they wanted; browser ON by default would be a
// permission prompt nobody asked for, on a page they opened to plan a ride. The
// browser channel also cannot deliver until the rider grants Chrome's
// permission, so a preference switched on before that is a promise the app
// cannot keep — `enabledFor` says what they ASKED for and the client is what
// knows whether it can be honored.
import { CHANNELS, isChannel, isEvent, type Channel, type NotificationEvent } from './catalog'

/** One stored answer. Exactly the columns the rules read, so a test does not
 *  have to build a whole row. */
export type PrefRow = {
  event: string
  channel: string
  enabled: boolean
}

/**
 * Events whose default is OFF on every channel, before any rider has said
 * anything. The row is still stored, so the notification center and the badge
 * report it — only delivery is silent.
 *
 * **THIS IS A DEPARTURE FROM THE RULE BELOW AND IT IS DELIBERATE.** Ziad's call,
 * 2026-09-08 (#288). `release` is raised by the DEPLOY rather than by anything a
 * rider or their friends did, and prod deploys several times a day — so the
 * house default of email-on is a mail per deploy to every rider, which is the
 * one shape of notification guaranteed to make somebody turn all of them off.
 *
 * The rule's own escape hatch does not fit. It says an argument for a quieter
 * default is really an argument that the event should not be OPTIONAL, answered
 * by leaving it out of the catalog — but out of the catalog means no switch at
 * all, and a rider who wants these by mail should be able to say so. Quiet and
 * switchable is not expressible any other way.
 *
 * KEEP THIS LIST SHORT. A second entry is worth arguing about; a third means the
 * per-channel default is simply wrong and should move.
 */
const QUIET_BY_DEFAULT: ReadonlySet<string> = new Set(['release'])

/**
 * The default for a channel, before any rider has said anything.
 *
 * Per channel rather than per event, deliberately. A per-event default is a
 * second thing to decide every time the catalog grows, and every argument for
 * one ("surely a purge warning should be louder") is really an argument that the
 * event should not be optional — which is answered by leaving it out of the
 * catalog, not by pinning its default. `QUIET_BY_DEFAULT` above is the one
 * recorded exception and says why it could not be answered that way.
 *
 * The event is OPTIONAL in the signature so every existing caller reads as it
 * did, and so a caller that genuinely has no event in hand cannot be forced to
 * invent one.
 */
export const defaultFor = (channel: Channel, event?: string): boolean =>
  event !== undefined && QUIET_BY_DEFAULT.has(event) ? false : channel === 'email'

/**
 * A rider's answers, as a lookup the send path can ask twice per notification.
 *
 * **UNKNOWN EVENTS AND CHANNELS ARE DROPPED ON THE WAY IN, NOT ON THE WAY OUT.**
 * A stored row naming something this build has never heard of is the ordinary
 * result of removing an event from the catalog, and the honest reading of it is
 * that the rider has expressed no opinion about anything that currently exists.
 * Filtering here means every reader downstream is working with a map whose keys
 * are all real, so nothing else has to remember to check.
 */
export function prefMap(rows: readonly PrefRow[]): Map<string, boolean> {
  const out = new Map<string, boolean>()
  for (const r of rows) {
    if (!isEvent(r.event) || !isChannel(r.channel)) continue
    out.set(`${r.event}:${r.channel}`, r.enabled)
  }
  return out
}

/**
 * Does this rider want this notification here?
 *
 * The one question the send path asks. `prefs` is what `prefMap` returned; a
 * rider with no rows at all gets an empty map and every default, which is the
 * common case and must not need a special branch anywhere.
 */
export function enabledFor(prefs: Map<string, boolean>, event: NotificationEvent, channel: Channel): boolean {
  return prefs.get(`${event}:${channel}`) ?? defaultFor(channel, event)
}

/** Both answers for one event, which is what the settings page renders as a
 *  row of two checkboxes. */
export const channelsFor = (prefs: Map<string, boolean>, event: NotificationEvent): Record<Channel, boolean> => ({
  email: enabledFor(prefs, event, 'email'),
  browser: enabledFor(prefs, event, 'browser'),
})

/**
 * Turn a submitted form into the rows to store.
 *
 * **EVERY EVENT IS WRITTEN, NOT ONLY THE TICKED ONES, AND AN UNTICKED BOX IS THE
 * REASON.** An HTML checkbox sends nothing when it is off, so "absent from the
 * body" has to mean OFF for the group being saved — which is exactly the same
 * string of nothing that means "this rider has never answered". The two are told
 * apart by the CALLER knowing which events its form carried: `submitted` is that
 * list, and every one of them gets a row whichever way it went. A rider turning
 * email off for one event therefore writes `enabled: false` rather than deleting
 * a row, which is what keeps a later change to `defaultFor` from silently
 * turning it back on under them.
 *
 * `checked` is the set of `"<event>:<channel>"` keys the form posted. The form's
 * checkbox names are exactly those keys, so nothing here has to parse a naming
 * scheme — see the settings page.
 */
export function rowsFromForm(submitted: readonly NotificationEvent[], checked: ReadonlySet<string>): PrefRow[] {
  const out: PrefRow[] = []
  for (const event of submitted) {
    for (const channel of CHANNELS) {
      out.push({ event, channel, enabled: checked.has(`${event}:${channel}`) })
    }
  }
  return out
}

/** The `"<event>:<channel>"` keys a request body carries, filtered to ones this
 *  build recognizes. Hand-crafted junk is dropped rather than 400ing, which is
 *  the contract every other settings handler follows. */
export function checkedKeys(body: Record<string, unknown>): Set<string> {
  const out = new Set<string>()
  for (const key of Object.keys(body)) {
    const [event, channel] = key.split(':')
    if (!isEvent(event) || !isChannel(channel)) continue
    out.add(key)
  }
  return out
}
