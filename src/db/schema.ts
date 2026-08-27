import { sql } from 'drizzle-orm'
import {
  pgTable,
  pgEnum,
  bigserial,
  bigint,
  varchar,
  boolean,
  integer,
  smallint,
  numeric,
  timestamp,
  doublePrecision,
  jsonb,
  uniqueIndex,
  index,
  check,
  primaryKey,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core'

// 'google' is the OAuth flow and 'email' is the magic link — the two ways a
// rider can arrive. 'github' and 'cloudflare' are retained only so historical
// identity rows stay valid; nothing issues them any more.
export const providerEnum = pgEnum('provider', ['google', 'github', 'cloudflare', 'email'])
// Cloudflare Access authenticates; this authorizes. Access admits any Google
// account, so a new rider lands 'pending' and waits for approval.
export const userStatusEnum = pgEnum('user_status', ['pending', 'active', 'blocked'])
// FOUR LEVELS as of 2026-08-26, and the order here is not the order of
// openness — a pgEnum's member order is fixed once created and adding `friends`
// at the end is what keeps the migration a plain ALTER TYPE ADD VALUE rather
// than a rebuild of every column using it.
//
// `public` and `unlisted` keep their exact previous meanings. `private` gains
// "and invited riders", which is a SUPERSET — and no ride has invitees, so no
// existing row changed meaning. See canView() in src/access/policy.ts for the
// whole rule; nothing should read this enum and decide for itself.
export const visibilityEnum = pgEnum('visibility', ['public', 'unlisted', 'private', 'friends'])
// WHICH EVENT IS PINNED when the clocks of several subgroups are solved against
// each other. A second axis from WHOSE clock is pinned, which is
// rides.primary_subgroup_id, and keeping them separate is what dissolves the
// contradiction #143 was written with: one group setting the departure while
// another is pinned at 9am is two anchors, and only one can hold.
//
//   departure  the primary group leaves at their day's start_at; everyone else
//              is solved so they arrive at the meet when that group does
//   meet       the first meet happens at a fixed time; every group, primary
//              included, is solved backwards from it
//   arrival    the primary group reaches the end of the day at a fixed time
export const timeAnchorEnum = pgEnum('time_anchor', ['departure', 'meet', 'arrival'])
// Three ways to hand out access, and the difference is not only max_uses. An
// 'email' invite is bound to an address and mailed; a 'link' is one URL handed
// to one person; a 'group' is pasted into a channel and read by everyone in it.
// Recorded rather than derived from max_uses, because a group link with one seat
// left is still a group link and the admin page has to say so.
export const inviteKindEnum = pgEnum('invite_kind', ['email', 'link', 'group'])
export const rideSourceEnum = pgEnum('ride_source', ['native', 'imported'])
export const pointKindEnum = pgEnum('point_kind', ['stop', 'poi'])
// How a stop's dwell time is WRITTEN, not how it is stored — points.duration_min
// stays integer minutes whatever this says. Canonical metadata, the formatter and
// the parser all live in src/maps/duration.ts, mirrored for the browser in
// public/js/duration.js; keep the three members here in step with the array
// there, which test/duration.test.ts also pins.
export const durationFormatEnum = pgEnum('duration_format', ['hours', 'hm', 'minutes'])
// How a DATE and a clock are written, per rider. Same arrangement as the enum
// above: a display layer over storage that is untouched by it — days.start_at
// stays a timestamp, ride.json stays ISO, every export is unaffected.
//
// The members are real BCP-47 tags rather than an abstract mdy/dmy/ymd, so Intl
// does the formatting and the clock and the number grouping follow the date order
// instead of needing their own setting. Canonical metadata and the formatters
// live in src/views/date-format.ts; keep these three in step with the array
// there, which test/date-format.test.ts pins.
export const dateFormatEnum = pgEnum('date_format', ['en-US', 'en-GB', 'en-CA'])
// The two appearance axes. Deliberately two enums rather than one of six members:
// theme is about which signals a rider can distinguish and scheme is about
// ambient light, and only the scheme axis can follow the operating system. See
// src/views/appearance.ts.
export const themeEnum = pgEnum('theme', ['default', 'contrast', 'colorblind'])
export const schemeEnum = pgEnum('scheme', ['system', 'light', 'dark'])
// The 17-category taxonomy carried over from the KML naming convention;
// canonical metadata lives in src/maps/roles.ts.
export const waypointRoleEnum = pgEnum('waypoint_role', [
  'start',
  'finish',
  'home',
  'meet',
  'split',
  'gas',
  'charge',
  'break',
  'camp',
  'hotel',
  'food',
  'coffee',
  'drinks',
  'grocery',
  'view',
  'poi',
  'wtf',
])

// What a rider is telling us. The fork is the first screen of the intake and it
// is the only classification they are asked for; everything else about a report
// is inferred or optional.
export const feedbackKindEnum = pgEnum('feedback_kind', ['bug', 'idea', 'question'])
// The OWNER'S GATE, and the thing that makes a bug private without a private-bug
// feature: nothing is visible to anyone but its author and the owner until it is
// 'published'. Deliberately separate from feedback_status below — collapsing the
// two into one enum is the mistake this pair exists to prevent, because a bug is
// routinely 'fixed' while still 'pending' and there is nothing contradictory
// about that.
export const feedbackStateEnum = pgEnum('feedback_state', ['pending', 'published', 'declined', 'duplicate', 'spam'])
// The RIDER-FACING lifecycle, orthogonal to the gate above. Every member has a
// label and a sub-line in STATUS_META in src/feedback/policy.ts, and
// test/feedback-status-labels.test.ts fails the build if one is added here
// without copy — a raw enum value rendered to a rider is the failure mode.
export const feedbackStatusEnum = pgEnum('feedback_status', [
  'new',
  'needs_info',
  'confirmed',
  'planned',
  'in_progress',
  'shipped',
  'on_list',
  'not_doing',
  'no_repro',
  'by_design',
])

// Only what authorization and the page chrome need on every request — see
// user_profiles below for the rest, which deliberately stays off this row.
export const users = pgTable(
  'users',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    email: varchar('email', { length: 255 }).unique(),
    displayName: varchar('display_name', { length: 255 }).notNull(),
    username: varchar('username', { length: 30 }), // null until the rider picks one
    // The rider's stable public handle: `{first-username}-{YYMMDDTHHMMZ}`, e.g.
    // `ziad-260801T2220Z`. Written once, when a username is first chosen, and
    // never again — a later username change deliberately does not touch it, so
    // anything that has ever referred to this rider keeps resolving.
    //
    // Not a UUID and not named one. It is derived, so it cannot exist before
    // the username does, which is why this is nullable: rows created before the
    // signup prompt get theirs on the rider's next visit. Uniqueness holds by
    // construction — usernames are unique at any instant, so a name plus the
    // minute it was claimed cannot collide.
    publicId: varchar('public_id', { length: 64 }).unique(),
    avatarUrl: varchar('avatar_url', { length: 512 }),
    // Defaulting to 'active' is load-bearing, not an oversight: drizzle-kit push
    // stamps the default onto every existing row, so a 'pending' default would
    // flip the owner's own account to pending and lock them out of the app that
    // does the approving. resolveUser() writes 'pending' explicitly on the
    // insert path instead.
    status: userStatusEnum('status').notNull().default('active'),
    // When the "you're approved" email went out, or null if it never has.
    //
    // This is what makes that email exactly-once for the life of an account.
    // /admin can toggle active -> blocked -> active freely, and every one of
    // those transitions is a genuine status change, so "did the status change"
    // is not a sufficient guard on its own — it would mail a rider again every
    // time they were reinstated.
    //
    // Nullable with no default, and that is deliberate rather than incidental:
    // drizzle-kit push stamps a default onto every existing row, so defaulting
    // this to now() would mark every current account as already-notified, which
    // is the same class of mistake the status default above documents.
    //
    // To resend deliberately: UPDATE users SET approved_email_at = NULL.
    approvedEmailAt: timestamp('approved_email_at'),
    // When an invite let this rider into the Rider Survey, or null if none has.
    //
    // Denormalized from invite_redemptions -> invites.grants_survey, and the
    // reason is the nav: it decides whether to render a Survey item on every
    // page render, and this row is already loaded by withSession. Deriving it
    // would mean a join on every request or an eager join in withSession, which
    // is exactly the growth the users / user_profiles split below exists to
    // avoid. The join is the truth; this is the cache, like used_bytes above.
    //
    // A timestamp rather than a boolean because it also answers "when were they
    // let in", which the admin page wants, and null/not-null is the flag.
    //
    // Nullable with no default, for the reason approved_email_at documents.
    surveyInvitedAt: timestamp('survey_invited_at'),
    canManageRiders: boolean('can_manage_riders').notNull().default(false),
    // 100 MB, raised from 25 when stored originals started being compressed.
    //
    // The rise is the POINT of that change rather than a side effect: brotli
    // takes a real 8-day GPX import from 834 kB to 60 kB, so the same disk now
    // holds an order of magnitude more ride. Quota accounting deliberately still
    // counts the UNCOMPRESSED size — an allowance must not depend on how well a
    // rider's file happened to zip — so the way that saving reaches them is a
    // bigger number here.
    //
    // Only IMPORTED files count against this — a ride built in the builder writes
    // nothing to disk — and one import is stored three times over: the original
    // upload byte-for-byte, plus a generated KML and a generated GPX, which is
    // what size_bytes on rides sums. Call it 0.3–1 MB per imported riding day, so
    // 25 MB is roughly 25–80 days.
    //
    // The number is bounded below by two things, and moving it down further
    // breaks one of them: the 16 MB per-request body limit in routes/maps.ts, and
    // the 200,000-point ride cap, whose worst case is about 24 MB. A quota under
    // either would refuse a legitimate import for a reason the rider cannot see.
    //
    // Changing this default does NOT touch existing rows — for a column that
    // already exists, push emits ALTER COLUMN SET DEFAULT and Postgres applies it
    // to new inserts only. That is the mirror image of the hazard the status and
    // approved_email_at comments describe above, and it is why
    // utils/deploy/sql/2026-08-08-quota-25mb.sql carries an explicit UPDATE.
    quotaBytes: bigint('quota_bytes', { mode: 'number' }).notNull().default(104857600), // 100 MB
    // Denormalized cache of sum(rides.size_bytes), incremented on import and
    // decremented on delete, with no reconciler — so it drifts, and has. The
    // dashboard computes the authoritative sum alongside it and reports the
    // disagreement rather than trusting this.
    usedBytes: bigint('used_bytes', { mode: 'number' }).notNull().default(0),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
    lastLoginAt: timestamp('last_login_at'),

    // GTFO — "Delete Me" and the 30-day hold before anything is destroyed.
    //
    // Three nullable timestamps rather than a fourth user_status value, and the
    // reason is that status has to survive the round trip. A pending rider and a
    // blocked rider can both delete their account, and "Save Me" has to put them
    // back exactly where they were — a 'deleted' status destroys that fact and
    // forces a previous_status column anyway, at which point the enum value
    // bought nothing and cost an ALTER TYPE. Additive columns also leave every
    // existing `status !== 'active'` check alone.
    //
    // Nullable with no default, for the reason approved_email_at documents
    // above: a schema push stamps a default onto every existing row. Null here
    // means "has never asked to leave", which is true of every row today, so
    // there is no backfill to get wrong.
    deletionRequestedAt: timestamp('deletion_requested_at'),
    // The deadline, stored rather than derived from deletion_requested_at +
    // DELETION_HOLD_DAYS. It is a promise made to a person on a date, and
    // deriving it means changing that constant later retroactively moves a purge
    // date a rider was already shown. Same reasoning as invites.expires_at.
    purgeAfter: timestamp('purge_after'),
    // Claimed by the purge before it starts, so a crash cannot wedge the row and
    // two triggers cannot both run it. See src/account/purge.ts.
    purgeStartedAt: timestamp('purge_started_at'),
  },
  (t) => [
    index('idx_user_status').on(t.status),
    // Case-insensitive: "Ziad" and "ziad" are the same handle.
    uniqueIndex('uq_username_lower').on(sql`lower(${t.username})`),
    // The sweep asks "who is due" and nothing else; without this it is a scan of
    // every rider to find the none of them that usually qualify.
    index('idx_users_purge_due').on(t.purgeAfter),
  ],
)

