// The account archive format — the "Download Me" package.
//
// Pure, and deliberately so: everything here is arithmetic over plain rows, no
// database and no filesystem, which is what lets it be tested under the
// pure-logic rule that governs test/. The queries live in ./export.ts and the
// reader in ./restore.ts, the same rule-from-query split as invites/policy.ts
// vs service.ts.
//
// The manifest is the source of truth for where every file sits. buildAccountJson
// computes each path once and the writer puts the bytes exactly where the
// manifest says, so a manifest that disagrees with the archive is not a bug that
// can happen — there is only one place the path is decided.
import type { BikeRow, RideRow, UserIdentityRow, UserProfileRow, UserRow, UsernameHistoryRow } from '../db/schema'
import { buildExportName, NATIVE_EXT, slugField } from '../maps/filename'
import { DOWNLOAD_FORMATS, type DownloadFormat } from '../maps/downloads'
import type { StoredExt, StoredFile } from '../maps/storage'

/**
 * Bumped when the shape below changes incompatibly. Read the same way
 * nativeVersion() reads a ride file: a reader that meets a version it does not
 * know refuses rather than guessing, so an archive from a newer build is never
 * half-imported.
 */
export const ACCOUNT_ARCHIVE_VERSION = 1

export const ACCOUNT_JSON = 'account.json'
export const ACCOUNT_README = 'README.txt'

// Not the `routeloop_` marker the ride convention uses, and that is the point:
// READ_MARKERS matches `routeloop` exactly, so parseExportName returns null for
// an account zip and nothing will ever mistake the whole package for one ride's
// export. Underscores separate fields here for the same reason they do there.
const ARCHIVE_MARKER = 'routeloop-account'

/** UTC, matching filename.ts and the roadbook, so the name never shifts by timezone. */
const fmtDay = (d: Date): string => d.toISOString().slice(0, 10)

/** The zip's own name. Falls back to the public id, then to the row id, so it is never nameless. */
export function accountArchiveName(user: Pick<UserRow, 'id' | 'username' | 'publicId'>, exportedAt: Date): string {
  const who = slugField(user.username ?? user.publicId ?? `rider-${user.id}`) || `rider-${user.id}`
  return `${ARCHIVE_MARKER}_${who}_${fmtDay(exportedAt)}.zip`
}

/**
 * One directory per ride, keyed by slug rather than by exported filename.
 *
 * Required, not tidy: buildExportName derives a name from title plus start date,
 * so two rides both called "Sunday Loop" with no dates produce byte-identical
 * filenames and one would silently overwrite the other. The slug is unique by
 * uq_slug and is already the ride's public identity.
 */
export const rideDirFor = (slug: string): string => `rides/${slug}`

export type ArchiveRideInput = {
  ride: RideRow
  /** From rideStartDate() — the ride's first dated route, or null when nothing is dated. */
  startDate: Date | null
  /** What is actually on disk for this ride, from listOwnerFiles(). */
  originals: StoredFile[]
}

/** Another rider, as they already appear to this one on screen: a display name
 *  and a handle, never an email. See the note on AccountArchiveInput. */
export type ArchivePerson = { displayName: string; username: string | null }

export type AccountArchiveInput = {
  user: UserRow
  profile: UserProfileRow | null
  usernameHistory: UsernameHistoryRow[]
  identities: UserIdentityRow[]
  bikes: BikeRow[]
  rides: ArchiveRideInput[]
  // ── Everything below landed 2026-09-07, closing the gap between what the zip
  // said it was and what it held. See the AccountArchive comment.
  notificationPrefs: Array<{ event: string; channel: string; enabled: boolean; updatedAt: Date }>
  placeGroups: ArchivePlaceGroupInput[]
  places: ArchivePlaceInput[]
  friends: ArchiveFriendInput[]
  following: ArchivePerson[]
  followers: ArchivePerson[]
  memberships: ArchiveMembershipInput[]
  comments: ArchiveCommentInput[]
  suggestions: ArchiveSuggestionInput[]
  votes: ArchiveVoteInput[]
  feedback: ArchiveFeedbackInput[]
  survey: ArchiveSurveyInput[]
  exportedAt: Date
}

