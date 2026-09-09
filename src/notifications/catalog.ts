// EVERY NOTIFIABLE EVENT IN THE APP, IN ONE LIST, AND IT IS THE SOURCE OF TRUTH
// FOR THE SETTINGS PAGE AS WELL AS FOR THE SENDERS.
//
// Pure — a table and a few lookups over it, no database and no environment — so
// it is testable under the house rule that governs test/. The queries live in
// ./service.ts and the send decision in ./policy.ts.
//
// **AN EVENT IS A `varchar`, NOT A pgEnum, AND THAT IS A DELIBERATE DEPARTURE
// FROM THE REST OF THE SCHEMA.** Nearly every other closed set here is an enum,
// correctly: `visibility`, `ride_perm`, `waypoint_role` are all fixed vocabulary
// that a migration should have to touch. This one is the opposite by design —
// the whole point of a catalog is that the fifteenth notification is a code
// change and nothing else, and `ALTER TYPE … ADD VALUE` per event turns "we
// should tell riders about X" into a migration, a deploy and an ordering trap
// (`visibility`'s member order is not its openness, and this list would grow the
// same scar tissue). `EVENTS` is the validator instead, and `isEvent()` is what
// every reader of a stored string goes through — a row naming an event this
// build has never heard of is ignored rather than trusted, which is what makes
// removing an event safe too.
//
// **THE CHANNELS ARE `varchar` FOR CONSISTENCY, NOT BECAUSE A THIRD IS
// PLANNED.** Two channels genuinely is a closed set and an enum would be
// defensible — but one column of each kind in one table is the arrangement that
// invites somebody to "fix" the inconsistency in the wrong direction. Same
// validator, same rule.

/** A notification's stable id. Stored in `notification_prefs.event` and in
 *  `notifications.event`, so renaming one orphans a rider's stored answer —
 *  which is the correct failure (they fall back to the default) but is still a
 *  rename, not a free edit. */
export type NotificationEvent = (typeof EVENTS)[number]['key']

/** Where a notification is delivered. */
export type Channel = 'email' | 'browser'

export const CHANNELS: readonly Channel[] = ['email', 'browser']

/**
 * The groups the settings page renders as boxes, in the order it renders them.
 *
 * Broadest and most frequent first: what happens on a ride is what a rider gets
 * most of, and the account row is the one they will hopefully never see.
 *
 * **FOUR AND NOT FIVE — `reports` WAS FOLDED INTO `account`.** Ziad's call,
 * 2026-09-07. It held exactly one event, so it rendered as a box with a heading,
 * two column labels and a single row in it, which reads as something
 * half-finished rather than as a category. Four is also what lays out evenly two
 * abreast, which is what the page does with them.
 *
 * The fold is honest rather than merely tidy: a report you filed is a thing of
 * YOURS the app is keeping you posted about, which is what every other row in
 * that group is. If reports ever grow a second and a third notification, they
 * earn their own group back.
 */
export const GROUPS = [
  { id: 'rides', label: 'Rides you are on' },
  { id: 'roster', label: 'Who is coming' },
  { id: 'people', label: 'People' },
  { id: 'account', label: 'Your account' },
] as const

// **`release` LIVES UNDER `account` FOR THE SAME REASON `reports` WAS FOLDED
// INTO IT.** Ziad's call, 2026-09-08 (#288). A release note is about the APP
// rather than about the rider, so a fifth group called "The app" is the honest
// label — and it would render as a heading, two column labels and a single row,
// which is exactly the half-finished shape the fold above was decided against.
// One slightly loose home beats one accurate empty box; when app-level
// notifications grow a second, they earn the group.

export type GroupId = (typeof GROUPS)[number]['id']

type EventDef = {
  readonly key: string
  readonly group: GroupId
  /** The control's own label on the settings page. Written from the RIDER'S
   *  side — "Somebody comments on your ride", not "Comment created" — because
   *  the page is a list of things that will happen to them. */
  readonly label: string
  /** One line under the label saying who triggers it and when, for the cases
   *  where the label alone leaves that ambiguous. */
  readonly detail: string
  /**
   * Whether this event can be turned off at all.
   *
   * **THERE IS NO `false` HERE AND THAT IS THE POINT OF THE FIELD EXISTING.**
   * Every event in this catalog is optional; the transactional mail — the magic
   * link, the waitlist confirmation, the account-approved message — is
   * deliberately ABSENT from the catalog rather than present with a switch
   * nailed to on. A rider cannot opt out of the email that lets them sign in,
   * and a control that says so by being disabled is a control that invites
   * somebody to enable it. Absence is the honest form.
   */
  readonly optional: true
}

