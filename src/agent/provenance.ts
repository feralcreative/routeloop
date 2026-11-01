// Where a fact came from and how old it is (#452).
//
// A friend who has ridden it tells you whether they saw the closure sign last week
// or read about it on a forum two summers ago. Every fact a tool hands the model
// carries this, rendered by cite() into the words the model repeats, so the rider
// is told the same. The guide topics carry the same fields as front matter
// (src/agent/knowledge.ts).
//
// PURE.

export type ProvenanceKind =
  /** Worked out by Routeloop from the ride itself: distances, times, fuel walls. */
  | 'computed'
  /** An official source: a state DOT feed, the NPS, the National Weather Service. */
  | 'official'
  /** A rider's road report: real, dated, and unverified. */
  | 'rider-report'
  /** Ziad's own judgment from riding it. Opinion, and labeled as such. */
  | 'owner-opinion'
  /** A rule of thumb from experience and research, not a measurement. */
  | 'rule-of-thumb'
  /** A forecast, which is a prediction with an issue time. */
  | 'forecast'

export type Provenance = {
  kind: ProvenanceKind
  /** Who said it: "Caltrans CWWP2", "Open-Meteo", "a rider", "Routeloop". */
  source: string
  /** When the fact was true or issued, as an ISO date or date-time. */
  asOf?: string
  /** When Routeloop last fetched or checked it, if different from asOf. */
  checkedAt?: string
}

const LABEL: Record<ProvenanceKind, string> = {
  computed: 'computed by Routeloop',
  official: 'official',
  'rider-report': 'rider report, unverified',
  'owner-opinion': 'Ziad’s opinion',
  'rule-of-thumb': 'rule of thumb',
  forecast: 'forecast',
}

/** One bracketed tag the model can repeat: "[official: Caltrans, as of 2026-11-02,
 *  checked 2026-11-02 14:05]". A computed fact needs no source or date. */
export function cite(p: Provenance): string {
  if (p.kind === 'computed') return `[${LABEL.computed}]`
  const parts = [`${LABEL[p.kind]}: ${p.source}`]
  if (p.asOf) parts.push(`as of ${p.asOf}`)
  if (p.checkedAt && p.checkedAt !== p.asOf) parts.push(`checked ${p.checkedAt}`)
  return `[${parts.join(', ')}]`
}