export type ArchivePlaceGroupInput = { id: number; name: string; position: number; deletedAt: Date | null; createdAt: Date }
export type ArchivePlaceInput = {
  id: number
  groupId: number | null
  name: string
  lat: number
  lng: number
  roles: unknown
  phone: string | null
  address: string | null
  links: unknown
  deletedAt: Date | null
  createdAt: Date
  updatedAt: Date
}
/** A friendship in THIS rider's terms — friendView() has already turned the
 *  sideless row into "them" and "which way it went". */
export type ArchiveFriendInput = { person: ArchivePerson; status: string; direction: string; since: Date | null }
export type ArchiveMembershipInput = {
  rideTitle: string
  rideSlug: string
  role: string
  perm: string
  rsvp: string
  joinedAt: Date
}
export type ArchiveCommentInput = {
  rideTitle: string
  pointLabel: string | null
  body: string
  resolvedAt: Date | null
  createdAt: Date
}
export type ArchiveSuggestionInput = {
  rideTitle: string
  routeUid: string
  note: string | null
  outcome: string | null
  resolvedAt: Date | null
  createdAt: Date
  payload: unknown
}
export type ArchiveVoteInput = { rideTitle: string; routeUid: string; createdAt: Date }
export type ArchiveFeedbackInput = {
  publicId: string
  kind: string
  status: string
  state: string
  title: string | null
  body: string
  area: string | null
  publicResponse: string | null
  replyOk: boolean
  createdAt: Date
  attachments: Array<{ mime: string; bytes: number }>
}
export type ArchiveSurveyInput = { surveyVersion: number; answers: unknown; submittedAt: Date | null }

export type ArchiveOriginal = {
  path: string
  /** From the closed STORED_EXTS list, because it named a file this app wrote. */
  ext: StoredExt
  /** The route's position within a multi-file import; 0 for a single-file one. */
  index: number
}

export type ArchiveRide = {
  dir: string
  slug: string
  title: string
  description: string | null
  visibility: string
  source: string
  externalUrl: string | null
  createdAt: string
  updatedAt: string
  viewCount: number
  totalMiles: string
  totalDurationS: number
  stopCount: number
  /** In the recycle bin. The files and the ride are still here — see below. */
  trashed: boolean
  /** When the bin will destroy it, ISO, or null when it is not in the bin. */
  purgeAfter: string | null
  native: string
  exports: Record<DownloadFormat, string>
  originals: ArchiveOriginal[]
}

/**
 * One bike, with every stored column and the path its photo sits at.
 *
 * RAW STORED UNITS — meters and milliliters — rather than the miles and gallons
 * the Paddock form asks for. This file is the record of what the app HOLDS, and
 * a rider's own unit preference is a display choice that is itself in the
 * profile block a few lines up. Converting here would make the archive depend on
 * a setting they can change after exporting it.
 */
export type ArchiveBike = {
  id: number
  nickname: string | null
  make: string | null
  model: string | null
  year: number | null
  fuelType: string
  usableRangeM: number | null
  comfortRangeM: number | null
  tankMl: number | null
  isDefault: boolean
  position: number
  photoBytes: number
  /** Where the picture sits in the zip, or null when the bike has none. */
  photo: string | null
  createdAt: string
  updatedAt: string
}

