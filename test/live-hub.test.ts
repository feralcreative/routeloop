// Who is in a ride, and who holds which day.
//
// The registry is module-level state, so every test resets it — a room left
// behind changes the next test's answer, and the failure looks like a logic bug
// rather than a leak.
//
// Nothing here protects data. A claim is a courtesy; the day hash in
// src/maps/day-merge.ts is what actually decides a save. These tests are about
// what riders are SHOWN, and the two that matter are the deduplication (a rider
// with two tabs is one person) and the release on leave (a rider who closes the
// tab must stop holding day 4).
import { beforeEach, describe, expect, it } from 'vitest'
import {
  join,
  leave,
  presenceOf,
  publish,
  resetForTest,
  roomOf,
  setClaim,
  nextConnId,
  closeAll,
  isClosed,
  type Conn,
} from '../src/live/hub'

const RIDE = 7

type Sent = { event: string; data: unknown }

const conn = (riderId: number, name: string, over: Partial<Conn> = {}): Conn & { sent: Sent[] } => {
  const sent: Sent[] = []
  return {
    id: nextConnId(),
    rideId: RIDE,
    riderId,
    name,
    dayUid: null,
    sent,
    send: (event, data) => sent.push({ event, data }),
    close: () => {},
    ...over,
  } as Conn & { sent: Sent[] }
}

const names = (rideId: number) =>
  presenceOf(rideId)
    .map((p) => p.name)
    .sort()

beforeEach(() => resetForTest())

describe('presence', () => {
  it('lists everyone in the ride', () => {
    join(conn(1, 'ada'))
    join(conn(2, 'grace'))
    expect(names(RIDE)).toEqual(['ada', 'grace'])
  })

  it('keeps rooms separate', () => {
    join(conn(1, 'ada'))
    join(conn(2, 'grace', { rideId: 99 }))
    expect(names(RIDE)).toEqual(['ada'])
    expect(names(99)).toEqual(['grace'])
  })

  // A rider with the ride open in two tabs is ONE person. Showing them twice
  // reads as a second collaborator who does not exist.
  it('counts a rider with two tabs once', () => {
    join(conn(1, 'ada'))
    join(conn(1, 'ada'))
    expect(presenceOf(RIDE)).toHaveLength(1)
  })

  // And the working tab's day must survive an idle second tab, or opening the
  // ride again blanks out what you are shown to be doing.
  it('reports the day from whichever of a rider’s tabs claims one', () => {
    const working = conn(1, 'ada')
    const idle = conn(1, 'ada')
    join(idle)
    join(working)
    setClaim(working, 'day-a')
    expect(presenceOf(RIDE)).toEqual([{ riderId: 1, name: 'ada', dayUid: 'day-a' }])
  })

  it('drops a rider who leaves', () => {
    const a = conn(1, 'ada')
    join(a)
    join(conn(2, 'grace'))
    leave(a)
    expect(names(RIDE)).toEqual(['grace'])
  })

  // The only thing stopping the map growing for the life of the process.
  it('forgets a room once the last rider leaves', () => {
    const a = conn(1, 'ada')
    join(a)
    leave(a)
    expect(roomOf(RIDE).size).toBe(0)
    expect(presenceOf(RIDE)).toEqual([])
  })

  it('survives leaving twice', () => {
    const a = conn(1, 'ada')
    join(a)
    leave(a)
    expect(() => leave(a)).not.toThrow()
  })
})

