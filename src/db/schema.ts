import { sql } from 'drizzle-orm'
import type { RoutePrefs } from '../maps/route-prefs'
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
// FOUR LEVELS as of 2026-08-26, and the order here is not the order of openness
// — a pgEnum's member order is fixed once created, and adding `friends` at the
// end keeps the migration a plain ALTER TYPE ADD VALUE.
//
// `private` gains "and invited riders", a SUPERSET, so no existing row changed
// meaning. See canView(); nothing should read this enum and decide for itself.
export const visibilityEnum = pgEnum('visibility', ['public', 'unlisted', 'private', 'friends'])
// WHICH EVENT IS PINNED when several subgroups' clocks are solved against each
// other. A second axis from WHOSE clock is pinned (rides.primary_subgroup_id):
// one group setting the departure while another is pinned at 9am is two anchors.
//
//   departure  the primary group leaves at their route's start_at; everyone else
//              is solved to arrive at the meet when they do
//   meet       the first meet is fixed; every group solved backwards from it
//   arrival    the primary group reaches the end at a fixed time
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
// How a DATE and a clock are written, per rider — a display layer over storage.
//
// The members are real BCP-47 tags rather than an abstract mdy/dmy/ymd, so Intl
// does the formatting and number grouping follows the date order. THE CLOCK
// FOLLOWED TOO UNTIL #270, when it got its own column — it still follows by
// DEFAULT, and `clock` overrides `hour12` alone.
export const dateFormatEnum = pgEnum('date_format', ['en-US', 'en-GB', 'en-CA'])
// The two appearance axes. Deliberately two enums rather than one of six members:
// theme is about which signals a rider can distinguish and scheme is about
// ambient light, and only the scheme axis can follow the operating system. See
// src/views/appearance.ts.
export const themeEnum = pgEnum('theme', ['default', 'contrast', 'colorblind'])
export const schemeEnum = pgEnum('scheme', ['system', 'light', 'dark'])

// Whether this app animates. THREE STATES AND NOT A BOOLEAN — `system` means
// "whatever prefers-reduced-motion says", which is the default, because a
// two-state toggle defaulting to on would silently override the OS setting of
// every rider who already asked for less motion. See src/views/motion.ts.
export const motionEnum = pgEnum('motion', ['system', 'always', 'never'])
// The map tiles' own light/dark, separate from the page's. A dark page with a
// light map is a real preference — the tiles are what is being read and a dark
// basemap loses the road hierarchy. `follow` is the default and is the ABSENCE of
// a `data-map-scheme` stamp, the way `system` is for the page.
export const mapSchemeEnum = pgEnum('map_scheme', ['follow', 'light', 'dark'])

// Miles or kilometers. ITS OWN AXIS rather than derived from `date_format`,
// although the two look like siblings: `en-GB` writes 24/08/2026 and measures
// road distance in MILES, so deriving would hand every British rider kilometers
// they never asked for. See src/views/units.ts.
export const unitsEnum = pgEnum('units', ['imperial', 'metric'])

// Twelve- or twenty-four-hour time. A THIRD MEMBER RATHER THAN A BOOLEAN, and
// `locale` is the default because it is what the app already did.
//
// THIS REVERSES THAT CALL NARROWLY (#270): an American who wants twenty-four-hour
// time is a real rider, and the only way to give them one was also giving them
// 24/08/2026. The override is `hour12` alone, so the locale still decides the
// order, the padding and the separator.
export const clockEnum = pgEnum('clock', ['locale', 'h12', 'h24'])

