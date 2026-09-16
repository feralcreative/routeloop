// The pure half of the ride list: which tab a query names, and the cap on a
// rider's own rides. Both lived inline in the dashboard route until 2026-09-15
// and neither could be tested there.
import { describe, expect, it } from 'vitest'
import { RIDE_CEILING, RIDE_PAGE, RIDE_TABS, pageOwned, rideTabOf } from '../src/rides/tabs'

describe('rideTabOf', () => {
  it('opens every named tab', () => {
    for (const t of RIDE_TABS) expect(rideTabOf(t)).toBe(t)
  })

  it('opens the first tab for anything else, including nothing at all', () => {
    expect(rideTabOf(undefined)).toBe('mine')
    expect(rideTabOf('')).toBe('mine')
    // Case matters: a bot's `?tab=BIN` is not the bin.
    expect(rideTabOf('BIN')).toBe('mine')
    expect(rideTabOf('__proto__')).toBe('mine')
    expect(rideTabOf('mine ')).toBe('mine')
  })

  it('keeps the bin last, because it is the tab a rider goes looking for', () => {
    expect(RIDE_TABS[RIDE_TABS.length - 1]).toBe('bin')
  })
})

describe('pageOwned', () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => i)

  it('shows a page that fits the cap whole, with nothing more to offer', () => {
    expect(pageOwned(rows(RIDE_PAGE), false)).toEqual({ visible: rows(RIDE_PAGE), hasMore: false })
    expect(pageOwned([], false)).toEqual({ visible: [], hasMore: false })
  })

  it('slices the one extra row the query fetched and reports there is more', () => {
    const r = pageOwned(rows(RIDE_PAGE + 1), false)
    expect(r.visible).toHaveLength(RIDE_PAGE)
    expect(r.hasMore).toBe(true)
  })

  it('shows everything under show-all and never offers more', () => {
    const r = pageOwned(rows(RIDE_PAGE + 1), true)
    expect(r.visible).toHaveLength(RIDE_PAGE + 1)
    expect(r.hasMore).toBe(false)
  })

  it('keeps the ceiling above the page, or show-all would show less than the cap', () => {
    expect(RIDE_CEILING).toBeGreaterThan(RIDE_PAGE)
  })
})
