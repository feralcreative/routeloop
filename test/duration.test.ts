// The stop-duration formatter, and the promise that the browser's copy of it
// agrees with the server's.
//
// Two things are being tested and they are not the same thing:
//
//   1. The rule itself — what "1h 30m" means, what 90 minutes looks like in each
//      format, and which inputs the parser is allowed to refuse.
//   2. That public/js/duration.js produces byte-identical answers to
//      src/maps/duration.ts. Same arrangement as twist-client.test.ts and
//      filename-client.test.ts, and the same instruction if it fails: bring the
//      two implementations back into line rather than loosening the assertion.
//
// The roadbook is in here too. fmtDuration() in src/routes/roadbook.tsx is the
// oldest of the three copies and the one a rider actually prints, so the "hm"
// format is defined as agreeing with it rather than the other way round.
import { describe, expect, it, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  DEFAULT_DURATION_FORMAT,
  DURATION_FORMATS,
  DURATION_FORMAT_CHOICES,
  MAX_DURATION_MIN,
  decimalHours,
  durationInputMode,
  durationPlaceholder,
  durationUnitName,
  formatDuration,
  hoursMinutes,
  isDurationFormat,
  parseDuration,
  toDurationFormat,
  type DurationFormat,
} from '../src/maps/duration'

let C: any

beforeAll(() => {
  const win: Record<string, unknown> = {}
  new Function('window', readFileSync('public/js/duration.js', 'utf8'))(win)
  C = win.TBDuration
})

describe('formatDuration', () => {
  it('writes 90 minutes differently in each format', () => {
    expect(formatDuration(90, 'hours')).toBe('1.5')
    expect(formatDuration(90, 'hm')).toBe('1h 30m')
    expect(formatDuration(90, 'minutes')).toBe('90')
  })

  it('keeps the trailing zero on a round number of hours', () => {
    // A column mixing "2" and "1.5" reads as two units. See the comment on
    // decimalHours().
    expect(formatDuration(120, 'hours')).toBe('2.0')
    expect(formatDuration(60, 'hours')).toBe('1.0')
  })

  it('drops the hours part below an hour', () => {
    expect(formatDuration(35, 'hm')).toBe('35m')
    expect(formatDuration(0, 'hm')).toBe('0m')
  })

  it('treats null as blank rather than as zero', () => {
    // The distinction this app keeps everywhere: null is "nothing measured it",
    // zero is a measurement. A POI with no dwell is null, not 0.
    for (const f of DURATION_FORMATS) {
      expect(formatDuration(null, f)).toBe('')
      expect(formatDuration(undefined, f)).toBe('')
      expect(formatDuration(NaN, f)).toBe('')
      expect(formatDuration(0, f)).not.toBe('')
    }
  })

  it('never emits a negative duration', () => {
    expect(formatDuration(-30, 'hours')).toBe('0.0')
    expect(formatDuration(-30, 'hm')).toBe('0m')
    expect(formatDuration(-30, 'minutes')).toBe('0')
  })

  it('handles an overnight stop, which is the case that prompted the issue', () => {
    // 658 minutes is the roadbook comment's real example.
    expect(formatDuration(658, 'minutes')).toBe('658')
    expect(formatDuration(658, 'hm')).toBe('10h 58m')
    expect(formatDuration(658, 'hours')).toBe('11.0')
  })
})