// Gallons or liters. A THIRD AXIS beside `units` and `date_format`: a rider can
// want miles and a metric fuel volume, or the reverse.
//
// `auto` FOLLOWS `units` AND IS THE DEFAULT, which is not the same as folding the
// two together — deriving would leave a metric rider no way to ask for gallons.
export const volumeUnitsEnum = pgEnum('volume_units', ['auto', 'gallons', 'liters'])
// Whether a control explains itself (#133). TWO MEMBERS AND NOT A BOOLEAN: a
// checkbox that sends nothing when unchecked cannot tell "the rider said no" from
// "the form was malformed", which for an autosaved form is the difference between
// storing a choice and storing an accident.
//
// **DEFAULTED TO `on`, AND THAT DIRECTION IS THE FEATURE.** Every other default
// here answers "what did the rider not say"; this one answers "what does somebody
// who has never been here need".
export const tipsEnum = pgEnum('tips', ['on', 'off'])
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
// The OWNER'S GATE, and what makes a bug private without a private-bug feature:
// nothing is visible to anyone but its author and the owner until it is
// 'published'. Deliberately separate from feedback_status — a bug is routinely
// 'fixed' while still 'pending' and there is nothing contradictory about that.
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
    // The rider's stable public handle: `{first-username}-{YYMMDDTHHMMZ}`. Written
    // once and never again — a later username change deliberately does not touch it,
    // so anything that ever referred to this rider keeps resolving.
    //
    // Derived, so it cannot exist before the username does, which is why this is
    // nullable. Uniqueness holds by construction: usernames are unique at any
    // instant, so a name plus the minute it was claimed cannot collide.
    publicId: varchar('public_id', { length: 64 }).unique(),
    avatarUrl: varchar('avatar_url', { length: 512 }),
    // Defaulting to 'active' is load-bearing, not an oversight: drizzle-kit push
    // stamps the default onto every existing row, so a 'pending' default would
    // flip the owner's own account to pending and lock them out of the app that
    // does the approving. resolveUser() writes 'pending' explicitly on the
    // insert path instead.
    status: userStatusEnum('status').notNull().default('active'),
    // When the "you're approved" email went out — what makes it exactly-once for the
    // life of an account. /admin can toggle active → blocked → active freely, so "did
    // the status change" would mail a rider on every reinstatement.
    //
    // Nullable with no default: a default would mark every current account as
    // already-notified. To resend: set it NULL.
    approvedEmailAt: timestamp('approved_email_at'),
    // When an invite let this rider into the Rider Survey, or null if none has.
    // Denormalized from invite_redemptions → invites.grants_survey because it decides
    // whether to render a Survey nav item on every page render, and this row is
    // already loaded by withSession. The join is the truth; this is the cache.
    surveyInvitedAt: timestamp('survey_invited_at'),
    canManageRiders: boolean('can_manage_riders').notNull().default(false),
    // 100 MB, raised from 25 when stored originals started being compressed — the
    // rise is the POINT of that change: brotli takes a real 8-route GPX import from
    // 834 kB to 60 kB. Quota accounting deliberately still counts the UNCOMPRESSED
    // size, so the saving reaches the rider as a bigger number here.
    //
    // Only IMPORTED files count, and one import is stored three times over.
    //
    // Bounded below by the 16 MB body limit and the 200,000-point ride cap, whose
    // worst case is about 24 MB: a quota under either refuses a legitimate import.
    //
    // Changing this default does NOT touch existing rows — ALTER COLUMN SET DEFAULT
    // applies to new inserts only.
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
    // Three nullable timestamps rather than a fourth user_status value, because
    // status has to survive the round trip: a pending rider and a blocked rider can
    // both delete, and "Save Me" has to put them back exactly where they were.
    //
    // Null means "has never asked to leave".
    deletionRequestedAt: timestamp('deletion_requested_at'),
    // The deadline, stored rather than derived from deletion_requested_at +
    // DELETION_HOLD_DAYS. It is a promise made to a person on a date, and
    // deriving it means changing that constant later retroactively moves a purge
    // date a rider was already shown. Same reasoning as invites.expires_at.
    purgeAfter: timestamp('purge_after'),
    // Claimed by the purge before it starts, so a crash cannot wedge the row and
    // two triggers cannot both run it. See src/account/purge.ts.
    purgeStartedAt: timestamp('purge_started_at'),

    // WHEN A WARNING WAS LAST SENT — ANTI-REPEAT STAMPS RATHER THAN FLAGS. The
    // question is never "should this rider be warned" but "have they been warned
    // about THIS", which a boolean cannot answer a second time after the condition
    // clears. `quota_warned_at` is CLEARED when a rider drops back under the line.
    quotaWarnedAt: timestamp('quota_warned_at'),
    // The account-deletion warning. Never cleared by the sweep: Save Me clears
    // `purge_after` itself, and a rider who asks to leave a second time gets a
    // fresh `purge_after` — so the sweep's own "is this stamp older than the
    // current request" test is what makes the second warning fire.
    purgeWarnedAt: timestamp('purge_warned_at'),
    // A GUIDE RIDER: one of the three seeded accounts the guided tour invites onto its
    // demo ride. They are REAL ROWS — a real membership, a real bike with a real range
    // — because every surface the tour shows reads those tables.
    //
    // What the flag buys is exclusion: never listed on /riders or /@handle, neither
    // friendable nor followable, never mailed, and invitable WITHOUT a friendship. A
    // null email is not a safe discriminator, since legacy rows carry one. Created
    // lazily by POST /api/tour/start rather than at boot: stage shares prod's database
    // and runs no boot jobs, and under blue/green a boot insert lands while the OLD
    // color, which does not filter on this, is still serving.
    isGuide: boolean('is_guide').notNull().default(false),
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
  // What the rider calls the place they set off from — "Bill's apartment", "the
  // shop". MIRRORS start_label EXACTLY, including being nullable with the fallback
  // living in code rather than in a column default: "Home" is a FALLBACK and not a
  // stored value, so a rider who clears the field goes back to it.
  homeLabel: varchar('home_label', { length: 120 }),
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
  // The public starting point: where a shared ride begins instead of the rider's
  // front door. Mirrors the home block field for field.
  //
  // Moving the *pin* is not enough — a route seeded from home is drawn from home,
  // and the first leg points at the house whatever the marker says. Swapping the
  // start has to happen while planning, not while rendering.
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
  // The first genuine preference on the profile. It changes how the builder's
  // duration field reads and nothing else: the stored unit is minutes and every
  // export, the roadbook and the timeline are untouched by it.
  //
  // Defaulted rather than nullable so there is no third state to handle.
  durationFormat: durationFormatEnum('duration_format').notNull().default('hours'),
  // Defaulted rather than nullable for the same reason as durationFormat above:
  // no third state for every reader to interpret differently. The signup path
  // seeds it from Accept-Language, so the default is what a rider gets only when
  // the header says nothing useful.
  dateFormat: dateFormatEnum('date_format').notNull().default('en-US'),
  // The palette and the light/dark scheme, defaulted for the same reason as the two
  // above: no third state for a reader to interpret.
  //
  // UNLIKE dateFormat, NEITHER IS SEEDED FROM A HEADER, which is what makes them
  // safe to add — there is no header for a palette, and 'system' already means "ask
  // the browser" on the one axis where the browser has an opinion.
  theme: themeEnum('theme').notNull().default('default'),
  scheme: schemeEnum('scheme').notNull().default('system'),
  // Defaulted for the same reason as the four above: no third state for a reader
  // to interpret. Neither is seeded from a header — `motion` delegates to the
  // browser through its own `system` member rather than through a header, and
  // there is no Accept-Units.
  motion: motionEnum('motion').notNull().default('system'),
  // Defaulted for the same reason as the three above. `follow` delegates to
  // `scheme`, so no reader ever has to answer "null means what?".
  mapScheme: mapSchemeEnum('map_scheme').notNull().default('follow'),
  units: unitsEnum('units').notNull().default('imperial'),
  // Defaulted for the same reason as the five above: no third state for a reader
  // to interpret. Neither is seeded from a header — `clock` delegates to the
  // rider's date format through its own `locale` member, which is the same
  // mechanism `motion` uses for the browser, and there is no Accept-Volume.
  clock: clockEnum('clock').notNull().default('locale'),
  volumeUnits: volumeUnitsEnum('volume_units').notNull().default('auto'),
  // Defaulted for the same reason as the six above: no third state for a reader
  // to interpret. It is the one column here whose default is not "what a rider
  // who said nothing would have wanted" but "what somebody seeing this for the
  // first time needs" — see the enum's own note.
  tips: tipsEnum('tips').notNull().default('on'),
  // WHEN THE GUIDED TOUR WAS FINISHED OR DISMISSED, deliberately NULLABLE rather
  // than defaulted: "has never been offered the tour" decides whether it runs on its
  // own, and is not the same as "ran it and dismissed it at step one". A TIMESTAMP
  // RATHER THAN A BOOLEAN, because the next question is always "how long ago".
  tourDoneAt: timestamp('tour_done_at', { withTimezone: true }),
  // WHETHER THE HEADER'S "Take the tour" SIGN IS HIDDEN. Ziad's call, 2026-09-11:
  // right for a new rider and furniture for one who has taken it twice. A boolean
  // and not a timestamp, unlike `tour_done_at`: nothing will ask how long ago it
  // was hidden. The account menu's item survives either way, so this removes an
  // affordance and never the feature.
  hideTour: boolean('hide_tour').notNull().default(false),
  // THE RIDE THE TOUR IS CURRENTLY BUILDING, OR THE ONE IT LEFT BEHIND. The tour
  // creates a real ride and bins it on Finish and on Skip — but a tab closed mid-tour
  // leaves it live, so the next start bins whatever this still names and the hourly
  // trash sweep bins one older than a day. `set null` on delete so a ride purged by
  // any other path leaves nothing dangling.
  tourRideId: bigint('tour_ride_id', { mode: 'number' }).references(() => rides.id, { onDelete: 'set null' }),
  // Places to push DOWN a place search (#271). FREE TEXT AND NOT A JOIN TABLE: the
  // intended use is as loose as it sounds — a category and one chain by name in the
  // same list — so there is nothing to normalize against.
  //
  // A WEIGHTING AND NEVER A FILTER, which is what makes free text safe: a false
  // match costs one result ranked lower, and the one time a rider is out of fuel
  // with an ARCO in front of them is the time this must not have hidden it.
  avoidPlaces: varchar('avoid_places', { length: 1000 }),
  // The mirror of the column above: places to push UP a place search.
  //
  // TWO COLUMNS AND NOT ONE SIGNED LIST — a leading `-` or `+` would be a syntax to
  // learn, where the point is that a rider types "ARCO, Costco Gas" the way they
  // would say it. NOTHING STOPS A TERM APPEARING IN BOTH; the ranking resolves it.
  favorPlaces: varchar('favor_places', { length: 1000 }),
  // HOW MUCH FURTHER OUT OF THEIR WAY THAN NECESSARY A JOINING GROUP MAY BE SENT to
  // meet sooner, in miles (#370). The builder seeds its dial from this; the dial is
  // still per press.
  //
  // NULLABLE WITH THE DEFAULT IN CODE — the `home_label` arrangement: a rider who
  // clears the box goes back to the app's default rather than carrying the number it
  // was that day. Clamped on the way in and out, which is why there is no CHECK.
  meetDivertMi: integer('meet_divert_mi'),
  // WHAT THE APP CALLS THINGS (#321). The rider's default preset — a vehicle and
  // what powers it — and their own words for any term set to Custom.
  //
  // VARCHAR AND NOT pgEnum for the reason notifications.event is: a new vehicle is
  // a code change and nothing else. Null means the default (motorcycle, gas). A
  // ride carries its own pair and wins over these; `jargon` wins over both.
  vehicle: varchar('vehicle', { length: 20 }),
  power: varchar('power', { length: 20 }),
  // `{ journey: 'adventure', highway: 'motorway' }` — only the rows a rider
  // customized. jsonb rather than fourteen columns because the row set is the
  // table in vocab.ts and a fifteenth term must not be a migration.
  jargon: jsonb('jargon').$type<Record<string, string>>(),
  // Contact details, each behind its own share flag (#183).
  //
  // TWO FLAGS AND NOT ONE, deliberately. `share_payment_handles` covers four
  // fields because the four are the same kind of thing; a phone number is not
  // the same kind of thing as an Instagram handle, and one flag over both would
  // mean a rider who wants their socials seen has to publish their phone to do
  // it. The phone's default matters more than any other on this table.
  phone: varchar('phone', { length: 40 }),
  sharePhone: boolean('share_phone').notNull().default(false),
  // HANDLES, NOT URLS, and that is a security decision rather than a storage
  // preference. A rider-supplied `href` needs a scheme allow-list or
  // `javascript:` is stored XSS, and JSX escaping does not save an attribute. A
  // handle cannot carry a scheme, so composing the link at render time removes
  // the class of bug instead of defending against it. Same shape as the four
  // payment handles above.
  instagram: varchar('instagram', { length: 120 }),
  facebook: varchar('facebook', { length: 120 }),
  youtube: varchar('youtube', { length: 120 }),
  strava: varchar('strava', { length: 120 }),
  shareSocials: boolean('share_socials').notNull().default(false),
  // The rider's own avatar, counted HERE AND NOWHERE ELSE — never in
  // `users.used_bytes` and never in `rides.size_bytes`'s generated expression. Same
  // rule as `bikes.photo_bytes`: an avatar is not ride data, and a fourth byte
  // column reaching that expression corrupts quota accounting on every delete.
  //
  // Zero means "no uploaded avatar", which makes this the flag as well as the size.
  avatarBytes: integer('avatar_bytes').notNull().default(0),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})

