// The "Download Me" package format.
//
// The assertion that matters most here is the collision one: per-ride
// directories are load-bearing, not decoration. Two rides sharing a title and
// carrying no dates produce identical export filenames, and a flat archive would
// silently keep one of them.
//
// Second most: the manifest is the only place a path is decided. Every path the
// writer uses comes back out of buildAccountJson, so an archive whose contents
// disagree with its own manifest is not a state that can be reached.
import { describe, expect, it } from 'vitest'
import {
  ACCOUNT_ARCHIVE_VERSION,
  accountArchiveName,
  buildAccountJson,
  readmeText,
  rideDirFor,
  type AccountArchiveInput,
} from '../src/account/archive'
import type { RideRow, UserIdentityRow, UserProfileRow, UserRow, UsernameHistoryRow } from '../src/db/schema'
import { parseExportName } from '../src/maps/filename'

const AT = new Date('2026-08-14T18:22:00.000Z')

const user = (over: Partial<UserRow> = {}): UserRow =>
  ({
    id: 2,
    email: 'ziad@example.com',
    displayName: 'Ziad',
    username: 'ziad',
    publicId: 'ziad-260801T2220Z',
    avatarUrl: null,
    status: 'active',
    approvedEmailAt: AT,
    surveyInvitedAt: null,
    canManageRiders: false,
    quotaBytes: 26214400,
    usedBytes: 1234,
    createdAt: AT,
    updatedAt: AT,
    lastLoginAt: AT,
    ...over,
  }) as UserRow

const ride = (over: Partial<RideRow> = {}): RideRow =>
  ({
    id: 19,
    ownerId: 2,
    slug: 'aB3xY7kLmN9pQrS2tUvWxY',
    title: 'Big Sur run',
    description: 'Two days down the coast',
    visibility: 'unlisted',
    source: 'imported',
    externalUrl: null,
    gpxPresent: false,
    kmlBytes: 48210,
    gpxBytes: 0,
    sourceFormat: 'kml',
    sourceBytes: 0,
    sizeBytes: 48210,
    totalMiles: '241.7',
    totalDurationS: 0,
    stopCount: 9,
    viewCount: 412,
    createdAt: AT,
    updatedAt: AT,
    ...over,
  }) as RideRow

const input = (over: Partial<AccountArchiveInput> = {}): AccountArchiveInput => ({
  user: user(),
  profile: null,
  usernameHistory: [],
  identities: [],
  rides: [],
  exportedAt: AT,
  ...over,
})

describe('accountArchiveName', () => {
  it('names itself after the rider and the day', () => {
    expect(accountArchiveName(user(), AT)).toBe('routeloop-account_ziad_2026-08-14.zip')
  })

  // The whole package is not one ride's export, and must never be read as one.
  // READ_MARKERS matches `routeloop` exactly, so the compound marker is what
  // keeps parseExportName off it.
  it('is not readable as a ride export name', () => {
    expect(parseExportName(accountArchiveName(user(), AT))).toBeNull()
  })

  // Falls back through public id to the row id. Lowercased on the way, because
  // slugField owns every field in a filename and a name is not a place for case
  // to be significant.
  it('never comes out nameless', () => {
    expect(accountArchiveName(user({ username: null }), AT)).toBe('routeloop-account_ziad-260801t2220z_2026-08-14.zip')
    expect(accountArchiveName(user({ username: null, publicId: null }), AT)).toContain('rider-2')
  })
})

