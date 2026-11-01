// find_along_route: the builder's Along the route search, for the assistant.
//
// THE SAME SEARCH, NOT A SECOND IDEA OF ONE. The track is the route's legs
// concatenated the way trackAndSpans() in builder.js builds it, the samples are
// corridorSamples(), every search is a wide Text Search biased at one sample, and
// what comes back is kept only inside the corridor. src/maps/corridor.ts is the
// arithmetic, pinned to public/js/corridor.js.
//
// A PARTIAL SEARCH MUST NEVER READ AS AN EMPTY ROAD. That was the corridor
// search's defining bug in the builder (a 593-mile route searched in six circles
// with 37-mile holes between them answered "no gas"), and a model reading a list is
// more likely than a rider to take silence as an answer. So every stretch that was
// not searched, whether the budget ran out, a request failed, or the circles could
// not reach end to end, is named by its miles from the start, and an empty result
// on a partial search says what it does not know.
//
// THE BUDGET DECIDES THE SHAPE BEFORE ANYTHING IS SPENT. The searches are claimed
// up front; with fewer than the route wants, the route is re-sampled with fewer,
// larger circles (corridorSamples() does exactly that given a smaller cap) rather
// than searching its first half properly and its second half not at all. A cached
// answer is refunded, as search_places refunds one, because Google was not asked.
//
// THE GEOMETRY IS NEVER PRINTED. Only names, addresses, one coordinate per place
// and distances leave this file, which is the summary's rule (summary.ts).
import { z } from 'zod'
import { GMAPS_SERVER_KEY } from '../../config'
import { METERS_PER_MILE, type Track } from '../../maps/kml'
import { MAX_CORRIDOR_RESULTS, searchPlaces, type PlaceHit, type PlacesError } from '../../maps/places'
import {
  corridorSamples,
  cumulativeM,
  legAtVertex,
  pointAtDistance,
  samplesCoverAll,
  trackAndSpans,
  withinCorridor,
  type Sample,
  type Span,
} from '../../maps/corridor'
import { matchesAny, rankPlaces } from '../../places/ranking'
import { routeIndex } from '../ride-edit'
import type { Units } from '../summary'
import type { Tool } from '../tools'

const tool = <S extends z.ZodObject>(t: Tool<S>) => t

/**
 * The most searches one call may make. SIX IS THE FREE TIER'S WHOLE TURN, and the
 * number that lets the tool cover a route end to end: six circles at the 50 km clamp
 * reach about 370 miles with no holes. A route shorter than that at the default
 * 15-mile corridor uses one search per 30 miles and stops well short of it. The
 * capability declares this, so the per-call ceiling and the claim loop agree.
 */
export const ALONG_ROUTE_MAX_SEARCHES = 6

/** The builder's CORRIDOR_MI: how far off the road a stop is worth, by default. */
export const DEFAULT_CORRIDOR_MI = 15

/** What one call prints at most. Twelve is enough to choose from on any stretch and
 *  short enough that a long route's list is spread rather than truncated. */
export const MAX_ALONG_RESULTS = 12

/** A gap shorter than this is floating-point noise where two circles exactly touch,
 *  not a stretch nobody searched. Kept tiny: a failed search between two overlapping
 *  neighbors can leave a real gap of a few meters, and that is still a gap. */
const MIN_GAP_M = 1

type Found = PlaceHit & {
  offM: number
  /** Along the drawn track, for grouping and coverage. */
  trackM: number
  /** Along the route as get_ride measures it (the legs' road distance). */
  alongM: number
  leg: number | null
}

const dist = (m: number, u: Units, places = 1) =>
  u === 'mi' ? `${(m / METERS_PER_MILE).toFixed(places)} mi` : `${(m / 1000).toFixed(places)} km`

const whole = (m: number, u: Units) => Math.round(u === 'mi' ? m / METERS_PER_MILE : m / 1000)

/** A stretch of road by its distances from the start, in the rider's units. */
const stretch = (a: number, b: number, u: Units) => `${whole(a, u)}–${whole(b, u)} ${u}`

/**
 * Track meters (haversine along the drawn line) to route meters (the legs' own
 * `distanceM`, which is what get_ride prints). The two agree only to within a few
 * percent, and a place the assistant says is "at 112 mi" should sit beside a point
 * get_ride says is at 110, so every distance a rider reads goes through this.
 */
