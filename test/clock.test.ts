// The clock preference, and the narrowness of what it overrides (#270).
//
// The whole risk in reversing the "one locale decides everything" call is that
// the override widens — a `hour`/`minute` pair would take the PADDING off the
// locale too, which is the exact mistake fmtClock's own comment records having
// been made once. So these assert the override AND what it leaves alone.
import { describe, expect, it } from 'vitest'
import { CLOCK_CHOICES, CLOCKS, clockAttr, DEFAULT_CLOCK, hour12For, toClock } from '../src/views/clock'
import { fmtClock } from '../src/views/date-format'

const at = (h: number, m: number) => new Date(Date.UTC(2026, 7, 24, h, m))

describe('toClock', () => {
  it('accepts every member', () => {
    for (const c of CLOCKS) expect(toClock(c)).toBe(c)
  })

  it('answers undefined with the default, like every other preference coercer', () => {
    expect(toClock(undefined)).toBe(DEFAULT_CLOCK)
    expect(toClock(null)).toBe(DEFAULT_CLOCK)
    expect(toClock('h36')).toBe(DEFAULT_CLOCK)
    expect(toClock(24)).toBe(DEFAULT_CLOCK)
  })
})

describe('hour12For', () => {
  // UNDEFINED AND NOT FALSE for `locale`. It spreads into an Intl options object
  // as a no-op; `false` would pin every rider who never touched the control to a
  // 24-hour clock, which is the opposite of what the member means.
  it('leaves the decision with the locale', () => {
    expect(hour12For('locale')).toBeUndefined()
  })

  it('overrides in both directions', () => {
    expect(hour12For('h12')).toBe(true)
    expect(hour12For('h24')).toBe(false)
  })
})

describe('clockAttr', () => {
  it('stamps nothing for locale, so the date format answers instead', () => {
    expect(clockAttr('locale')).toBeNull()
  })

  it('stamps both overrides, because the client has to tell them apart', () => {
    expect(clockAttr('h12')).toBe('h12')
    expect(clockAttr('h24')).toBe('h24')
  })
})

describe('fmtClock', () => {
  // THE REGRESSION THIS FILE EXISTS FOR: an omitted argument has to produce the
  // string the function produced before the preference was added, or every
  // caller that has not been updated silently changes what it prints.
  it('defaults to exactly what the locale said', () => {
    for (const f of ['en-US', 'en-GB', 'en-CA'] as const) {
      expect(fmtClock(at(9, 5), f)).toBe(fmtClock(at(9, 5), f, 'locale'))
    }
  })

  it('gives an American a 24-hour clock without giving them a British date', () => {
    expect(fmtClock(at(16, 30), 'en-US', 'h24')).toBe('16:30')
    // The date order is a different setting and is untouched by this one.
    expect(fmtClock(at(9, 5), 'en-US', 'h24')).toBe('09:05')
  })

  // NOTE WHAT en-GB ACTUALLY RETURNS: "04:30 pm", PADDED. That is the narrow
  // override behaving exactly as designed rather than a defect — en-GB's short
  // time pattern is a two-digit hour field, and `hour12` swaps the cycle without
  // touching the field width. Spelling out `hour: 'numeric'` would unpad it and
  // would also take the padding off every OTHER locale, which is the mistake
  // fmtClock's own comment records having been made once.
  //
  // Matched loosely because ICU differs between Node 22 and 24, which CI runs
  // both of, and the claim here is the CYCLE rather than the exact glyphs.
  it('gives a British rider a 12-hour clock', () => {
    const out = fmtClock(at(16, 30), 'en-GB', 'h12')
    expect(out).toMatch(/0?4:30/)
    expect(out).toMatch(/pm/i)
  })

  // THE NARROWNESS. `timeStyle: 'short'` stays, so Intl keeps deciding the
  // separator and how the marker is spelled — en-CA writes "a.m.", not "AM".
  // An `hour`/`minute` override would have Americanized this.
  it('leaves the marker spelling to the locale', () => {
    expect(fmtClock(at(9, 5), 'en-CA', 'h12')).toContain('a.m.')
    expect(fmtClock(at(9, 5), 'en-US', 'h12')).toContain('AM')
  })

  // THE PADDING IS THE LOCALE'S, WHICHEVER CYCLE IS ASKED FOR. en-GB pads to two
  // digits and en-US does not, and that stays true after the override — which is
  // the property that makes this a narrow change rather than an Americanization.
  it('leaves the padding to the locale', () => {
    expect(fmtClock(at(9, 5), 'en-GB', 'h24')).toBe('09:05')
    expect(fmtClock(at(9, 5), 'en-GB', 'h12')).toMatch(/^09:05/)
    expect(fmtClock(at(9, 5), 'en-US', 'h12')).toMatch(/^9:05/)
  })
})

describe('CLOCK_CHOICES', () => {
  it('offers every member exactly once', () => {
    expect(CLOCK_CHOICES.map((c) => c.id).sort()).toEqual([...CLOCKS].sort())
  })
})
