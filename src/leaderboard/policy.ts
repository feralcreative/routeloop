// The Most Active board on /riders (#192): the pure half. service.ts is the query.
//
// OPT-IN, AND THAT IS THE DECISION THE ISSUE WAS FILED FOR (Ziad's call,
// 2026-10-02). The roster promises names and handles only, so a rider appears
// here only after ticking `on_leaderboard` on their Profile tab, and every figure
// counts their LISTED, live rides alone, the same set their public profile counts:
// nothing private reaches a number.

export const METRICS = ['miles', 'rides', 'stops'] as const
export type Metric = (typeof METRICS)[number]

export const METRIC_LABEL: Record<Metric, string> = {
  miles: 'Most miles',
  rides: 'Most rides',
  stops: 'Most stops',
}

export const BOARD_SIZE = 25

export function toMetric(v: unknown): Metric {
  return typeof v === 'string' && (METRICS as readonly string[]).includes(v) ? (v as Metric) : 'miles'
}

/** Standard competition ranking: ties share a rank and the next rank skips. */
export function rank<T>(rows: T[], value: (r: T) => number): Array<T & { rank: number }> {
  let last: number | null = null
  let lastRank = 0
  return rows.map((r, i) => {
    const v = value(r)
    if (v !== last) {
      lastRank = i + 1
      last = v
    }
    return { ...r, rank: lastRank }
  })
}
