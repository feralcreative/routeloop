// The naming convention, both directions.
//
// The assertions that matter most are the negative ones: a rider's own file
// must NOT be read as structured, because the fallback path (upload order is
// day order) is correct for it and reinterpreting it silently is not.
import { describe, expect, it } from 'vitest'
import { buildExportName, parseExportName, planImport, slugField, splitExt, titleFromSlug } from '../src/maps/filename'

describe('slugField', () => {
  it('lowercases and hyphenates', () => {
    expect(slugField('Lost Coast')).toBe('lost-coast')
    expect(slugField('Avenue of Giants')).toBe('avenue-of-giants')
  })

  it('folds diacritics rather than dropping the letter', () => {
    expect(slugField('Cañón')).toBe('canon')
    expect(slugField('Côte d’Azur')).toBe('cote-d-azur')
  })

  // The invariant the whole format rests on. An underscore surviving into a
  // field would split that field into two on the way back in.
  it('never emits an underscore', () => {
    expect(slugField('day_two_coast')).toBe('day-two-coast')
    expect(slugField('a_b')).not.toContain('_')
  })

  it('collapses and trims separator runs', () => {
    expect(slugField('  --Big   Sur!!  ')).toBe('big-sur')
    expect(slugField('***')).toBe('')
  })

  it('caps length without leaving a trailing hyphen', () => {
    const s = slugField('aaaa bbbb cccc dddd', 10)
    expect(s.length).toBeLessThanOrEqual(10)
    expect(s.endsWith('-')).toBe(false)
  })
})

describe('titleFromSlug', () => {
  it('is a guess, and says so by capitalising every word', () => {
    expect(titleFromSlug('lost-coast')).toBe('Lost Coast')
    // Not "Avenue of Giants" — the original casing was destroyed by slugField
    // and cannot be recovered. This is why a file's internal name wins.
    expect(titleFromSlug('avenue-of-giants')).toBe('Avenue Of Giants')
  })
})

describe('splitExt', () => {
  it('treats .tankbag.json as one extension', () => {
    expect(splitExt('tankbag_big-sur_d01.tankbag.json')).toEqual({
      stem: 'tankbag_big-sur_d01',
      ext: 'tankbag.json',
    })
  })

  it('handles ordinary and absent extensions', () => {
    expect(splitExt('a.gpx')).toEqual({ stem: 'a', ext: 'gpx' })
    expect(splitExt('a.GPX')).toEqual({ stem: 'a', ext: 'gpx' })
    expect(splitExt('noext')).toEqual({ stem: 'noext', ext: '' })
    expect(splitExt('.hidden')).toEqual({ stem: '.hidden', ext: '' })
  })
})