export type AccountArchive = {
  routeloopAccount: number
  exportedFrom: string
  exportedAt: string
  account: Record<string, unknown>
  profile: Record<string, unknown> | null
  usernameHistory: Array<{ username: string; claimedAt: string; releasedAt: string | null }>
  identities: Array<{ provider: string; providerEmail: string | null; createdAt: string }>
  bikes: ArchiveBike[]
  rides: ArchiveRide[]
  // EVERYTHING BELOW IS RIDER-OWNED DATA THAT THE ZIP DID NOT CARRY UNTIL
  // 2026-09-07. Ziad's call: the infrastructure is his and the information in it
  // is the rider's, forever — so the export is complete by definition and a
  // table holding anything of theirs that is absent from here is a defect
  // rather than a scoping decision. See `docs/decisions.md`.
  notificationPrefs: Array<{ event: string; channel: string; enabled: boolean; updatedAt: string | null }>
  placeGroups: Array<{ id: number; name: string; position: number; inBin: boolean; createdAt: string | null }>
  places: Array<Record<string, unknown>>
  friends: Array<{ displayName: string; username: string | null; status: string; direction: string; since: string | null }>
  following: ArchivePerson[]
  followers: ArchivePerson[]
  memberships: Array<{ ride: string; slug: string; role: string; perm: string; rsvp: string; joinedAt: string | null }>
  comments: Array<{ ride: string; point: string | null; body: string; resolved: boolean; createdAt: string | null }>
  suggestions: Array<Record<string, unknown>>
  votes: Array<{ ride: string; routeUid: string; createdAt: string | null }>
  feedback: Array<Record<string, unknown>>
  survey: Array<{ surveyVersion: number; answers: unknown; submittedAt: string | null }>
}

/**
 * Where a bike's picture sits in the zip.
 *
 * KEYED BY ID RATHER THAN BY NICKNAME, unlike a ride's directory, and for the
 * opposite reason: a ride has `uq_slug` and a bike has nothing unique about it
 * at all — every field is optional, so two bikes can be identically nameless and
 * `bikeLabel()` answers "Untitled bike" for both. The id is the only thing that
 * cannot collide. It matches the on-disk name too, which is what makes the
 * writer a lookup rather than a second naming rule.
 */
export const bikePhotoEntry = (bikeId: number): string => `bikes/bike-${bikeId}.webp`

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null)

/**
 * The manifest.
 *
 * Note what the `account` block carries: status, canManageRiders, quotaBytes and
 * viewCount are all in here, and restore.ts refuses every one of them. That is
 * deliberate. Portability means telling a rider everything the app holds about
 * them; the safety property belongs in the reader, where it can be tested as a
 * deny-list, not in the writer, where an omission looks the same as an oversight.
 *
 * Two things are absent for a different reason. `provider_user_id` — Google's
 * `sub` — is left out because it is the exact key resolveUser() matches on, and
 * a file that gets emailed around is a poor place for it. Session and login
 * token hashes are left out because they are live credentials and worthless to
 * the rider besides.
 */
