// The two follow verbs.
//
// SERVER-RENDERED FORMS, NOT THE JSON API — the same choice /friends and /trash
// made and for the same reason: one button press with no state to keep in sync,
// and a redirect back to where you pressed it is the whole interaction.
//
// The rules are src/follows/policy.ts and the queries are service.ts. Nothing
// here decides whether a verb is allowed.
//
// THE ANSWER IS THE SAME WHETHER IT WORKED OR NOT, exactly as on /friends: every
// path redirects and none reports which refusal it hit. Following inherits that
// requirement from friendship rather than having its own — a follow is refused
// when either rider has blocked the other, and a distinguishable refusal there
// would be the notification a block must never be.
import { Hono } from 'hono'
import { sql } from 'drizzle-orm'
import { db } from '../db/index'
import { users } from '../db/schema'
import { currentUser, requireActive, requireSameOrigin, type AuthEnv } from '../auth/middleware'
import { followRider, unfollowRider } from '../follows/service'

export const followRoutes = new Hono<AuthEnv>()

/** Identical to safeBack in routes/friends.tsx, and deliberately a second copy
 *  rather than an import: it is six lines of allow-shape, and a shared helper
 *  that one of the two callers later "improves" is how an open redirect gets
 *  introduced. If a third caller appears, hoist it then. */
function safeBack(raw: unknown): string {
  if (typeof raw !== 'string') return '/riders'
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return '/riders'
  return raw
}

followRoutes.post('/follows/:verb{follow|unfollow}', requireActive, requireSameOrigin, async (c) => {
  const user = currentUser(c)
  const verb = c.req.param('verb')
  const form = await c.req.parseBody()
  const back = safeBack(form.back)
  const handle = typeof form.handle === 'string' ? form.handle.trim() : ''
  if (!handle) return c.redirect(back, 303)

  // BY HANDLE, like every friendship verb, because a handle is what the pages
  // this is submitted from already have and is the only rider identifier this
  // app treats as public. An id would be one query shorter and would put raw
  // user ids in page source for the first time.
  const [other] = await db
    .select({ id: users.id })
    .from(users)
    .where(
      sql`lower(${users.username}) = lower(${handle}) and ${users.status} = 'active'
        and ${users.deletionRequestedAt} is null`,
    )
    .limit(1)

  // Caught here rather than at the check constraint, which throws — a 500 is a
  // worse answer to a replayed form than doing nothing.
  if (!other || other.id === user.id) return c.redirect(back, 303)

  if (verb === 'follow') await followRider(user.id, other.id)
  else await unfollowRider(user.id, other.id)
  return c.redirect(back, 303)
})
