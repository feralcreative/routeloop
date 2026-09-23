// How a date and a clock are written down, per rider.
//
// The three members are real locale tags and Intl does the formatting, so most of
// what these assert is that the RIGHT tag reaches Intl — the digit order, the
// clock convention that comes with it, and the fallbacks for a rider who has
// chosen nothing. The exact glyphs Intl emits are its business, not ours, so the
// assertions below check order and shape rather than pinning every character.
import { describe, expect, it } from 'vitest'
import {
  DATE_FORMATS,
  dateFormatChoices,
  DEFAULT_DATE_FORMAT,
  fmtClock,
  fmtDateFull,
  fmtDateLong,
  fmtDateNumeric,
  fmtMonthShort,
  fmtNumber,
  fromAcceptLanguage,
  toDateFormat,
} from '../src/views/date-format'

// 09:05 UTC, deliberately a morning so the 12-hour locales show AM and the
// 24-hour one shows a leading zero.
const D = new Date('2026-08-24T09:05:00Z')

describe('the three digit orders', () => {
  it('puts the parts in the order each locale expects', () => {
    // DASHES AND TWO DIGITS IN ALL THREE, with the locale deciding only the
    // ORDER. Ziad's call, 2026-09-07: it used to hand the whole decision to Intl
    // and got three separators and three paddings along with the three orders,
    // so a column of dates changed shape as well as sequence.
    expect(fmtDateNumeric(D, 'en-US')).toBe('08-24-2026')
    expect(fmtDateNumeric(D, 'en-GB')).toBe('24-08-2026')
    expect(fmtDateNumeric(D, 'en-CA')).toBe('2026-08-24')
  })

  // THE LABEL IS THE FORMATTER'S OWN OUTPUT since 2026-09-22, so the drift this
  // once guarded against is gone by construction — what is left to pin is that
  // the settings page and the printed date come from the same call.
  it('shows each choice the shape it actually produces', () => {
    for (const choice of dateFormatChoices(D)) {
      expect(choice.label, choice.id).toBe(fmtDateNumeric(D, choice.id))
    }
  })

  // The reason the members are locale tags rather than an mdy/dmy/ymd enum: an
  // order-only enum could not have produced this, and a British rider reading
  // "9:05 AM" on a printed sheet is the same class of wrong as "08/24".
  it('brings the clock convention with the date order', () => {
    expect(fmtClock(D, 'en-US')).toMatch(/9:05\s?AM/i)
    expect(fmtClock(D, 'en-GB')).toBe('09:05')
    expect(fmtClock(D, 'en-CA')).toMatch(/9:05/)
  })

  it('reads the same instant in UTC for every format', () => {
    // Not the server's zone. routes.start_at holds the wall-clock time the rider
    // typed, so reading it anywhere else shifts every printed time by the offset
    // between the server and the rider — hours wrong on a printed roadbook.
    for (const f of DATE_FORMATS) expect(fmtDateNumeric(D, f), f).toContain('24')
    expect(fmtDateLong(D, 'en-US')).toContain('Monday')
    expect(fmtDateLong(D, 'en-GB')).toContain('Monday')
  })

  it('writes English words in all three, because translation is not in scope', () => {
    for (const f of DATE_FORMATS) {
      expect(fmtDateLong(D, f), f).toMatch(/August/)
      expect(fmtMonthShort(D, f), f).toBe('Aug')
    }
    expect(fmtDateFull(D, 'en-US')).toBe('August 24, 2026')
  })

  it('groups numbers through the same setting', () => {
    // All three shipped members are English, so they agree here. The value of
    // routing it through the format at all is that adding a de-DE member would
    // change this with no formatter change — and that fmtMiles stops carrying a
    // hardcoded 'en-US'.
    for (const f of DATE_FORMATS) expect(fmtNumber(1234, f), f).toBe('1,234')
  })
})

describe('coercing a stored value', () => {
  it('takes the three it knows', () => {
    for (const f of DATE_FORMATS) expect(toDateFormat(f)).toBe(f)
  })

  // A rider who has never opened their settings has no user_profiles row at all,
  // so undefined arrives as often as a value. Same contract as toDurationFormat.
  it('falls back for anything else, rather than inventing a third state', () => {
    for (const v of [undefined, null, '', 'en', 'fr-FR', 'mdy', 42, {}, []]) {
      expect(toDateFormat(v), JSON.stringify(v)).toBe(DEFAULT_DATE_FORMAT)
    }
  })
})

describe('guessing from Accept-Language', () => {
  it('takes an exact member outright', () => {
    expect(fromAcceptLanguage('en-GB')).toBe('en-GB')
    expect(fromAcceptLanguage('en-CA,en;q=0.9')).toBe('en-CA')
    // Case-insensitively, because headers are not normalized.
    expect(fromAcceptLanguage('en-gb')).toBe('en-GB')
  })

  it('reads the region off a locale it does not stock', () => {
    expect(fromAcceptLanguage('de-DE,de;q=0.9')).toBe('en-GB') // day first
    expect(fromAcceptLanguage('fr-FR')).toBe('en-GB')
    expect(fromAcceptLanguage('pt-BR')).toBe('en-GB')
    expect(fromAcceptLanguage('ja-JP')).toBe('en-CA') // year first
    expect(fromAcceptLanguage('en-AU')).toBe('en-GB')
  })

  it('uses only the FIRST tag, not the whole weighted list', () => {
    // The header is ordered by preference and the first entry is the answer.
    // Walking the list would let a q=0.1 fallback outvote the rider's own choice.
    expect(fromAcceptLanguage('en-US,en-GB;q=0.9,de-DE;q=0.8')).toBe('en-US')
    expect(fromAcceptLanguage('de-DE,en-US;q=0.9')).toBe('en-GB')
  })

  it('defaults rather than guessing when there is nothing to read', () => {
    for (const h of [undefined, null, '', '   ', '*', 'en', 'xx']) {
      expect(fromAcceptLanguage(h), JSON.stringify(h)).toBe(DEFAULT_DATE_FORMAT)
    }
  })
})

describe('the settings choices', () => {
  it('offers exactly the supported formats, once each', () => {
    expect(dateFormatChoices(D).map((c) => c.id)).toEqual([...DATE_FORMATS])
  })

  it('gives every choice a date and a tooltip naming the order', () => {
    for (const c of dateFormatChoices(D)) {
      expect(c.label.trim(), c.id).not.toBe('')
      expect(c.tip.trim(), c.id).not.toBe('')
    }
  })

  // The three are the SAME DATE in three orders, which is the question being
  // asked: a set that differed by date as well would compare nothing.
  it('writes one date three ways', () => {
    const parts = dateFormatChoices(D).map((c) => c.label.split('-').sort().join())
    expect(new Set(parts).size).toBe(1)
  })

  // It moves with the day rather than being frozen at boot.
  it('follows the date it is given', () => {
    const later = new Date('2027-01-02T09:05:00Z')
    expect(dateFormatChoices(later).map((c) => c.label)).not.toEqual(dateFormatChoices(D).map((c) => c.label))
    expect(dateFormatChoices(later)[0].label).toBe(fmtDateNumeric(later, 'en-US'))
  })
})