function toRouteM(
  trackM: number,
  legHint: number | null,
  spans: Span[],
  cum: number[],
  legs: { distanceM: number }[],
): number {
  let leg = legHint
  if (leg == null) {
    leg = spans.findIndex((s) => s != null && trackM <= cum[s.endIndex])
    if (leg < 0) leg = spans.length - 1
  }
  let before = 0
  for (let i = 0; i < leg; i++) before += legs[i]?.distanceM ?? 0
  const s = spans[leg]
  if (!s) return before
  const span = cum[s.endIndex] - cum[s.startIndex]
  const frac = span > 0 ? Math.max(0, Math.min(1, (trackM - cum[s.startIndex]) / span)) : 0
  return before + frac * (legs[leg]?.distanceM ?? 0)
}

/** The stretches of [0, total] no successful search reached, merged. */
function unsearched(reached: Sample[], totalM: number): [number, number][] {
  const iv = reached
    .map((s) => [Math.max(0, s.atM - s.radiusM), Math.min(totalM, s.atM + s.radiusM)] as [number, number])
    .sort((a, b) => a[0] - b[0])
  const gaps: [number, number][] = []
  let edge = 0
  for (const [a, b] of iv) {
    if (a - edge > MIN_GAP_M) gaps.push([edge, a])
    edge = Math.max(edge, b)
  }
  if (totalM - edge > MIN_GAP_M) gaps.push([edge, totalM])
  return gaps
}

/**
 * At most `limit` places, SPREAD ALONG THE ROUTE rather than the nearest dozen to
 * the road. On a long route the nearest twelve can all be in one town, and a list
 * with nothing past mile 80 reads as a road with nothing past mile 80. So the route
 * is cut into `bands` equal stretches and each gives up its best place in turn, in
 * the rider's favor/avoid order.
 */
function spread(ranked: Found[], bands: number, totalTrackM: number, limit: number): Found[] {
  const n = Math.max(1, bands)
  const queues: Found[][] = Array.from({ length: n }, () => [])
  for (const f of ranked) {
    const b = totalTrackM > 0 ? Math.min(n - 1, Math.floor((f.trackM / totalTrackM) * n)) : 0
    queues[b].push(f)
  }
  const out: Found[] = []
  while (out.length < limit && queues.some((q) => q.length)) {
    for (const q of queues) {
      const f = q.shift()
      if (f) out.push(f)
      if (out.length >= limit) break
    }
  }
  return out
}

const ERROR_WORDS: Record<PlacesError, string> = {
  unconfigured: 'place search is not configured',
  unreachable: 'Google could not be reached',
  blocked: 'the server key is not allowed to use Places',
  rejected: 'Google rejected the request',
}