describe('parseDuration', () => {
  it('reads a bare number in the format own unit', () => {
    expect(parseDuration('1.5', 'hours')).toBe(90)
    expect(parseDuration('90', 'hm')).toBe(90)
    expect(parseDuration('90', 'minutes')).toBe(90)
    // The one that looks alarming and is not: under 'hours' the field shows
    // "1.5", so a rider typing 90 there means 90 hours.
    expect(parseDuration('90', 'hours')).toBe(5400)
  })

  it('lets an explicit unit win in every format', () => {
    for (const f of DURATION_FORMATS) {
      expect(parseDuration('90m', f)).toBe(90)
      expect(parseDuration('90 min', f)).toBe(90)
      expect(parseDuration('90 minutes', f)).toBe(90)
      expect(parseDuration('1.5h', f)).toBe(90)
      expect(parseDuration('1.5 hr', f)).toBe(90)
      expect(parseDuration('1.5 hours', f)).toBe(90)
      expect(parseDuration('1h 30m', f)).toBe(90)
      expect(parseDuration('1 h 30 min', f)).toBe(90)
      expect(parseDuration('1:30', f)).toBe(90)
    }
  })

  it('does not let the hours-only rule swallow the minutes of a compound', () => {
    // The ordering bug this guards: "1h 30m" matching /^(\d+)h$/ would be 60.
    expect(parseDuration('1h 30m', 'minutes')).toBe(90)
    expect(parseDuration('2h 5m', 'minutes')).toBe(125)
  })

  it('rounds to whole stored minutes', () => {
    expect(parseDuration('0.34', 'hours')).toBe(20)
    expect(parseDuration('20.6m', 'minutes')).toBe(21)
  })

  it('separates blank from zero and from a typo', () => {
    for (const f of DURATION_FORMATS) {
      expect(parseDuration('', f)).toBe(null)
      expect(parseDuration('   ', f)).toBe(null)
      expect(parseDuration('0', f)).toBe(0)
      // Refusing to guess: a typo must not become a real duration.
      expect(parseDuration('abc', f)).toBe(null)
      expect(parseDuration('1h30', f)).toBe(null)
      expect(parseDuration('-30', f)).toBe(null)
      expect(parseDuration('1.2.3', f)).toBe(null)
    }
  })

  it('refuses a clock time with an impossible minutes field', () => {
    expect(parseDuration('1:75', 'hm')).toBe(null)
    expect(parseDuration('1:59', 'hm')).toBe(119)
  })

  it('clamps at the ceiling the ride-graph schema enforces', () => {
    // The field is a text input now, so `max="43200"` is gone from the markup
    // and this is the only thing standing between a fat-fingered "800h" and a
    // 400 on the ride's next autosave. Clamping shows the rider what happened;
    // refusing would look like the field ate their input.
    expect(MAX_DURATION_MIN).toBe(43200)
    expect(parseDuration('800h', 'hm')).toBe(MAX_DURATION_MIN)
    expect(parseDuration('99999', 'minutes')).toBe(MAX_DURATION_MIN)
    expect(parseDuration('9999', 'hours')).toBe(MAX_DURATION_MIN)
    expect(parseDuration('720h', 'hm')).toBe(MAX_DURATION_MIN)
    // One under the limit is untouched, so the clamp is a ceiling and not a cap
    // that rounds everything near it.
    expect(parseDuration('43199m', 'hm')).toBe(43199)
  })

  it('round-trips every format', () => {
    // The property that matters in the panel: what a rider sees is what the
    // field will read back. 'hours' is exact only on six-minute boundaries,
    // which is the documented cost of one decimal place.
    const exact = [0, 5, 15, 30, 45, 60, 90, 125, 658, 1440]
    for (const m of exact) {
      for (const f of ['hm', 'minutes'] as DurationFormat[]) {
        expect(parseDuration(formatDuration(m, f), f)).toBe(m)
      }
    }
    for (const m of [0, 6, 30, 60, 90, 120, 660]) {
      expect(parseDuration(formatDuration(m, 'hours'), 'hours')).toBe(m)
    }
  })

  it('loses at most three minutes to the hours format, and says so here', () => {
    // Not a bug, a documented trade: one decimal hour is six minutes. This test
    // exists so the size of the loss cannot grow unnoticed.
    for (let m = 0; m <= 600; m++) {
      const back = parseDuration(formatDuration(m, 'hours'), 'hours')
      expect(back).not.toBe(null)
      expect(Math.abs((back as number) - m)).toBeLessThanOrEqual(3)
    }
  })
})