export function buildAccountJson(input: AccountArchiveInput): AccountArchive {
  const { user, profile } = input

  return {
    routeloopAccount: ACCOUNT_ARCHIVE_VERSION,
    exportedFrom: 'routeloop.app',
    exportedAt: input.exportedAt.toISOString(),

    account: {
      publicId: user.publicId,
      username: user.username,
      displayName: user.displayName,
      email: user.email,
      avatarUrl: user.avatarUrl,
      status: user.status,
      canManageRiders: user.canManageRiders,
      quotaBytes: user.quotaBytes,
      usedBytes: user.usedBytes,
      approvedEmailAt: iso(user.approvedEmailAt),
      surveyInvitedAt: iso(user.surveyInvitedAt),
      createdAt: iso(user.createdAt),
      updatedAt: iso(user.updatedAt),
      lastLoginAt: iso(user.lastLoginAt),
    },

    profile: profile
      ? {
          firstName: profile.firstName,
          lastName: profile.lastName,
          homeLabel: profile.homeLabel,
          addressLine: profile.addressLine,
          city: profile.city,
          state: profile.state,
          postalCode: profile.postalCode,
          homeLat: profile.homeLat,
          homeLng: profile.homeLng,
          startLabel: profile.startLabel,
          startAddressLine: profile.startAddressLine,
          startCity: profile.startCity,
          startState: profile.startState,
          startPostalCode: profile.startPostalCode,
          startLat: profile.startLat,
          startLng: profile.startLng,
          shareLastName: profile.shareLastName,
          addHomeToRides: profile.addHomeToRides,
          sharePaymentHandles: profile.sharePaymentHandles,
          cashApp: profile.cashApp,
          venmo: profile.venmo,
          paypal: profile.paypal,
          zelle: profile.zelle,
          // #183 and #174/#150. "Everything the app holds about you" has to mean
          // it — a field added to user_profiles and not added here leaves the
          // rider's own archive quietly incomplete, and nothing would raise it.
          sharePhone: profile.sharePhone,
          phone: profile.phone,
          shareSocials: profile.shareSocials,
          instagram: profile.instagram,
          facebook: profile.facebook,
          youtube: profile.youtube,
          strava: profile.strava,
          durationFormat: profile.durationFormat,
          dateFormat: profile.dateFormat,
          theme: profile.theme,
          scheme: profile.scheme,
          motion: profile.motion,
          units: profile.units,
          clock: profile.clock,
          volumeUnits: profile.volumeUnits,
          avoidPlaces: profile.avoidPlaces,
          favorPlaces: profile.favorPlaces,
          createdAt: iso(profile.createdAt),
          updatedAt: iso(profile.updatedAt),
        }
      : null,

    usernameHistory: input.usernameHistory.map((h) => ({
      username: h.username,
      claimedAt: iso(h.claimedAt) ?? '',
      releasedAt: iso(h.releasedAt),
    })),

    identities: input.identities.map((i) => ({
      provider: i.provider,
      providerEmail: i.providerEmail,
      createdAt: iso(i.createdAt) ?? '',
    })),

    // THE PADDOCK, since 2026-09-07. It was absent entirely — "everything the
    // app holds about you" did not include a rider's bikes, their ranges, or
    // the photographs they had uploaded of them, and nothing said so. Found
    // while adding tank capacity to the same table.
    bikes: input.bikes.map(archiveBike),

    rides: input.rides.map(archiveRide),

    // A rider's own answers about what we may write to them, in the catalog's
    // own vocabulary. Only the rows they actually SET are here — an absent event
    // is one they never touched, which is a real state and not a gap. See
    // src/notifications/policy.ts.
    notificationPrefs: input.notificationPrefs.map((p) => ({
      event: p.event,
      channel: p.channel,
      enabled: p.enabled,
      updatedAt: iso(p.updatedAt),
    })),

    // SAVED PLACES, INCLUDING THE BINNED ONES. A place in the recycle bin is
    // still theirs for thirty days and is still restorable, so leaving it out
    // would make the export depend on when they happened to run it.
    placeGroups: input.placeGroups.map((g) => ({
      id: g.id,
      name: g.name,
      position: g.position,
      inBin: g.deletedAt !== null,
      createdAt: iso(g.createdAt),
    })),
    places: input.places.map((p) => ({
      id: p.id,
      groupId: p.groupId,
      name: p.name,
      // [lng, lat] EVERYWHERE IN THIS APP, and the export is not the place to
      // invent a second convention.
      lngLat: [p.lng, p.lat],
      roles: p.roles,
      phone: p.phone,
      address: p.address,
      links: p.links,
      inBin: p.deletedAt !== null,
      createdAt: iso(p.createdAt),
      updatedAt: iso(p.updatedAt),
    })),

    // WHO THEY KNOW, BY HANDLE AND NEVER BY EMAIL. A friend's address is that
    // friend's data, not this rider's, and the whole principle behind a complete
    // export is that each rider owns their own — so what ships is exactly what
    // this rider can already read on /friends. `direction` is what friendView()
    // resolved: a sideless row read from their end.
    friends: input.friends.map((f) => ({
      displayName: f.person.displayName,
      username: f.person.username,
      status: f.status,
      direction: f.direction,
      since: iso(f.since),
    })),
    following: input.following,
    // BOTH DIRECTIONS, because following is a second relation rather than a mode
    // of friendship and the two lists are genuinely different facts. Who follows
    // you is something the app tells you, so it is something the app holds.
    followers: input.followers,

    // RIDES THEY ARE ON BUT DO NOT OWN. `rides` above is ownership; this is the
    // other half, and without it a rider who was only ever a guest exported an
    // account that looked empty.
    memberships: input.memberships.map((m) => ({
      ride: m.rideTitle,
      slug: m.rideSlug,
      role: m.role,
      perm: m.perm,
      rsvp: m.rsvp,
      joinedAt: iso(m.joinedAt),
    })),

    // THINGS THEY WROTE OR DECIDED, on anybody's ride. A comment is a thing a
    // PERSON said — the reasoning demoteOrphanComments already carries — so it
    // belongs to whoever said it rather than to the ride it was said on.
    comments: input.comments.map((c) => ({
      ride: c.rideTitle,
      point: c.pointLabel,
      body: c.body,
      resolved: c.resolvedAt !== null,
      createdAt: iso(c.createdAt),
    })),
    suggestions: input.suggestions.map((g) => ({
      ride: g.rideTitle,
      routeUid: g.routeUid,
      note: g.note,
      outcome: g.outcome,
      resolvedAt: iso(g.resolvedAt),
      createdAt: iso(g.createdAt),
      // THE WHOLE PROPOSED ROUTE, not a summary. It is a route they drew, and a
      // record of it that cannot be re-imported is not a record of it.
      route: g.payload,
    })),
    votes: input.votes.map((v) => ({ ride: v.rideTitle, routeUid: v.routeUid, createdAt: iso(v.createdAt) })),

    // REPORTS THEY FILED. `ownerNote` and `duplicateOf` are deliberately absent:
    // those are the owner's working notes ABOUT a report rather than anything
    // the rider wrote or was shown, and visibleTo() has never exposed them.
    // `publicResponse` is here because they were shown it.
    feedback: input.feedback.map((f) => ({
      id: f.publicId,
      kind: f.kind,
      status: f.status,
      published: f.state === 'published',
      title: f.title,
      body: f.body,
      area: f.area,
      response: f.publicResponse,
      replyOk: f.replyOk,
      createdAt: iso(f.createdAt),
      // Metadata rather than the files. The bytes live outside the ride storage
      // this archive walks, and an attachment is usually a screenshot of our own
      // UI — naming them keeps the record honest without doubling the zip.
      attachments: f.attachments,
    })),

    survey: input.survey.map((r) => ({
      surveyVersion: r.surveyVersion,
      answers: r.answers,
      submittedAt: iso(r.submittedAt),
    })),
  }
}