// The profile record. Separate from `users` on purpose: withSession() selects
// the whole users row on every request and jsonScript() serializes arbitrary
// objects into page HTML, so keeping a street address and four payment handles
// off that row means a careless `tb: { user }` can never leak them to a client.
// Only the profile page loads this table.
export const userProfiles = pgTable('user_profiles', {
  // The FK is the PK — one profile per user, no surrogate id to keep in sync.
  userId: bigint('user_id', { mode: 'number' })
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  firstName: varchar('first_name', { length: 80 }),
  lastName: varchar('last_name', { length: 80 }),
  addressLine: varchar('address_line', { length: 255 }),
  city: varchar('city', { length: 120 }),
  // Free text, not a US state list — the labels are US-shaped but nothing here
  // should reject a rider outside it.
  state: varchar('state', { length: 80 }),
  postalCode: varchar('postal_code', { length: 20 }),
  // Geocoded from the address on the client so the builder never has to. Null
  // whenever the address did not resolve; a failed lookup must not block a save.
  homeLat: doublePrecision('home_lat'),
  homeLng: doublePrecision('home_lng'),
  // The public starting point: where a shared ride begins instead of the
  // rider's front door. Mirrors the home block above field for field so both
  // geocode and edit the same way.
  //
  // This exists because moving the *pin* is not enough — a route seeded from
  // home is drawn from home, and the first leg points at the house whatever the
  // marker says. Swapping the start has to happen while planning, not while
  // rendering, which is why this is a stored place rather than a display rule.
  // A gas station, coffee shop or trailhead a few minutes away is the intent.
  startLabel: varchar('start_label', { length: 120 }),
  startAddressLine: varchar('start_address_line', { length: 255 }),
  startCity: varchar('start_city', { length: 120 }),
  startState: varchar('start_state', { length: 80 }),
  startPostalCode: varchar('start_postal_code', { length: 20 }),
  startLat: doublePrecision('start_lat'),
  startLng: doublePrecision('start_lng'),
  shareLastName: boolean('share_last_name').notNull().default(false),
  addHomeToRides: boolean('add_home_to_rides').notNull().default(false),
  sharePaymentHandles: boolean('share_payment_handles').notNull().default(false),
  cashApp: varchar('cash_app', { length: 120 }),
  venmo: varchar('venmo', { length: 120 }),
  paypal: varchar('paypal', { length: 120 }),
  zelle: varchar('zelle', { length: 120 }),
  // The first genuine preference on the profile, and the first real content on
  // /settings. It changes how the builder's duration field reads and nothing
  // else: the stored unit is minutes and every export, the roadbook and the
  // timeline are untouched by it.
  //
  // Defaulted rather than nullable so there is no third state to handle. Every
  // reader would otherwise have to answer "null means what?" and they would not
  // all answer the same way.
  durationFormat: durationFormatEnum('duration_format').notNull().default('hours'),
  // Defaulted rather than nullable for the same reason as durationFormat above:
  // no third state for every reader to interpret differently. The signup path
  // seeds it from Accept-Language, so the default is what a rider gets only when
  // the header says nothing useful.
  dateFormat: dateFormatEnum('date_format').notNull().default('en-US'),
  // The palette and the light/dark scheme, defaulted for the same reason as the
  // two above: no third state for a reader to interpret.
  //
  // UNLIKE dateFormat, NEITHER IS SEEDED FROM A HEADER, and that is what makes
  // them safe to add. `date_format` has to be seeded from Accept-Language on
  // INSERT — see the handlers in settings.tsx — because a German browser should
  // get day-first without anyone choosing. There is no header for a palette, and
  // 'system' already means "ask the browser" on the one axis where the browser
  // has an opinion, so the column defaults are the whole answer and no existing
  // upsert has to learn about these.
  theme: themeEnum('theme').notNull().default('default'),
  scheme: schemeEnum('scheme').notNull().default('system'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})

// What a bike runs on. `gas`, not `petrol`: American English everywhere in code,
// comments and copy, the same rule that keeps `color` spelled that way. It
// shares a word with the `gas` waypoint role and that is not a collision — one
// is a reason to stop, the other is what a machine drinks.
export const fuelTypeEnum = pgEnum('fuel_type', ['gas', 'electric'])

// THE PADDOCK — a rider's bikes.
//
// Owned by the rider and not by any ride. A ride will eventually record WHICH
// bike someone brought, but that is ride membership's problem (#71) and it is
// deliberately not modeled here: a bike is a fact about a person that outlives
// any trip, and the fuel-stop math in #11 only needs to know a range.
//
// RANGE IS STORED IN METERS, although the rider types miles.
//
// Both spellings exist in this schema already — `route_legs.distance_m` and
// `days.distance_m` are meters, `rides.total_miles` is miles as a cache — so
// this is a choice rather than a convention to follow. Meters, because #150 will
// let a rider switch the whole site to metric, and a value stored in the unit
// somebody happened to type drifts on every round trip: a rider entering 300 km
// against a mile column gets 186 mi stored and 299.3 km read back. Storing the
// unit-free quantity means neither reader sees the other's rounding.
//
// NULLABLE, and null is not zero — the rule this app states everywhere. Null
// means nobody has measured this bike's range, which is the state every bike
// starts in and a perfectly reasonable one to leave it in; zero would mean a
// machine that cannot leave the driveway. Range features must skip a null rather
// than treating it as a very thirsty bike.
export const bikes = pgTable(
  'bikes',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    ownerId: bigint('owner_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // All four nullable, and the label falls back through them — see
    // bikeLabel() in src/bikes/policy.ts. A rider who types "the orange one" and
    // nothing else has described their bike well enough for every surface here.
    nickname: varchar('nickname', { length: 80 }),
    make: varchar('make', { length: 60 }),
    model: varchar('model', { length: 80 }),
    year: smallint('year'),
    fuelType: fuelTypeEnum('fuel_type').notNull().default('gas'),
    usableRangeM: integer('usable_range_m'),
    // How far this rider is good for on THIS bike before they want off it.
    // On the bike rather than on the rider, deliberately: a tourer and a
    // supermoto are not the same day, and the number a rider would give changes
    // with which one is in the garage.
    comfortRangeM: integer('comfort_range_m'),
    // The photo's bookkeeping, mirroring rides.thumb_hash: the hash is a
    // fingerprint that lets the route serve the image immutable, because a
    // changed picture is a changed URL.
    //
    // `photo_bytes` IS COUNTED HERE AND NOWHERE ELSE. It must stay out of
    // rides.size_bytes and out of users.used_bytes — a bike photo is not ride
    // data, must not eat a quota that exists to bound route uploads, and a
    // fourth byte column in that generated expression would corrupt quota
    // accounting on every ride delete. Exactly the arrangement
    // feedback_attachments already has, for exactly the same reason.
    photoHash: varchar('photo_hash', { length: 32 }),
    photoBytes: integer('photo_bytes').notNull().default(0),
    // Which bike the rider is assumed to be on. Enforced as AT MOST ONE by the
    // partial unique index below rather than by app code, so two defaults cannot
    // exist however the rows were written.
    isDefault: boolean('is_default').notNull().default(false),
    // Rider-defined order, so a paddock reads the way its owner thinks about it
    // rather than alphabetically. Same as place_groups.position.
    position: smallint('position').notNull().default(0),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('idx_bike_owner').on(t.ownerId),
    // At most one default per rider, in the database rather than in a service
    // that has to remember to clear the old one first.
    uniqueIndex('uq_bike_default')
      .on(t.ownerId)
      .where(sql`${t.isDefault}`),
    // A range is a distance, not a fantasy. The ceiling is 2,000,000 m — about
    // 1,240 miles, comfortably past any production motorcycle — and exists so a
    // fat-fingered entry cannot poison a fuel-stop calculation downstream.
    check('ck_bike_range', sql`${t.usableRangeM} is null or (${t.usableRangeM} > 0 and ${t.usableRangeM} <= 2000000)`),
    check(
      'ck_bike_comfort',
      sql`${t.comfortRangeM} is null or (${t.comfortRangeM} > 0 and ${t.comfortRangeM} <= 2000000)`,
    ),
  ],
)

// Every username a rider has held, current one included. Two jobs: showing them
// their own history, and keeping a released name out of anyone else's hands for
// a cooling-off period so a change of mind is recoverable.
//
// The window cannot be an index — "unavailable unless you are the rider who
// released it" is not something a unique constraint can express — so it is an
// application check, and uq_username_lower on users remains the hard guard
// against two riders holding the same name at once.
export const usernameHistory = pgTable(
  'username_history',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    username: varchar('username', { length: 30 }).notNull(),
    claimedAt: timestamp('claimed_at', { withTimezone: true }).notNull().defaultNow(),
    // Null means this is the name the rider holds right now. Set on the way out,
    // and the cooling-off window is measured from it.
    releasedAt: timestamp('released_at', { withTimezone: true }),
  },
  (t) => [
    index('idx_username_history_user').on(t.userId),
    // The availability check looks a name up case-insensitively, matching how
    // uq_username_lower treats them: "Ziad" and "ziad" are the same handle.
    index('idx_username_history_name').on(sql`lower(${t.username})`),
  ],
)

