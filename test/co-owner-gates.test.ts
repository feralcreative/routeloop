// #443: a co-owner, and for route riders an edit-level rider, can reach every
// endpoint the builder shows them a control for.
//
// Read as TEXT, because CI runs no Postgres. These endpoints used `ownRide()`,
// which matches `rides.owner_id` (the creator) only, so a co-owner pressing Find
// meeting points, Send, or a route's riders got a 404 from a control the builder
// had drawn for them. The gate now goes through the roster: `administeredRide()`
// for owner-role powers and `editableRide()` for planning, both built on
// `builderRide()`, which reads the viewer's row through memberOrOwner() and so
// through LIVE_MEMBER.
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

/** Every handler registered on a path, as `[method path, body]`. */
function handlers(file: string, pathPrefix: string): Array<[string, string]> {
  const src = readFileSync(file, 'utf8')
  const re = /\.(get|post|put|patch|delete)\('([^']+)'/g
  const marks = [...src.matchAll(re)]
  const out: Array<[string, string]> = []
  marks.forEach((m, i) => {
    if (!m[2].startsWith(pathPrefix)) return
    const end = i + 1 < marks.length ? marks[i + 1].index : src.length
    out.push([`${m[1].toUpperCase()} ${m[2]}`, src.slice(m.index, end)])
  })
  return out
}

const ADMINISTERED: Array<[string, string]> = [
  ['src/routes/rendezvous.ts', '/api/rides/:id/rendezvous'],
  ['src/routes/roster.tsx', '/api/rides/:id/riders'],
]
const EDITABLE: Array<[string, string]> = [['src/routes/route-riders.ts', '/api/rides/:id/route-riders']]

describe('the gates are the roster, not the creator column', () => {
  it('administeredRide and editableRide ask builderRide and the policy', () => {
    const admin = bodyOf('src/routes/builder.ts', 'administeredRide')
    expect(admin).toContain('builderRide(')
    expect(admin).toContain('canAdminister(')
    const edit = bodyOf('src/routes/builder.ts', 'editableRide')
    expect(edit).toContain('builderRide(')
    expect(edit).toContain('canEditAsMember(')
  })

  it('builderRide reads the viewer through memberOrOwner, which drops drafts', () => {
    expect(bodyOf('src/routes/builder.ts', 'builderRide')).toContain('memberOrOwner(')
  })

  for (const [file, prefix] of ADMINISTERED) {
    const found = handlers(file, prefix)
    it(`${file} has handlers under ${prefix}`, () => expect(found.length).toBeGreaterThan(0))
    for (const [name, body] of found) {
      it(`${name} is gated on administeredRide, not ownRide`, () => {
        expect(body).not.toContain('ownRide(')
        expect(body).toContain('administeredRide(')
      })
    }
  }

  // A co-owner can now press Send on a draft another owner added. The friend
  // request comes from whoever pressed it, and promotePendingFriends() matches on
  // `invitedBy`, so the row has to name the sender or it waits forever.
  it('Send names the sender as invitedBy on a friend request', () => {
    expect(bodyOf('src/members/service.ts', 'sendInvitations')).toContain(
      "setState(d.riderId, 'pending_friend', viewerId)",
    )
  })

  for (const [file, prefix] of EDITABLE) {
    const found = handlers(file, prefix)
    it(`${file} has handlers under ${prefix}`, () => expect(found.length).toBe(2))
    for (const [name, body] of found) {
      it(`${name} is gated on editableRide, not ownRide`, () => {
        expect(body).not.toContain('ownRide(')
        expect(body).toContain('editableRide(')
      })
    }
  }
})