function archiveBike(bike: BikeRow): ArchiveBike {
  return {
    id: bike.id,
    nickname: bike.nickname,
    make: bike.make,
    model: bike.model,
    year: bike.year,
    fuelType: bike.fuelType,
    usableRangeM: bike.usableRangeM,
    comfortRangeM: bike.comfortRangeM,
    tankMl: bike.tankMl,
    isDefault: bike.isDefault,
    position: bike.position,
    photoBytes: bike.photoBytes,
    // photoHash IS THE TEST AND IT IS NOT SHIPPED. It is a cache-busting
    // fingerprint for a URL, which is bookkeeping about serving rather than
    // anything the rider gave us — the picture itself is in the zip, which is
    // the fact that matters. `photoBytes` stays because it is what the quota
    // note in schema.ts is about, and a rider auditing their storage can read it.
    photo: bike.photoHash ? bikePhotoEntry(bike.id) : null,
    createdAt: iso(bike.createdAt) ?? '',
    updatedAt: iso(bike.updatedAt) ?? '',
  }
}

function archiveRide({ ride, startDate, originals }: ArchiveRideInput): ArchiveRide {
  const dir = rideDirFor(ride.slug)

  // The same name the per-ride download would give it, so a rider who drags one
  // file out of the archive and into /import gets exactly today's behavior.
  const nameFor = (ext: string): string => `${dir}/${buildExportName({ ride: ride.title, date: startDate, ext })}`

  const exports = {} as Record<DownloadFormat, string>
  for (const format of DOWNLOAD_FORMATS) exports[format] = nameFor(format)

  return {
    dir,
    slug: ride.slug,
    title: ride.title,
    description: ride.description,
    visibility: ride.visibility,
    source: ride.source,
    externalUrl: ride.externalUrl,
    createdAt: iso(ride.createdAt) ?? '',
    updatedAt: iso(ride.updatedAt) ?? '',
    viewCount: ride.viewCount,
    totalMiles: ride.totalMiles,
    totalDurationS: ride.totalDurationS,
    stopCount: ride.stopCount,
    // TRASHED RIDES ARE IN THE ARCHIVE, deliberately. This is the "you can
    // always get your data out" path, and a ride in the bin is still a ride
    // this app is holding — it is also about to be destroyed, which makes it the
    // one a rider most needs a copy of. Marked rather than hidden, so the file
    // says what state it was in rather than quietly presenting it as live.
    trashed: ride.deletedAt != null,
    purgeAfter: iso(ride.purgeAfter),
    native: nameFor(NATIVE_EXT),
    exports,
    // Kept under their on-disk names. The index is what says which route of a
    // folder import a file was, and nothing else records that.
    originals: originals.map((f) => ({
      path: `${dir}/originals/${f.index === 0 ? `${f.rideId}.${f.ext}` : `${f.rideId}-${f.index}.${f.ext}`}`,
      ext: f.ext,
      index: f.index,
    })),
  }
}