// One user may retain legacy OAuth identities alongside Cloudflare Access.
export const userIdentities = pgTable(
  'user_identities',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: providerEnum('provider').notNull(),
    providerUserId: varchar('provider_user_id', { length: 255 }).notNull(),
    providerEmail: varchar('provider_email', { length: 255 }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('uq_provider_identity').on(t.provider, t.providerUserId), index('idx_user').on(t.userId)],
)

// Server sessions. The primary key is the SHA-256 hash of the token we hand the
// browser, never the token itself — a leaked database therefore yields no usable
// session cookies.
export const sessions = pgTable(
  'sessions',
  {
    id: varchar('id', { length: 64 }).primaryKey(), // hex sha256 of the token
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [index('idx_session_user').on(t.userId), index('idx_session_expires').on(t.expiresAt)],
)

// Magic-link tokens, following the sessions table above exactly: the primary key
// is the SHA-256 hash of the token that was emailed, never the token itself, so
// a leaked table yields nothing redeemable.
//
// Keyed on email rather than user id on purpose — a link can be requested for an
// address with no account yet, and that is the signup path.
export const loginTokens = pgTable(
  'login_tokens',
  {
    id: varchar('id', { length: 64 }).primaryKey(), // hex sha256 of the token
    email: varchar('email', { length: 255 }).notNull(),
    expiresAt: timestamp('expires_at').notNull(),
    // Set inside the same transaction that creates the session. Single use is
    // what stops a forwarded email being a replayable credential.
    consumedAt: timestamp('consumed_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [
    // Rate limiting counts recent rows per address; expiry sweeps read the other.
    index('idx_login_token_email').on(t.email, t.createdAt),
    index('idx_login_token_expires').on(t.expiresAt),
  ],
)

// A grant of access, issued by a manager, redeemed by whoever holds the link.
//
// The token follows login_tokens exactly: random bytes handed out, only the
// SHA-256 hash stored, so a leaked table yields nothing redeemable. What is
// deliberately NOT here is any notion of the invite identifying a person — a
// group link is read by a whole Discord channel, so the only identity that ever
// matters is the one the redeemer signs in with. invite_redemptions is where
// people appear.
//
// This is not a second authorization system. grants_beta performs the same
// pending -> active transition /admin performs, through the same rule in
// src/emails/rules.ts. There is no third account state and no invite-specific
// capability.
//
// THE SECURITY MODEL IS REVOCABLE-AND-OBSERVABLE, NOT UNFORGEABLE. A link
// pasted into a channel will leak past it; treat that as certain rather than as
// a risk. uq_redemption_invite_user stops one account redeeming twice, and
// nothing stops one person with three Google accounts. The controls that
// actually work are max_uses as a hard budget, label so you can tell which link
// leaked, expires_at, revoked_at, and rotating token_hash.
export const invites = pgTable(
  'invites',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    // Rotatable, which is why this is a unique index and not the primary key the
    // way it is on login_tokens and sessions. Regenerating answers a leak while
    // keeping the row's identity, its label and its redemption history.
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    kind: inviteKindEnum('kind').notNull(),
    grantsSurvey: boolean('grants_survey').notNull().default(false),
    grantsBeta: boolean('grants_beta').notNull().default(false),
    // Set only for kind='email'. NOT enforced at redemption: people are mailed
    // at one address and sign in with another constantly, and refusing that
    // would strand exactly the invitees who did nothing wrong.
    email: varchar('email', { length: 255 }),
    // What this link is for, in the manager's own words — "MC Discord #general".
    // The only thing that tells you WHICH link leaked.
    label: varchar('label', { length: 120 }),
    maxUses: integer('max_uses').notNull().default(1),
    // A cache of invite_redemptions rows with consumed_seat, kept here so the
    // seat claim is one conditional UPDATE rather than a count under a lock.
    usedCount: integer('used_count').notNull().default(0),
    expiresAt: timestamp('expires_at').notNull(),
    revokedAt: timestamp('revoked_at'),
    // SET NULL, not cascade, and nullable for that reason alone.
    //
    // Cascading here means purging a manager deletes their invites, and
    // invite_redemptions cascades from invites — so it would take OTHER riders'
    // record of how they got in as a side effect of a third party leaving. That
    // audit trail is not the departing rider's to take. The departing rider's own
    // redemption row still goes, via invite_redemptions.user_id, which is
    // correct because that row is theirs.
    //
    // Losing "who minted it" is the cheapest thing to lose: label already
    // carries the human meaning of a link ("MC Discord #general").
    createdBy: bigint('created_by', { mode: 'number' }).references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uq_invite_token').on(t.tokenHash),
    index('idx_invite_created').on(t.createdBy, t.createdAt),
    // An invite that grants nothing is a bug, not a state.
    check('ck_invite_grants_something', sql`grants_survey or grants_beta`),
    check('ck_invite_uses', sql`max_uses >= 1 and used_count >= 0 and used_count <= max_uses`),
    check('ck_invite_email_kind', sql`kind <> 'email' or email is not null`),
  ],
)

// Who came in through which invite. The audit trail invites.used_count caches.
//
// The unique index is the idempotency MECHANISM, not a report: it is what makes
// a double-click, a retried POST and a second visit a week later all cost one
// seat. redeemInvite() reads a zero-row insert as "this rider is already in".
//
// consumed_seat records whether this redemption incremented invites.used_count.
// It is false when the invite had nothing left to give this rider — an already
// active member opening a group link out of curiosity — because seats are a
// budget for letting NEW people in. Without it, a 25-seat link pasted into a
// channel of 40 riders who mostly have accounts is exhausted by people who
// gained nothing, which is the group link quietly failing.
export const inviteRedemptions = pgTable(
  'invite_redemptions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    inviteId: bigint('invite_id', { mode: 'number' })
      .notNull()
      .references(() => invites.id, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    consumedSeat: boolean('consumed_seat').notNull().default(false),
    redeemedAt: timestamp('redeemed_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uq_redemption_invite_user').on(t.inviteId, t.userId),
    index('idx_redemption_invite').on(t.inviteId, t.redeemedAt),
    index('idx_redemption_user').on(t.userId),
  ],
)

// One rider's answers to the Rider Survey. The FK is the PK — one response per
// rider, no surrogate id to keep in sync — following user_profiles above.
//
// answers is jsonb and the question set lives in src/survey/questions.ts, so
// changing a question is a code change and never a migration. That is the whole
// point: drizzle-kit push is the only migration tool here and it is dangerous,
// so this feature is deliberately DDL-free after day one.
//
// $type<> is a compile-time claim Postgres does not enforce. EVERY read goes
// through parseAnswers(), which is lenient by design — a draft written under
// SURVEY_VERSION 1 and read by version 2 code has missing keys, and casting
// would assert they are there.
//
// submitted_at null means a draft in progress. The admin summary counts only
// submitted rows; the rider may keep editing either way.
export const surveyResponses = pgTable(
  'survey_responses',
  {
    userId: bigint('user_id', { mode: 'number' })
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    surveyVersion: smallint('survey_version').notNull().default(1),
    answers: jsonb('answers')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    submittedAt: timestamp('submitted_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [index('idx_survey_submitted').on(t.submittedAt)],
)

// The shareable package (docs/ideas.md), and the top of the hierarchy:
// ride > day > leg > stop/POI. The slug is the share id; visibility gates. Byte
// columns describe imported originals on disk and drive quota — native rides
// have zero bytes and no files. totalMiles/totalDurationS/stopCount are caches
// recomputed on every save/import.
export const rides = pgTable(
  'rides',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    ownerId: bigint('owner_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    slug: varchar('slug', { length: 22 }).notNull(), // unguessable public id
    title: varchar('title', { length: 150 }).notNull(),
    description: varchar('description', { length: 2000 }),
    visibility: visibilityEnum('visibility').notNull().default('private'),
    source: rideSourceEnum('source').notNull().default('imported'),
    externalUrl: varchar('external_url', { length: 2048 }),
    // WHEN THE ALTERNATE VOTE CLOSES, and null — which is every row that existed
    // before this landed — means it never does. A null tally is ADVISORY: the
    // numbers are shown beside each alternate and the owner promotes one by
    // hand, which is exactly what the builder already does. Set, and the sweep
    // in src/votes/resolve.ts elects each group's leader at that moment.
    //
    // Opt-in per ride rather than a global default, deliberately. Something that
    // rewrites which road a ride takes, unattended, on a site real riders have
    // accounts on, should be a thing the owner asked for.
    altVotesCloseAt: timestamp('alt_votes_close_at', { withTimezone: true }),
    // WHOSE CLOCK IS FIXED. Not a decision the app can make fairly on its own:
    // 3 miles against 60 to a 6am meet is unfair, the same two distances to a
    // 10am meet heading the other way is not, and only the planner knows which
    // they are looking at. #67 is explicit that the DEFAULT must not be the
    // planner's own group — it is the one most likely to be nearest the meet,
    // so that default reproduces the unfair case every time and the planner
    // does not notice, being the one who rode three miles.
    primarySubgroupId: bigint('primary_subgroup_id', { mode: 'number' }).references((): AnyPgColumn => rideSubgroups.id, {
      onDelete: 'set null',
    }),
    // WHOSE ROUTE IS THE SPINE a rendezvous is proposed against. A SEPARATE
    // COLUMN from the one above although the UI asks once, because the two come
    // apart: they are the same group when Sacramento joins Oakland's run to the
    // Sierras, and they are not the same thing at all when Seattle and San
    // Francisco meet in eastern Oregon — there is no trunk there and the ride
    // starts at the meet. #67 says keep them separate in the model and this is
    // that.
    trunkSubgroupId: bigint('trunk_subgroup_id', { mode: 'number' }).references((): AnyPgColumn => rideSubgroups.id, {
      onDelete: 'set null',
    }),
    timeAnchor: timeAnchorEnum('time_anchor').notNull().default('departure'),
    gpxPresent: boolean('gpx_present').notNull().default(false),
    kmlBytes: integer('kml_bytes').notNull().default(0),
    gpxBytes: integer('gpx_bytes').notNull().default(0),
    // What the ride actually arrived as, which kml_bytes/gpx_bytes cannot say:
    // a KMZ is stored as the KML pulled out of it, and a GeoJSON or CSV has no
    // column of its own. NULL for a ride built here rather than imported.
    sourceFormat: varchar('source_format', { length: 10 }),
    // Bytes of the stored original for the formats without a dedicated column.
    // Kept separate rather than folded into kml_bytes so "how big is the KML"
    // stays answerable.
    sourceBytes: integer('source_bytes').notNull().default(0),
    // Must include every byte column. used_bytes is incremented by the app on
    // import and decremented by this on delete, so a column missing here means
    // quota leaks a little on every delete, permanently and silently.
    sizeBytes: integer('size_bytes').generatedAlwaysAs(sql`kml_bytes + gpx_bytes + source_bytes`),
    totalMiles: numeric('total_miles', { precision: 7, scale: 1 }).notNull().default('0'),
    totalDurationS: integer('total_duration_s').notNull().default(0),
    stopCount: smallint('stop_count').notNull().default(0),
    viewCount: integer('view_count').notNull().default(0),
    // The thumbnail's bookkeeping. Both null means one has never been built,
    // which is the state every existing ride starts in and the state a ride with
    // no drawable geometry stays in — the card shows its color swatch instead.
    //
    // `thumb_hash` is a fingerprint of the Static Maps request MINUS the API
    // key; see src/maps/thumbnail.ts for why the key is kept out of it. The
    // sweep recomputes the request and skips the fetch when the hash matches, so
    // retitling a ride, changing a stop's dwell or flipping visibility all cost
    // a query and nothing else.
    //
    // There is deliberately NO byte column here. The PNG is derived data, not
    // the rider's file: it must not eat a quota that exists to bound uploads,
    // and `size_bytes` above must name every byte column on this table, so a
    // column that has to be excluded from it does not belong on it. Same
    // reasoning as feedback_attachments, which counts its bytes in its own
    // table for exactly this reason.
    thumbHash: varchar('thumb_hash', { length: 32 }),
    thumbBuiltAt: timestamp('thumb_built_at'),

    // The recycle bin. Same three-column shape as the GTFO hold on `users`, and
    // deliberately so: that is a 30-day reversible hold that ends in a purge,
    // and so is this. See src/trash/policy.ts for the rules and
    // src/account/policy.ts for the original argument behind each column.
    //
    // Nullable with no default, for the reason approved_email_at documents
    // above: a schema push stamps a default onto every existing row. Null here
    // means "not in the bin", which is true of every row today, so there is no
    // backfill to get wrong.
    deletedAt: timestamp('deleted_at'),
    // The deadline, stored rather than derived from deleted_at + the constant.
    // It is a promise made to a person on a date, so changing TRASH_HOLD_DAYS
    // later must not retroactively move a purge date a rider was already shown.
    //
    // Recomputed on every trash, which is ALSO what makes the reset work: taking
    // a ride out of the bin and putting it back sets a fresh 30 days with no
    // separate mechanism.
    purgeAfter: timestamp('purge_after'),
    // Claimed by the purge before it starts, so a crash cannot wedge the row and
    // two triggers cannot both run it. Rides carry this and places/groups do not
    // because a ride purge also removes files from disk and can therefore
    // half-finish; a place purge is one statement.
    purgeStartedAt: timestamp('purge_started_at'),

    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uq_slug').on(t.slug),
    index('idx_owner').on(t.ownerId),
    index('idx_browse').on(t.visibility, t.createdAt),
    index('idx_popular').on(t.visibility, t.viewCount),
    // What the sweep selects on: rides edited since their thumbnail was built.
    // Partial, because a ride whose thumbnail is current is the overwhelming
    // majority and is never a candidate — the index only needs to hold the work
    // queue. `thumb_built_at is null` is in it so a ride that has never been
    // rendered is picked up by the same scan.
    index('idx_thumb_stale')
      .on(t.updatedAt)
      .where(sql`${t.thumbBuiltAt} is null or ${t.updatedAt} > ${t.thumbBuiltAt}`),
    // What the purge sweep selects on. Partial for the same reason
    // idx_thumb_stale is: a ride in the bin is a rounding error against every
    // ride that is not, and the index only has to hold the work queue.
    index('idx_rides_purge_due')
      .on(t.purgeAfter)
      .where(sql`${t.deletedAt} is not null`),
  ],
)

// One day within a ride: ordered stops joined by routed legs. The time model
// (startAt/endAt) exists now so the timeline slider is pure UI later.
// distanceM/durationS are caches over the day's legs.
//
// Called `routes` until 2026-08-09, which collided twice: with `route` meaning
// a whole ride in the import copy, and with the ~130 `adminRoutes`/`app.route()`
// identifiers that mean HTTP handlers. Every rider-facing surface already said
// "day" — the builder slider, the viewer legend, DAY_COLORS, the `d02` filename
// field — so the table moved to meet them rather than the other way around.
//
// A day is a *position* within a ride, not a calendar date: two days can share
// a date, and a ride with no dates at all still has days.
export const days = pgTable(
  'days',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    rideId: bigint('ride_id', { mode: 'number' })
      .notNull()
      .references(() => rides.id, { onDelete: 'cascade' }),
    position: smallint('position').notNull(), // 0-based order within the ride
    title: varchar('title', { length: 150 }).notNull().default(''),
    color: varchar('color', { length: 7 }).notNull().default('#0000cc'),
    // A WALL CLOCK AT THE DEPARTURE POINT, CARRIED AS UTC — not an instant.
    // Ziad's call, 2026-08-24: a time is a time is a time at the departure
    // point, so a 9am departure is 9am where the bike is and nothing converts it
    // into anyone's local time. `public/js/day-clock.js` is the only place the
    // conversion between this and an input field happens; read its header first.
    //
    // The type stays `timestamptz` even though the value is now naive, and that
    // is measured rather than assumed: node-postgres parses `timestamp without
    // time zone` in the PROCESS's zone, so a stored 09:00 read back on a Pacific
    // machine comes out 16:00Z and the app's behavior depends on `TZ`.
    // `timestamptz` round-trips the exact digits in both directions with no type
    // parser and no environment dependency. The type is a carrier, not a claim.
    startAt: timestamp('start_at', { withTimezone: true }),
    endAt: timestamp('end_at', { withTimezone: true }),
    distanceM: integer('distance_m').notNull().default(0),
    durationS: integer('duration_s').notNull().default(0),
    // How twisty the day's roads are, in degrees of heading change per mile.
    // See src/maps/twist.ts. Computed from geometry at write time in both the
    // builder save and the KML/GPX import, so imported rides get one too.
    //
    // Nullable on purpose, and null is NOT the same as 0: 0 claims the road is
    // straight, null says nothing has measured it. Every row predating this
    // column is null until utils/backfill-twistiness.ts runs, and a day with
    // no legs stays null forever.
    twistinessDpm: integer('twistiness_dpm'),
    // The same figure over the twistiest 20-mile stretch of the day, which is
    // the number that actually tells a rider whether to go — a day average
    // buries 40 good miles under 200 of slab.
    twistinessBestDpm: integer('twistiness_best_dpm'),
    // THE DAY'S DURABLE IDENTITY, and the same answer points.uid is to the same
    // problem — see src/maps/uid.ts. `days.id` churns on every save because the
    // builder's PUT deletes and re-inserts every day, and `alt_group` below is
    // renumbered densely from 0 every time, so NEITHER can be referenced from
    // another table. A vote on an alternate is the first feature that needs a
    // day to keep its identity across a save, and this is what it keeps.
    //
    // Client-minted, exactly like a point's: same alphabet, same length, or the
    // save 400s. Backfilled for every pre-existing row in drizzle/0015.
    uid: varchar('uid', { length: 12 }).notNull(),
    // WHOSE DAY THIS IS. Null means everyone rides it — the trunk — and that is
    // the value every day that predates #67 carries, which is why this needed
    // no backfill.
    //
    // A subgroup owns a SUBSEQUENCE of the ride's positions rather than a
    // parallel numbering of its own, so uq_day_ride_pos is untouched and a
    // multi-day approach is simply more days: Seattle takes 0 and 1, SF takes
    // 2, the trunk takes 3. Which days happen on the same calendar day is
    // carried by start_at, which already exists.
    //
    // `set null` on delete: removing a subgroup makes its days everyone's
    // rather than destroying them. Losing a rider's planned road because they
    // renamed a group wrong would be the place_groups mistake over again.
    subgroupId: bigint('subgroup_id', { mode: 'number' }).references((): AnyPgColumn => rideSubgroups.id, { onDelete: 'set null' }),
    // ALTERNATES: two or more candidate routings for the same stretch, of which
    // exactly one counts toward the ride's mileage. See src/maps/alts.ts, which
    // owns every rule about these two columns.
    //
    // A WITHIN-PAYLOAD PARTITION KEY, NOT A STABLE ID. `alt_group` is rewritten
    // densely from 0 on every save and means only "these days are siblings".
    // Nothing may store it, join to it from another table, or expect the value
    // a rider saw yesterday. That is forced rather than chosen: the autosave in
    // src/routes/builder.ts deletes every day of a ride and reinserts it, so no
    // `days.id` survives a save and a real foreign key has nothing to point at.
    //
    // Null means a plain day. A group always has at least two members — one is
    // dissolved back to null — so a non-null value here is never alone.
    altGroup: smallint('alt_group'),
    // Which member of the group counts. Meaningless while alt_group is null,
    // and forced true there so a stale false cannot hide a plain day from every
    // mileage total in the app.
    //
    // NOT NULL DEFAULT true is what makes this migration need no backfill:
    // `alt_group IS NULL, alt_active = TRUE` is already a true description of
    // every row that existed before it, so every stored rides.total_miles and
    // every dashboard figure stays correct on the day it lands. Contrast
    // twistiness_dpm above, which needed utils/backfill-twistiness.ts.
    altActive: boolean('alt_active').notNull().default(true),
  },
  (t) => [
    uniqueIndex('uq_day_ride_pos').on(t.rideId, t.position),
    // Scoped to the ride rather than global, the same way uq_point_day_uid is
    // scoped to the day: a uid is unique where it is REFERENCED FROM, and
    // alt_votes is keyed by (ride_id, day_uid). A global unique index would also
    // make importing a native JSON file twice fail on the second copy.
    uniqueIndex('uq_day_ride_uid').on(t.rideId, t.uid),
    // A TRIPWIRE, NOT A GATE. resolveAltGroups() is total and always elects
    // exactly one active member, so this should be unreachable — it is here to
    // turn a hole in that function into a loud failure rather than a quietly
    // stored ride whose mileage is wrong. Partial, because the pair is only
    // meaningful for grouped days: without the WHERE, every plain day in a ride
    // would collide on (ride_id, NULL).
    uniqueIndex('uq_day_alt_active')
      .on(t.rideId, t.altGroup)
      .where(sql`${t.altActive} and ${t.altGroup} is not null`),
  ],
)

// The dots (docs/ideas.md). EVERY point in a day is ordered — `position` is the
// rider's own sequence and is set for both kinds. `kind` says only whether the
// point anchors routing: a stop does and a POI does not, so legs connect
// consecutive STOPS while POIs sit between them without bending the road.
//
// Ziad's call, 2026-08-23, and it replaced a model where only stops carried a
// position and a POI's place in the list was DERIVED by projecting it onto the
// day's track. That derivation had no answer before a route existed — every POI
// on a trackless day reported distance 0 — and the new model needs one, because
// a point now starts life as a POI and is promoted later. Promotion is a flag
// flip that moves nothing.
//
// The third dot kind — ephemeral shaping waypoints — lives in
// route_legs.via_points, not here.
export const points = pgTable(
  'points',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    dayId: bigint('day_id', { mode: 'number' })
      .notNull()
      .references(() => days.id, { onDelete: 'cascade' }),
    kind: pointKindEnum('kind').notNull(),
    // The rider's order within the day, for BOTH kinds. Dense from 0.
    position: smallint('position').notNull(),
    lat: doublePrecision('lat').notNull(),
    lng: doublePrecision('lng').notNull(),
    name: varchar('name', { length: 255 }).notNull().default(''),
    description: varchar('description', { length: 2000 }),
    roles: waypointRoleEnum('roles')
      .array()
      .notNull()
      .default(sql`'{}'::waypoint_role[]`),
    durationMin: integer('duration_min'),
    // TIME ONLY A LATE GROUP SPENDS, where duration_min is time everyone spends.
    // Meaningful on a meeting point and nowhere else. Ziad's call, 2026-08-26,
    // after #67 left it open.
    //
    // The two behave differently and that is the whole reason for a second
    // column: dwell pushes the shared departure later for everybody, slack is a
    // margin ahead of it that absorbs one group running late without moving
    // anyone. See daySchedule and solveStrands in src/subgroups/schedule.ts.
    //
    // Null is not zero. Null means nobody set any; 0 means none is wanted, and
    // a meet deliberately run to the minute is a real thing to say.
    slackMin: integer('slack_min'),
    distFromStartM: integer('dist_from_start_m'), // server-computed cumulative meters
    // The point's DURABLE identity, and the thing `id` is not.
    //
    // `PUT /api/rides/:id` deletes and re-inserts every day and point on every
    // save — a deliberate decision on 2026-08-15, and autosave makes it happen
    // constantly. So `id` churns, and anything that referenced a point across a
    // save would silently lose it. Rich stop details is the first feature that
    // needs a point to keep its identity, and this is how it does: the client
    // owns the uid, the save carries it through unchanged, and point_details is
    // keyed by it rather than by the row id that keeps changing.
    //
    // Client-generated rather than server-assigned so the builder can attach
    // details to a stop it has only just created, before any save has happened.
    // A payload arriving without one — an old tab, a native JSON file written
    // before this shipped, an import from another app — gets one server-side.
    //
    // Unique per DAY and not globally: it only ever has to disambiguate within
    // the ride being saved, and a global unique index would make two riders
    // importing the same file collide for no reason.
    uid: varchar('uid', { length: 12 }).notNull(),
  },
  (t) => [
    // Now a real uniqueness constraint over every point in the day. It used to
    // lean on NULLS DISTINCT so that any number of POIs could coexist carrying
    // null; with position NOT NULL for both kinds there is nothing to except.
    uniqueIndex('uq_point_day_pos').on(t.dayId, t.position),
    index('idx_point_day').on(t.dayId),
    uniqueIndex('uq_point_day_uid').on(t.dayId, t.uid),
    check('ck_point_roles_max4', sql`cardinality(roles) <= 4`),
    // ck_point_stop_pos is gone: it said "a stop must have a position", which
    // the NOT NULL above now says about every point.
  ],
)

// The private half of a stop: reservations, confirmation numbers, gate codes,
// check-in and check-out, phone, address, links, and freeform notes.
//
// A SEPARATE TABLE, and that is the load-bearing part of the whole feature.
// `points` is what `ride.json` is built from and what every export serializes,
// so a confirmation number stored as a column on `points` is one forgetful
// `select()` away from a public share. Keeping it in its own table means the
// public path cannot leak it by accident — it has to JOIN to leak it, and a
// join is visible in review in a way an extra column in a `select *` is not.
// Same reasoning that splits `user_profiles` from `users`.
//
// Keyed by (ride_id, uid) rather than by point_id, because point ids churn on
// every save — see points.uid above. ride_id cascades, so deleting a ride takes
// the details with it; a point deleted from a ride is cleaned up by uid at save
// time, in src/maps/ride-graph.ts.
export const pointDetails = pgTable(
  'point_details',
  {
    rideId: bigint('ride_id', { mode: 'number' })
      .notNull()
      .references(() => rides.id, { onDelete: 'cascade' }),
    uid: varchar('uid', { length: 12 }).notNull(),
    // Reservation and arrival. checkInAt/checkOutAt follow days.start_at exactly
    // — a hotel check-in is a wall-clock moment in a place, carried as UTC for
    // the reasons stated on that column.
    confirmation: varchar('confirmation', { length: 120 }),
    checkInAt: timestamp('check_in_at', { withTimezone: true }),
    checkOutAt: timestamp('check_out_at', { withTimezone: true }),
    phone: varchar('phone', { length: 40 }),
    address: varchar('address', { length: 300 }),
    // Up to MAX_LINKS_PER_POINT {label, url} pairs — a booking link, a menu, a
    // map. jsonb rather than three columns because which links a stop wants is
    // a property of the stop, not of the schema, and rather than its own table
    // because nothing ever queries across them.
    links: jsonb('links')
      .$type<Array<{ label: string; url: string }>>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    // "Gate code 4417, park behind the barn, ask for Dave."
    notes: varchar('notes', { length: 2000 }),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.rideId, t.uid] }), index('idx_point_details_ride').on(t.rideId)],
)

