// The guided tour's three guide riders.
//
// Real accounts with real bikes, because every surface the tour shows — the
// roster, the Riders tab, the range ring, the split dialog — reads those tables
// and faking them client-side would be a second rendering path for each. What
// makes them safe to seed is `users.is_guide`, which excludes them from every
// listing, every friendship verb, every follow, and every notification, and
// which is the ONE thing that lets a rider invite them without a friendship.
//
// CREATED LAZILY, BY THE FIRST TOUR START ON A DEPLOYMENT, AND NEVER AT BOOT.
// Stage shares prod's database and runs no boot jobs, and under blue/green a
// boot-time insert would land while the OLD color — which knows nothing of
// `is_guide` and filters on nothing — was still serving, so the guides would
// sit on /riders for the length of the cutover. A request handled by the new
// code is the earliest moment the filtering code is the code serving.
//
// KEYED ON A RESERVED public_id, NEVER ON THE USERNAME. An upsert by
// `lower(username)` is an upsert onto whoever holds the handle, and although
// the three handles are in RESERVED_USERNAMES that only guards claims made
// AFTER the list grew. A pre-existing row under one of them is a real rider,
// so the insert is left to fail on `uq_username_lower` and the tour start
// reports it rather than adopting the account.
import { eq } from 'drizzle-orm'
import { db } from '../db/index'
import { bikes, users } from '../db/schema'
import { milesToMeters } from '../bikes/policy'

export type Guide = {
  /** The identity the upsert keys on. `guide:` cannot collide with a real
   *  public id, which is always `{username}-{stamp}`. */
  publicId: string
  username: string
  displayName: string
  bike: { make: string; model: string; year: number; rangeMi: number }
}

// Two long tanks and one short one, so the ride's binding range — the shortest
// tank in the group, which is what groupRange() answers — is Diego's, and the
// fuel part of the tour has an E marker to point at.
export const GUIDES: readonly Guide[] = [
  {
    publicId: 'guide:sam',
    username: 'routeloop_guide_sam',
    displayName: 'Sam Okafor',
    bike: { make: 'KTM', model: '890 Adventure', year: 2024, rangeMi: 200 },
  },
  {
    publicId: 'guide:priya',
    username: 'routeloop_guide_priya',
    displayName: 'Priya Nair',
    bike: { make: 'Triumph', model: 'Tiger 900', year: 2023, rangeMi: 190 },
  },
  {
    publicId: 'guide:diego',
    username: 'routeloop_guide_diego',
    displayName: 'Diego Reyes',
    bike: { make: 'Ducati', model: 'Multistrada V2', year: 2022, rangeMi: 140 },
  },
]

/** The guide whose tank binds the group: the one the fuel part of the tour is
 *  about. Pure, so the fixture builder and a test can agree on which. */
export const bindingGuide = (): Guide => GUIDES.reduce((a, b) => (b.bike.rangeMi < a.bike.rangeMi ? b : a))

export type GuideRow = { id: number; username: string; publicId: string }

/**
 * Finds or creates the three guides and returns their ids, in GUIDES order.
 *
 * Idempotent: a guide already present by public_id is read and left alone,
 * so a later change to a display name here does not rewrite a row somebody
 * may have a ride membership against. A missing one is inserted with its
 * bike in one transaction — a guide without a bike is a roster row the range
 * ring cannot use, which is the one thing the tour needs them for.
 *
 * Throws on a username collision with a non-guide row, deliberately: see the
 * file comment. The tour start turns that into a 503 with a reason.
 */
export async function ensureGuideRiders(): Promise<GuideRow[]> {
  const out: GuideRow[] = []
  for (const g of GUIDES) {
    const [have] = await db
      .select({ id: users.id, username: users.username, publicId: users.publicId })
      .from(users)
      .where(eq(users.publicId, g.publicId))
      .limit(1)
    if (have) {
      out.push({ id: have.id, username: have.username ?? g.username, publicId: g.publicId })
      continue
    }
    const row = await db.transaction(async (tx) => {
      const [u] = await tx
        .insert(users)
        .values({
          email: null,
          displayName: g.displayName,
          username: g.username,
          publicId: g.publicId,
          status: 'active',
          isGuide: true,
        })
        .returning({ id: users.id, username: users.username, publicId: users.publicId })
      await tx.insert(bikes).values({
        ownerId: u.id,
        make: g.bike.make,
        model: g.bike.model,
        year: g.bike.year,
        usableRangeM: milesToMeters(g.bike.rangeMi),
        isDefault: true,
        position: 0,
      })
      return u
    })
    console.log(`[tour] seeded guide rider ${g.username} (${row.id})`)
    out.push({ id: row.id, username: row.username ?? g.username, publicId: g.publicId })
  }
  return out
}
