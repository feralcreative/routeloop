// The assistant's knowledge pack: what Routeloop is, how to tell a ride is ready
// to ride, and how to plan one. Plain markdown in src/agent/knowledge/, so the
// owner can edit it without touching code.
//
// ONE SOURCE, THREE DOORS. core.md is in the cached system prompt of the builder's
// assistant and is the MCP server's `instructions`; every other file is a topic,
// served by the `guide` tool on both surfaces and as an MCP resource. A topic is
// read only when the model asks for it, because pasting all of them into every
// free-tier turn would cost far more than the answers they improve.
//
// Read from the app root like src/content/, which is where the process runs both
// in dev and in the image. core.md is read at import, so a missing file fails at
// boot rather than on a rider's first question; test/agent-knowledge.test.ts
// holds that every topic below has a file and every file has a topic.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const DIR = join(process.cwd(), 'src', 'agent', 'knowledge')

/** Every topic `guide` serves, with the line the model reads to choose one. */
export const TOPICS = {
  'ready-to-ride':
    'The pre-ride checklist: everything to check before a ride is ready to ride, in order of what strands riders first, and how to check each.',
  builder:
    'How a ride is shaped and edited in Routeloop: routes, legs, stops, POIs, shaping points, categories, alternates, times, saving, and the limits.',
  'map-warnings':
    'Every warning on the map and timeline (fuel range ring, E markers, dry stretch, stop-by band, road reports, conditions, twistiness) and what to do about each.',
  'groups-and-riders':
    'Groups, meeting points, splits, who rides which route, the roster, permissions, votes, suggestions, comments, visibility, and the Paddock.',
  'riding-it':
    'Import and export formats, the ride page, the roadbook, the On the road page and Google Maps links, Keep on this phone, sharing, and the recycle bin.',
  'account-and-app':
    'Notifications, account settings tab by tab, the AI features and their limits, the dashboard, Explore, saved places, the tour, and feedback.',
  pacing: 'How far and how long to ride in a day, breaks, meals, rest days, and how group size changes all of it.',
  'fuel-and-charging':
    'Fuel and charge margins, group fuel stops, long gaps between stations, what costs range, and electric vehicles.',
  'weather-and-seasons':
    'Temperature limits for riding, wind chill, elevation, heat, rain, storms, wind, dusk and wildlife, and seasonal mountain passes.',
  'group-riding': 'Riding as a group: pace, regrouping, leader and sweep, passing, separation plans, and setting expectations.',
  'trip-prep': 'Preparing the bike and the rider: maintenance before a trip, what to carry, papers, keys, and contacts.',
  'borders-laws-lodging':
    'Mexico and Canada, state laws that change at the line, national park entry rules, lodging, camping, and rally weeks.',
} as const

export type Topic = keyof typeof TOPICS
export const TOPIC_NAMES = Object.keys(TOPICS) as [Topic, ...Topic[]]

const read = (name: string): string => readFileSync(join(DIR, `${name}.md`), 'utf8').trim()

/** The always-present part, for the system prompt and the MCP instructions. */
export const CORE = read('core')

const cache = new Map<Topic, string>()

export function topicText(topic: Topic): string {
  let text = cache.get(topic)
  if (text === undefined) {
    text = read(topic)
    cache.set(topic, text)
  }
  return text
}