describe('buildExportName', () => {
  const date = new Date(Date.UTC(2026, 7, 14))

  it('writes every field in order', () => {
    expect(buildExportName({ ride: 'Big Sur Run', day: 2, date, title: 'Lost Coast', ext: 'gpx' })).toBe(
      'tankbag_big-sur-run_d02_2026-08-14_lost-coast.gpx',
    )
  })

  it('zero-pads the day so d10 sorts after d09', () => {
    const names = [9, 10].map((d) => buildExportName({ ride: 'r', day: d, ext: 'gpx' }))
    expect(names).toEqual(['tankbag_r_d09.gpx', 'tankbag_r_d10.gpx'])
    expect([...names].sort()).toEqual(names)
  })

  it('skips absent optional fields rather than writing them empty', () => {
    expect(buildExportName({ ride: 'r', ext: 'gpx' })).toBe('tankbag_r.gpx')
    expect(buildExportName({ ride: 'r', day: 1, ext: 'gpx' })).toBe('tankbag_r_d01.gpx')
    expect(buildExportName({ ride: 'r', date, ext: 'gpx' })).toBe('tankbag_r_2026-08-14.gpx')
    expect(buildExportName({ ride: 'r', day: 1, title: 'x', ext: 'gpx' })).not.toContain('__')
  })

  it('omits a midnight time and keeps any other', () => {
    expect(buildExportName({ ride: 'r', date, ext: 'gpx' })).toBe('tankbag_r_2026-08-14.gpx')
    expect(buildExportName({ ride: 'r', date: new Date(Date.UTC(2026, 7, 14, 8, 30)), ext: 'gpx' })).toBe(
      'tankbag_r_2026-08-14T0830.gpx',
    )
  })

  // The roadbook renders these timestamps with timeZone: 'UTC', so a filename
  // built from local getters would disagree with it about which day a route is
  // on. This instant is 2026-08-13 in US Pacific and 2026-08-14 in UTC, so the
  // assertion fails on a local-getter implementation when run in Pacific. CI
  // runs in UTC, where both agree — this guard bites hardest on a workstation.
  it('formats the date in UTC, matching the roadbook', () => {
    expect(buildExportName({ ride: 'r', date: new Date(Date.UTC(2026, 7, 14, 5, 0)), ext: 'gpx' })).toBe(
      'tankbag_r_2026-08-14T0500.gpx',
    )
  })

  it('survives a title that was full of separators', () => {
    const name = buildExportName({ ride: 'r', day: 1, title: 'day_two: the_good_part', ext: 'gpx' })
    expect(name).toBe('tankbag_r_d01_day-two-the-good-part.gpx')
    expect(parseExportName(name)?.title).toBe('day-two-the-good-part')
  })
})

describe('parseExportName — what it refuses', () => {
  // Realistic files a rider actually has. Every one of these must fall through
  // to the pre-convention import path untouched.
  it.each([
    'day-2.gpx',
    'Big Sur Run.gpx',
    'coast.kml',
    '2026-08-14.gpx',
    'd02_2026-08-14_lost-coast.gpx', // fields but no marker
    'tankbag.gpx', // marker with no ride
    'my_tankbag_ride.gpx', // marker present but not first
    'Track_001.gpx',
  ])('returns null for %s', (name) => {
    expect(parseExportName(name)).toBeNull()
  })
})

describe('parseExportName', () => {
  it('reads every field back', () => {
    const p = parseExportName('tankbag_big-sur-run_d02_2026-08-14_lost-coast.gpx')!
    expect(p.ride).toBe('big-sur-run')
    expect(p.day).toBe(2)
    expect(p.date?.toISOString()).toBe('2026-08-14T00:00:00.000Z')
    expect(p.hasTime).toBe(false)
    expect(p.title).toBe('lost-coast')
    expect(p.ext).toBe('gpx')
  })

  it('reads a time when the date carries one', () => {
    const p = parseExportName('tankbag_r_d01_2026-08-14T0830.gpx')!
    expect(p.date?.toISOString()).toBe('2026-08-14T08:30:00.000Z')
    expect(p.hasTime).toBe(true)
  })

  it('identifies optional fields by shape, not position', () => {
    expect(parseExportName('tankbag_r_d02.gpx')).toMatchObject({ day: 2, date: null, title: null })
    expect(parseExportName('tankbag_r_2026-08-14.gpx')).toMatchObject({ day: null, title: null })
    expect(parseExportName('tankbag_r_lost-coast.gpx')).toMatchObject({ day: null, date: null, title: 'lost-coast' })
  })

  it('is forgiving inside a marked name', () => {
    expect(parseExportName('tankbag_r_d2.gpx')?.day).toBe(2)
    expect(parseExportName('TANKBAG_r_d02.gpx')?.day).toBe(2)
    // Tokens past the title are folded in rather than failing the parse.
    expect(parseExportName('tankbag_r_d01_2026-08-14_a_b.gpx')?.title).toBe('a-b')
  })

  it('leaves an impossible date to be read as title text', () => {
    const p = parseExportName('tankbag_r_2026-02-30.gpx')!
    expect(p.date).toBeNull()
    expect(p.title).toBe('2026-02-30')
  })

  it('does not read d00 as a day', () => {
    const p = parseExportName('tankbag_r_d00.gpx')!
    expect(p.day).toBeNull()
    expect(p.title).toBe('d00')
  })

  it('round-trips everything the builder writes', () => {
    const cases = [
      { ride: 'Big Sur Run', day: 2, date: new Date(Date.UTC(2026, 7, 14)), title: 'Lost Coast', ext: 'gpx' },
      { ride: 'Big Sur Run', day: 12, date: new Date(Date.UTC(2026, 11, 1, 7, 5)), title: 'Rest Day', ext: 'kml' },
      { ride: 'r', day: 1, ext: 'tankbag.json' },
      { ride: 'Solo', ext: 'csv' },
      { ride: 'Cañón Trip', day: 3, title: 'Côte', ext: 'geojson' },
    ]
    for (const c of cases) {
      const p = parseExportName(buildExportName(c))
      expect(p, buildExportName(c)).not.toBeNull()
      expect(p!.ride).toBe(slugField(c.ride))
      expect(p!.day).toBe(c.day ?? null)
      expect(p!.date?.getTime() ?? null).toBe(c.date?.getTime() ?? null)
      expect(p!.title).toBe(c.title ? slugField(c.title) : null)
      expect(p!.ext).toBe(c.ext)
    }
  })
})