export const findAlongRoute = tool({
  name: 'find_along_route',
  cap: { mutates: false, needs: 'view', spends: { search: ALONG_ROUTE_MAX_SEARCHES } },
  description: `Find places of one kind ALONG a whole route (“gas station”, “coffee”, “motel”), the way the builder’s Along the route search does: Google is searched at several points down the road and only places within corridor_mi of the road are kept. Returns up to ${MAX_ALONG_RESULTS} places spread along the route, each with coordinates you can pass to add_stop, how far off the road it is, roughly how far along the route, and the two points it falls between (use the first as after_point_uid). Uses up to ${ALONG_ROUTE_MAX_SEARCHES} place searches. It says which stretches were NOT searched; a place there is unknown, not absent. Prefer this over search_places for anything “along the way”.`,
  schema: z
    .object({
      route_uid: z.string().min(1).max(12),
      query: z.string().min(2).max(100).describe('A kind of place, such as "gas station", "coffee" or "motel"'),
      corridor_mi: z
        .number()
        .min(1)
        .max(30)
        .optional()
        .describe(`How far off the road to look, in miles; default ${DEFAULT_CORRIDOR_MI}`),
    })
    .strict(),
  run: async (ctx, input) => {
    if (!GMAPS_SERVER_KEY) return 'Place search is not configured on this server.'
    const route = ctx.ride.routes[routeIndex(ctx.ride, input.route_uid)]
    const name = `“${route.title || 'Untitled'}” [${route.uid}]`
    const u = ctx.units
    const corridorMi = input.corridor_mi ?? DEFAULT_CORRIDOR_MI
    const corridorM = corridorMi * METERS_PER_MILE
    const width = u === 'mi' ? `${corridorMi} mi` : `${Math.round(corridorMi * 1.609344)} km`

    const { track, spans } = trackAndSpans(route.legs as { geometry: [number, number][] }[])
    const cum = cumulativeM(track as Track)
    const totalTrackM = cum[cum.length - 1] ?? 0
    if (track.length < 2 || !(totalTrackM > 0))
      return `Route ${name} has no road drawn yet, so there is nothing to search along. Use search_places near one of its points instead.`
    // A route whose legs carry no road distance (nothing has ever answered for them)
    // is measured along the drawn line instead, rather than every place being "at 0".
    const legM = route.legs.reduce((s, l) => s + l.distanceM, 0)
    const routeM = legM || totalTrackM
    const at = (trackM: number, leg: number | null = null) =>
      legM > 0 ? toRouteM(trackM, leg, spans, cum, route.legs) : trackM

    // CLAIM FIRST, THEN SHAPE. Each take() is checked against this call's ceiling, the
    // turn and the rider's day, so the count that succeeds is exactly what may be spent.
    const ideal = corridorSamples(totalTrackM, corridorM, ALONG_ROUTE_MAX_SEARCHES)
    let claimed = 0
    while (claimed < ideal.length && ctx.budget.take('search')) claimed++
    if (claimed === 0)
      return `The place-search budget for this turn (or today) is spent, so nothing along ${name} was searched. Nothing is known about what is there; say so rather than reporting that there is none.`
    const short = claimed < ideal.length
    const samples = short ? corridorSamples(totalTrackM, corridorM, claimed) : ideal
    const planned = samples
      .map((s) => ({ s, near: pointAtDistance(track as Track, s.atM) }))
      .filter((p): p is { s: Sample; near: [number, number] } => p.near != null)
    for (let i = planned.length; i < claimed; i++) ctx.budget.refund('search')

    ctx.progress(`Searching “${input.query}” along ${route.title || 'the route'}`)
    const answers = await Promise.all(
      planned.map((p) =>
        searchPlaces({ query: input.query, near: p.near, radiusM: p.s.radiusM, wide: true }, GMAPS_SERVER_KEY),
      ),
    )

    const reached: Sample[] = []
    const failed: { s: Sample; error: PlacesError }[] = []
    const full: Sample[] = []
    const seen = new Set<string>()
    const raw: PlaceHit[] = []
    answers.forEach((out, i) => {
      const s = planned[i].s
      if (!out.ok) {
        failed.push({ s, error: out.error })
        return
      }
      if (out.cached) ctx.budget.refund('search')
      reached.push(s)
      if (out.places.length >= MAX_CORRIDOR_RESULTS) full.push(s)
      // The circles overlap by design, and the proxy carries no place id, so a place
      // is the same place when its position and name are: the builder's rule.
      for (const p of out.places) {
        const key = `${p.lngLat[0]},${p.lngLat[1]}|${p.name}`
        if (seen.has(key)) continue
        seen.add(key)
        raw.push(p)
      }
    })

    if (reached.length === 0) {
      const why = [...new Set(failed.map((f) => ERROR_WORDS[f.error]))].join('; ')
      return `Every search along ${name} failed (${why}). Nothing is known about what is there; say so rather than reporting that there is none.`
    }

    const found: Found[] = withinCorridor(raw, track as Track, corridorM).map((h) => {
      const i = h.atIndex ?? 0
      const next = Math.min(i + 1, cum.length - 1)
      const trackM = cum[i] + (h.t ?? 0) * (cum[next] - cum[i])
      // `edgeForward` because nearestSegment() answers with a segment's LEADING vertex,
      // so at a joint the leg leaving it is the one the place sat beside (#266).
      const leg = legAtVertex(spans, i, true)
      return { ...h.place, offM: h.offRouteM ?? 0, trackM, alongM: at(trackM, leg), leg }
    })
    const ranked = rankPlaces(found, ctx.favor, ctx.avoid)
    const shown = spread(ranked, planned.length, totalTrackM, MAX_ALONG_RESULTS).sort((a, b) => a.alongM - b.alongM)

    // --- What was and was not searched ---
    const lines: string[] = []
    lines.push(
      `Along route ${name} (${dist(routeM, u)}): “${input.query}” within ${width} of the road, ${planned.length} search${planned.length === 1 ? '' : 'es'}.`,
    )
    const gaps = unsearched(reached, totalTrackM)
    if (gaps.length === 0) {
      lines.push(
        failed.length
          ? `Coverage: every stretch was within reach of a search that answered, though ${failed.length} search${failed.length === 1 ? '' : 'es'} failed (${[...new Set(failed.map((f) => ERROR_WORDS[f.error]))].join('; ')}), so a stretch may hold more than is listed.`
          : 'Coverage: the whole route was searched.',
      )
      if (short)
        lines.push(
          `(With ${planned.length} of the ${ideal.length} searches it would normally use, because the search budget is short, so each search covered more road and a busy stretch may hold more than is listed.)`,
        )
    } else {
      const why: string[] = []
      if (failed.length)
        why.push(
          `${failed.length} search${failed.length === 1 ? '' : 'es'} failed (${[...new Set(failed.map((f) => ERROR_WORDS[f.error]))].join('; ')})`,
        )
      if (!samplesCoverAll(samples, totalTrackM))
        why.push(
          short
            ? `the search budget for this turn (or today) allowed only ${planned.length} search${planned.length === 1 ? '' : 'es'}, too few to reach end to end`
            : `the route is too long for ${planned.length} searches to reach end to end`,
        )
      const where = gaps.map(([a, b]) => stretch(at(a), at(b), u)).join(', ')
      lines.push(
        `Coverage: PARTIAL. Not searched: ${where} from the start of the route, because ${why.join(' and ')}. What is on those stretches is unknown, not absent; do not tell the rider there is nothing there.`,
      )
    }
    if (full.length) {
      const where = full.map((s) =>
        stretch(at(Math.max(0, s.atM - s.radiusM)), at(Math.min(totalTrackM, s.atM + s.radiusM)), u),
      )
      lines.push(
        `Google returned its maximum of ${MAX_CORRIDOR_RESULTS} results around ${where.join(', ')}, so there may be more there than listed.`,
      )
    }
    const undrawn = route.legs.filter((l) => l.durationS <= 0 && l.distanceM > 0).length
    if (undrawn)
      lines.push(
        `${undrawn} leg${undrawn === 1 ? ' is' : 's are'} not drawn yet, so the corridor follows a straight line there, not the road.`,
      )

    // --- What was found ---
    lines.push('')
    if (found.length === 0) {
      lines.push(
        gaps.length
          ? `None found within ${width} of the stretches that were searched. That says nothing about the stretches that were not.`
          : `None found within ${width} of this route.`,
      )
      return lines.join('\n')
    }
    lines.push(
      found.length > shown.length
        ? `${found.length} places in the corridor; ${shown.length} shown, spread along the route, in order from the start:`
        : `${found.length} place${found.length === 1 ? '' : 's'} in the corridor, in order from the start:`,
    )
    const pt = (i: number) => {
      const p = route.points[i]
      return p ? `“${p.name || 'Unnamed'}” [${p.uid}]` : null
    }
    shown.forEach((f, i) => {
      const a = f.leg != null ? pt(f.leg) : null
      const b = f.leg != null ? pt(f.leg + 1) : null
      const between = a && b ? ` · between ${a} and ${b}` : ''
      const list = matchesAny(f, ctx.favor)
        ? ' (on the rider’s favor list)'
        : matchesAny(f, ctx.avoid)
          ? ' (on the rider’s avoid list)'
          : ''
      lines.push(
        `${i + 1}. ${f.name}${f.address ? `, ${f.address}` : ''} (lat ${f.lngLat[1].toFixed(6)}, lng ${f.lngLat[0].toFixed(6)})${f.type ? ` [${f.type}]` : ''}${list} · ${dist(f.offM, u)} off the road · about ${whole(f.alongM, u)} ${u} along${between}`,
      )
    })
    lines.push('To add one, pass its lat and lng to add_stop with after_point_uid set to the first of the two points.')
    return lines.join('\n')
  },
})
