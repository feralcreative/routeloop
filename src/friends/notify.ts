// The two friendship emails, and the table read that decides who gets them.
//
// Lives here rather than in src/emails/ for the reason that directory's header
// gives: everything in there is pure, which is what lets test/emails.test.ts
// import the whole registry with no database and no environment. This file
// reads `users`, so it belongs outside. Same arrangement as src/auth/notify.ts
// and src/feedback/notify.ts, which are the precedents.
//
// **TWO VERBS MAIL AND THREE DO NOT.** `request` and `accept` send; `remove`,
// `block` and `unblock` send nothing, ever. That is not an omission to fill in
// later:
//
//   - **block must be silent.** A friendship refusal is identical in every case
//     and an unknown handle is indistinguishable from a rider who blocked you —
//     the whole point being that a block is never a notification. An email is
//     the loudest notification this app has. See src/friends/policy.ts.
//   - **unblock must be silent** for the mirror reason: telling somebody they
//     have been unblocked tells them they were blocked.
//   - **remove covers withdraw, decline and unfriend** in one operation, so a
//     message could not say which of the three happened. A rider who declined
//     has already said no and should not have to say it twice.
//
// Both sends are fire-and-forget: a mail failure must not turn a successful
// button press into an error page, which is what sendTemplateDetached is for.
import { eq } from 'drizzle-orm'
import { db } from '../db/index'
import { users } from '../db/schema'
import { friendAcceptedEmail } from '../emails/friend-accepted'
import { friendRequestEmail } from '../emails/friend-request'
import { sendTemplateDetached } from '../auth/mailer'

type Card = { email: string | null; displayName: string; username: string | null }

/** Both riders in one round trip. Returns them keyed by id, or null if either
 *  row is missing or has no handle — a rider with no username cannot be linked
 *  to, and neither template makes sense without one. */
async function pair(oneId: number, otherId: number): Promise<Map<number, Card> | null> {
  const rows = await db
    .select({ id: users.id, email: users.email, displayName: users.displayName, username: users.username })
    .from(users)
    .where(eq(users.id, oneId))
    .union(
      db
        .select({ id: users.id, email: users.email, displayName: users.displayName, username: users.username })
        .from(users)
        .where(eq(users.id, otherId)),
    )
  const map = new Map(rows.map((r) => [r.id, r]))
  const one = map.get(oneId)
  const other = map.get(otherId)
  if (!one?.username || !other?.username) return null
  return map as Map<number, Card>
}

/**
 * Tell a rider somebody asked to be their friend.
 *
 * ONLY CALL THIS WHEN requestFriend RETURNED ok:true. A refused request must
 * send nothing — the refusal might be a block, and mailing on it would announce
 * the block to the person it was against.
 *
 * Void and never throws, like every other notifier here.
 */
export function notifyFriendRequest(fromId: number, toId: number): void {
  void (async () => {
    const both = await pair(fromId, toId)
    if (!both) return
    const from = both.get(fromId)!
    const to = both.get(toId)!
    sendTemplateDetached(to.email, friendRequestEmail, {
      fromName: from.displayName,
      fromHandle: from.username!,
    })
  })().catch((err) => {
    console.warn('[friends] request notification failed:', err)
  })
}

/**
 * Tell the rider who asked that their request was accepted.
 *
 * `accepterId` is the one who pressed Accept and `requesterId` is who hears
 * about it — the opposite direction from the request, which is the easy thing to
 * get backwards here. acceptFriend refuses the 'sent' view, so the accepter can
 * never be the requester and these two ids are always different people.
 */
export function notifyFriendAccepted(accepterId: number, requesterId: number): void {
  void (async () => {
    const both = await pair(accepterId, requesterId)
    if (!both) return
    const accepter = both.get(accepterId)!
    const requester = both.get(requesterId)!
    sendTemplateDetached(requester.email, friendAcceptedEmail, {
      friendName: accepter.displayName,
      friendHandle: accepter.username!,
    })
  })().catch((err) => {
    console.warn('[friends] accept notification failed:', err)
  })
}
