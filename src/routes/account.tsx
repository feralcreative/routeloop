// GTFO — the account's own exits.
//
// Everything here is about a rider taking their data elsewhere or asking for it
// to be destroyed. src/content/privacy.html promised both by hand "until there
// is a button"; this is the button.
import { Hono } from 'hono'
import { currentUser, requireActive, type AuthEnv } from '../auth/middleware'
import { allow } from '../auth/ratelimit'
import { ArchiveTooLargeError, buildAccountArchive } from '../account/export'

export const accountRoutes = new Hono<AuthEnv>()

// Packaging an account reads every ride and holds the archive in memory, so this
// is limited per rider rather than per IP: the cost is driven by whose account
// it is, and a shared address should not make one rider's exports another's
// problem. Three an hour is well past any honest use.
const DOWNLOAD_LIMIT = { max: 3 }

accountRoutes.get('/account/download', requireActive, async (c) => {
  const user = currentUser(c)

  if (!allow('account-download', String(user.id), DOWNLOAD_LIMIT)) {
    return c.text('You have downloaded your account a few times just now. Try again in an hour.', 429)
  }

  let archive
  try {
    archive = await buildAccountArchive(user, new Date())
  } catch (err) {
    if (err instanceof ArchiveTooLargeError) return c.text(err.message, 413)
    throw err
  }

  console.log(`[account] packaged user ${user.id}: ${archive.manifest.rides.length} rides, ${archive.body.length} bytes`)

  return new Response(archive.body, {
    headers: {
      'Content-Type': 'application/zip',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `attachment; filename="${archive.fileName}"`,
    },
  })
})
