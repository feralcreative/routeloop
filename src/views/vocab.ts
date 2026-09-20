// What the app calls things, as a rider's own choice (#321).
//
// ROUTELOOP IS FOR EVERY VEHICLE A RIDER OWNS — gas and electric motorcycles,
// cars, EVs, bicycles — and the copy assumed a motorcycle everywhere: ride,
// rider, bike, paddock, gas, tank. Ziad's call, 2026-09-13: the words are a
// preference. This file is the pure half — the terms, the presets, and the
// resolution — with no table and no DOM, the `volume.ts` shape.
//
// **PRESETS ARE VEHICLE × POWER, NOT A FLAT MOTO / CAR / EV LIST.** EV is a
// powertrain and not a vehicle: an electric-motorcycle rider still says Ride,
// Bike, Rider and Paddock, and only the fuel words change. So the Vehicle
// preset (motorcycle, car, bicycle) fills most rows and the Power preset (gas,
// electric, pedal) fills only the fuel family. A flat list would need Moto,
// E-moto, Car, EV, Bicycle, E-bike, and still have nowhere to put the next
// one.
//
// **PER RIDE, WITH THE RIDER'S OWN WORDS OVER THE TOP.** A ride carries its own
// vehicle and power (`rides.vehicle`, `rides.power`; null means unset, and each
// viewer reads the ride in their own default words — what every ride did
// before this existed), because a rider who owns a bike and a car plans rides
// for each. The
// rider's profile carries their default preset AND their Custom words, and the
// precedence is: the ride picks the preset, and a row the rider set to Custom is
// their word everywhere, whatever the ride. "Adventure" for journey is how they
// talk, not a fact about one ride. Ziad's call, 2026-09-13.
//
// **PEDAL HIDES THE FUEL FAMILY.** A bicycle has no tank to plan around, so a
// ride powered by pedaling renders no fuel word at all — `words.fuel` is null —
// and the surfaces that would use one (the range ring, the E markers, the Range
// button, the Fuel volume preference) read `off('fuel')` and stay away. Bicycle ×
// Gas is not a thing and is coerced to Pedal.
//
// **`highway` IS REGIONAL, NOT VEHICLE-BOUND, AND MAY BE PULLED OUT.** Motorway
// versus highway is a fact about where the rider lives, which is localization's
// question. It is a row here because the Avoid chip reads it today and
// localization is later; Ziad's caveat, 2026-09-13, is that real localization
// may take it back.
//
// **VARCHAR, NOT pgEnum**, for the reason `notifications.event` is: a new vehicle
// is a code change and nothing else. `toVehicle`/`toPower` are the validators
// every stored string goes through, so an unknown value renders the default.

export const VEHICLES = ['motorcycle', 'car', 'bicycle'] as const
export type Vehicle = (typeof VEHICLES)[number]
export const DEFAULT_VEHICLE: Vehicle = 'motorcycle'

export const POWERS = ['gas', 'electric', 'pedal'] as const
export type Power = (typeof POWERS)[number]
export const DEFAULT_POWER: Power = 'gas'

export const toVehicle = (v: unknown): Vehicle => (VEHICLES.includes(v as Vehicle) ? (v as Vehicle) : DEFAULT_VEHICLE)

/** Coerces a power, GIVEN THE VEHICLE: a bicycle does not run on gas, so that
 *  pair falls to pedal, and nothing but a bicycle pedals. */
export function toPower(p: unknown, vehicle: Vehicle): Power {
  const raw: Power = POWERS.includes(p as Power) ? (p as Power) : DEFAULT_POWER
  if (vehicle === 'bicycle') return raw === 'gas' ? 'pedal' : raw
  return raw === 'pedal' ? DEFAULT_POWER : raw
}

/** A word in both numbers. */
export type Word = { one: string; many: string }

/** The kind of preset a term follows: the vehicle, the power, or neither
 *  (regional, one row with radios and no preset filling it). */
export type Axis = 'vehicle' | 'power' | 'regional'

export type Term = {
  id: TermId
  /** The row's label on the settings page. */
  label: string
  /** One line under it: where the word shows up. */
  where: string
  axis: Axis
  /** The preset's word for each member of the axis; a power term omits pedal. */
  by: Partial<Record<Vehicle | Power, Word>>
  /** Regional terms carry their options here instead. */
  options?: Word[]
}

export const TERM_IDS = [
  'journey',
  'travel',
  'vehicle',
  'person',
  'storage',
  'curvy',
  'route',
  'roadbook',
  'fuel',
  'refuel',
  'tank',
  'station',
  'dry',
  'highway',
] as const
export type TermId = (typeof TERM_IDS)[number]