describe('buildAccountJson', () => {
  it('stamps the version a reader checks', () => {
    expect(buildAccountJson(input()).routeloopAccount).toBe(ACCOUNT_ARCHIVE_VERSION)
  })

  it('puts every file for a ride under that ride’s own directory', () => {
    const a = buildAccountJson(input({ rides: [{ ride: ride(), startDate: AT, originals: [] }] })).rides[0]
    const dir = rideDirFor('aB3xY7kLmN9pQrS2tUvWxY')

    expect(a.dir).toBe(dir)
    expect(a.native.startsWith(`${dir}/`)).toBe(true)
    for (const path of Object.values(a.exports)) expect(path.startsWith(`${dir}/`)).toBe(true)
  })

  // The archive is the "you can always get your data out" path, so a ride in the
  // recycle bin has to be in it — it is the one about to be destroyed. Marked
  // rather than hidden, so the file never presents a binned ride as live.
  it('includes a trashed ride and says when it will be destroyed', () => {
    const purgeAfter = new Date('2026-09-25T12:00:00.000Z')
    const a = buildAccountJson(
      input({ rides: [{ ride: ride({ deletedAt: AT, purgeAfter }), startDate: AT, originals: [] }] }),
    ).rides[0]

    expect(a.trashed).toBe(true)
    expect(a.purgeAfter).toBe(purgeAfter.toISOString())
    expect(a.native.startsWith(`${rideDirFor('aB3xY7kLmN9pQrS2tUvWxY')}/`)).toBe(true)
  })

  it('marks a live ride as neither trashed nor scheduled', () => {
    const a = buildAccountJson(input({ rides: [{ ride: ride(), startDate: AT, originals: [] }] })).rides[0]

    expect(a.trashed).toBe(false)
    expect(a.purgeAfter).toBe(null)
  })

  it('carries the four generated formats plus the lossless one', () => {
    const a = buildAccountJson(input({ rides: [{ ride: ride(), startDate: AT, originals: [] }] })).rides[0]

    expect(Object.keys(a.exports).sort()).toEqual(['csv', 'geojson', 'gpx', 'kml'])
    expect(a.native.endsWith('.routeloop.json')).toBe(true)
  })

  // The reason rideDirFor exists. Without it these two rides write the same five
  // filenames and the archive keeps one ride's data under both names.
  it('keeps two identically named, undated rides apart', () => {
    const archive = buildAccountJson(
      input({
        rides: [
          { ride: ride({ id: 1, slug: 'slugOne', title: 'Sunday Loop' }), startDate: null, originals: [] },
          { ride: ride({ id: 2, slug: 'slugTwo', title: 'Sunday Loop' }), startDate: null, originals: [] },
        ],
      }),
    )

    const [a, b] = archive.rides
    expect(a.native).not.toBe(b.native)
    expect(a.exports.gpx).not.toBe(b.exports.gpx)

    // Every path in the archive is distinct, which is the property that matters.
    const all = archive.rides.flatMap((r) => [r.native, ...Object.values(r.exports)])
    expect(new Set(all).size).toBe(all.length)
  })

  it('keeps a stored original under its on-disk name, index and all', () => {
    const a = buildAccountJson(
      input({
        rides: [
          {
            ride: ride(),
            startDate: AT,
            originals: [
              { rideId: 19, index: 0, ext: 'kml', compressed: true },
              { rideId: 19, index: 2, ext: 'gpx', compressed: true },
            ],
          },
        ],
      }),
    ).rides[0]

    expect(a.originals.map((o) => o.path)).toEqual([
      `${rideDirFor('aB3xY7kLmN9pQrS2tUvWxY')}/originals/19.kml`,
      `${rideDirFor('aB3xY7kLmN9pQrS2tUvWxY')}/originals/19-2.gpx`,
    ])
  })

  it('renders every timestamp as an ISO string rather than a Date', () => {
    const archive = buildAccountJson(
      input({
        usernameHistory: [{ username: 'zed', claimedAt: AT, releasedAt: AT } as UsernameHistoryRow],
        rides: [{ ride: ride(), startDate: AT, originals: [] }],
      }),
    )

    expect(archive.exportedAt).toBe(AT.toISOString())
    expect(archive.account.createdAt).toBe(AT.toISOString())
    expect(archive.usernameHistory[0].claimedAt).toBe(AT.toISOString())
    expect(archive.rides[0].createdAt).toBe(AT.toISOString())
    expect(JSON.parse(JSON.stringify(archive))).toEqual(archive)
  })

  it('marks the name a rider still holds as unreleased', () => {
    const archive = buildAccountJson(
      input({ usernameHistory: [{ username: 'ziad', claimedAt: AT, releasedAt: null } as UsernameHistoryRow] }),
    )
    expect(archive.usernameHistory[0].releasedAt).toBeNull()
  })

  it('carries the whole profile, payment handles included', () => {
    const profile = {
      firstName: 'Ziad',
      lastName: 'E',
      addressLine: '1 Example St',
      homeLat: 36.2,
      homeLng: -121.8,
      cashApp: '$ziad',
      venmo: null,
      paypal: null,
      zelle: null,
      shareLastName: false,
      addHomeToRides: false,
      sharePaymentHandles: false,
      createdAt: AT,
      updatedAt: AT,
    } as UserProfileRow

    const out = buildAccountJson(input({ profile }))
    expect(out.profile).toMatchObject({ addressLine: '1 Example St', homeLat: 36.2, cashApp: '$ziad' })
  })

  it('has no profile block for a rider who never filled one in', () => {
    expect(buildAccountJson(input()).profile).toBeNull()
  })

  // Portability means telling a rider everything held about them. These fields
  // are here on purpose and restore.ts refuses every one of them — the safety
  // property belongs in the reader, where it can be asserted as a deny-list.
  it('discloses the account fields a restore will refuse to read back', () => {
    const archive = buildAccountJson(input({ user: user({ canManageRiders: true, status: 'pending' }) }))

    expect(archive.account).toMatchObject({
      status: 'pending',
      canManageRiders: true,
      quotaBytes: 26214400,
      publicId: 'ziad-260801T2220Z',
    })
    expect(archive.rides).toEqual([])
  })

  // The one identifier deliberately withheld: it is the key resolveUser matches
  // on, and an archive is a file that gets emailed around.
  it('names the provider without carrying the provider’s user id', () => {
    const archive = buildAccountJson(
      input({
        identities: [
          {
            provider: 'google',
            providerUserId: '11223344556677889900',
            providerEmail: 'ziad@example.com',
            createdAt: AT,
          } as UserIdentityRow,
        ],
      }),
    )

    expect(archive.identities[0]).toEqual({
      provider: 'google',
      providerEmail: 'ziad@example.com',
      createdAt: AT.toISOString(),
    })
    expect(JSON.stringify(archive)).not.toContain('11223344556677889900')
  })

  it('holds no session or token material anywhere in the file', () => {
    const json = JSON.stringify(
      buildAccountJson(input({ rides: [{ ride: ride(), startDate: AT, originals: [] }] })),
    ).toLowerCase()

    for (const word of ['session', 'token', 'password', 'secret']) expect(json).not.toContain(word)
  })
})

describe('readmeText', () => {
  // Both facts a rider would otherwise discover by being surprised.
  it('says a stored KML is sanitized and that builder history is not included', () => {
    const text = readmeText(buildAccountJson(input({ rides: [{ ride: ride(), startDate: AT, originals: [] }] })))

    expect(text).toContain('sanitized')
    expect(text).toContain('Builder undo history')
    expect(text).toContain('1 ride.')
  })

  it('counts rides in plural when there are several', () => {
    const text = readmeText(
      buildAccountJson(
        input({
          rides: [
            { ride: ride({ id: 1, slug: 'a' }), startDate: AT, originals: [] },
            { ride: ride({ id: 2, slug: 'b' }), startDate: AT, originals: [] },
          ],
        }),
      ),
    )
    expect(text).toContain('2 rides.')
  })
})