// Leg i connects stop i to stop i+1, carrying the road-snapped geometry from
// the Directions API (distance/duration are Directions-authoritative — the
// mileage authority). via_points are the rider's ephemeral shaping waypoints.
// THIS IS NOW TRUE OF IMPORTED RIDES TOO. They used to store one leg at
// position 0 holding the whole track, which the viewer coped with because it
// renders concat(legs) either way — but the builder's model IS this invariant,
// so an import could never be opened, saved or exported as valid native JSON.
// The import cuts the uploaded track at its stops now; see
// src/maps/track-split.ts, and utils/split-imported-legs.ts for the rows that
// predate it. The one thing that has not changed: distance/duration on an
// imported leg come from geometry, not from Directions, because an imported
// ride never touches the router.
//
// Still `route_legs` after days stopped being called routes, deliberately: the
// "route" here is the path a day traces, which is what these legs compose, not
// a reference to the renamed table. The column below is the reference, and it
// moved.
export const routeLegs = pgTable(
  'route_legs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    dayId: bigint('day_id', { mode: 'number' })
      .notNull()
      .references(() => days.id, { onDelete: 'cascade' }),
    position: smallint('position').notNull(),
    geometry: jsonb('geometry').$type<[number, number][]>().notNull(), // [lng,lat] pairs, 6-decimal
    distanceM: integer('distance_m').notNull().default(0),
    durationS: integer('duration_s').notNull().default(0),
    viaPoints: jsonb('via_points')
      .$type<[number, number][]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
  },
  (t) => [uniqueIndex('uq_leg_day_pos').on(t.dayId, t.position)],
)