// What a bike runs on. `gas`, not `petrol`: American English everywhere in code,
// comments and copy, the same rule that keeps `color` spelled that way. It
// shares a word with the `gas` waypoint role and that is not a collision — one
// is a reason to stop, the other is what a machine drinks.
export const fuelTypeEnum = pgEnum('fuel_type', ['gas', 'electric'])

// THE PADDOCK — a rider's bikes. Owned by the rider and not by any ride: which
// bike somebody brought is ride membership's problem (#71).
//
// RANGE IS STORED IN METERS, although the rider types miles. #150 will let a rider
// switch the site to metric, and a value stored in whatever unit somebody typed
// drifts on every round trip.
//
// NULLABLE, and null is not zero: null means nobody has measured this bike's range,
// where zero would mean a machine that cannot leave the driveway. Range features
// must skip a null rather than treating it as a very thirsty bike.
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
    // supermoto are not the same route, and the number a rider would give changes
    // with which one is in the garage.
    comfortRangeM: integer('comfort_range_m'),
    // Tank capacity in MILLILITERS, typed in gallons or liters — the same unit
    // boundary `usable_range_m` follows, and src/bikes/policy.ts is again the
    // only place the two meet. Stored metric because #150 will switch the site
    // over, and a value stored in whatever unit somebody typed drifts on every
    // round trip.
    //
    // NULLABLE, AND NULL IS NOT ZERO. Most riders will never fill it in, and a
    // tank of zero is a different claim from a tank nobody has measured.
    tankMl: integer('tank_ml'),
    // The photo's bookkeeping, mirroring rides.thumb_hash: the hash lets the route
    // serve the image immutable, because a changed picture is a changed URL.
    //
    // `photo_bytes` IS COUNTED HERE AND NOWHERE ELSE — out of rides.size_bytes and
    // out of users.used_bytes, since a bike photo is not ride data and a fourth byte
    // column in that generated expression corrupts quota accounting on every delete.
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
    // 100 L, comfortably past any production motorcycle, for the same reason the
    // range ceiling exists: a fat-fingered entry must not poison a fuel
    // calculation downstream.
    check('ck_bike_tank', sql`${t.tankMl} is null or (${t.tankMl} > 0 and ${t.tankMl} <= 100000)`),
    check(
      'ck_bike_comfort',
      sql`${t.comfortRangeM} is null or (${t.comfortRangeM} > 0 and ${t.comfortRangeM} <= 2000000)`,
    ),
  ],
)

// Every username a rider has held, current one included. Two jobs: showing them
// their own history, and keeping a released name out of anyone else's hands for a
// cooling-off period.
//
// The window cannot be an index — "unavailable unless you are the rider who
// released it" is not something a unique constraint can express — so it is an
// application check, and uq_username_lower remains the hard guard.
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

