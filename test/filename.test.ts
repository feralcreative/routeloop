// The naming convention, both directions.
//
// The assertions that matter most are the negative ones: a rider's own file
// must NOT be read as structured, because the fallback path (upload order is
// day order) is correct for it and reinterpreting it silently is not.
//
// Second most: the legacy-marker block at the bottom. This app wrote `tankbag_`
// names between 2026-07-29 and 2026-08-11, and a rename that stops reading them
// fails silently — the files still import, just stripped of day order and dates,
// which is precisely the information the convention exists to carry.
import { describe, expect, it } from 'vitest'
import {
  buildExportName,
  parseExportName,
  planImport,
  slugField,
  splitExt,
  titleFromSlug,
  uniqueName,
} from '../src/maps/filename'

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
  it('treats .routeloop.json as one extension', () => {
    expect(splitExt('routeloop_big-sur_d01.routeloop.json')).toEqual({
      stem: 'routeloop_big-sur_d01',
      ext: 'routeloop.json',
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
      'routeloop_big-sur-run_d02_2026-08-14_lost-coast.gpx',
    )
  })

  it('zero-pads the day so d10 sorts after d09', () => {
    const names = [9, 10].map((d) => buildExportName({ ride: 'r', day: d, ext: 'gpx' }))
    expect(names).toEqual(['routeloop_r_d09.gpx', 'routeloop_r_d10.gpx'])
    expect([...names].sort()).toEqual(names)
  })

  it('skips absent optional fields rather than writing them empty', () => {
    expect(buildExportName({ ride: 'r', ext: 'gpx' })).toBe('routeloop_r.gpx')
    expect(buildExportName({ ride: 'r', day: 1, ext: 'gpx' })).toBe('routeloop_r_d01.gpx')
    expect(buildExportName({ ride: 'r', date, ext: 'gpx' })).toBe('routeloop_r_2026-08-14.gpx')
    expect(buildExportName({ ride: 'r', day: 1, title: 'x', ext: 'gpx' })).not.toContain('__')
  })

  it('omits a midnight time and keeps any other', () => {
    expect(buildExportName({ ride: 'r', date, ext: 'gpx' })).toBe('routeloop_r_2026-08-14.gpx')
    expect(buildExportName({ ride: 'r', date: new Date(Date.UTC(2026, 7, 14, 8, 30)), ext: 'gpx' })).toBe(
      'routeloop_r_2026-08-14T0830.gpx',
    )
  })

  // The roadbook renders these timestamps with timeZone: 'UTC', so a filename
  // built from local getters would disagree with it about which day a route is
  // on. This instant is 2026-08-13 in US Pacific and 2026-08-14 in UTC, so the
  // assertion fails on a local-getter implementation when run in Pacific. CI
  // runs in UTC, where both agree — this guard bites hardest on a workstation.
  it('formats the date in UTC, matching the roadbook', () => {
    expect(buildExportName({ ride: 'r', date: new Date(Date.UTC(2026, 7, 14, 5, 0)), ext: 'gpx' })).toBe(
      'routeloop_r_2026-08-14T0500.gpx',
    )
  })

  // The legacy marker is read, never written. If this ever produces a
  // `tankbag_` name again, the two markers have been wired together somewhere.
  it('never writes the legacy marker', () => {
    expect(buildExportName({ ride: 'r', day: 1, ext: 'gpx' })).not.toContain('tankbag')
  })

  it('survives a title that was full of separators', () => {
    const name = buildExportName({ ride: 'r', day: 1, title: 'day_two: the_good_part', ext: 'gpx' })
    expect(name).toBe('routeloop_r_d01_day-two-the-good-part.gpx')
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
    'routeloop.gpx', // marker with no ride
    'tankbag.gpx', // legacy marker with no ride
    'my_routeloop_ride.gpx', // marker present but not first
    'my_tankbag_ride.gpx', // legacy marker present but not first
    'Track_001.gpx',
  ])('returns null for %s', (name) => {
    expect(parseExportName(name)).toBeNull()
  })
})