// One submission of any kind — a bug, an idea or a question. The word is
// "report": never "ticket", never "issue" (that belongs to GitHub), never
// "post". See docs/rider-feedback.md.
//
// state and status are two columns on purpose; the enums above say why.
//
// The audience shapes the columns. Riders are motorcyclists on phones, often
// outdoors, who will not write reproduction steps and will abandon a form that
// asks — so `body` is the only required field, `title` is DERIVED from it by
// titleFrom() rather than requested, and every other text column is optional.
// frequency is "steps to reproduce" asked in a way someone will actually
// answer.
//
// priority is owner-only and must NEVER reach a rider-facing surface. A rider
// who sees "your bug is P3" is a support incident.
export const feedback = pgTable(
  'feedback',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    // Unguessable, same generator as rides.slug. The board, the rider's own
    // view and every email address a report by this and never by id.
    publicId: varchar('public_id', { length: 22 }).notNull(),
    authorId: bigint('author_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: feedbackKindEnum('kind').notNull(),
    state: feedbackStateEnum('state').notNull().default('pending'),
    status: feedbackStatusEnum('status').notNull().default('new'),
    // Derived from the first line of body at submit time and editable by the
    // owner before publishing. Riders are not asked for a title.
    title: varchar('title', { length: 150 }),
    body: varchar('body', { length: 4000 }).notNull(), // the one required field
    context: varchar('context', { length: 2000 }), // "when did you last wish you had it"—ideas only
    // Which screen, from the chip group. Nullable because the floating entry
    // point pre-fills it from ?area= and the rider is never asked twice.
    area: varchar('area', { length: 40 }),
    frequency: varchar('frequency', { length: 20 }), // every_time/sometimes/once/unknown—bugs only
    impact: varchar('impact', { length: 20 }), // nice/often/every_ride—ideas only
    // Denormalized, written in the same transaction as the vote rows. Reading a
    // count(*) per row on every board render is the thing this avoids.
    wantCount: integer('want_count').notNull().default(0),
    priority: smallint('priority'), // owner-only, never rendered publicly
    ownerNote: varchar('owner_note', { length: 2000 }), // private scratchpad
    publicResponse: varchar('public_response', { length: 2000 }), // shown on the board when published
    duplicateOf: bigint('duplicate_of', { mode: 'number' }).references((): AnyPgColumn => feedback.id),
    replyOk: boolean('reply_ok').notNull().default(true), // rider consented to a follow-up
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
    publishedAt: timestamp('published_at'),
  },
  (t) => [
    uniqueIndex('uq_feedback_public_id').on(t.publicId),
    index('idx_feedback_board').on(t.state, t.kind, t.wantCount),
    index('idx_feedback_queue').on(t.state, t.createdAt),
    index('idx_feedback_author').on(t.authorId),
  ],
)

