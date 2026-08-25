// Reading a rider's display preferences off a request.
//
// Split from src/views/date-format.ts on purpose, the same way src/invites/
// policy.ts is split from service.ts: everything about HOW a date is written is
// pure and tested with no database, and this file is the part that has to ask one.
//
// It exists at all because the date format has three-plus consumers — the
// roadbook, the account page, and the settings page that sets it. `durationFormat`
// has two and each keeps its own local reader (builderPrefs in routes/builder.ts,
// durationFormatFor in routes/settings.tsx); a third copy of the same four-line
// query is where that stops being reasonable. If duration ever grows a third
// consumer it belongs here too.
import type { Context } from 'hono'
import { eq } from 'drizzle-orm'
import type { AuthEnv } from '../auth/middleware'
import { db } from '../db/index'
import { userProfiles } from '../db/schema'
import { type DateFormat, fromAcceptLanguage, toDateFormat } from './date-format'

/**
 * Which date format this request should render in.
 *
 * THE FALLBACK CHAIN, and the order is the whole design:
 *
 *   1. The rider's stored choice, when they have a profile row.
 *   2. `Accept-Language`, when they do not — which is most riders, because
 *      `user_profiles` rows are created LAZILY by the settings upsert. A rider
 *      who has never opened settings has no row, so a German browser gets
 *      day-first without anyone choosing anything.
 *   3. The column's default, for a header that says nothing useful.
 *
 * Works for a signed-out request too, which the public roadbook needs: a shared
 * ride is printable by anyone, and `c.get('user')` is null for all of them.
 *
 * THE LIMITATION WORTH KNOWING: because `date_format` is NOT NULL with a default
 * — matching duration_format, so no reader has to interpret a third state — a
 * rider who HAS a row cannot be told apart from one who deliberately chose the
 * default. So step 2 only ever helps someone with no row yet. That is why the
 * settings upsert seeds this column from the header on INSERT: creating a row to
 * save some other preference must not silently overwrite what the header was
 * already giving them.
 */
export async function dateFormatFor(c: Context<AuthEnv>): Promise<DateFormat> {
  const user = c.get('user')
  if (user) {
    const [p] = await db
      .select({ dateFormat: userProfiles.dateFormat })
      .from(userProfiles)
      .where(eq(userProfiles.userId, user.id))
      .limit(1)
    if (p) return toDateFormat(p.dateFormat)
  }
  return fromAcceptLanguage(c.req.header('Accept-Language'))
}