describe('the format identifier', () => {
  it('defaults anything it does not recognize', () => {
    expect(DEFAULT_DURATION_FORMAT).toBe('hours')
    expect(toDurationFormat('hm')).toBe('hm')
    expect(toDurationFormat('nonsense')).toBe('hours')
    expect(toDurationFormat(null)).toBe('hours')
    expect(toDurationFormat(undefined)).toBe('hours')
    expect(isDurationFormat('minutes')).toBe(true)
    expect(isDurationFormat('seconds')).toBe(false)
  })

  it('offers every format on the settings page, each with a worked example', () => {
    expect(DURATION_FORMAT_CHOICES.map((c) => c.id)).toEqual([...DURATION_FORMATS])
    // Ninety minutes is the example because it is the value that looks
    // different in all three — that is the question the page is asking.
    expect(new Set(DURATION_FORMAT_CHOICES.map((c) => c.example)).size).toBe(3)
  })
})

describe('the roadbook prints the same "hm" the builder does', () => {
  // fmtDuration() in src/routes/roadbook.tsx is the oldest copy and the one a
  // rider prints, so hoursMinutes() is defined as matching it. Reproduced here
  // rather than imported because it is private to a route module; if that ever
  // changes, import it instead and delete this.
  const roadbook = (seconds: number): string => {
    if (seconds <= 0) return '—'
    const h = Math.floor(seconds / 3600)
    const m = Math.round((seconds % 3600) / 60)
    return h > 0 ? `${h}h ${m}m` : `${m}m`
  }

  it('agrees on every positive duration up to a full day', () => {
    for (let m = 1; m <= 1440; m++) {
      expect(hoursMinutes(m)).toBe(roadbook(m * 60))
    }
  })

  it('differs only on zero, where the roadbook says unknown and this says none', () => {
    // The dash is the roadbook's rule about a router that never answered, not a
    // property of the format. The builder has a blank field for that.
    expect(roadbook(0)).toBe('—')
    expect(hoursMinutes(0)).toBe('0m')
  })
})

describe('public/js/duration.js agrees with src/maps/duration.ts', () => {
  const MINUTES = [0, 1, 5, 6, 7, 20, 30, 45, 59, 60, 61, 90, 125, 359, 658, 1440, 43200]
  const TEXTS = [
    '',
    '   ',
    '0',
    '90',
    '1.5',
    '0.34',
    '90m',
    '90 min',
    '90 minutes',
    '1.5h',
    '1.5 hr',
    '1.5 hours',
    '1h 30m',
    '1 h 30 min',
    '1:30',
    '1:75',
    '1h30',
    'abc',
    '-30',
    '1.2.3',
    '20.6m',
    '800h',
    '99999',
    '43199m',
  ]

  it('formats identically', () => {
    for (const f of DURATION_FORMATS) {
      for (const m of MINUTES) {
        expect(C.format(m, f)).toBe(formatDuration(m, f))
      }
      expect(C.format(null, f)).toBe(formatDuration(null, f))
      expect(C.format(undefined, f)).toBe(formatDuration(undefined, f))
      expect(C.format(NaN, f)).toBe(formatDuration(NaN, f))
    }
  })

  it('parses identically', () => {
    for (const f of DURATION_FORMATS) {
      for (const t of TEXTS) {
        expect(C.parse(t, f)).toBe(parseDuration(t, f))
      }
    }
  })

  it('agrees on the field furniture, which is what keeps the markup in step', () => {
    expect(C.FORMATS).toEqual([...DURATION_FORMATS])
    expect(C.DEFAULT_FORMAT).toBe(DEFAULT_DURATION_FORMAT)
    expect(C.MAX_MIN).toBe(MAX_DURATION_MIN)
    for (const f of DURATION_FORMATS) {
      expect(C.placeholder(f)).toBe(durationPlaceholder(f))
      expect(C.unitName(f)).toBe(durationUnitName(f))
      expect(C.inputMode(f)).toBe(durationInputMode(f))
      expect(C.toFormat(f)).toBe(toDurationFormat(f))
    }
    expect(C.toFormat('nonsense')).toBe(toDurationFormat('nonsense'))
    expect(C.toFormat(undefined)).toBe(toDurationFormat(undefined))
  })

  it('agrees on the two pieces the hm and hours formats are built from', () => {
    for (const m of MINUTES) {
      expect(C.format(m, 'hm')).toBe(hoursMinutes(m))
      expect(C.format(m, 'hours')).toBe(decimalHours(m))
    }
  })
})
