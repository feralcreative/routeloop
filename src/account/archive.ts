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
import type { RideRow, UserIdentityRow, UserProfileRow, UserRow, UsernameHistoryRow } from '../db/schema'
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
  /** From rideStartDate() — the ride's first dated day, or null when nothing is dated. */
  startDate: Date | null
  /** What is actually on disk for this ride, from listOwnerFiles(). */
  originals: StoredFile[]
}

export type AccountArchiveInput = {
  user: UserRow
  profile: UserProfileRow | null
  usernameHistory: UsernameHistoryRow[]
  identities: UserIdentityRow[]
  rides: ArchiveRideInput[]
  exportedAt: Date
}

export type ArchiveOriginal = {
  path: string
  /** From the closed STORED_EXTS list, because it named a file this app wrote. */
  ext: StoredExt
  /** The day's position within a multi-file import; 0 for a single-file one. */
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

export type AccountArchive = {
  routeloopAccount: number
  exportedFrom: string
  exportedAt: string
  account: Record<string, unknown>
  profile: Record<string, unknown> | null
  usernameHistory: Array<{ username: string; claimedAt: string; releasedAt: string | null }>
  identities: Array<{ provider: string; providerEmail: string | null; createdAt: string }>
  rides: ArchiveRide[]
}

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

    rides: input.rides.map(archiveRide),
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
    // Kept under their on-disk names. The index is what says which day of a
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
  return [
    'Your Routeloop account',
    '======================',
    '',
    `Exported ${archive.exportedAt} from ${archive.exportedFrom}.`,
    `${rides} ride${rides === 1 ? '' : 's'}.`,
    '',
    'What is in here',
    '---------------',
    '',
    'account.json   Everything the app holds about your account: your profile,',
    '               every username you have held, and a manifest of your rides.',
    '',
    'rides/         One directory per ride. Each holds the same ride in five',
    '               formats. The .routeloop.json is the lossless one and the only',
    '               one that carries day order, dates and via points—GPX and KML',
    '               cannot hold a schedule, which is why the dates are in the',
    '               filenames instead. Drag any single file into /import and it',
    '               behaves exactly as it does on the site.',
    '',
    'originals/     Inside each ride, the file you originally uploaded, where the',
    '               ride was imported rather than built.',
    '',
    'Three things worth knowing',
    '--------------------------',
    '',
    '1. A stored KML is the sanitized version, not byte-for-byte what you',
    '   uploaded. Imported KML is stripped of scripts and network links before it',
    '   is kept. A KMZ is stored as the KML pulled out of it.',
    '',
    '2. Builder undo history and unsaved drafts are not in here. They live in your',
    '   own browser, not on the server, so no export can reach them.',
    '',
    '3. Rides you have moved to the recycle bin ARE in here, marked "trashed" in',
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