describe('parseExportName', () => {
  it('reads every field back', () => {
    const p = parseExportName('routeloop_big-sur-run_d02_2026-08-14_lost-coast.gpx')!
    expect(p.ride).toBe('big-sur-run')
    expect(p.day).toBe(2)
    expect(p.date?.toISOString()).toBe('2026-08-14T00:00:00.000Z')
    expect(p.hasTime).toBe(false)
    expect(p.title).toBe('lost-coast')
    expect(p.ext).toBe('gpx')
  })

  it('reads a time when the date carries one', () => {
    const p = parseExportName('routeloop_r_d01_2026-08-14T0830.gpx')!
    expect(p.date?.toISOString()).toBe('2026-08-14T08:30:00.000Z')
    expect(p.hasTime).toBe(true)
  })

  it('identifies optional fields by shape, not position', () => {
    expect(parseExportName('routeloop_r_d02.gpx')).toMatchObject({ day: 2, date: null, title: null })
    expect(parseExportName('routeloop_r_2026-08-14.gpx')).toMatchObject({ day: null, title: null })
    expect(parseExportName('routeloop_r_lost-coast.gpx')).toMatchObject({ day: null, date: null, title: 'lost-coast' })
  })

  it('is forgiving inside a marked name', () => {
    expect(parseExportName('routeloop_r_d2.gpx')?.day).toBe(2)
    expect(parseExportName('ROUTELOOP_r_d02.gpx')?.day).toBe(2)
    // Tokens past the title are folded in rather than failing the parse.
    expect(parseExportName('routeloop_r_d01_2026-08-14_a_b.gpx')?.title).toBe('a-b')
  })

  it('leaves an impossible date to be read as title text', () => {
    const p = parseExportName('routeloop_r_2026-02-30.gpx')!
    expect(p.date).toBeNull()
    expect(p.title).toBe('2026-02-30')
  })

  it('does not read d00 as a day', () => {
    const p = parseExportName('routeloop_r_d00.gpx')!
    expect(p.day).toBeNull()
    expect(p.title).toBe('d00')
  })

  it('round-trips everything the builder writes', () => {
    const cases = [
      { ride: 'Big Sur Run', day: 2, date: new Date(Date.UTC(2026, 7, 14)), title: 'Lost Coast', ext: 'gpx' },
      { ride: 'Big Sur Run', day: 12, date: new Date(Date.UTC(2026, 11, 1, 7, 5)), title: 'Rest Day', ext: 'kml' },
      { ride: 'r', day: 1, ext: 'routeloop.json' },
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

// Files exported while the app was called tankbag. A rider still holds these,
// and they are the only copy of a day's date once the ride is a GPX. Every
// assertion here is about not losing that.
describe('parseExportName — the legacy tankbag marker', () => {
  it('reads a legacy name exactly as it reads a current one', () => {
    const legacy = parseExportName('tankbag_big-sur-run_d02_2026-08-14_lost-coast.gpx')!
    const current = parseExportName('routeloop_big-sur-run_d02_2026-08-14_lost-coast.gpx')!
    expect(legacy).toEqual(current)
  })

  it('is case-insensitive on the legacy marker too', () => {
    expect(parseExportName('TANKBAG_r_d02.gpx')?.day).toBe(2)
  })

  it('still treats .tankbag.json as one extension', () => {
    expect(splitExt('tankbag_big-sur_d01.tankbag.json')).toEqual({
      stem: 'tankbag_big-sur_d01',
      ext: 'tankbag.json',
    })
  })

  // The whole point: a folder downloaded before the rename still comes back in
  // day order with its dates, rather than in upload order with none.
  it('orders and dates a legacy folder', () => {
    const plan = planImport([
      'tankbag_big-sur-run_d03_2026-08-15_avenue-of-giants.gpx',
      'tankbag_big-sur-run_d01_2026-08-13_coast-start.gpx',
      'tankbag_big-sur-run_d02_2026-08-14_lost-coast.gpx',
    ])
    expect(plan.ride).toBe('Big Sur Run')
    expect(plan.allConforming).toBe(true)
    expect(plan.reordered).toBe(true)
    expect(plan.files.map((f) => f.day)).toEqual([1, 2, 3])
    expect(plan.files.every((f) => f.date !== null)).toBe(true)
  })

  // A rider who exported before the rename and again after has one folder with
  // both markers in it. Same ride, so it must not read as a ride conflict.
  it('reads a mixed folder as one ride', () => {
    const plan = planImport(['tankbag_big-sur-run_d01.gpx', 'routeloop_big-sur-run_d02.gpx'])
    expect(plan.rideConflict).toBe(false)
    expect(plan.allConforming).toBe(true)
    expect(plan.files.map((f) => f.day)).toEqual([1, 2])
  })
})

describe('planImport', () => {
  const names = [
    'routeloop_big-sur-run_d03_2026-08-15_avenue-of-giants.gpx',
    'routeloop_big-sur-run_d01_2026-08-13_coast-start.gpx',
    'routeloop_big-sur-run_d02_2026-08-14_lost-coast.gpx',
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
    const plan = planImport(['routeloop_r_d02.gpx', 'whatever.gpx', 'routeloop_r_d01.gpx'])
    expect(plan.reordered).toBe(false)
    expect(plan.allConforming).toBe(false)
    expect(plan.files.map((f) => f.fileName)).toEqual(['routeloop_r_d02.gpx', 'whatever.gpx', 'routeloop_r_d01.gpx'])
  })

  it('flags files that disagree about which ride they belong to', () => {
    expect(planImport(['routeloop_a_d01.gpx', 'routeloop_b_d02.gpx']).rideConflict).toBe(true)
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
    const plan = planImport(['routeloop_r_d02_b.gpx', 'routeloop_r_d02_a.gpx'])
    expect(plan.files.map((f) => f.title)).toEqual(['b', 'a'])
  })
})

describe('uniqueName', () => {
  it('hands back a name nobody has used', () => {
    const used = new Set<string>()
    expect(uniqueName(used, 'routeloop_coast_2026-08-14.gpx')).toBe('routeloop_coast_2026-08-14.gpx')
  })

  it('claims the name it hands back, so a caller cannot forget to', () => {
    const used = new Set<string>()
    uniqueName(used, 'a.gpx')
    expect(used.has('a.gpx')).toBe(true)
  })

  it('numbers a collision', () => {
    const used = new Set<string>()
    uniqueName(used, 'a.gpx')
    expect(uniqueName(used, 'a.gpx')).toBe('a-2.gpx')
    expect(uniqueName(used, 'a.gpx')).toBe('a-3.gpx')
  })

  it('numbers before the extension, and the compound extension is one extension', () => {
    // `ride.routeloop.json-2` is not a JSON file to anything that reads names.
    const used = new Set(['routeloop_coast.routeloop.json'])
    expect(uniqueName(used, 'routeloop_coast.routeloop.json')).toBe('routeloop_coast-2.routeloop.json')
  })

  it('handles a name with no extension at all', () => {
    const used = new Set(['coast'])
    expect(uniqueName(used, 'coast')).toBe('coast-2')
  })

  it('skips a numbered name that is itself already taken', () => {
    const used = new Set(['a.gpx', 'a-2.gpx'])
    expect(uniqueName(used, 'a.gpx')).toBe('a-3.gpx')
  })
})