const w = (one: string, many = one + 's'): Word => ({ one, many })

/** The table. */
export const TERMS: Term[] = [
  {
    id: 'journey',
    label: 'The whole thing',
    where: '“Plan a ride”, “Your rides”, every card',
    axis: 'vehicle',
    by: { motorcycle: w('ride'), car: w('trip'), bicycle: w('ride') },
  },
  {
    id: 'travel',
    label: 'Moving',
    where: '“3h 33m riding”, “hours of riding”',
    axis: 'vehicle',
    by: { motorcycle: w('riding'), car: w('driving'), bicycle: w('pedaling') },
  },
  {
    id: 'vehicle',
    label: 'What you are on',
    where: 'the paddock, “no bike on file”',
    axis: 'vehicle',
    by: { motorcycle: w('bike'), car: w('car'), bicycle: w('bike') },
  },
  {
    id: 'person',
    label: 'Who is coming',
    where: 'the roster, “riders you follow”',
    axis: 'vehicle',
    by: { motorcycle: w('rider'), car: w('driver'), bicycle: w('rider') },
  },
  {
    id: 'storage',
    label: 'Where it lives',
    where: 'the Paddock tab',
    axis: 'vehicle',
    by: { motorcycle: w('paddock'), car: w('garage'), bicycle: w('shed') },
  },
  {
    id: 'curvy',
    label: 'A road with bends',
    where: 'the Prefer chip, the dashboard',
    axis: 'vehicle',
    by: { motorcycle: w('twisty', 'twisty'), car: w('twisty', 'twisty'), bicycle: w('twisty', 'twisty') },
  },
  {
    id: 'route',
    label: 'One day’s worth',
    where: 'route headers, “Route 1 of 3”',
    axis: 'vehicle',
    by: { motorcycle: w('route'), car: w('day'), bicycle: w('stage') },
  },
  {
    id: 'roadbook',
    label: 'The printable page',
    where: 'the viewer’s print link',
    axis: 'vehicle',
    by: { motorcycle: w('roadbook'), car: w('itinerary', 'itineraries'), bicycle: w('cue sheet') },
  },
  {
    id: 'fuel',
    label: 'What it runs on',
    where: '“fuel stop”, the Gas chip',
    axis: 'power',
    by: { gas: w('gas', 'gas'), electric: w('charge', 'charge') },
  },
  {
    id: 'refuel',
    label: 'Topping up',
    where: '“fill up here”',
    axis: 'power',
    by: { gas: w('fill up', 'fill up'), electric: w('charge', 'charge') },
  },
  {
    id: 'tank',
    label: 'What holds it',
    where: 'the paddock, “on this tank”',
    axis: 'power',
    by: { gas: w('tank'), electric: w('battery', 'batteries') },
  },
  {
    id: 'station',
    label: 'Where you get it',
    where: 'the search, meeting points',
    axis: 'power',
    by: { gas: w('gas station'), electric: w('charger') },
  },
  {
    id: 'dry',
    label: 'Running out',
    where: 'the E marker, tips',
    axis: 'power',
    by: { gas: w('runs dry', 'runs dry'), electric: w('goes flat', 'goes flat') },
  },
  {
    id: 'highway',
    label: 'The big road',
    where: 'the Avoid chip',
    axis: 'regional',
    by: {},
    options: [w('highway'), w('motorway'), w('freeway')],
  },
]

export const termById = (id: TermId): Term => TERMS.find((t) => t.id === id) as Term

/** The rider's own words, keyed by term — only the rows they set to Custom, or
 *  a regional row's pick. Stored as jsonb on the profile. */
export type Jargon = Partial<Record<TermId, string>>

/**
 * Coerces a stored or posted jargon object: unknown keys dropped, values
 * trimmed and capped, empty values dropped. Never throws — a hostile body
 * renders the presets.
 */
export function toJargon(v: unknown): Jargon {
  const out: Jargon = {}
  if (!v || typeof v !== 'object') return out
  for (const id of TERM_IDS) {
    const raw = (v as Record<string, unknown>)[id]
    if (typeof raw !== 'string') continue
    // LOWERCASE, because a word is used mid-sentence far more than it opens
    // one — "Plan a trip", "3 trips you were added to" — and cap() is what
    // capitalizes at the call sites that need it. A rider who types "Adventure"
    // in the box meant the word, not the capital.
    const s = raw.trim().slice(0, 40).toLowerCase()
    if (s) out[id] = s
  }
  return out
}

