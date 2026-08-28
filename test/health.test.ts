// The health endpoint's rule, with no server and no database (Phase 1 of
// docs/zero-downtime-deploy.md).
//
// What is worth testing here is not "does it return 200 when everything is
// fine" — it is the two states the deploy actually depends on being reported
// correctly, both of which are easy to get backwards: a draining container must
// report UNHEALTHY while it is still answering requests, and the build field
// must be whatever it was handed rather than anything derived, because the
// deploy asserts the SHA it just pushed against it.
import { describe, expect, it } from 'vitest'
import { health, type HealthInput } from '../src/health'

const ok: HealthInput = {
  version: '2026-08-27-1034PT',
  build: 'abc1234',
  color: '',
  dbUp: true,
  draining: false,
  uptimeSec: 12.7,
}

describe('a healthy container', () => {
  it('answers 200', () => {
    expect(health(ok).status).toBe(200)
  })

  it('reports the version and the build it was given, unchanged', () => {
    const b = health(ok).body
    expect(b.version).toBe('2026-08-27-1034PT')
    expect(b.build).toBe('abc1234')
  })

  // The gate polls this and asserts the SHA. A container that reported a
  // truncated or reformatted build would fail every deploy for no reason, and
  // one that reported a DIFFERENT build would pass a deploy that did nothing.
  it('does not truncate or reformat the build', () => {
    const long = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    expect(health({ ...ok, build: long }).body.build).toBe(long)
  })

  it('floors the uptime to whole seconds', () => {
    expect(health(ok).body.uptime).toBe(12)
  })
})

describe('a draining container', () => {
  // THE ONE THAT MATTERS. The process is still up and still answering — that is
  // the entire point of a drain — and it must nevertheless report unhealthy so
  // a proxy stops sending it new work while the in-flight requests finish.
  // Reporting 200 here would keep traffic arriving at a container on its way
  // out, which is the exact failure the drain exists to prevent.
  it('answers 503 even though the database is fine', () => {
    const out = health({ ...ok, draining: true })
    expect(out.status).toBe(503)
    expect(out.body.ok).toBe(false)
    expect(out.body.db).toBe('up')
    expect(out.body.draining).toBe(true)
  })
})

describe('a container that cannot reach Postgres', () => {
  it('answers 503 and says which half is broken', () => {
    const out = health({ ...ok, dbUp: false })
    expect(out.status).toBe(503)
    expect(out.body.db).toBe('down')
    expect(out.body.draining).toBe(false)
  })

  it('still reports its build, so a deploy can tell "wrong build" from "broken build"', () => {
    expect(health({ ...ok, dbUp: false }).body.build).toBe('abc1234')
  })
})

describe('the color field', () => {
  // Blank on every environment today. It exists so Phase 2 does not have to
  // change the endpoint's shape, and an empty string is the honest answer for a
  // topology with one container — not a missing key, which a reader would have
  // to guess about.
  it('is present and empty when nothing set it', () => {
    expect(health(ok).body.color).toBe('')
    expect(Object.keys(health(ok).body)).toContain('color')
  })

  it('is reported verbatim when Phase 2 sets one', () => {
    expect(health({ ...ok, color: 'green' }).body.color).toBe('green')
  })
})

describe('the status code and the ok flag never disagree', () => {
  // They are derived from the same expression today. This is here so that stays
  // true if either one ever grows a special case — a 200 with ok:false would be
  // read as healthy by the deploy gate and as broken by a person.
  const states: HealthInput[] = [
    ok,
    { ...ok, dbUp: false },
    { ...ok, draining: true },
    { ...ok, dbUp: false, draining: true },
  ]
  for (const s of states) {
    it(`agrees for db=${s.dbUp} draining=${s.draining}`, () => {
      const out = health(s)
      expect(out.body.ok).toBe(out.status === 200)
    })
  }
})
