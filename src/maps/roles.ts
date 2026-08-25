// The canonical waypoint-role taxonomy — single source of truth.
//
// Replaces the three divergent alias tables of the legacy viewer (main.js
// marker pass, main.js route-table pass, README) with their union, plus two
// deliberate fixes: WTF now matches the literal "WTF", and CHARGE matches
// "CHARGER". The DB stores roles as first-class enum values (see
// waypointRoleEnum in src/db/schema.ts — keep the two lists in sync); the
// `ROLE - Name` / `GAS/FOOD - Name` string convention survives only at the
// import/export boundary, parsed and formatted here. Page shells inject
// ROLE_META as window.TB.roles so clients never duplicate this table.
export const ROLES = [
  'start',
  'finish',
  'home',
  'meet',
  'split',
  'gas',
  'charge',
  'break',
  'camp',
  'hotel',
  'food',
  'coffee',
  'drinks',
  'grocery',
  'view',
  'poi',
  'wtf',
] as const

export type Role = (typeof ROLES)[number]

export const MAX_ROLES_PER_POINT = 4 // matches the legacy slash-combining cap

// Aliases always include the canonical term itself, uppercase.
export const ROLE_META: Record<Role, { title: string; icon: string; aliases: string[] }> = {
  start: { title: 'Ride Start', icon: 'icon-start.svg', aliases: ['START', 'BEGIN'] },
  finish: { title: 'Ride End', icon: 'icon-finish.svg', aliases: ['FINISH', 'END'] },
  home: { title: 'Home', icon: 'icon-home.svg', aliases: ['HOME', 'HOUSE'] },
  meet: { title: 'Meet', icon: 'icon-meet.svg', aliases: ['MEET', 'MEETUP', 'MEETING', 'CONVERGE', 'JOIN'] },
  split: { title: 'Split', icon: 'icon-split.svg', aliases: ['SPLIT', 'DEPART', 'DIVERGE', 'LEAVE'] },
  gas: { title: 'Gas', icon: 'icon-gas.svg', aliases: ['GAS', 'FUEL'] },
  charge: { title: 'EV Charger', icon: 'icon-charge.svg', aliases: ['CHARGE', 'CHARGER'] },
  break: { title: 'Rest Break', icon: 'icon-break.svg', aliases: ['BREAK', 'REST'] },
  camp: { title: 'Campground', icon: 'icon-camp.svg', aliases: ['CAMP', 'CAMPGROUND', 'CAMPING', 'CAMPSITE'] },
  hotel: { title: 'Lodging', icon: 'icon-hotel.svg', aliases: ['HOTEL', 'LODGING', 'MOTEL', 'AIRBNB', 'SLEEP', 'STAY'] },
  food: { title: 'Food', icon: 'icon-food.svg', aliases: ['FOOD', 'LUNCH', 'DINNER', 'BREAKFAST'] },
  coffee: { title: 'Coffee', icon: 'icon-coffee.svg', aliases: ['COFFEE', 'CAFE'] },
  drinks: { title: 'Drinks', icon: 'icon-drinks.svg', aliases: ['DRINKS', 'BAR', 'COCKTAILS', 'BEER', 'BEERS'] },
  grocery: { title: 'Groceries', icon: 'icon-grocery.svg', aliases: ['GROCERY', 'GROCERIES'] },
  view: { title: 'Scenic Viewpoint', icon: 'icon-view.svg', aliases: ['VIEW', 'SCENIC', 'LOOKOUT', 'VIEWPOINT'] },
  // 'Sight' on screen, `poi` in code. Ziad's call, 2026-08-24: `poi` names a ROLE
  // here and a KIND on points.kind, and the two mean nearly opposite things — the
  // role is somewhere you stop to see something, the kind is somewhere you ride
  // past. The identifier keeps its name because renaming the enum value is a
  // migration over every stored point; the label is what a rider reads, and it is
  // free to fix. 'Sight' also pairs with 'Scenic Viewpoint' without repeating it:
  // a viewpoint is something you look AT, a sight is something you go SEE.
  poi: { title: 'Sight', icon: 'icon-poi.svg', aliases: ['POI', 'SIGHT', 'STOP'] },
  wtf: { title: 'Weird Random Shit', icon: 'icon-wtf.svg', aliases: ['WTF', 'WEIRD', 'RANDOM'] },
}

const ALIAS_TO_ROLE = new Map<string, Role>()
for (const role of ROLES) {
  for (const alias of ROLE_META[role].aliases) ALIAS_TO_ROLE.set(alias, role)
}

export function canonicalRole(term: string): Role | null {
  return ALIAS_TO_ROLE.get(term.trim().toUpperCase()) ?? null
}

// "GAS/FUEL - Chevron" → { roles: ['gas'], name: 'Chevron' } (dedup, cap 4).
// If no token before the first "-" canonicalizes, the raw text is the name.
export function parseRoleName(raw: string): { roles: Role[]; name: string } {
  const trimmed = raw.trim()
  const m = trimmed.match(/^([^-]*?)\s*-\s*(.*)$/s)
  if (m) {
    const roles: Role[] = []
    for (const token of m[1].split('/')) {
      const role = canonicalRole(token)
      if (role && !roles.includes(role)) roles.push(role)
      if (roles.length === MAX_ROLES_PER_POINT) break
    }
    if (roles.length > 0) return { roles, name: m[2].trim() }
  }
  return { roles: [], name: trimmed }
}

// (['gas','food'], 'Chevron') → 'GAS/FOOD - Chevron'; no roles → name as-is.
// The inverse of parseRoleName, used by exports so files round-trip through
// our own importer, Google Earth, and the documented README convention.
export function formatRoleName(roles: readonly Role[], name: string): string {
  if (roles.length === 0) return name
  return `${roles.map((r) => r.toUpperCase()).join('/')} - ${name}`
}