/**
 * A typed word, in both numbers. `person/people` after a slash is the plural;
 * otherwise `+s`, which is right for nearly every word a rider will type and
 * wrong for none they cannot fix with the slash.
 */
export function customWord(s: string): Word {
  const i = s.indexOf('/')
  if (i > 0) return { one: s.slice(0, i).trim(), many: s.slice(i + 1).trim() || s.slice(0, i).trim() }
  return w(s)
}

/** What a ride or a rider carries: the preset pair. */
export type Preset = { vehicle: Vehicle; power: Power }

/** What a profile carries: the default preset plus the rider's own words. */
export type Vocab = Preset & { jargon: Jargon }

/** The resolved words for one surface, keyed by term; a power term is null
 *  under pedal. Lowercase — capitalize at the call site with `cap()`. */
export type Words = Record<TermId, Word | null> & { vehicle_: Vehicle; power_: Power }

/**
 * Resolves the words for a surface. `ride` is the ride on screen, when there
 * is one; its non-null preset wins over the rider's default. A Custom word
 * wins over the preset either way (that is the precedence Ziad set), except
 * that pedal still blanks a fuel term — a bicycle rider who typed "juice" for
 * fuel has typed it for their e-bike, not for the pedal one.
 */
export function wordsFor(profile: Vocab, ride?: { vehicle?: string | null; power?: string | null } | null): Words {
  const vehicle = ride?.vehicle ? toVehicle(ride.vehicle) : profile.vehicle
  const power = toPower(ride?.power ?? profile.power, vehicle)
  const out = { vehicle_: vehicle, power_: power } as Words
  for (const t of TERMS) {
    const custom = profile.jargon[t.id]
    if (t.axis === 'power' && power === 'pedal') {
      out[t.id] = null
    } else if (custom) {
      out[t.id] = customWord(custom)
    } else if (t.axis === 'vehicle') {
      out[t.id] = t.by[vehicle] ?? null
    } else if (t.axis === 'power') {
      out[t.id] = t.by[power] ?? null
    } else {
      out[t.id] = t.options?.[0] ?? null
    }
  }
  return out
}

/** The default profile, for a signed-out visitor and for a rider with no row. */
export const DEFAULT_VOCAB: Vocab = { vehicle: DEFAULT_VEHICLE, power: DEFAULT_POWER, jargon: {} }

/** The profile's vocab off the session user (or any row carrying the three
 *  columns), coerced. Null user is the default. */
export function vocabOf(u: { vehicle?: unknown; power?: unknown; jargon?: unknown } | null | undefined): Vocab {
  if (!u) return DEFAULT_VOCAB
  const vehicle = toVehicle(u.vehicle)
  return { vehicle, power: toPower(u.power, vehicle), jargon: toJargon(u.jargon) }
}

/** The table as the client needs it — ids, axes and words, no labels. */
export const clientTerms = () => TERMS.map((t) => ({ id: t.id, axis: t.axis, by: t.by, options: t.options }))

export const cap = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s)

/** The four readers a template wants: singular, plural, and each capitalized.
 *  A blanked term (a fuel word under pedal) reads as an empty string, so a
 *  sentence built around one degrades to a gap rather than "null". */
export const wd = (w: Words, id: TermId): string => w[id]?.one ?? ''
export const wds = (w: Words, id: TermId): string => w[id]?.many ?? ''
export const Wd = (w: Words, id: TermId): string => cap(wd(w, id))
export const Wds = (w: Words, id: TermId): string => cap(wds(w, id))
/** One or many, by count. */
export const wn = (w: Words, id: TermId, n: number): string => (n === 1 ? wd(w, id) : wds(w, id))
/** With its indefinite article: "a ride", "an adventure", "an itinerary". */
export const aWd = (w: Words, id: TermId): string => an(wd(w, id))
export const an = (word: string): string => (/^[aeiou]/i.test(word) ? `an ${word}` : `a ${word}`)

/** The settings page's two pickers. */
export const VEHICLE_CHOICES: { id: Vehicle; label: string; example: string }[] = [
  { id: 'motorcycle', label: 'Motorcycle', example: 'ride, rider, bike, paddock' },
  { id: 'car', label: 'Car', example: 'trip, driver, car, garage' },
  { id: 'bicycle', label: 'Bicycle', example: 'ride, rider, bike, shed, no fuel' },
]
export const POWER_CHOICES: { id: Power; label: string; example: string }[] = [
  { id: 'gas', label: 'Gas', example: 'gas, tank, gas station' },
  { id: 'electric', label: 'Electric', example: 'charge, battery, charger' },
  { id: 'pedal', label: 'Pedal', example: 'nothing to plan fuel around' },
]