describe('planImport', () => {
  const names = [
    'tankbag_big-sur-run_d03_2026-08-15_avenue-of-giants.gpx',
    'tankbag_big-sur-run_d01_2026-08-13_coast-start.gpx',
    'tankbag_big-sur-run_d02_2026-08-14_lost-coast.gpx',
  ]

  it('recovers the trip and orders by day, not by upload order', () => {
    const plan = planImport(names)
    expect(plan.ride).toBe('Big Sur Run')
    expect(plan.allConforming).toBe(true)
    expect(plan.reordered).toBe(true)
    expect(plan.rideConflict).toBe(false)
    expect(plan.files.map((f) => f.day)).toEqual([1, 2, 3])
    expect(plan.files.map((f) => f.title)).toEqual(['coast-start', 'lost-coast', 'avenue-of-giants'])
  })

  it('reports reordered false when the supplied order was already right', () => {
    expect(planImport([...names].sort()).reordered).toBe(false)
  })

  // A partial set has no defensible order: sorting it would interleave numbered
  // and unnumbered days by an invented rule.
  it('keeps the supplied order when any file lacks a day', () => {
    const plan = planImport(['tankbag_r_d02.gpx', 'whatever.gpx', 'tankbag_r_d01.gpx'])
    expect(plan.reordered).toBe(false)
    expect(plan.allConforming).toBe(false)
    expect(plan.files.map((f) => f.fileName)).toEqual(['tankbag_r_d02.gpx', 'whatever.gpx', 'tankbag_r_d01.gpx'])
  })

  it('flags files that disagree about which ride they belong to', () => {
    expect(planImport(['tankbag_a_d01.gpx', 'tankbag_b_d02.gpx']).rideConflict).toBe(true)
  })

  it('says nothing about a folder of ordinary files', () => {
    const plan = planImport(['day-1.gpx', 'day-2.gpx'])
    expect(plan.ride).toBeNull()
    expect(plan.allConforming).toBe(false)
    expect(plan.reordered).toBe(false)
    expect(plan.files.map((f) => f.ext)).toEqual(['gpx', 'gpx'])
  })

  it('is empty-safe', () => {
    expect(planImport([])).toMatchObject({ ride: null, allConforming: false, reordered: false })
  })

  it('ties break on supplied order rather than unpredictably', () => {
    const plan = planImport(['tankbag_r_d02_b.gpx', 'tankbag_r_d02_a.gpx'])
    expect(plan.files.map((f) => f.title)).toEqual(['b', 'a'])
  })
})
