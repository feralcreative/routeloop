// What a rider typed into the export search box, turned into the two questions
// the query can actually ask: a name, and a time.
//
// Pure — a string in, a shape out, no database — which is the house split every
// other rule module follows (invites/policy.ts vs service.ts, access/policy.ts
// vs query.ts). The query that uses it lives in routes/import.tsx.
//
// **A DATE HERE MEANS THE DAYS' DATES, NEVER `rides.created_at`.** #131 states
// it and it is the whole reason this module exists rather than a bare `ilike` on
// the title: a rider searching "August" means when they RODE, not when they
// happened to make the record. The two are frequently months apart — a ride
// planned in March for a trip in August is the normal case, not the edge one.

/** The three months a rider is most likely to abbreviate, and the other nine. */
const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
]

export type RideQuery = {
  /** What is left after the date words are taken out. Null when nothing is. */
  text: string | null
  /** Inclusive start of the range a date term named. */
  from: Date | null
  /** EXCLUSIVE end, so a whole month is one `>= from AND < to` with no
   *  arithmetic about how many days it has and no midnight edge to get wrong. */
  to: Date | null
  /** 1-12, set ONLY when a month was named with no year — "august" means every
   *  August, and a range cannot say that. Mutually exclusive with from/to. */
  month: number | null
  /**
   * Whether the caller should OR the name and the date rather than AND them.
   *
   * True in exactly one case: the whole query was a single month name. "august"
   * has two honest readings — rides ridden in August, and a ride called August
   * Loop — and picking one silently hides the other, which is the thing that
   * makes a search box feel broken. Every other query ANDs, because "coast
   * august" plainly means both terms at once.
   */
  loose: boolean
}

const EMPTY: RideQuery = { text: null, from: null, to: null, month: null, loose: false }

/** UTC, because a day's clock is a wall clock carried as UTC and every surface
 *  in this app reads it back with `timeZone: 'UTC'`. A range built in the
 *  server's zone would put a ride on the wrong side of a month boundary for
 *  eight hours of every day. */
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d))

/**
 * Read a search box.
 *
 * Deliberately forgiving in one direction only: anything it does not recognize
 * stays in `text` and is matched against the title, so a rider whose ride is
 * called "August Loop" still finds it by typing August — the month term and the
 * title term are OR-ed by the caller, not AND-ed. Being clever about which one
 * was meant would silently hide the other.
 */
export function parseRideQuery(raw: string): RideQuery {
  const q = raw.trim().toLowerCase()
  if (!q) return EMPTY

  // An explicit ISO-ish date wins outright and consumes the whole query: nobody
  // types "2026-08-14 coast" meaning two things, and treating the rest as a
  // title term would return nothing for the common case of a stray character.
  // 1900-2099 rather than any four digits, the same bound the bare-year word
  // below uses. "1899" and "2126" are far likelier to be part of a ride's name
  // than a date somebody rode, and reading one as a year returns nothing at all.
  const iso = /^((?:19|20)\d{2})(?:-(\d{2}))?(?:-(\d{2}))?$/.exec(q)
  if (iso) {
    const y = Number(iso[1])
    const m = iso[2] ? Number(iso[2]) - 1 : null
    const d = iso[3] ? Number(iso[3]) : null
    if (m !== null && (m < 0 || m > 11)) return { ...EMPTY, text: q }
    if (d !== null && (d < 1 || d > 31)) return { ...EMPTY, text: q }
    if (d !== null && m !== null)
      return { text: null, from: utc(y, m, d), to: utc(y, m, d + 1), month: null, loose: false }
    if (m !== null) return { text: null, from: utc(y, m, 1), to: utc(y, m + 1, 1), month: null, loose: false }
    return { text: null, from: utc(y, 0, 1), to: utc(y + 1, 0, 1), month: null, loose: false }
  }

  const words = q.split(/\s+/)
  let month: number | null = null
  let year: number | null = null
  const rest: string[] = []

  for (const w of words) {
    // Three letters is the shortest abbreviation worth honoring, and a prefix
    // match rather than a table of abbreviations: "sept" and "sep" both find
    // September without either being written down. "may" needs no abbreviation
    // and matches itself.
    const i = w.length >= 3 ? MONTHS.findIndex((m) => m.startsWith(w)) : -1
    if (i >= 0 && month === null) {
      month = i + 1
      continue
    }
    if (/^(19|20)\d{2}$/.test(w) && year === null) {
      year = Number(w)
      continue
    }
    rest.push(w)
  }

  const text = rest.join(' ') || null
  if (month !== null && year !== null) {
    return { text, from: utc(year, month - 1, 1), to: utc(year, month, 1), month: null, loose: false }
  }
  if (year !== null) return { text, from: utc(year, 0, 1), to: utc(year + 1, 0, 1), month: null, loose: false }
  if (month !== null) {
    // The month word is put BACK as a title term when it was the whole query, so
    // "August Loop" is still findable by typing August. `loose` is what tells
    // the caller these two are alternatives rather than both required.
    return text === null
      ? { text: q, from: null, to: null, month, loose: true }
      : { text, from: null, to: null, month, loose: false }
  }
  return { ...EMPTY, text }
}
