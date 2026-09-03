// What a day asks of the router, beyond where it goes.
//
// #29. A rider planning a Saturday in the hills and a Monday slog home wants two
// different answers from the same router, which is why this hangs off a DAY
// rather than off a ride: the transit day takes the interstate on purpose.
//
// **THIS IS THE HALF GOOGLE CAN ACTUALLY EXPRESS, AND THAT IS THE WHOLE SCOPE.**
// Routes API v2 takes `routeModifiers`, which covers tolls, highways and
// ferries — three things a rider can be spared. It has no notion of a scenic
// road, a surface type or a good corner, so nothing here pretends otherwise:
// #30 was closed because an unpaved preference is not expressible at all, and
// the prefer-the-fun-road half of #29 is #28, which is a different mechanism
// entirely (score the alternates Routes already returns and pick the twistiest).
// Naming a flag `preferScenic` here would have been a promise the router cannot
// keep.
//
// Pure and free of the database and of any Google client, so test/ can reach it
// under the house rule, and so the one mapping from our shape to theirs cannot
// be written twice.
import { z } from 'zod'

/**
 * A day's routing preferences.
 *
 * STRICT, because this is the one payload field whose value is stored as jsonb
 * rather than into a typed column — an open object would let a hostile save park
 * arbitrary keys in the row. Every member is optional and every absent member
 * means false; there is no explicit `false` to distinguish from an absent one,
 * which is what keeps two spellings of "no preference" from hashing differently
 * in dayRevision().
 */
export const routePrefsSchema = z
  .object({
    avoidHighways: z.boolean().optional(),
    avoidTolls: z.boolean().optional(),
    avoidFerries: z.boolean().optional(),
    // #28. NOT A ROUTE MODIFIER — see the two lists below. Google has no notion
    // of a fun road, so this is answered by asking for the alternates it already
    // computes and scoring them ourselves.
    preferTwisty: z.boolean().optional(),
  })
  .strict()

export type RoutePrefs = z.infer<typeof routePrefsSchema>

/**
 * TWO LISTS, AND CONFLATING THEM SENDS GOOGLE A FIELD IT REJECTS.
 *
 * `AVOID_FLAGS` are the three things Routes API v2's `routeModifiers` actually
 * accepts. `FLAGS` is everything a day can ask for, which is what normalizing,
 * hashing and cache-keying have to cover — `preferTwisty` changes the road that
 * comes back, so it belongs in all three of those and in none of the request's
 * modifiers.
 *
 * The order is fixed because prefsKey() joins it, and a key whose field order
 * moved would miss every entry written before it moved.
 */
const AVOID_FLAGS = ['avoidHighways', 'avoidTolls', 'avoidFerries'] as const
const FLAGS = [...AVOID_FLAGS, 'preferTwisty'] as const

/**
 * The preferences with nothing set, collapsed to null.
 *
 * NULL AND `{}` AND `{avoidTolls: false}` ARE ONE STATE AND MUST STORE AS ONE.
 * A day carrying `{}` and a day carrying null are the same day, and if they
 * reach dayRevision() as different strings then toggling a flag on and back off
 * makes a rider's next autosave conflict with a save nobody else made. This is
 * the only place that decision is taken.
 */
export function normalizePrefs(prefs: RoutePrefs | null | undefined): RoutePrefs | null {
  if (!prefs) return null
  const out: RoutePrefs = {}
  for (const f of FLAGS) if (prefs[f] === true) out[f] = true
  return Object.keys(out).length ? out : null
}

/**
 * Google's `routeModifiers`, or undefined when there is nothing to ask for.
 *
 * UNDEFINED RATHER THAN AN OBJECT OF FALSES, so a day with no preferences sends
 * the request it sent before this feature existed — byte for byte, which is what
 * keeps every already-cached route a hit rather than silently re-billing the
 * whole corpus on the deploy that lands this.
 */
export function toRouteModifiers(prefs: RoutePrefs | null | undefined): Record<string, boolean> | undefined {
  const norm = normalizePrefs(prefs)
  if (!norm) return undefined
  const out: Record<string, boolean> = {}
  // AVOID_FLAGS, never FLAGS: `preferTwisty` is ours and Routes would reject it.
  for (const f of AVOID_FLAGS) if (norm[f]) out[f] = true
  return Object.keys(out).length ? out : undefined
}

/**
 * Should this leg be routed by asking for alternates and picking the twistiest?
 *
 * Its own function rather than a field read at the call site, so the one place
 * that decides it is here beside everything else about a day's preferences.
 */
export function wantsTwisty(prefs: RoutePrefs | null | undefined): boolean {
  return normalizePrefs(prefs)?.preferTwisty === true
}

/**
 * A stable string for a cache key.
 *
 * THE ROUTE CACHE IS KEYED ON THE REQUEST, AND PREFERENCES ARE PART OF IT.
 * Without this an avoid-highways route and a plain one between the same two
 * points are the same key, so the first one answered wins and the toggle looks
 * broken while doing exactly what it was told. Empty for no preferences, so
 * every key predating the feature is unchanged.
 */
export function prefsKey(prefs: RoutePrefs | null | undefined): string {
  const norm = normalizePrefs(prefs)
  if (!norm) return ''
  return FLAGS.filter((f) => norm[f]).join(',')
}

/** A rider-facing summary, for the builder's day row. Empty when nothing is set. */
export function describePrefs(prefs: RoutePrefs | null | undefined): string {
  const norm = normalizePrefs(prefs)
  if (!norm) return ''
  const words: string[] = []
  if (norm.avoidHighways) words.push('highways')
  if (norm.avoidTolls) words.push('tolls')
  if (norm.avoidFerries) words.push('ferries')
  // Nothing to avoid, only something to prefer — a real state, and "Avoiding"
  // with an empty list would be a sentence about nothing.
  if (!words.length) return norm.preferTwisty ? 'Preferring the twistier road' : ''
  // "Avoiding highways and tolls" — the Oxford comma applies at three.
  const list =
    words.length <= 1
      ? words.join('')
      : words.length === 2
        ? `${words[0]} and ${words[1]}`
        : `${words.slice(0, -1).join(', ')}, and ${words[words.length - 1]}`
  return norm.preferTwisty ? `Avoiding ${list}, preferring the twistier road` : `Avoiding ${list}`
}