// One rider wanting one report. The composite primary key IS the anti-fraud
// mechanism — one want per rider per report, enforced by Postgres rather than by
// a check in the handler that a second code path could forget.
export const feedbackVotes = pgTable(
  'feedback_votes',
  {
    feedbackId: bigint('feedback_id', { mode: 'number' })
      .notNull()
      .references(() => feedback.id, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.feedbackId, t.userId] }), index('idx_feedback_vote_user').on(t.userId)],
)

// What the browser was doing, captured silently so no rider is ever asked a
// technical question. Its own table rather than a column on feedback because the
// blob runs 5–50 KB and every board query would otherwise drag it across the
// wire for nothing.
//
// $type<> is a compile-time claim Postgres does not enforce, exactly as on
// survey_responses.answers above: every read goes through parseDiagnostics(),
// which is lenient by design and never casts.
//
// NOTHING REACHES THIS COLUMN UNREDACTED. src/feedback/diagnostics.ts strips
// query strings and fragments from every URL and there are no coordinates in
// here at all — geolocation is recorded as a permission state, never a position.
export const feedbackDiagnostics = pgTable('feedback_diagnostics', {
  feedbackId: bigint('feedback_id', { mode: 'number' })
    .primaryKey()
    .references(() => feedback.id, { onDelete: 'cascade' }),
  payload: jsonb('payload')
    .$type<Record<string, unknown>>()
    .notNull()
    .default(sql`'{}'::jsonb`),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})

