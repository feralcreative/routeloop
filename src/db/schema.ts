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
} from 'drizzle-orm/pg-core'

// 'google' is the OAuth flow and 'email' is the magic link — the two ways a
// rider can arrive. 'github' and 'cloudflare' are retained only so historical
// identity rows stay valid; nothing issues them any more.
export const providerEnum = pgEnum('provider', ['google', 'github', 'cloudflare', 'email'])
// Cloudflare Access authenticates; this authorizes. Access admits any Google
// account, so a new rider lands 'pending' and waits for approval.
export const userStatusEnum = pgEnum('user_status', ['pending', 'active', 'blocked'])
export const visibilityEnum = pgEnum('visibility', ['public', 'unlisted', 'private'])
// Three ways to hand out access, and the difference is not only max_uses. An
// 'email' invite is bound to an address and mailed; a 'link' is one URL handed
// to one person; a 'group' is pasted into a channel and read by everyone in it.
// Recorded rather than derived from max_uses, because a group link with one seat
// left is still a group link and the admin page has to say so.
export const inviteKindEnum = pgEnum('invite_kind', ['email', 'link', 'group'])
export const rideSourceEnum = pgEnum('ride_source', ['native', 'imported'])
export const pointKindEnum = pgEnum('point_kind', ['stop', 'poi'])
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
    // 25 MB, lowered from 250 for the beta.
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
    quotaBytes: bigint('quota_bytes', { mode: 'number' }).notNull().default(26214400), // 25 MB
    // Denormalized cache of sum(rides.size_bytes), incremented on import and
    // decremented on delete, with no reconciler — so it drifts, and has. The
    // dashboard computes the authoritative sum alongside it and reports the
    // disagreement rather than trusting this.
    usedBytes: bigint('used_bytes', { mode: 'number' }).notNull().default(0),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
    lastLoginAt: timestamp('last_login_at'),
  },
  (t) => [
    index('idx_user_status').on(t.status),
    // Case-insensitive: "Ziad" and "ziad" are the same handle.
    uniqueIndex('uq_username_lower').on(sql`lower(${t.username})`),
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
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})

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
    createdBy: bigint('created_by', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
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
    answers: jsonb('answers').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
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
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uq_slug').on(t.slug),
    index('idx_owner').on(t.ownerId),
    index('idx_browse').on(t.visibility, t.createdAt),
    index('idx_popular').on(t.visibility, t.viewCount),
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
  },
  (t) => [uniqueIndex('uq_day_ride_pos').on(t.rideId, t.position)],
)

// The dots (docs/ideas.md). Stops are the ordered routing anchors — not riding
// for a while; durationMin null = no duration (ride ends). POIs are unordered
// annotations near the day's route and never affect routing. The third dot kind
// — ephemeral shaping waypoints — lives in route_legs.via_points, not here.
export const points = pgTable(
  'points',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    dayId: bigint('day_id', { mode: 'number' })
      .notNull()
      .references(() => days.id, { onDelete: 'cascade' }),
    kind: pointKindEnum('kind').notNull(),
    position: smallint('position'), // stop order along the day; null for POIs
    lat: doublePrecision('lat').notNull(),
    lng: doublePrecision('lng').notNull(),
    name: varchar('name', { length: 255 }).notNull().default(''),
    description: varchar('description', { length: 2000 }),
    roles: waypointRoleEnum('roles').array().notNull().default(sql`'{}'::waypoint_role[]`),
    durationMin: integer('duration_min'),
    distFromStartM: integer('dist_from_start_m'), // server-computed cumulative meters
  },
  (t) => [
    // Stops get distinct positions; POIs all carry null (NULLS DISTINCT).
    uniqueIndex('uq_point_day_pos').on(t.dayId, t.position),
    index('idx_point_day').on(t.dayId),
    check('ck_point_roles_max4', sql`cardinality(roles) <= 4`),
    check('ck_point_stop_pos', sql`kind <> 'stop' OR position IS NOT NULL`),
  ],
)

// Leg i connects stop i to stop i+1, carrying the road-snapped geometry from
// the Directions API (distance/duration are Directions-authoritative — the
// mileage authority). via_points are the rider's ephemeral shaping waypoints.
// Imported rides store one leg at position 0 holding the whole track, so the
// viewer always renders concat(legs) — one code path for both sources.
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
    viaPoints: jsonb('via_points').$type<[number, number][]>().notNull().default(sql`'[]'::jsonb`),
  },
  (t) => [uniqueIndex('uq_leg_day_pos').on(t.dayId, t.position)],
)

export type UserRow = typeof users.$inferSelect
/** The authorization states, derived from the enum so the two cannot drift. */
export type UserStatus = (typeof userStatusEnum.enumValues)[number]
export type UserProfileRow = typeof userProfiles.$inferSelect
export type UsernameHistoryRow = typeof usernameHistory.$inferSelect
export type LoginTokenRow = typeof loginTokens.$inferSelect
export type SessionRow = typeof sessions.$inferSelect
export type InviteRow = typeof invites.$inferSelect
export type InviteRedemptionRow = typeof inviteRedemptions.$inferSelect
export type SurveyResponseRow = typeof surveyResponses.$inferSelect
/** The three ways an invite is handed out, derived from the enum so the two cannot drift. */
export type InviteKind = (typeof inviteKindEnum.enumValues)[number]
export type RideRow = typeof rides.$inferSelect
export type DayRow = typeof days.$inferSelect
export type PointRow = typeof points.$inferSelect
export type RouteLegRow = typeof routeLegs.$inferSelect