/**
 * The catalog.
 *
 * **THE ORDER IS THE ORDER ON THE PAGE**, grouped by `group` in `GROUPS` order.
 * A new event goes beside its siblings rather than at the end.
 */
export const EVENTS = [
  // ── Rides ──────────────────────────────────────────────────────────────────
  {
    key: 'ride_comment',
    group: 'rides',
    label: 'Somebody comments on a ride you own',
    detail: 'Commenting is roster-only, so this is always somebody you put on the ride.',
    optional: true,
  },
  {
    key: 'ride_suggestion',
    group: 'rides',
    label: 'Somebody suggests a change to a ride you own',
    detail: 'A whole route proposed against yours, for you to accept or discard.',
    optional: true,
  },
  {
    key: 'suggestion_decided',
    group: 'rides',
    label: 'Your suggestion was accepted or discarded',
    detail: 'The other half of the one above, from the proposer’s side.',
    optional: true,
  },
  {
    key: 'vote_resolved',
    group: 'rides',
    label: 'A vote on an alternate route closed',
    detail: 'Only when a winner was actually elected—a tie changes nothing and says nothing.',
    optional: true,
  },
  // ── Roster ─────────────────────────────────────────────────────────────────
  {
    key: 'ride_added',
    group: 'roster',
    label: 'Somebody puts you on a ride',
    detail: 'You can only be added by a friend, so this is never a stranger.',
    optional: true,
  },
  {
    key: 'ride_rsvp',
    group: 'roster',
    label: 'Somebody says whether they are coming',
    detail: 'On a ride you own. One message per answer, including a changed one.',
    optional: true,
  },
  // ── People ─────────────────────────────────────────────────────────────────
  {
    key: 'friend_request',
    group: 'people',
    label: 'Somebody asks to be your friend',
    detail: 'A request is the one thing you cannot discover any other way.',
    optional: true,
  },
  {
    key: 'friend_accepted',
    group: 'people',
    label: 'Your friend request was accepted',
    detail: 'A decline sends nothing, deliberately—see the FAQ on how refusals work.',
    optional: true,
  },
  {
    key: 'new_follower',
    group: 'people',
    label: 'Somebody follows you',
    detail: 'Following is one-way and grants no access to anything of yours.',
    optional: true,
  },
  // ── Account ────────────────────────────────────────────────────────────────
  {
    key: 'feedback_status',
    group: 'account',
    label: 'Something changed on a report you filed',
    detail: 'Fixed, planned, being worked on, or not happening. Never on every edit.',
    optional: true,
  },
  {
    key: 'trash_purge_soon',
    group: 'account',
    label: 'A ride in your bin is about to be destroyed',
    detail: 'Once, a week before the thirty-day hold runs out. Restoring it stops the clock.',
    optional: true,
  },
  {
    key: 'quota_full',
    group: 'account',
    label: 'Your storage is nearly full',
    detail: 'Once when you cross the line, and again only after you drop back under it.',
    optional: true,
  },
  {
    key: 'account_purge_soon',
    group: 'account',
    label: 'Your account is about to be deleted',
    detail: 'Only if you asked for it. Signing in cancels the deletion.',
    optional: true,
  },
  {
    key: 'release',
    group: 'account',
    label: 'Routeloop changed',
    detail: 'The release notes, in your notifications, so you see what changed without going to look.',
    optional: true,
  },
] as const satisfies readonly EventDef[]

const BY_KEY = new Map<string, (typeof EVENTS)[number]>(EVENTS.map((e) => [e.key, e]))

/** Whether a stored string names an event THIS BUILD knows about.
 *
 *  Every read of `notification_prefs.event` goes through this. A row naming a
 *  removed or misspelled event is ignored rather than trusted, so deleting an
 *  event from the catalog is safe with no migration behind it — the orphaned
 *  rows simply stop being consulted, and the rider falls back to the default for
 *  whatever they still have. */
export const isEvent = (v: unknown): v is NotificationEvent => typeof v === 'string' && BY_KEY.has(v)

export const isChannel = (v: unknown): v is Channel => v === 'email' || v === 'browser'

/** The definition, or null. Null rather than a throw: this is reached from the
 *  send path, and a notification that cannot be described is one that should be
 *  skipped, not one that should take a request down with it. */
export const eventDef = (key: string) => BY_KEY.get(key) ?? null

/** The events in one group, in catalog order. What the settings page renders. */
export const eventsInGroup = (group: GroupId) => EVENTS.filter((e) => e.group === group)
