// A draft is not a member (#428), and the access paths have to say so.
//
// Read as TEXT, because CI runs no Postgres: every function that answers "may
// this person see, vote, comment, or be told" has to filter its ride_members read
// with LIVE_MEMBER. A path that forgets it lets a draft — somebody the organizer
// has not sent anything to yet — see a private ride or receive a message about
// one, and nothing else would notice.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/** The body of one top-level function, from its declaration to the next one. */
function bodyOf(file: string, name: string): string {
  const src = readFileSync(file, 'utf8')
  const start = src.search(new RegExp(`(?:async )?function ${name}\\b`))
  if (start < 0) throw new Error(`${name} not found in ${file}`)
  const next = src.slice(start + 1).search(/\n(?:export )?(?:async )?function |\n\/\*\*/)
  return next < 0 ? src.slice(start) : src.slice(start, start + 1 + next)
}

const ACCESS_PATHS: Array<[string, string]> = [
  ['src/access/query.ts', 'grantsFor'],
  ['src/members/service.ts', 'roleOf'],
  ['src/members/service.ts', 'goingCount'],
  ['src/members/service.ts', 'ridesImOn'],
  ['src/members/service.ts', 'rolesOn'],
  ['src/notifications/senders.ts', 'rosterOf'],
]

describe('the access paths read members only', () => {
  for (const [file, fn] of ACCESS_PATHS) {
    it(`${fn} in ${file} filters with LIVE_MEMBER`, () => {
      expect(bodyOf(file, fn)).toContain('LIVE_MEMBER')
    })
  }

  it('membershipOf asks isLiveMember, which memberOrOwner and every rung check go through', () => {
    expect(bodyOf('src/members/service.ts', 'membershipOf')).toContain('isLiveMember')
  })
})