// A grant of access, issued by a manager, redeemed by whoever holds the link. The
// token follows login_tokens exactly: random bytes handed out, only the SHA-256
// hash stored. An invite deliberately identifies no person — a group link is read
// by a whole Discord channel.
//
// Not a second authorization system: grants_beta performs the same pending → active
// transition /admin performs, through the same rule in src/emails/rules.ts.
//
// THE SECURITY MODEL IS REVOCABLE-AND-OBSERVABLE, NOT UNFORGEABLE. A link pasted
// into a channel will leak past it; treat that as certain. What works is max_uses
// as a hard budget, label so you can tell which link leaked, expires_at,
// revoked_at, and rotating token_hash.
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
    // SET NULL, not cascade, and nullable for that reason alone: cascading means
    // purging a manager deletes their invites, and invite_redemptions cascades from
    // invites — so it would take OTHER riders' record of how they got in. Losing "who
    // minted it" is the cheapest thing to lose; label carries the human meaning.
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
// The unique index is the idempotency MECHANISM, not a report: it makes a
// double-click, a retried POST and a second visit a week later all cost one seat.
//
// consumed_seat records whether this redemption incremented used_count. It is false
// when the invite had nothing to give this rider, because seats are a budget for
// letting NEW people in — without it, a 25-seat link in a channel of 40 riders who
// mostly have accounts is exhausted by people who gained nothing.
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
// rider, no surrogate id to keep in sync.
//
// answers is jsonb and the question set lives in src/survey/questions.ts, so
// changing a question is a code change and never a migration.
//
// $type<> is a compile-time claim Postgres does not enforce. EVERY read goes through
// parseAnswers(), which is lenient by design. submitted_at null means a draft.
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
// ride > route > leg > stop/POI. The slug is the share id; visibility gates. Byte
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
    // WHEN THE ALTERNATE VOTE CLOSES, and null — every row predating this — means it
    // never does. A null tally is ADVISORY: the numbers are shown and the owner
    // promotes one by hand. Set, and the sweep elects each group's leader.
    //
    // Opt-in per ride rather than a global default: something that rewrites which
    // road a ride takes, unattended, on a site real riders have accounts on, should
    // be a thing the owner asked for.
    altVotesCloseAt: timestamp('alt_votes_close_at', { withTimezone: true }),
    // THE MAIN GROUP: whose clock is fixed AND, since #239, whose road every other
    // group joins when a meeting point is proposed. Not a decision the app can make
    // fairly on its own — 3 miles against 60 to a 6am meet is unfair, the same two
    // distances to a 10am meet heading the other way is not. #67 is explicit that the
    // DEFAULT must not be the planner's own group: it is the one most likely to be
    // nearest the meet, so that default reproduces the unfair case every time.
    primarySubgroupId: bigint('primary_subgroup_id', { mode: 'number' }).references(
      (): AnyPgColumn => rideSubgroups.id,
      {
        onDelete: 'set null',
      },
    ),
    // DEAD AS OF #239 AND READ BY NOTHING. It held whose route a rendezvous was
    // proposed against, kept separate on the reasoning that the two come apart. That
    // reasoning is struck rather than deleted so it is not rediscovered and acted on:
    // `primary_subgroup_id` carries both axes now. The column stays because dropping
    // one is two deploys under expand/contract.
    trunkSubgroupId: bigint('trunk_subgroup_id', { mode: 'number' }).references((): AnyPgColumn => rideSubgroups.id, {
      onDelete: 'set null',
    }),
    timeAnchor: timeAnchorEnum('time_anchor').notNull().default('departure'),
    // WHEN THE RIDER WANTS TO BE LOOKING FOR A BED, as minutes from midnight. Null
    // means they have not said, which is most rides.
    //
    // A WALL CLOCK, LIKE `routes.start_at`. Minutes from midnight rather than a
    // `time` column because there is no date to attach it to and no zone to read it
    // in, and an integer cannot accidentally acquire either.
    //
    // PER RIDE rather than per rider or per route: a relaxed tour and a hard push
    // want different answers, and a per-route one would ask nine times.
    stopByMin: integer('stop_by_min'),
    // WHICH VEHICLE THIS RIDE IS FOR (#321). Per ride from the start: a rider who owns
    // a bike and a car plans rides for each, and the words on every surface showing
    // the ride follow this pair. Null means unset. Varchar for the reason the
    // profile's columns are; coerced by src/views/vocab.ts on every read.
    vehicle: varchar('vehicle', { length: 20 }),
    power: varchar('power', { length: 20 }),
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
    // WHEN THE STORED ORIGINAL WAS WRITTEN, so an export can tell a ride that still IS
    // its uploaded file from one rebuilt in the builder since.
    // `updated_at > original_stored_at` is the whole test, the same shape as
    // `updated_at > thumb_built_at`.
    //
    // It exists because the export route prefers the stored original and nothing
    // clears it when the builder saves: a rider who imported a GPX, spent an hour
    // re-cutting it and pressed Export got the pre-edit file back, silently.
    //
    // NULL where nothing was ever stored, which is every ride built here.
    originalStoredAt: timestamp('original_stored_at'),
    // Must include every byte column. used_bytes is incremented by the app on
    // import and decremented by this on delete, so a column missing here means
    // quota leaks a little on every delete, permanently and silently.
    sizeBytes: integer('size_bytes').generatedAlwaysAs(sql`kml_bytes + gpx_bytes + source_bytes`),
    totalMiles: numeric('total_miles', { precision: 7, scale: 1 }).notNull().default('0'),
    totalDurationS: integer('total_duration_s').notNull().default(0),
    stopCount: smallint('stop_count').notNull().default(0),
    viewCount: integer('view_count').notNull().default(0),
    // The thumbnail's bookkeeping. Both null means one has never been built, which is
    // the state a ride with no drawable geometry stays in.
    //
    // `thumb_hash` fingerprints the Static Maps request MINUS the API key; the sweep
    // recomputes and skips the fetch when it matches.
    //
    // There is deliberately NO byte column here: the PNG is derived data, not the
    // rider's file, and `size_bytes` must name every byte column on this table.
    thumbHash: varchar('thumb_hash', { length: 32 }),
    thumbBuiltAt: timestamp('thumb_built_at'),

    // The recycle bin. Same three-column shape as the GTFO hold on `users`, and
    // deliberately so: that is a 30-day reversible hold that ends in a purge, and so
    // is this. Nullable with no default, for the reason approved_email_at documents
    // above; null here means "not in the bin".
    deletedAt: timestamp('deleted_at'),
    // The deadline, stored rather than derived from deleted_at + the constant: it is a
    // promise made to a person on a date, so changing TRASH_HOLD_DAYS must not
    // retroactively move a purge date a rider was already shown. Recomputed on every
    // trash, which is also what makes the reset work.
    purgeAfter: timestamp('purge_after'),
    // Claimed by the purge before it starts, so a crash cannot wedge the row and
    // two triggers cannot both run it. Rides carry this and places/groups do not
    // because a ride purge also removes files from disk and can therefore
    // half-finish; a place purge is one statement.
    purgeStartedAt: timestamp('purge_started_at'),

    // WHEN THE RIDER WAS WARNED THIS RIDE WAS ABOUT TO BE DESTROYED. Set once, a week
    // out, by the hourly trash sweep. NOT cleared on restore and it does not need to
    // be: `purge_after` is recomputed on every trash, and the sweep compares this
    // stamp against that deadline rather than testing it for null.
    purgeWarnedAt: timestamp('purge_warned_at'),

    // WHAT A SAVE IS CHECKED AGAINST, so two riders in one builder cannot silently
    // overwrite each other. Bumped in the same transaction as every write; a PUT
    // carrying an older value is refused with a 409.
    //
    // A COUNTER RATHER THAN `updated_at`: two saves inside the same millisecond are
    // indistinguishable by a timestamp at a 3-second autosave.
    //
    // It covers the RIDE-level fields only. Routes are merged per uid and carry their
    // own hash, because refusing a whole save because somebody renamed route 4 is
    // what makes concurrent editing unusable rather than safe.
    rev: bigint('rev', { mode: 'number' }).notNull().default(0),

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

// One route within a ride: ordered stops joined by routed legs. The time model
// (startAt/endAt) exists so the timeline slider is pure UI; distanceM/durationS are
// caches over the route's legs.
//
// A route is a *position* within a ride, not a calendar date: two routes can share
// a date, and a ride with no dates at all still has routes.
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
    // A WALL CLOCK AT THE DEPARTURE POINT, CARRIED AS UTC — not an instant. A 9am
    // departure is 9am where the bike is and nothing converts it into anyone's local
    // time; `public/js/route-clock.js` is the only place the conversion between this
    // and an input field happens.
    //
    // The type stays `timestamptz` although the value is naive, and that is measured:
    // node-postgres parses `timestamp without time zone` in the PROCESS's zone, so a
    // stored 09:00 read back on a Pacific machine comes out 16:00Z. `timestamptz`
    // round-trips the exact digits with no environment dependency.
    startAt: timestamp('start_at', { withTimezone: true }),
    endAt: timestamp('end_at', { withTimezone: true }),
    distanceM: integer('distance_m').notNull().default(0),
    durationS: integer('duration_s').notNull().default(0),
    // How twisty the route's roads are, in degrees of heading change per mile.
    // Computed from geometry at write time in both the builder save and the KML/GPX
    // import. Nullable, and null is NOT 0: 0 claims the road is straight, null says
    // nothing has measured it. A route with no legs stays null forever.
    twistinessDpm: integer('twistiness_dpm'),
    // The same figure over the twistiest 20-mile stretch of the route, which is
    // the number that actually tells a rider whether to go — a route average
    // buries 40 good miles under 200 of slab.
    twistinessBestDpm: integer('twistiness_best_dpm'),
    // THE ROUTE'S DURABLE IDENTITY, the same answer points.uid is to the same problem.
    // `routes.id` churns on every save and `alt_group` is renumbered densely, so
    // NEITHER can be referenced from another table. Client-minted, exactly like a
    // point's: same alphabet, same length, or the save 400s.
    uid: varchar('uid', { length: 12 }).notNull(),
    // WHOSE ROUTE THIS IS. Null means everyone rides it — the trunk — and that is the
    // value every route predating #67 carries, which is why this needed no backfill.
    //
    // A subgroup owns a SUBSEQUENCE of the ride's positions rather than a parallel
    // numbering of its own, so uq_route_ride_pos is untouched and a multi-route
    // approach is simply more routes.
    //
    // `set null` on delete: removing a subgroup makes its routes everyone's rather
    // than destroying them.
    subgroupId: bigint('subgroup_id', { mode: 'number' }).references((): AnyPgColumn => rideSubgroups.id, {
      onDelete: 'set null',
    }),
    // ALTERNATES: two or more candidate routings for the same stretch, of which
    // exactly one counts toward the ride's mileage. src/maps/alts.ts owns every rule.
    //
    // A WITHIN-PAYLOAD PARTITION KEY, NOT A STABLE ID. `alt_group` is rewritten
    // densely from 0 on every save and means only "these routes are siblings".
    // Nothing may store it or join to it: the autosave deletes every route of a ride
    // and reinserts it, so no `routes.id` survives a save.
    //
    // Null means a plain route. A group always has at least two members.
    altGroup: smallint('alt_group'),
    // Which member of the group counts. Meaningless while alt_group is null, and
    // forced true there so a stale false cannot hide a plain route from every mileage
    // total in the app. NOT NULL DEFAULT true is what makes this need no backfill:
    // `alt_group IS NULL, alt_active = TRUE` already describes every earlier row.
    altActive: boolean('alt_active').notNull().default(true),
    // WHAT THIS ROUTE ASKS OF THE ROUTER — see src/maps/route-prefs.ts. PER ROUTE
    // RATHER THAN PER RIDE: a Saturday in the hills and the Monday slog home want
    // opposite answers.
    //
    // NULLABLE WITH NO DEFAULT, which is what makes it safe in one deploy under
    // expand/contract, and `{}` is normalized to null so one state cannot have two
    // spellings. jsonb rather than three booleans because the set grows; the shape is
    // not open — routePrefsSchema is `.strict()`.
    routePrefs: jsonb('route_prefs').$type<RoutePrefs>(),
    // WHAT THIS ROUTE CONTAINED WHEN IT WAS LAST WRITTEN — see route-revision.ts. It
    // is what lets a save merge per route instead of refusing whole.
    //
    // STORED RATHER THAN COMPUTED ON READ: the merge needs one cheap `select uid,
    // content_hash`, where recomputing means loading every point and leg of every
    // route on every save.
    //
    // NULLABLE, and null means UNKNOWN rather than changed: mergeRoutes() takes the
    // client's version on an unknown, so this migration was not an outage.
    contentHash: varchar('content_hash', { length: 32 }),
  },
  (t) => [
    uniqueIndex('uq_route_ride_pos').on(t.rideId, t.position),
    // Scoped to the ride rather than global, the same way uq_point_route_uid is
    // scoped to the route: a uid is unique where it is REFERENCED FROM, and
    // alt_votes is keyed by (ride_id, route_uid). A global unique index would also
    // make importing a native JSON file twice fail on the second copy.
    uniqueIndex('uq_route_ride_uid').on(t.rideId, t.uid),
    // A TRIPWIRE, NOT A GATE. resolveAltGroups() is total and always elects exactly one
    // active member, so this should be unreachable — it turns a hole in that function
    // into a loud failure rather than a quietly stored ride whose mileage is wrong.
    // Partial, because without the WHERE every plain route would collide on
    // (ride_id, NULL).
    uniqueIndex('uq_route_alt_active')
      .on(t.rideId, t.altGroup)
      .where(sql`${t.altActive} and ${t.altGroup} is not null`),
  ],
)