/**
 * What goes in README.txt.
 *
 * It earns its place by holding the two facts a rider would otherwise discover
 * by being surprised: a stored KML is not the file they uploaded, and the app
 * cannot give them their builder history because it never had it.
 */
export function readmeText(archive: AccountArchive): string {
  const rides = archive.rides.length
  const bikes = archive.bikes.length
  return [
    'Your Routeloop account',
    '======================',
    '',
    `Exported ${archive.exportedAt} from ${archive.exportedFrom}.`,
    `${rides} ride${rides === 1 ? '' : 's'}, ${bikes} bike${bikes === 1 ? '' : 's'}.`,
    '',
    'What is in here',
    '---------------',
    '',
    'account.json   Everything the app holds about your account, and we mean',
    '               everything: your profile and settings, every username you',
    '               have held, how you asked to be notified, your saved places,',
    '               your friends and follows, the rides you own and the rides you',
    '               were on, every comment, suggestion and vote you made, the',
    '               reports you filed, and your survey answers.',
    '',
    'rides/         One directory per ride. Each holds the same ride in five',
    '               formats. The .routeloop.json is the lossless one and the only',
    '               one that carries route order, dates and via points—GPX and KML',
    '               cannot hold a schedule, which is why the dates are in the',
    '               filenames instead. Drag any single file into /import and it',
    '               behaves exactly as it does on the site.',
    '',
    'originals/     Inside each ride, the file you originally uploaded, where the',
    '               ride was imported rather than built.',
    '',
    'bikes/         A picture per bike that has one. What each bike IS—its make,',
    '               its ranges, its tank—is in account.json beside your profile.',
    '               Ranges are in meters and tanks in milliliters, which is how',
    '               they are stored; the miles and gallons you typed are that',
    '               converted for reading.',
    '',
    'Four things worth knowing',
    '-------------------------',
    '',
    '1. A stored KML is the sanitized version, not byte-for-byte what you',
    '   uploaded. Imported KML is stripped of scripts and network links before it',
    '   is kept. A KMZ is stored as the KML pulled out of it.',
    '',
    '2. Builder undo history and unsaved drafts are not in here. They live in your',
    '   own browser, not on the server, so no export can reach them.',
    '',
    '3. Other people are named by handle and never by email address. Your friends',
    '   list, the rosters you are on and the comments around yours identify people',
    '   the same way the site does. Their contact details are theirs to export,',
    '   not yours.',
    '',
    '4. Rides you have moved to the recycle bin ARE in here, marked "trashed" in',
    '   account.json with the date they will be destroyed. They are included',
    '   precisely because they are the ones about to go.',
    '',
    'Coordinates are [longitude, latitude] everywhere, which is what GeoJSON says',
    'and the opposite of what Google Maps says. If you feed these to something',
    'else and end up in the wrong hemisphere, that is the reason.',
    '',
    'To bring this back: Settings -> GTFO -> Save Me.',
    '',
  ].join('\n')
}
