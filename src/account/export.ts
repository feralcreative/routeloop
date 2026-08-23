// Building the "Download Me" archive. The queries; the shape lives in
// ./archive.ts, which is pure and tested.
import { asc, eq } from 'drizzle-orm'
import { readFile } from 'node:fs/promises'
import { db } from '../db/index'
import { rides, userIdentities, userProfiles, usernameHistory, type UserRow } from '../db/schema'
import { DOWNLOADS, DOWNLOAD_FORMATS } from '../maps/downloads'
import { buildNativeJson, loadNativeRide, loadRideForExport, rideStartDate } from '../maps/export'
import { detailsForOwner } from '../maps/point-details'
import { listOwnerFiles, mapFilePath } from '../maps/storage'
import { buildZip, type ZipFile } from '../maps/zip'
import {
  ACCOUNT_JSON,
  ACCOUNT_README,
  accountArchiveName,
  buildAccountJson,
  readmeText,
  type AccountArchive,
  type ArchiveRideInput,
} from './archive'

/**
 * The point at which we refuse rather than keep going.
 *
 * buildZip returns a Buffer, so the whole archive is resident while it is built.
 * The bound that matters is not the 25 MB quota — that covers stored originals
 * only — but the four generated formats per ride on top of it, which for a
 * geometry-heavy account is several times the source. This is a ceiling on the
 * container's memory, not a policy about how much a rider may keep, which is
 * why it is generous and why the message points somewhere useful.
 */
export const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024

export class ArchiveTooLargeError extends Error {
  constructor() {
    super(
      'Your account is too large to package in one download. Download your rides individually from the Rides page instead.',
    )
  }
}

export type AccountArchiveResult = {
  fileName: string
  body: Buffer
  manifest: AccountArchive
}

/**
 * Everything the app holds about one rider, as a zip.
 *
 * Ride files are generated from the rows rather than streamed from stored
 * originals, and the originals ride along beside them under `originals/`. That
 * is the opposite of what the per-ride download does, deliberately: a download
 * answers "give me this ride as a GPX", where the original is the better answer,
 * and this answers "give me everything", where the rider wants both.
 */
export async function buildAccountArchive(user: UserRow, exportedAt: Date): Promise<AccountArchiveResult> {
  const [profile] = await db.select().from(userProfiles).where(eq(userProfiles.userId, user.id)).limit(1)

  const history = await db
    .select()
    .from(usernameHistory)
    .where(eq(usernameHistory.userId, user.id))
    .orderBy(asc(usernameHistory.claimedAt))

  const identities = await db.select().from(userIdentities).where(eq(userIdentities.userId, user.id))

  const owned = await db.select().from(rides).where(eq(rides.ownerId, user.id)).orderBy(asc(rides.createdAt))

  // One readdir for the account, bucketed by ride, rather than probing every
  // extension and index for every ride the way deleteMapFiles has to.
  const onDisk = await listOwnerFiles(user.id)
  const filesByRide = new Map<number, typeof onDisk>()
  for (const f of onDisk) {
    const list = filesByRide.get(f.rideId)
    if (list) list.push(f)
    else filesByRide.set(f.rideId, [f])
  }

  const rideInputs: ArchiveRideInput[] = []
  for (const ride of owned) {
    rideInputs.push({
      ride,
      startDate: await rideStartDate(ride.id),
      // Sorted so the manifest is stable between exports of an unchanged account.
      originals: (filesByRide.get(ride.id) ?? []).sort((a, b) => a.index - b.index || a.ext.localeCompare(b.ext)),
    })
  }

  const manifest = buildAccountJson({
    user,
    profile: profile ?? null,
    usernameHistory: history,
    identities,
    rides: rideInputs,
    exportedAt,
  })

  const files: ZipFile[] = [
    { name: ACCOUNT_JSON, body: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') },
    { name: ACCOUNT_README, body: Buffer.from(readmeText(manifest), 'utf8') },
  ]
  let total = files.reduce((n, f) => n + f.body.length, 0)

  const add = (name: string, body: Buffer): void => {
    total += body.length
    // Checked as it accumulates rather than at the end, so a runaway account
    // stops partway instead of being measured once it is already in memory —
    // the same reasoning readZipEntries uses on the way in.
    if (total > MAX_ARCHIVE_BYTES) throw new ArchiveTooLargeError()
    files.push({ name, body })
  }

  for (let i = 0; i < owned.length; i++) {
    const ride = owned[i]
    const entry = manifest.rides[i]

    // The manifest decided every path above; this only fills them in. There is
    // no second place a name is computed, so the two cannot disagree.
    const native = await loadNativeRide(
      ride.id,
      {
        title: ride.title,
        description: ride.description,
        visibility: ride.visibility,
        externalUrl: ride.externalUrl,
      },
      // The account archive is the rider's own data by definition, so it
      // carries their details — this is the "you can always get your data out"
      // path, and a backup missing every reservation would make that false.
      await detailsForOwner(ride.id),
    )
    add(entry.native, Buffer.from(buildNativeJson(native), 'utf8'))

    const forExport = await loadRideForExport(ride.id, { title: ride.title, description: ride.description })
    for (const format of DOWNLOAD_FORMATS) {
      add(entry.exports[format], Buffer.from(DOWNLOADS[format].build(forExport), 'utf8'))
    }

    for (const original of entry.originals) {
      const path = mapFilePath(ride.ownerId, ride.id, original.ext, original.index)
      if (!path) continue
      // listOwnerFiles read the directory, but a file can go between then and
      // now. A missing original is not worth failing an export over — the rows
      // are the ride, and the four generated formats above carry them.
      const buf = await readFile(path).catch(() => null)
      if (buf) add(original.path, buf)
    }
  }

  return {
    fileName: accountArchiveName(user, exportedAt),
    // The zip epoch, not today: two exports of an unchanged account come out
    // byte-identical, which is what makes "did anything change" answerable.
    body: buildZip(files),
    manifest,
  }
}
