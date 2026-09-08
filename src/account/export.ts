// Building the "Download Me" archive. The queries; the shape lives in
// ./archive.ts, which is pure and tested.
import { asc, eq, inArray, or } from 'drizzle-orm'
import { readFile } from 'node:fs/promises'
import { db } from '../db/index'
import {
  altVotes,
  bikes,
  feedback,
  feedbackAttachments,
  follows,
  friendships,
  notificationPrefs,
  placeGroups,
  places,
  rideComments,
  rideMembers,
  rideSuggestions,
  rides,
  surveyResponses,
  userIdentities,
  userProfiles,
  usernameHistory,
  users,
  type UserRow,
} from '../db/schema'
import { friendView } from '../friends/policy'
import { DOWNLOADS, DOWNLOAD_FORMATS } from '../maps/downloads'
import { buildNativeJson, loadNativeRide, loadRideForExport, rideStartDate } from '../maps/export'
import { detailsForOwner } from '../maps/point-details'
import { listOwnerFiles, readMapFile } from '../maps/storage'
import { readBikePhoto } from '../bikes/photo'
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

  // Ordered the way the Paddock renders them, so the archive reads in the order
  // the rider arranged rather than by insertion.
  const garage = await db
    .select()
    .from(bikes)
    .where(eq(bikes.ownerId, user.id))
    .orderBy(asc(bikes.position), asc(bikes.id))

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
    bikes: garage,
    rides: rideInputs,
    ...(await everythingElse(user.id)),
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

  // THE PICTURES, BEFORE THE RIDES. A rider's whole Paddock is a handful of
  // small WebPs and every ride is four generated exports plus its originals, so
  // putting the bikes first means a garage full of photos survives a runaway
  // ride list hitting MAX_ARCHIVE_BYTES rather than being the thing cut off.
  //
  // A MISSING FILE IS SKIPPED RATHER THAN FAILING THE EXPORT, the same rule the
  // ride originals follow below: the row said there was a photo, the directory
  // is read at a different moment, and a backup missing one picture is worth far
  // more than no backup at all.
  for (const entry of manifest.bikes) {
    if (!entry.photo) continue
    const buf = await readBikePhoto(user.id, entry.id)
    if (buf) add(entry.photo, buf)
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
      // DECOMPRESSED ON THE WAY IN, which is the sharp edge of the whole
      // compression change: the archive entry is named `.gpx`, so putting brotli
      // bytes under that name hands the rider a backup that silently will not
      // open. listOwnerFiles read the directory, but a file can go between then
      // and now — a missing original is not worth failing an export over, since
      // the rows are the ride and the four generated formats above carry them.
      const buf = await readMapFile(ride.ownerId, ride.id, original.ext, original.index)
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


/**
 * Every rider-owned row that is not a ride, a bike or a profile.
 *
 * **THE EXPORT IS COMPLETE BY DEFINITION, AND A TABLE HOLDING SOMETHING OF
 * THEIRS THAT IS ABSENT FROM HERE IS A DEFECT.** Ziad's call, 2026-09-07: the
 * infrastructure is his and the information inside it is the rider's, forever —
 * whatever the app ever charges for access. So this is not a curated selection
 * of the interesting parts; it is the remainder, and the only things left out
 * are named below with a reason.
 *
 * **DELIBERATELY ABSENT.** `sessions` and `login_tokens` are credentials rather
 * than data — exporting a live session id hands whoever opens the zip an
 * account. `invites`/`invite_redemptions` describe the beta gate rather than the
 * rider. Ride internals (routes, points, legs, point details) are already inside
 * each ride's own files, in five formats, which is a better record than a
 * flattened row would be. `users.password`-shaped fields do not exist here.
 *
 * **OTHER PEOPLE ARE NAMED BY HANDLE AND NEVER BY EMAIL.** A friend's address is
 * the friend's data, and the principle that makes this export complete is the
 * same one that stops it reaching past its owner. What ships is exactly what the
 * rider can already read on screen.
 *
 * ONE FUNCTION RATHER THAN TEN CALLS IN THE CALLER, so a new table is one edit
 * here and the completeness test has one place to point at.
 */
async function everythingElse(userId: number) {
  // A person's public identity, for the several places one is named.
  const person = { displayName: users.displayName, username: users.username }

  const [prefs, groups, saved, friendRows, followingRows, followerRows, survey] = await Promise.all([
    db.select().from(notificationPrefs).where(eq(notificationPrefs.userId, userId)),
    // BINNED ONES INCLUDED, here and for places: a row in the recycle bin is
    // still theirs for thirty days and still restorable, so filtering it would
    // make the export depend on when they happened to run it — and these are
    // precisely the ones about to be destroyed.
    db.select().from(placeGroups).where(eq(placeGroups.ownerId, userId)).orderBy(asc(placeGroups.position)),
    db.select().from(places).where(eq(places.ownerId, userId)).orderBy(asc(places.name)),
    // The ROW only. Which of the two ids is the other rider is decided below,
    // because a friendship has no sides in storage — joining `users` twice here
    // to get both would fetch this rider's own name on every row.
    db
      .select()
      .from(friendships)
      .where(or(eq(friendships.riderA, userId), eq(friendships.riderB, userId))),
    db
      .select(person)
      .from(follows)
      .innerJoin(users, eq(users.id, follows.followeeId))
      .where(eq(follows.followerId, userId)),
    db
      .select(person)
      .from(follows)
      .innerJoin(users, eq(users.id, follows.followerId))
      .where(eq(follows.followeeId, userId)),
    db.select().from(surveyResponses).where(eq(surveyResponses.userId, userId)),
  ])

  // The friend on the OTHER side of each row, resolved in one query rather than
  // one per friendship. The pair has no sides in storage, so which id to look up
  // is decided here and the STATUS is read through friendView(), the one place
  // that turns a sideless row into this rider's terms.
  const otherIds = friendRows.map((f) => (f.riderA === userId ? f.riderB : f.riderA))
  const people = otherIds.length
    ? new Map(
        (await db.select({ id: users.id, ...person }).from(users).where(inArray(users.id, otherIds))).map((u) => [
          u.id,
          { displayName: u.displayName, username: u.username },
        ]),
      )
    : new Map<number, { displayName: string; username: string | null }>()

  const friends = friendRows.flatMap((f) => {
    const otherId = f.riderA === userId ? f.riderB : f.riderA
    const p = people.get(otherId)
    if (!p) return []
    return [
      {
        person: p,
        status: f.status,
        // 'friends' | 'sent' | 'incoming' | 'blocked' | 'blocked-by', which is
        // the answer the app itself renders from.
        direction: friendView(f, userId),
        since: f.createdAt,
      },
    ]
  })

  // Rides they are ON, minus the ones they own — those are already the `rides`
  // section, in full, with their files.
  const memberRows = await db
    .select({ m: rideMembers, ride: { title: rides.title, slug: rides.slug, ownerId: rides.ownerId } })
    .from(rideMembers)
    .innerJoin(rides, eq(rides.id, rideMembers.rideId))
    .where(eq(rideMembers.riderId, userId))
  const memberships = memberRows
    .filter((r) => r.ride.ownerId !== userId)
    .map((r) => ({
      rideTitle: r.ride.title,
      rideSlug: r.ride.slug,
      role: r.m.role,
      perm: r.m.perm,
      rsvp: r.m.rsvp,
      joinedAt: r.m.createdAt,
    }))

  const [commentRows, suggestionRows, voteRows, reports] = await Promise.all([
    db
      .select({ c: rideComments, title: rides.title })
      .from(rideComments)
      .innerJoin(rides, eq(rides.id, rideComments.rideId))
      .where(eq(rideComments.authorId, userId)),
    db
      .select({ g: rideSuggestions, title: rides.title })
      .from(rideSuggestions)
      .innerJoin(rides, eq(rides.id, rideSuggestions.rideId))
      .where(eq(rideSuggestions.authorId, userId)),
    db
      .select({ v: altVotes, title: rides.title })
      .from(altVotes)
      .innerJoin(rides, eq(rides.id, altVotes.rideId))
      .where(eq(altVotes.userId, userId)),
    db.select().from(feedback).where(eq(feedback.authorId, userId)).orderBy(asc(feedback.createdAt)),
  ])

  // Attachment METADATA, in one query for every report rather than one per
  // report. The files themselves stay out: they live outside the ride storage
  // this archive walks, and an attachment is usually a screenshot of our own UI.
  const attachRows = reports.length
    ? await db
        .select({ feedbackId: feedbackAttachments.feedbackId, mime: feedbackAttachments.mime, bytes: feedbackAttachments.bytes })
        .from(feedbackAttachments)
        .where(
          inArray(
            feedbackAttachments.feedbackId,
            reports.map((r) => r.id),
          ),
        )
    : []
  const attachByReport = new Map<number, Array<{ mime: string; bytes: number }>>()
  for (const a of attachRows) {
    const list = attachByReport.get(a.feedbackId)
    if (list) list.push({ mime: a.mime, bytes: a.bytes })
    else attachByReport.set(a.feedbackId, [{ mime: a.mime, bytes: a.bytes }])
  }

  return {
    notificationPrefs: prefs.map((p) => ({
      event: p.event,
      channel: p.channel,
      enabled: p.enabled,
      updatedAt: p.updatedAt,
    })),
    placeGroups: groups.map((g) => ({
      id: g.id,
      name: g.name,
      position: g.position,
      deletedAt: g.deletedAt,
      createdAt: g.createdAt,
    })),
    places: saved.map((p) => ({
      id: p.id,
      groupId: p.groupId,
      name: p.name,
      lat: p.lat,
      lng: p.lng,
      roles: p.roles,
      phone: p.phone,
      address: p.address,
      links: p.links,
      deletedAt: p.deletedAt,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    })),
    friends,
    following: followingRows,
    followers: followerRows,
    memberships,
    comments: commentRows.map((r) => ({
      rideTitle: r.title,
      pointLabel: r.c.pointLabel,
      body: r.c.body,
      resolvedAt: r.c.resolvedAt,
      createdAt: r.c.createdAt,
    })),
    suggestions: suggestionRows.map((r) => ({
      rideTitle: r.title,
      routeUid: r.g.routeUid,
      note: r.g.note,
      outcome: r.g.outcome,
      resolvedAt: r.g.resolvedAt,
      createdAt: r.g.createdAt,
      payload: r.g.payload,
    })),
    votes: voteRows.map((r) => ({ rideTitle: r.title, routeUid: r.v.routeUid, createdAt: r.v.createdAt })),
    feedback: reports.map((f) => ({
      publicId: f.publicId,
      kind: f.kind,
      status: f.status,
      state: f.state,
      title: f.title,
      body: f.body,
      area: f.area,
      publicResponse: f.publicResponse,
      replyOk: f.replyOk,
      createdAt: f.createdAt,
      attachments: attachByReport.get(f.id) ?? [],
    })),
    survey: survey.map((r) => ({
      surveyVersion: r.surveyVersion,
      answers: r.answers,
      submittedAt: r.submittedAt,
    })),
  }
}
