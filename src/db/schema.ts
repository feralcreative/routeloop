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
export const rideSourceEnum = pgEnum('ride_source', ['native', 'imported'])
export const pointKindEnum = pgEnum('point_kind', ['stop', 'poi'])
// The 17-category taxonomy carried over from the KML naming convention
// (README "Waypoint Naming"); canonical metadata lives in src/maps/roles.ts.
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
    avatarUrl: varchar('avatar_url', { length: 512 }),
    // Defaulting to 'active' is load-bearing, not an oversight: drizzle-kit push
    // stamps the default onto every existing row, so a 'pending' default would
    // flip the owner's own account to pending and lock them out of the app that
    // does the approving. resolveUser() writes 'pending' explicitly on the
    // insert path instead.
    status: userStatusEnum('status').notNull().default('active'),
    canManageRiders: boolean('can_manage_riders').notNull().default(false),
    quotaBytes: bigint('quota_bytes', { mode: 'number' }).notNull().default(262144000), // 250 MB
    usedBytes: bigint('used_bytes', { mode: 'number' }).notNull().default(0), // denormalized cache
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

// The shareable package (docs/ideas.md): a ride holds many routes over many
// days/sessions. The slug is the share id; visibility gates viewing. Byte
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
    sizeBytes: integer('size_bytes').generatedAlwaysAs(sql`kml_bytes + gpx_bytes`),
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

// One session/day within a ride: ordered stops joined by routed legs. The time
// model (startAt/endAt) exists now so the timeline slider is pure UI later.
// distanceM/durationS are caches over the route's legs.
export const routes = pgTable(
  'routes',
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
  },
  (t) => [uniqueIndex('uq_route_ride_pos').on(t.rideId, t.position)],
)

// The dots (docs/ideas.md). Stops are the ordered routing anchors — not riding
// for a while; durationMin null = no duration (ride ends). POIs are unordered
// annotations near the route and never affect routing. The third dot kind —
// ephemeral shaping waypoints — lives in route_legs.via_points, not here.
export const points = pgTable(
  'points',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    routeId: bigint('route_id', { mode: 'number' })
      .notNull()
      .references(() => routes.id, { onDelete: 'cascade' }),
    kind: pointKindEnum('kind').notNull(),
    position: smallint('position'), // stop order along the route; null for POIs
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
    uniqueIndex('uq_point_route_pos').on(t.routeId, t.position),
    index('idx_point_route').on(t.routeId),
    check('ck_point_roles_max4', sql`cardinality(roles) <= 4`),
    check('ck_point_stop_pos', sql`kind <> 'stop' OR position IS NOT NULL`),
  ],
)

// Leg i connects stop i to stop i+1, carrying the road-snapped geometry from
// the Directions API (distance/duration are Directions-authoritative — the
// mileage authority). via_points are the rider's ephemeral shaping waypoints.
// Imported rides store one leg at position 0 holding the whole track, so the
// viewer always renders concat(legs) — one code path for both sources.
export const routeLegs = pgTable(
  'route_legs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    routeId: bigint('route_id', { mode: 'number' })
      .notNull()
      .references(() => routes.id, { onDelete: 'cascade' }),
    position: smallint('position').notNull(),
    geometry: jsonb('geometry').$type<[number, number][]>().notNull(), // [lng,lat] pairs, 6-decimal
    distanceM: integer('distance_m').notNull().default(0),
    durationS: integer('duration_s').notNull().default(0),
    viaPoints: jsonb('via_points').$type<[number, number][]>().notNull().default(sql`'[]'::jsonb`),
  },
  (t) => [uniqueIndex('uq_leg_route_pos').on(t.routeId, t.position)],
)

export type UserRow = typeof users.$inferSelect
export type UserProfileRow = typeof userProfiles.$inferSelect
export type LoginTokenRow = typeof loginTokens.$inferSelect
export type SessionRow = typeof sessions.$inferSelect
export type RideRow = typeof rides.$inferSelect
export type RouteRow = typeof routes.$inferSelect
export type PointRow = typeof points.$inferSelect
export type RouteLegRow = typeof routeLegs.$inferSelect