// The dots (docs/ideas.md). EVERY point in a route is ordered — `position` is the
// rider's own sequence and is set for both kinds. `kind` says only whether the
// point anchors routing.
//
// It replaced a model where only stops carried a position and a POI's place was
// DERIVED by projecting it onto the route's track — a derivation with no answer
// before a route existed, where every POI on a trackless route reported distance 0.
//
// The third dot kind, ephemeral shaping waypoints, lives in route_legs.via_points.
export const points = pgTable(
  'points',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    routeId: bigint('route_id', { mode: 'number' })
      .notNull()
      .references(() => routes.id, { onDelete: 'cascade' }),
    kind: pointKindEnum('kind').notNull(),
    // The rider's order within the route, for BOTH kinds. Dense from 0.
    position: smallint('position').notNull(),
    lat: doublePrecision('lat').notNull(),
    lng: doublePrecision('lng').notNull(),
    name: varchar('name', { length: 255 }).notNull().default(''),
    // WHERE THE SPOT IS, IN WORDS, AND IT IS PUBLIC — which is what makes it a column
    // here rather than a field on point_details: the popup names a place and a rider
    // reading a shared ride has no way to tell which Shell in Bakersfield is meant.
    //
    // `point_details.address` is a DIFFERENT field: owner-only, typed by hand, beside
    // the confirmation number. This one is what Google answered when the point was
    // added. Null is the ordinary state for a point dropped on the map.
    address: varchar('address', { length: 300 }),
    description: varchar('description', { length: 2000 }),
    roles: waypointRoleEnum('roles')
      .array()
      .notNull()
      .default(sql`'{}'::waypoint_role[]`),
    durationMin: integer('duration_min'),
    // TIME ONLY A LATE GROUP SPENDS, where duration_min is time everyone spends.
    // Meaningful on a meeting point and nowhere else.
    //
    // The two behave differently, which is the whole reason for a second column:
    // dwell pushes the shared departure later for everybody, slack is a margin ahead
    // of it that absorbs one group running late without moving anyone.
    //
    // Null is not zero: null means nobody set any, 0 means none is wanted.
    slackMin: integer('slack_min'),
    distFromStartM: integer('dist_from_start_m'), // server-computed cumulative meters
    // The point's DURABLE identity, and the thing `id` is not.
    //
    // `PUT /api/rides/:id` deletes and re-inserts every route and point on every
    // save, so `id` churns and anything referencing a point across a save would
    // silently lose it. point_details is keyed by this rather than by the row id.
    //
    // Client-generated so the builder can attach details to a stop it has only just
    // created. A payload arriving without one gets one server-side.
    //
    // Unique per ROUTE and not globally: it only has to disambiguate within the ride
    // being saved, and a global index would make two riders importing the same file
    // collide for no reason.
    uid: varchar('uid', { length: 12 }).notNull(),
  },
  (t) => [
    // Now a real uniqueness constraint over every point in the route. It used to
    // lean on NULLS DISTINCT so that any number of POIs could coexist carrying
    // null; with position NOT NULL for both kinds there is nothing to except.
    uniqueIndex('uq_point_route_pos').on(t.routeId, t.position),
    index('idx_point_route').on(t.routeId),
    uniqueIndex('uq_point_route_uid').on(t.routeId, t.uid),
    check('ck_point_roles_max4', sql`cardinality(roles) <= 4`),
    // ck_point_stop_pos is gone: it said "a stop must have a position", which
    // the NOT NULL above now says about every point.
  ],
)