// A screenshot or photo a rider attached, on disk under STORAGE_PATH following
// the src/maps/storage.ts convention.
//
// These bytes are counted HERE and nowhere else. They must stay out of
// rides.size_bytes and out of users.used_bytes: they are not ride data, they
// must not eat a rider's quota, and adding a fourth byte column to that
// generated expression would corrupt quota accounting on every ride delete.
export const feedbackAttachments = pgTable(
  'feedback_attachments',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    feedbackId: bigint('feedback_id', { mode: 'number' })
      .notNull()
      .references(() => feedback.id, { onDelete: 'cascade' }),
    storageKey: varchar('storage_key', { length: 255 }).notNull(),
    mime: varchar('mime', { length: 60 }).notNull(),
    bytes: integer('bytes').notNull().default(0),
    width: integer('width'),
    height: integer('height'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [index('idx_feedback_attachment').on(t.feedbackId)],
)

// A rider's reusable library of locations: home, the good fuel stop, the meet
// point everyone knows. Dropped into any ride as a stop.
//
// **A place is COPIED into a ride, never referenced.** Ziad's call, 2026-08-21.
// There is deliberately no `place_id` on `points`: a ride is a record of what
// the rider planned, so renaming "Bob's Gas" or deleting it must not reach back
// and rewrite a ride from last year. It also sidesteps the churn problem
// entirely — points are deleted and re-inserted on every save, so a foreign key
// from a point to a place would have to survive that, and there is no reason to
// make it.
//
// The cost, stated plainly so nobody re-litigates it as a bug: fixing a badly
// placed pin fixes it for FUTURE rides only. Rides that already copied it keep
// the old coordinates.
export const placeGroups = pgTable(
  'place_groups',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    ownerId: bigint('owner_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 80 }).notNull(),
    // Rider-defined order, so a library can be arranged the way the rider
    // thinks about it rather than alphabetically.
    position: smallint('position').notNull().default(0),
    // The recycle bin. Two columns, as on `places` and for the same reason.
    //
    // Trashing a group still ungroups its places on the spot — that is the
    // `set null` on places.group_id below, and it is not changed here. Restoring
    // the group therefore brings back an EMPTY group, which is exactly what
    // deleting one does today, so no rider expectation moves.
    deletedAt: timestamp('deleted_at'),
    purgeAfter: timestamp('purge_after'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [
    // PARTIAL, and that is what stops the bin blocking a name. Unique on
    // (owner, name) across every row would mean a rider who trashed "Oregon"
    // could not create a new "Oregon" — refused on the strength of a row they
    // cannot see and were told was gone. Excluding trashed rows frees the name
    // immediately.
    //
    // The flip side, and it has to be handled in the restore path rather than
    // here: restoring a group whose name has since been reused collides. Refuse
    // that restore and say which name is taken.
    uniqueIndex('uq_place_group_name')
      .on(t.ownerId, t.name)
      .where(sql`${t.deletedAt} is null`),
    index('idx_place_group_owner').on(t.ownerId),
    index('idx_place_groups_purge_due')
      .on(t.purgeAfter)
      .where(sql`${t.deletedAt} is not null`),
  ],
)

export const places = pgTable(
  'places',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    ownerId: bigint('owner_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // NULLABLE, and that is a usability decision rather than an omission.
    // Requiring a group would mean inventing one before a rider can save their
    // first place, which is friction in front of the very first use. Ungrouped
    // is a real state and the UI shows it as its own section.
    //
    // `set null` on delete rather than cascade: deleting a group must not delete
    // the places in it. Losing a rider's saved locations because they tidied up
    // a folder name would be unforgivable and is exactly what cascade would do.
    groupId: bigint('group_id', { mode: 'number' }).references(() => placeGroups.id, { onDelete: 'set null' }),
    name: varchar('name', { length: 255 }).notNull(),
    lat: doublePrecision('lat').notNull(),
    lng: doublePrecision('lng').notNull(),
    // Same taxonomy as a point, so a saved hotel drops in already wearing the
    // hotel icon. src/maps/roles.ts is the source of truth for both.
    roles: waypointRoleEnum('roles')
      .array()
      .notNull()
      .default(sql`'{}'::waypoint_role[]`),
    // The DURABLE half of what rich stop details holds — a hotel's phone number
    // is a fact about the hotel, and does not change between rides. Copied into
    // a stop's point_details when the place is dropped in.
    //
    // Confirmation numbers and check-in times are deliberately NOT here: those
    // belong to one trip, not to the place, and storing them would mean every
    // ride using the place inherited last trip's reservation.
    phone: varchar('phone', { length: 40 }),
    address: varchar('address', { length: 300 }),
    links: jsonb('links')
      .$type<Array<{ label: string; url: string }>>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    // The recycle bin. Two columns rather than the three on `rides`: a place
    // stores no file, so its purge is a single statement and there is nothing
    // for a claim column to protect against half-finishing.
    deletedAt: timestamp('deleted_at'),
    purgeAfter: timestamp('purge_after'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('idx_place_owner').on(t.ownerId),
    index('idx_place_group').on(t.groupId),
    check('ck_place_roles_max4', sql`cardinality(roles) <= 4`),
    index('idx_places_purge_due')
      .on(t.purgeAfter)
      .where(sql`${t.deletedAt} is not null`),
  ],
)

export type UserRow = typeof users.$inferSelect
/** The authorization states, derived from the enum so the two cannot drift. */
export type UserStatus = (typeof userStatusEnum.enumValues)[number]
export type UserProfileRow = typeof userProfiles.$inferSelect
export type UsernameHistoryRow = typeof usernameHistory.$inferSelect
export type UserIdentityRow = typeof userIdentities.$inferSelect
export type LoginTokenRow = typeof loginTokens.$inferSelect
export type SessionRow = typeof sessions.$inferSelect
export type InviteRow = typeof invites.$inferSelect
export type InviteRedemptionRow = typeof inviteRedemptions.$inferSelect
export type SurveyResponseRow = typeof surveyResponses.$inferSelect
/** The three ways an invite is handed out, derived from the enum so the two cannot drift. */
export type InviteKind = (typeof inviteKindEnum.enumValues)[number]
/** The four levels a ride can be shared at, derived from the enum so the two
 *  cannot drift. What each one MEANS is canView() in src/access/policy.ts —
 *  nothing else should read this union and decide for itself. */
export type RideVisibility = (typeof visibilityEnum.enumValues)[number]
export type PlaceGroupRow = typeof placeGroups.$inferSelect
// --- The rider layer --------------------------------------------------------

// Minimal on purpose. Editor rights are #32's problem; this leaves room for the
// value without pretending to answer it.
export const rideRoleEnum = pgEnum('ride_role', ['owner', 'rider'])

// Distinct from role, because a rider who declined is still on the roster —
// that is the whole reason the two are separate columns.
export const rsvpEnum = pgEnum('rsvp', ['invited', 'going', 'maybe', 'declined'])

export const friendshipStatusEnum = pgEnum('friendship_status', ['pending', 'accepted', 'blocked'])

// A NAMED SET OF RIDERS SHARING AN APPROACH — the Oakland contingent, the
// Sacramento contingent. The primitive #67 is built on.
//
// NOT CHURNED ON SAVE, unlike days and points. The builder's PUT deletes and
// re-inserts every day of a ride, and if it did the same here every
// ride_members.subgroup_id would be orphaned on the first edit. So
// insertRideGraph reconciles these BY UID — upsert what the payload carries,
// delete what it does not — which is why they have a uid at all and why ids
// here are safe to reference where days' and points' are not.
export const rideSubgroups = pgTable(
  'ride_subgroups',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    rideId: bigint('ride_id', { mode: 'number' })
      .notNull()
      .references(() => rides.id, { onDelete: 'cascade' }),
    // Client-minted, same alphabet and length as days.uid and points.uid — see
    // src/maps/uid.ts. It is what lets a payload reference a subgroup the
    // server has never seen.
    uid: varchar('uid', { length: 12 }).notNull(),
    name: varchar('name', { length: 80 }).notNull(),
    // Its own, not borrowed from a day. A subgroup spans several days and its
    // line on the map has to read as one thing across all of them, which the
    // per-day palette cannot do.
    color: varchar('color', { length: 7 }).notNull().default('#0066cc'),
    position: smallint('position').notNull().default(0),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('uq_subgroup_ride_uid').on(t.rideId, t.uid), index('idx_subgroup_ride').on(t.rideId)],
)

// A rider's relationship to a ride: the primitive several planned features
// assume and none of them owns.
//
// SCHEMA ONLY FOR NOW. Ziad's call, 2026-08-26: the invite path that would
// create rows here is cut, so nothing in the app inserts one yet. The table
// exists because canView() already reads it — the membership grant is wired and
// correct the day membership is switched on, rather than being a second change
// to the access rule later.
export const rideMembers = pgTable(
  'ride_members',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    rideId: bigint('ride_id', { mode: 'number' })
      .notNull()
      .references(() => rides.id, { onDelete: 'cascade' }),
    riderId: bigint('rider_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: rideRoleEnum('role').notNull().default('rider'),
    rsvp: rsvpEnum('rsvp').notNull().default('invited'),
    // Which approach this rider is on. NULLABLE AND THAT IS LOAD-BEARING: a
    // club secretary planning a joint rally is not in any of the groups, and
    // #67 says so explicitly. `set null` rather than cascade, so deleting a
    // subgroup un-groups its riders instead of throwing them off the ride —
    // the same call place_groups made about its places.
    subgroupId: bigint('subgroup_id', { mode: 'number' }).references((): AnyPgColumn => rideSubgroups.id, { onDelete: 'set null' }),
    // WHICH BIKE THEY ARE BRINGING, which #52 needs and which a rider's default
    // bike cannot answer on its own: the whole point of owning two is that you
    // pick one per ride. Null falls back to their default — see bikesOnRide()
    // in src/bikes/service.ts — so a rider who has never said still counts
    // toward the group's range.
    //
    // `set null` rather than cascade: selling a bike must not throw its owner
    // off every ride they were on.
    bikeId: bigint('bike_id', { mode: 'number' }).references((): AnyPgColumn => bikes.id, { onDelete: 'set null' }),
    // `set null` rather than cascade: the rider who did the inviting may leave,
    // and losing their account must not evict everyone they brought.
    invitedBy: bigint('invited_by', { mode: 'number' }).references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uq_ride_member').on(t.rideId, t.riderId),
    // What canView's EXISTS subquery probes, and it reads rider-first because
    // the question is always "is THIS viewer on this ride".
    index('idx_ride_member_rider').on(t.riderId, t.rideId),
  ],
)

// A standing relationship between two riders, separate from any one ride.
//
// ONE ROW PER PAIR, under a canonical ordering enforced by the check constraint:
// the lower id is always rider_a. Two mirrored rows would mean "are these two
// friends" is two lookups that can disagree, and every write has to remember to
// update both. The cost is that direction is not implied by the columns, which
// is what `requested_by` and `blocked_by` are for.
export const friendships = pgTable(
  'friendships',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    riderA: bigint('rider_a', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    riderB: bigint('rider_b', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: friendshipStatusEnum('status').notNull().default('pending'),
    // Who asked. Without it the canonical ordering loses which of the two is
    // waiting on the other, and a pending row cannot be rendered.
    requestedBy: bigint('requested_by', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Who blocked, when status is 'blocked'. Load-bearing rather than
    // informational: the blocker may unblock and the blocked rider may not, and
    // without this column the row cannot tell them apart.
    blockedBy: bigint('blocked_by', { mode: 'number' }).references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uq_friendship_pair').on(t.riderA, t.riderB),
    index('idx_friendship_b').on(t.riderB),
    // The canonical ordering, in the database rather than in a service that has
    // to remember. It also rules out a rider befriending themselves.
    check('ck_friendship_order', sql`${t.riderA} < ${t.riderB}`),
  ],
)

// Who a rider watches. A SECOND RELATION, and deliberately not a mode of the
// first one above.
//
// **DIRECTION IS THE DATA HERE, WHICH IS WHY THERE IS NO CANONICAL ORDERING.**
// `friendships` holds one row per pair under `rider_a < rider_b` because "are
// these two friends" is one question with one answer; following is two
// independent questions and A following B says nothing about B following A. So
// there are two columns with distinct meanings, two rows for a mutual follow,
// and no `ck_..._order` check — copying that constraint here would make the
// relation symmetric, which is the whole thing it is not.
//
// **NO STATUS COLUMN, BECAUSE THERE IS NOTHING TO ACCEPT.** A friendship has a
// lifecycle — pending, accepted, blocked — and needs a status to sit in. A
// follow is done the moment it is made and undone by deleting the row. A
// `pending` follow would be a friend request with a different name.
//
// **FOLLOWING GRANTS NO VISIBILITY. NOT ANY. EVER.** It decides what reaches a
// rider's feed and nothing else — `canView()` in src/access/policy.ts does not
// know this table exists and must not learn. A one-way relationship the other
// rider never agreed to cannot be a key to anything: if following granted what
// friendship grants, `friends` visibility would be openable by anyone willing
// to press a button, and the level would mean nothing. The feed shows PUBLIC
// rides, which the follower could already have seen on /explore; what following
// buys is that they no longer have to go looking.
//
// **A BLOCK REMOVES THE ROW IN BOTH DIRECTIONS AND REFUSES A NEW ONE.** A block
// that left a follow standing would leave the blocked rider watching the
// blocker's feed, which is precisely what a block is for stopping. See
// src/follows/policy.ts.
export const follows = pgTable(
  'follows',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    followerId: bigint('follower_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    followeeId: bigint('followee_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uq_follow_pair').on(t.followerId, t.followeeId),
    // The feed's own lookup reads follower-first, which the unique index above
    // already serves. This one is for the other direction — "who follows this
    // rider", which a profile's follower count asks.
    index('idx_follow_followee').on(t.followeeId),
    // A rider cannot follow themselves. In the database rather than in a service
    // that has to remember, the same reasoning ck_friendship_order carries.
    check('ck_follow_not_self', sql`${t.followerId} <> ${t.followeeId}`),
  ],
)

// One member's pick among a day's alternates.
//
// KEYED BY (ride_id, day_uid), NOT BY day_id, and cascading from `rides` rather
// than from `days` — the same arrangement point_details has and for the same
// reason. The builder's PUT deletes and re-inserts every day of a ride on every
// save, so a foreign key to `days` would take every vote with it the first time
// anybody moved a stop. `days.uid` is what survives that.
//
// The flip side is the same too: nothing cleans these up automatically, so
// `reconcileVotes()` in src/votes/service.ts deletes rows whose uid left the
// payload. Skip that and a vote for a deleted alternate lives forever and keeps
// counting.
export const altVotes = pgTable(
  'alt_votes',
  {
    rideId: bigint('ride_id', { mode: 'number' })
      .notNull()
      .references(() => rides.id, { onDelete: 'cascade' }),
    dayUid: varchar('day_uid', { length: 12 }).notNull(),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [
    // THE COMPOSITE KEY IS THE ANTI-DOUBLE-VOTE MECHANISM, enforced by Postgres
    // rather than by a check a second code path could forget — the same argument
    // feedback_votes makes about (feedback_id, user_id).
    //
    // What it CANNOT enforce is one vote per alt GROUP, because a group has no
    // durable id: it forms and dissolves as a rider edits, and `alt_group` is
    // renumbered on every save. castVote() resolves the group from the current
    // days and clears the member's other votes in it. That rule lives in the
    // service and nowhere else.
    primaryKey({ columns: [t.rideId, t.dayUid, t.userId] }),
    index('idx_alt_vote_ride').on(t.rideId),
  ],
)

export type PlaceRow = typeof places.$inferSelect
export type RideMemberRow = typeof rideMembers.$inferSelect
export type FriendshipRow = typeof friendships.$inferSelect
export type AltVoteRow = typeof altVotes.$inferSelect
export type RideSubgroupRow = typeof rideSubgroups.$inferSelect
/** The three pinnable events, derived from the enum so the two cannot drift. */
export type TimeAnchor = (typeof timeAnchorEnum.enumValues)[number]
/** The two ride roles, derived from the enum so the two cannot drift. */
export type RideRole = (typeof rideRoleEnum.enumValues)[number]
/** The four RSVP states, likewise. */
export type Rsvp = (typeof rsvpEnum.enumValues)[number]
export type BikeRow = typeof bikes.$inferSelect
export type RideRow = typeof rides.$inferSelect
export type DayRow = typeof days.$inferSelect
export type PointRow = typeof points.$inferSelect
export type RouteLegRow = typeof routeLegs.$inferSelect
export type FeedbackRow = typeof feedback.$inferSelect
export type FeedbackVoteRow = typeof feedbackVotes.$inferSelect
export type FeedbackDiagnosticsRow = typeof feedbackDiagnostics.$inferSelect
export type FeedbackAttachmentRow = typeof feedbackAttachments.$inferSelect
/** The three things a rider can send, derived from the enum so the two cannot drift. */
export type FeedbackKind = (typeof feedbackKindEnum.enumValues)[number]
/** The owner's visibility gate, derived from the enum so the two cannot drift. */
export type FeedbackState = (typeof feedbackStateEnum.enumValues)[number]
/** The rider-facing lifecycle, derived from the enum so the two cannot drift. */
export type FeedbackStatus = (typeof feedbackStatusEnum.enumValues)[number]