describe('claims', () => {
  it('grants an unheld day', () => {
    const a = conn(1, 'ada')
    join(a)
    expect(setClaim(a, 'day-a')).toBe(true)
    expect(presenceOf(RIDE)[0].dayUid).toBe('day-a')
  })

  it('refuses a day another rider holds', () => {
    const a = conn(1, 'ada')
    const b = conn(2, 'grace')
    join(a)
    join(b)
    setClaim(a, 'day-a')
    expect(setClaim(b, 'day-a')).toBe(false)
    expect(presenceOf(RIDE).find((p) => p.riderId === 2)?.dayUid).toBe(null)
  })

  // A rider is never in their own way — the same person in two tabs, or
  // re-claiming after a reconnect, must not lock themselves out of their day.
  it('lets a rider re-claim their own day', () => {
    const a = conn(1, 'ada')
    const alsoA = conn(1, 'ada')
    join(a)
    join(alsoA)
    setClaim(a, 'day-a')
    expect(setClaim(alsoA, 'day-a')).toBe(true)
  })

  it('frees the day when the holder releases it', () => {
    const a = conn(1, 'ada')
    const b = conn(2, 'grace')
    join(a)
    join(b)
    setClaim(a, 'day-a')
    setClaim(a, null)
    expect(setClaim(b, 'day-a')).toBe(true)
  })

  // THE RELEASE THAT MATTERS. A closed tab that kept its claim would hold day 4
  // for the life of the process, and nobody could take it back.
  it('frees the day when the holder disconnects', () => {
    const a = conn(1, 'ada')
    const b = conn(2, 'grace')
    join(a)
    join(b)
    setClaim(a, 'day-a')
    leave(a)
    expect(setClaim(b, 'day-a')).toBe(true)
  })

  it('lets two riders hold different days', () => {
    const a = conn(1, 'ada')
    const b = conn(2, 'grace')
    join(a)
    join(b)
    expect(setClaim(a, 'day-a')).toBe(true)
    expect(setClaim(b, 'day-b')).toBe(true)
  })
})

describe('publish', () => {
  it('reaches everyone in the room', () => {
    const a = conn(1, 'ada')
    const b = conn(2, 'grace')
    join(a)
    join(b)
    publish(RIDE, 'saved', { day: 'x' })
    expect(a.sent.filter((s) => s.event === 'saved')).toHaveLength(1)
    expect(b.sent.filter((s) => s.event === 'saved')).toHaveLength(1)
  })

  it('can skip the rider who caused it', () => {
    const a = conn(1, 'ada')
    const b = conn(2, 'grace')
    join(a)
    join(b)
    publish(RIDE, 'saved', {}, a)
    expect(a.sent.filter((s) => s.event === 'saved')).toHaveLength(0)
    expect(b.sent.filter((s) => s.event === 'saved')).toHaveLength(1)
  })

  // One dead socket must not stop the rest of the room being told.
  it('carries on past a connection whose send throws', () => {
    const bad = conn(1, 'ada')
    bad.send = () => {
      throw new Error('socket gone')
    }
    const good = conn(2, 'grace')
    join(bad)
    join(good)
    expect(() => publish(RIDE, 'saved', {})).not.toThrow()
    expect(good.sent.filter((s) => s.event === 'saved')).toHaveLength(1)
  })

  it('publishes presence when somebody joins or leaves', () => {
    const a = conn(1, 'ada')
    join(a)
    const b = conn(2, 'grace')
    join(b)
    expect(a.sent.filter((s) => s.event === 'presence').length).toBeGreaterThanOrEqual(2)
    leave(b)
    const last = a.sent.filter((s) => s.event === 'presence').at(-1)
    expect(last?.data).toEqual([{ riderId: 1, name: 'ada', dayUid: null }])
  })
})

describe('shutdown', () => {
  // Not because the drain hangs without it — that was measured false, see
  // src/shutdown.ts — but because a container that is going away must stop
  // accepting subscriptions, and nothing else sets that flag.
  it('closes every stream and refuses to look open afterwards', () => {
    let closedA = false
    const a = conn(1, 'ada')
    a.close = () => {
      closedA = true
    }
    join(a)
    expect(isClosed()).toBe(false)
    closeAll()
    expect(closedA).toBe(true)
    expect(isClosed()).toBe(true)
    expect(presenceOf(RIDE)).toEqual([])
  })

  it('does not throw when a close handler does', () => {
    const a = conn(1, 'ada')
    a.close = () => {
      throw new Error('already gone')
    }
    join(a)
    expect(() => closeAll()).not.toThrow()
  })
})