// The private half of a stop: reservations, confirmation numbers, gate codes,
// check-in and check-out, phone, address, links, and freeform notes.
//
// A SEPARATE TABLE, and that is the load-bearing part of the whole feature.
// `points` is what `ride.json` is built from and what every export serializes, so
// a confirmation number stored as a column there is one forgetful `select()` away
// from a public share. Its own table has to be JOINed to leak, and a join is
// visible in review. Same reasoning that splits `user_profiles` from `users`.
//
// Keyed by (ride_id, uid) rather than by point_id, because point ids churn on every
// save. ride_id cascades; a point deleted from a ride is cleaned up by uid at save
// time, in src/maps/ride-graph.ts.
export const pointDetails = pgTable(
  'point_details',
  {
    rideId: bigint('ride_id', { mode: 'number' })
      .notNull()
      .references(() => rides.id, { onDelete: 'cascade' }),
    uid: varchar('uid', { length: 12 }).notNull(),
    // Reservation and arrival. checkInAt/checkOutAt follow routes.start_at exactly
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

/**
 * What a rider said about a ride, or about one point on it (#190).
 *
 * **ANCHORED TO A POINT BY `uid`, OR TO THE RIDE WHEN `point_uid` IS NULL.** Two
 * anchors and one table: splitting them would mean two queries, two policies and
 * two chances to forget the gate.
 *
 * **AN ORPHANED COMMENT DEMOTES TO THE RIDE. IT IS NEVER DELETED BY A SAVE, AND
 * THIS IS THE OPPOSITE OF EVERY OTHER uid-KEYED CHILD OF A RIDE.** point_details
 * and alt_votes are reconciled away when their uid leaves the payload, correctly,
 * because they are DATA ABOUT a point. A comment is a thing a PERSON said, so
 * demoteOrphanComments() sets point_uid to null and the thread carries on.
 *
 * **`point_label` IS DENORMALIZED FOR EXACTLY THAT MOMENT**: the row it referred
 * to is gone, so "on Shell, Oakdale" is the only thing that stops the comment
 * being about nothing. Never updated afterwards.
 *
 * Cascades from `rides` like point_details, for the same reason.
 */
export const rideComments = pgTable(
  'ride_comments',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    rideId: bigint('ride_id', { mode: 'number' })
      .notNull()
      .references(() => rides.id, { onDelete: 'cascade' }),
    // Cascade rather than `set null`: an account purge destroys what that rider
    // wrote, the same as it destroys their rides. An anonymous comment nobody
    // can be asked about is worse than no comment.
    authorId: bigint('author_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Null means the ride itself — either written there, or demoted there when
    // its point went away. The two are indistinguishable by design; what the
    // reader needs is point_label, not which of the two happened.
    pointUid: varchar('point_uid', { length: 12 }),
    pointLabel: varchar('point_label', { length: 200 }),
    body: varchar('body', { length: 4000 }).notNull(),
    // Closed rather than deleted. A resolved comment stays readable — the
    // question and the answer are the record of why a ride is shaped the way it
    // is, which is the same argument docs/decisions.md is built on.
    resolvedAt: timestamp('resolved_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [
    // The one query the surface makes: every comment on a ride, oldest first,
    // grouped into threads in memory. A ride's comments are counted in dozens.
    index('idx_ride_comment_ride').on(t.rideId, t.createdAt),
  ],
)

// HOW A SUGGESTION ENDED, and only ever written together with resolved_at. There
// is deliberately no `pending` member and no `stale` one: pending is resolved_at
// being null, and stale is DERIVED from the target route's fingerprint — a stored
// one would be wrong the moment a route was edited back.
export const suggestionOutcomeEnum = pgEnum('suggestion_outcome', ['accepted', 'discarded', 'withdrawn'])

/**
 * A proposed change to one route of a ride, waiting for an owner to take it or
 * leave it (#190).
 *
 * **A SUGGESTION IS A WHOLE ROUTE, NOT A FIELD-LEVEL DIFF.** The builder deletes
 * and re-inserts every route and point on every save, so there is no stable row to
 * hang a per-field change off. Storing the proposed route whole means accepting
 * one is a replace, which this app already does on every save.
 *
 * **STALENESS IS DERIVED, NEVER STORED.** `base_fingerprint` is what the target
 * route looked like when the suggestion was made; a suggestion is stale when the
 * fingerprint no longer matches. Nothing has to sweep, and a route edited and then
 * edited BACK correctly stops being stale, which a stored flag would get wrong.
 *
 * **THE TARGET IS A ROUTE `uid`, NEVER AN `id`.** routes.id churns on every save.
 */
export const rideSuggestions = pgTable(
  'ride_suggestions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    rideId: bigint('ride_id', { mode: 'number' })
      .notNull()
      .references(() => rides.id, { onDelete: 'cascade' }),
    authorId: bigint('author_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Which route this proposes to replace.
    routeUid: varchar('route_uid', { length: 12 }).notNull(),
    // The proposed route, in the same shape the builder's PUT accepts for one.
    // jsonb rather than a parallel set of tables: nothing queries across the
    // inside of a suggestion, and a second copy of the route/point/leg schema is a
    // second place for the payload's shape to drift.
    payload: jsonb('payload').$type<unknown>().notNull(),
    // What the route looked like when this was made. See the note above on why
    // staleness is derived from this rather than stored beside it.
    baseFingerprint: varchar('base_fingerprint', { length: 64 }).notNull(),
    // Why. Optional, because the diff is usually the argument.
    note: varchar('note', { length: 2000 }),
    // Null while pending. The outcome column says which way it went; the two are
    // written together and neither is read without the other.
    resolvedAt: timestamp('resolved_at'),
    outcome: suggestionOutcomeEnum('outcome'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [index('idx_ride_suggestion_ride').on(t.rideId, t.createdAt)],
)

// Leg i connects point i to point i+1, carrying the road-snapped geometry from the
// Directions API (distance/duration are Directions-authoritative). via_points are
// the rider's ephemeral shaping waypoints.
//
// THIS IS NOW TRUE OF IMPORTED RIDES TOO. They used to store one leg at position 0
// holding the whole track, which the viewer coped with — but the builder's model IS
// this invariant, so an import could never be opened, saved or exported as valid
// native JSON. The import cuts the uploaded track at its stops now; see
// src/maps/track-split.ts. The one thing unchanged: distance and duration on an
// imported leg come from geometry, because an imported ride never touches the
// router.
//
// Still `route_legs` after routes stopped being called routes: the "route" here is
// the path a route traces, not a reference to the renamed table.
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
    viaPoints: jsonb('via_points')
      .$type<[number, number][]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
  },
  (t) => [uniqueIndex('uq_leg_route_pos').on(t.routeId, t.position)],
)

// One submission of any kind — a bug, an idea or a question. The word is "report":
// never "ticket", never "issue", never "post". See docs/rider-feedback.md.
//
// state and status are two columns on purpose; the enums above say why.
//
// The audience shapes the columns. Riders are motorcyclists on phones, often
// outdoors, who will not write reproduction steps and will abandon a form that asks
// — so `body` is the only required field, `title` is DERIVED from it, and every
// other text column is optional.
//
// priority is owner-only and must NEVER reach a rider-facing surface.
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
// blob runs 5–50 KB and every board query would drag it across the wire.
//
// $type<> is a compile-time claim Postgres does not enforce: every read goes
// through parseDiagnostics(), which is lenient by design and never casts.
//
// NOTHING REACHES THIS COLUMN UNREDACTED. src/feedback/diagnostics.ts strips query
// strings and fragments from every URL, and geolocation is recorded as a permission
// state, never a position.
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

// A rider's reusable library of locations: home, the good fuel stop, the meet point
// everyone knows. Dropped into any ride as a stop.
//
// **A place is COPIED into a ride, never referenced.** There is deliberately no
// `place_id` on `points`: a ride is a record of what the rider planned, so renaming
// "Bob's Gas" must not reach back and rewrite a ride from last year. It also
// sidesteps the churn problem, points being deleted and re-inserted on every save.
//
// The cost, stated so nobody re-litigates it as a bug: fixing a badly placed pin
// fixes it for FUTURE rides only.
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
    // PARTIAL, and that is what stops the bin blocking a name: unique on (owner, name)
    // across every row would mean a rider who trashed "Oregon" could not create a new
    // one, refused on the strength of a row they cannot see.
    //
    // The flip side, handled in the restore path rather than here: restoring a group
    // whose name has since been reused collides, and that restore is refused by name.
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
    // NULLABLE, a usability decision rather than an omission: requiring a group would
    // mean inventing one before a rider can save their first place. Ungrouped is a
    // real state and the UI shows it as its own section.
    //
    // `set null` on delete rather than cascade: deleting a group must not delete the
    // places in it.
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
export type RideCommentRow = typeof rideComments.$inferSelect
export type RideSuggestionRow = typeof rideSuggestions.$inferSelect
export type SuggestionOutcome = (typeof suggestionOutcomeEnum.enumValues)[number]
// --- The rider layer --------------------------------------------------------

// WHO A RIDE BELONGS TO, which is an identity rather than a permission. What a
// rider may DO is ride_perm below, deliberately a second column: folding the ladder
// into this enum would make `owner` a rung, and every rule that asks "is this the
// owner" would start having to ask "or one of these".
//
// `owner` IS HELD BY MORE THAN ONE ROW SINCE #190 — co-owners rather than an
// ownership transfer. rides.owner_id stays singular and keeps meaning the creator
// and the QUOTA holder, because rides.size_bytes rolls up to users.used_bytes
// through one owner. Co-ownership is a roster role; the bytes belong to the creator.
export const rideRoleEnum = pgEnum('ride_role', ['owner', 'rider'])

// WHAT A MEMBER MAY DO to the ride they are on. Least to most: look at it, discuss
// it, propose changes to it, change it (#190).
//
// THE MEMBER ORDER IS NOT THE RANK AND CANNOT BE REORDERED LATER. Same trap as
// visibilityEnum: `ALTER TYPE ... ADD VALUE` appends, so putting a new rung "in the
// right place" means rebuilding every column using the type. Nothing may sort by
// this or compare two members — PERM_RANK in src/members/policy.ts is the only
// ordering. It happens to read in ascending order today; nothing may rely on that.
export const ridePermEnum = pgEnum('ride_perm', ['view', 'comment', 'suggest', 'edit'])

// Distinct from role, because a rider who declined is still on the roster —
// that is the whole reason the two are separate columns.
export const rsvpEnum = pgEnum('rsvp', ['invited', 'going', 'maybe', 'declined'])

export const friendshipStatusEnum = pgEnum('friendship_status', ['pending', 'accepted', 'blocked'])

// A NAMED SET OF RIDERS SHARING AN APPROACH — the Oakland contingent, the
// Sacramento contingent. The primitive #67 is built on.
//
// NOT CHURNED ON SAVE, unlike routes and points: if the PUT deleted and re-inserted
// these, every ride_members.subgroup_id would be orphaned on the first edit. So
// insertRideGraph reconciles them BY UID, which is why they have a uid at all and
// why ids here are safe to reference where routes' and points' are not.
export const rideSubgroups = pgTable(
  'ride_subgroups',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    rideId: bigint('ride_id', { mode: 'number' })
      .notNull()
      .references(() => rides.id, { onDelete: 'cascade' }),
    // Client-minted, same alphabet and length as routes.uid and points.uid — see
    // src/maps/uid.ts. It is what lets a payload reference a subgroup the
    // server has never seen.
    uid: varchar('uid', { length: 12 }).notNull(),
    name: varchar('name', { length: 80 }).notNull(),
    // Its own, not borrowed from a route. A subgroup spans several routes and its
    // line on the map has to read as one thing across all of them, which the
    // per-route palette cannot do.
    color: varchar('color', { length: 7 }).notNull().default('#0066cc'),
    position: smallint('position').notNull().default(0),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('uq_subgroup_ride_uid').on(t.rideId, t.uid), index('idx_subgroup_ride').on(t.rideId)],
)

// A rider's relationship to a ride: the primitive several planned features assume
// and none of them owns. Every ride insert seeds its owner a row here, in the same
// transaction.
//
// TWO AXES, THREE COLUMNS, AND THEY ARE ALL DIFFERENT QUESTIONS. `role` is who the
// ride belongs to, `perm` is what this rider may do to it, and `rsvp` is whether
// they are coming. A rider who declined still holds their permission level, and an
// owner's `perm` is never read at all — `owner` outranks the whole ladder.
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
    // WHAT THIS RIDER MAY DO, defaulting to `suggest` — the top of what an invitation
    // grants on its own. Edit is a deliberate promotion by an owner and never
    // something an invite hands out, which is the whole shape of #190.
    //
    // Existing rows backfilled to `suggest` rather than `view`: it grants comment and
    // suggest rights to riders whose owners never chose that, accepted because the
    // alternative makes every existing owner promote their roster by hand.
    //
    // An owner's value here is never read, and is left at the default rather than
    // stamped to `edit`, so demoting a co-owner is one column changing and not two.
    perm: ridePermEnum('perm').notNull().default('suggest'),
    rsvp: rsvpEnum('rsvp').notNull().default('invited'),
    // Which approach this rider is on. NULLABLE AND THAT IS LOAD-BEARING: a
    // club secretary planning a joint rally is not in any of the groups, and
    // #67 says so explicitly. `set null` rather than cascade, so deleting a
    // subgroup un-groups its riders instead of throwing them off the ride —
    // the same call place_groups made about its places.
    subgroupId: bigint('subgroup_id', { mode: 'number' }).references((): AnyPgColumn => rideSubgroups.id, {
      onDelete: 'set null',
    }),
    // WHICH BIKE THEY ARE BRINGING, which #52 needs and which a rider's default bike
    // cannot answer on its own: the point of owning two is that you pick one per ride.
    // Null falls back to their default, so a rider who has never said still counts
    // toward the group's range. `set null` rather than cascade: selling a bike must
    // not throw its owner off every ride they were on.
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

// Who a rider watches. A SECOND RELATION, and deliberately not a mode of
// `friendships`.
//
// **DIRECTION IS THE DATA HERE, WHICH IS WHY THERE IS NO CANONICAL ORDERING.**
// `friendships` holds one row per pair under `rider_a < rider_b` because "are these
// two friends" is one question with one answer; following is two independent
// questions. So there are two columns with distinct meanings, two rows for a mutual
// follow, and no order check — copying that constraint here would make the relation
// symmetric, which is the whole thing it is not.
//
// **NO STATUS COLUMN, BECAUSE THERE IS NOTHING TO ACCEPT.** A follow is done the
// moment it is made and undone by deleting the row; a `pending` follow would be a
// friend request with a different name.
//
// **FOLLOWING GRANTS NO VISIBILITY. NOT ANY. EVER.** It decides what reaches a
// rider's feed and nothing else — `canView()` does not know this table exists and
// must not learn. If following granted what friendship grants, `friends` visibility
// would be openable by anyone willing to press a button.
//
// **A BLOCK REMOVES THE ROW IN BOTH DIRECTIONS AND REFUSES A NEW ONE**, or the
// blocked rider goes on watching the blocker's feed.
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

// One member's pick among a route's alternates.
//
// KEYED BY (ride_id, route_uid), NOT BY route_id, and cascading from `rides` rather
// than `routes` — the same arrangement point_details has: the builder's PUT deletes
// and re-inserts every route on every save, so a foreign key to `routes` would take
// every vote with it the first time anybody moved a stop.
//
// The flip side is the same too: `reconcileVotes()` deletes rows whose uid left the
// payload, or a vote for a deleted alternate lives forever and keeps counting.
export const altVotes = pgTable(
  'alt_votes',
  {
    rideId: bigint('ride_id', { mode: 'number' })
      .notNull()
      .references(() => rides.id, { onDelete: 'cascade' }),
    routeUid: varchar('route_uid', { length: 12 }).notNull(),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [
    // THE COMPOSITE KEY IS THE ANTI-DOUBLE-VOTE MECHANISM, enforced by Postgres rather
    // than by a check a second code path could forget.
    //
    // What it CANNOT enforce is one vote per alt GROUP, because a group has no durable
    // id: it forms and dissolves as a rider edits, and `alt_group` is renumbered on
    // every save. castVote() resolves the group from the current routes and clears the
    // member's other votes in it.
    primaryKey({ columns: [t.rideId, t.routeUid, t.userId] }),
    index('idx_alt_vote_ride').on(t.rideId),
  ],
)

// WHO IS ON THIS STRETCH OF ROAD. It supersedes `routes.subgroup_id` as the answer
// to that question without removing it.
//
// A SUBGROUP COULD NOT SAY IT. A route carried one subgroup or none, and a rider
// belonged to one subgroup for the whole ride — so "three riders join at Portland
// and one of them peels off at Eugene" had nowhere to live. Every real ride breaks
// it the same way, because the set of people riding together changes for reasons
// that have nothing to do with where anybody set off from.
//
// SO THE PRIMITIVE IS THE RIDER, NOT THE GROUP. A group survives as a convenience
// for assigning several riders at once and as the thing a meeting point is proposed
// FOR; it is no longer what says who rides a route.
//
// KEYED ON `route_uid` AND CASCADING FROM `rides`, NOT FROM `routes`, since
// `routes.id` churns on every save. Same arrangement as `alt_votes` and
// `point_details`, and the same obligation: `reconcileRouteRiders()` deletes rows
// whose uid left the payload.
//
// ROWS ARE AN OVERRIDE, AND THEIR ABSENCE IS NOT "NOBODY". A route with no rows
// INHERITS the set from the route before it, and the first route of a ride with none
// is ridden by the whole roster — that is how a ride reads: you say who leaves and
// who joins. `resolveRouteRiders()` is the walk and the only place the rule lives.
export const routeRiders = pgTable(
  'route_riders',
  {
    rideId: bigint('ride_id', { mode: 'number' })
      .notNull()
      .references(() => rides.id, { onDelete: 'cascade' }),
    routeUid: varchar('route_uid', { length: 12 }).notNull(),
    riderId: bigint('rider_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // WHICH GROUP THEY ARE RIDING AS, ON THIS ROUTE — a DIFFERENT QUESTION from
    // `ride_members.subgroup_id`, which is the group a rider BELONGS to on this ride.
    // This is who they are riding as on one stretch: VMCSC on their own feeder, the
    // main group from the moment they join it.
    //
    // A GROUP DOES NOT GET DELETED WHEN IT MERGES, IT JUST STOPS APPLYING. VMCSC
    // survives on the route it rode as VMCSC, which is what a later split reads back
    // to offer "split off as VMCSC again" with those riders prefilled.
    //
    // NULL MEANS THE MAIN GROUP, not "no group": everyone riding together is riding as
    // the main group. `set null` on delete, matching `routes.subgroup_id`.
    subgroupId: bigint('subgroup_id', { mode: 'number' }).references(() => rideSubgroups.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.rideId, t.routeUid, t.riderId] }), index('idx_route_rider_ride').on(t.rideId)],
)

export type PlaceRow = typeof places.$inferSelect
export type RideMemberRow = typeof rideMembers.$inferSelect
// WHAT A RIDER HAS TURNED OFF, AND ONLY WHAT THEY HAVE TURNED OFF.
//
// **A ROW IS AN ANSWER; THE ABSENCE OF ONE IS "NEVER ASKED".** The default lives in
// src/notifications/policy.ts — email on, browser off — and this table stores the
// deviation, as `home_label` stores a name and lets "Home" live in code. That is
// what lets a default change reach every rider who never expressed an opinion and
// none of the riders who did, and it is the only arrangement that works on the
// FIRST new event: a `default true` column writes nothing for a row that does not
// exist yet.
//
// **`event` IS A varchar AND NOT A pgEnum, DELIBERATELY.** The whole point of a
// notification catalog is that the next one is a code change; `ALTER TYPE … ADD
// VALUE` per event would make "tell riders about X" a migration and a deploy.
// `isEvent()` is what every read goes through — a row naming an event this build
// has never heard of is IGNORED rather than trusted, which is also what makes
// removing an event safe with no migration behind it.
export const notificationPrefs = pgTable(
  'notification_prefs',
  {
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    event: varchar('event', { length: 40 }).notNull(),
    channel: varchar('channel', { length: 16 }).notNull(),
    enabled: boolean('enabled').notNull(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [
    // The PK IS the lookup. The send path asks for one rider's whole answer set
    // and the settings page writes it back the same way, so there is no second
    // access pattern to index for.
    primaryKey({ columns: [t.userId, t.event, t.channel] }),
  ],
)

// A BROWSER NOTIFICATION WAITING TO BE RAISED.
//
// **THIS EXISTS BECAUSE CHROME'S NOTIFICATION API ONLY FIRES FROM AN OPEN PAGE.**
// `new Notification(...)` is a call a live document makes, not a delivery channel a
// server can reach — that is Web Push, which needs a service worker, a VAPID pair
// and a dependency. So the server's half of the job is to LEAVE the message where
// the next open page will find it, and `public/js/notifications.js` polls it.
//
// **`delivered_at` IS WHAT STOPS A SECOND RAISE**, not a delete: a row survives
// being shown so two tabs cannot both raise it and so a failure to raise is
// distinguishable from a message that was never stored. Rows are pruned on read
// rather than by a timer, which is self-limiting and costs no sixth interval.
//
// **NOTHING IS WRITTEN HERE FOR A RIDER WHO HAS THE BROWSER CHANNEL OFF.** The
// preference is checked before the insert, so turning the channel on does not
// surface a backlog of everything that happened while it was off.
export const notifications = pgTable(
  'notifications',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // The catalog key, for the same reason and under the same rules as
    // notification_prefs.event above.
    event: varchar('event', { length: 40 }).notNull(),
    // Rendered at SEND time and stored, never re-derived at raise time. The
    // sender is the only code that holds the ride, the rider and the verb
    // together, and a notification about a ride that has since been deleted must
    // still say what it said — the same reasoning `comments.point_label` carries.
    title: varchar('title', { length: 160 }).notNull(),
    body: varchar('body', { length: 400 }).notNull(),
    // Where the notification goes when clicked. A path, never an absolute URL:
    // it is opened by the page that raised it, and a stored origin would be
    // wrong on stage the moment a database is cloned from prod.
    url: varchar('url', { length: 512 }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    // WHEN A TOAST WAS RAISED FOR IT. Set by the poll, which claims and stamps
    // in one statement so two tabs cannot both raise the same message.
    deliveredAt: timestamp('delivered_at'),
    // WHEN THE RIDER READ IT IN THE CENTER, a DIFFERENT question from whether a toast
    // fired, which must not share a column with it: a rider with browser notifications
    // on would otherwise have every badge silently cleared by a toast they never
    // looked at, and a rider with them off — the default — would have `delivered_at`
    // null forever and every notification permanently unread.
    readAt: timestamp('read_at'),
  },
  (t) => [
    // The poll's whole query: this rider's undelivered rows, oldest first.
    // Partial, because delivered rows are the overwhelming majority within
    // moments and none of them is ever selected by it again.
    index('idx_notifications_pending')
      .on(t.userId, t.createdAt)
      .where(sql`${t.deliveredAt} is null`),
    // THE BADGE'S OWN INDEX, and it is a SECOND partial index rather than a
    // widening of the one above because the two predicates are different
    // questions — `delivered_at` is "has a toast fired", `read_at` is "has the
    // rider looked". This one is read on EVERY page render for every signed-in
    // rider, through the correlated subquery in validateSessionToken, so it is
    // the hottest index in this table by a distance.
    index('idx_notifications_unread')
      .on(t.userId)
      .where(sql`${t.readAt} is null`),
  ],
)

// WHICH RELEASES HAVE BEEN ANNOUNCED, AND IT IS A CLAIM RATHER THAN A LOG.
//
// A release note becomes an ordinary `notifications` row for every rider (#288),
// raised on boot by the build that carries the note. Two things make that need a
// table: the fan-out must happen ONCE across restarts, and blue/green starts TWO
// containers per deploy, which race.
//
// **THE PRIMARY KEY IS THE CLAIM.** An insert with `onConflictDoNothing` either
// wins or reports zero rows, atomically, so the loser skips the fan-out without a
// lock or a lease. Same reasoning as the `mkdir` deploy lock.
//
// The id is a slug of the release's own heading, deliberately NOT the build sha:
// every deploy has a new one whether or not a note was written.
export const announcedReleases = pgTable('announced_releases', {
  id: varchar('id', { length: 120 }).primaryKey(),
  announcedAt: timestamp('announced_at').notNull().defaultNow(),
})

export type AnnouncedReleaseRow = typeof announcedReleases.$inferSelect
export type RouteRiderRow = typeof routeRiders.$inferSelect
export type NotificationPrefRow = typeof notificationPrefs.$inferSelect
export type NotificationRow = typeof notifications.$inferSelect
export type FriendshipRow = typeof friendships.$inferSelect
export type AltVoteRow = typeof altVotes.$inferSelect
export type RideSubgroupRow = typeof rideSubgroups.$inferSelect
/** The three pinnable events, derived from the enum so the two cannot drift. */
export type TimeAnchor = (typeof timeAnchorEnum.enumValues)[number]
/** The two ride roles, derived from the enum so the two cannot drift. */
export type RideRole = (typeof rideRoleEnum.enumValues)[number]
/** A rung on the permission ladder. What each one MEANS is src/members/policy.ts
 *  and nothing else may read this union and decide for itself — in particular
 *  nothing may infer an ordering from the member order. */
export type RidePerm = (typeof ridePermEnum.enumValues)[number]
/** The four RSVP states, likewise. */
export type Rsvp = (typeof rsvpEnum.enumValues)[number]
export type BikeRow = typeof bikes.$inferSelect
export type RideRow = typeof rides.$inferSelect
export type RouteRow = typeof routes.$inferSelect
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
