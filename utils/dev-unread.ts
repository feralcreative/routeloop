/**
 * Drives the unread notification badge to a chosen count, for LOOKING at it.
 *
 * `npx tsx utils/dev-unread.ts [count]` — default 3, capped at however many
 * rows the account actually has.
 *
 * **IT CLEARS `read_at` ON ROWS THAT ALREADY EXIST AND DELIBERATELY DOES NOT
 * CALL `notify()`.** That function runs the senders, so a badge triggered
 * through it puts real mail through SMTP for every event it invents — a cost
 * nobody asked for to look at a red pill. Marking existing rows unread produces
 * the identical badge with no send and nothing invented.
 *
 * **DEV ONLY, and it refuses anything that is not a local database.** It writes
 * to `notifications` for one account, which is harmless on a laptop and is
 * rewriting a rider's read state anywhere else.
 *
 * Note that OPENING `/notifications` marks everything read, so the badge is
 * gone the moment you look at the list — re-run this to put it back. Any other
 * page shows it: the dashboard, the rides list, or the account menu on a map
 * page.
 *
 * `utils/` is outside `tsconfig.json`, so `npm run typecheck` does not cover
 * this file — see AGENTS.md for the one-off `tsc` invocation that does.
 */
import { db } from '../src/db'
import { notifications, users } from '../src/db/schema'
import { DEV_LOGIN_EMAIL, IS_LOCAL_DATABASE } from '../src/config'
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'

async function main(): Promise<void> {
  if (!IS_LOCAL_DATABASE) {
    console.error('dev-unread: refusing to run against a non-local database')
    process.exit(1)
  }
  if (!DEV_LOGIN_EMAIL) {
    console.error('dev-unread: set DEV_LOGIN_EMAIL to name the account')
    process.exit(1)
  }

  const want = Math.max(0, Number(process.argv[2] ?? 3) || 0)
  const [who] = await db.select({ id: users.id }).from(users).where(eq(users.email, DEV_LOGIN_EMAIL)).limit(1)
  if (!who) {
    console.error(`dev-unread: no account for DEV_LOGIN_EMAIL`)
    process.exit(1)
  }

  // Start from all-read, so the count ends up exactly what was asked for rather
  // than whatever was already unread plus this.
  await db.update(notifications).set({ readAt: new Date() }).where(eq(notifications.userId, who.id))

  const rows = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(eq(notifications.userId, who.id))
    .orderBy(desc(notifications.createdAt))
    .limit(want)

  // inArray, never an interpolated array inside a tagged `sql` template —
  // drizzle expands an array into a tuple and the SQL comes out invalid.
  if (rows.length > 0) {
    await db
      .update(notifications)
      .set({ readAt: null })
      .where(
        inArray(
          notifications.id,
          rows.map((r) => r.id),
        ),
      )
  }

  const [count] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(eq(notifications.userId, who.id), isNull(notifications.readAt)))

  console.log(
    `unread: ${count?.n ?? 0}${want > rows.length ? ` (asked for ${want}; only ${rows.length} rows exist)` : ''}`,
  )
  process.exit(0)
}

void main()
