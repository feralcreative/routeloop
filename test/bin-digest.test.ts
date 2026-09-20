// The one notification about a rider's bin (2026-09-20). It was one per ride,
// and a month of real use turned that into a pile; this is the copy of the
// digest that replaced it, pinned so the column limits hold and the list
// degrades by dropping names rather than cutting one in half.
import { describe, expect, it } from 'vitest'
import { binDigest, binLines, BODY_MAX, daysUntil, TITLE_MAX } from '../src/notifications/bin-digest'

const now = new Date('2026-09-20T12:00:00Z')
const days = (n: number) => new Date(now.getTime() + n * 86_400_000)

describe('binDigest', () => {
  it('keeps the old sentence for a single ride', () => {
    const d = binDigest([{ title: 'Coast run', purgeAfter: days(3) }], now, 'en-US')
    expect(d.title).toBe('Coast run is deleted for good in 3 days')
    expect(d.body).toBe('Restoring it from your bin before 09-23-2026 keeps it.')
  })

  it('says tomorrow rather than in 1 day, and never in 0 days', () => {
    expect(binDigest([{ title: 'Coast run', purgeAfter: days(0.5) }], now, 'en-US').title).toBe(
      'Coast run is deleted for good tomorrow',
    )
    expect(daysUntil(days(0.01), now)).toBe(1)
  })

  it('counts several rides in the title and names every one in the body, soonest first', () => {
    const d = binDigest(
      [
        { title: 'Big Sur', purgeAfter: days(20) },
        { title: 'Coast run', purgeAfter: days(3) },
        { title: 'Weaverville', purgeAfter: days(5) },
      ],
      now,
      'en-US',
    )
    expect(d.title).toBe('3 rides in your bin are deleted for good, the first in 3 days')
    expect(d.body).toBe(
      'Coast run (09-23-2026), Weaverville (09-25-2026), Big Sur (10-10-2026). Restore anything you want to keep from your bin.',
    )
  })

  it('formats the dates in the recipient’s own format', () => {
    const d = binDigest([{ title: 'Coast run', purgeAfter: days(3) }], now, 'en-GB')
    expect(d.body).toContain('23-09-2026')
  })

  it('drops names rather than cutting one in half when the body overflows', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      title: `Ride number ${i + 1} of the summer`,
      purgeAfter: days(i + 1),
    }))
    const d = binDigest(many, now, 'en-US')
    expect(d.title.length).toBeLessThanOrEqual(TITLE_MAX)
    expect(d.body.length).toBeLessThanOrEqual(BODY_MAX)
    expect(d.body).toMatch(/, and \d+ more\. Restore anything you want to keep from your bin\.$/)
    // The first name is whole.
    expect(d.body.startsWith('Ride number 1 of the summer (09-21-2026), ')).toBe(true)
  })

  it('falls back to a count when even one name will not fit', () => {
    const long = { title: 'x'.repeat(500), purgeAfter: days(2) }
    const d = binDigest([long, { title: 'Coast run', purgeAfter: days(4) }], now, 'en-US')
    expect(d.body.length).toBeLessThanOrEqual(BODY_MAX)
    expect(d.body).toBe('2 rides, the first on 09-22-2026. Restore anything you want to keep from your bin.')
    expect(d.title.length).toBeLessThanOrEqual(TITLE_MAX)
  })

  it('caps a single long title with an ellipsis rather than a column error', () => {
    const d = binDigest([{ title: 'y'.repeat(300), purgeAfter: days(2) }], now, 'en-US')
    expect(d.title.length).toBe(TITLE_MAX)
    expect(d.title.endsWith('…')).toBe(true)
  })

  it('has nothing to say about an empty bin', () => {
    expect(binDigest([], now, 'en-US')).toEqual({ title: '', body: '' })
  })
})

describe('binLines', () => {
  it('is the email’s list: sorted, dated, with whole days left', () => {
    const lines = binLines(
      [
        { title: 'B', purgeAfter: days(9) },
        { title: 'A', purgeAfter: days(2) },
      ],
      now,
      'en-US',
    )
    expect(lines).toEqual([
      { title: 'A', purgeOn: '09-22-2026', daysLeft: 2 },
      { title: 'B', purgeOn: '09-29-2026', daysLeft: 9 },
    ])
  })
})
