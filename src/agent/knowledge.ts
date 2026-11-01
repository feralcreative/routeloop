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
  'group-riding':
    'Riding as a group: pace, regrouping, leader and sweep, passing, separation plans, and setting expectations.',
  'trip-prep':
    'Preparing the bike and the rider: maintenance before a trip, what to carry, papers, keys, and contacts.',
  'borders-laws-lodging':
    'Mexico and Canada, state laws that change at the line, national park entry rules, lodging, camping, and rally weeks.',
} as const

export type Topic = keyof typeof TOPICS
export const TOPIC_NAMES = Object.keys(TOPICS) as [Topic, ...Topic[]]

/**
 * WHAT A TOPIC IS AND HOW FAR TO TRUST IT, from the file's front matter:
 *
 *   ---
 *   kind: app            (describes Routeloop; checked against the code)
 *   kind: riding         (rules of thumb about riding)
 *   checked: 2026-10-31  (app: the date it was last checked against the code)
 *   reviewed: 2026-11-02 (riding: the date Ziad reviewed it, or `pending`)
 *   ---
 *
 * topicText() opens every topic with one line built from it, so the model knows
 * whether it is reading a description of the app or rules of thumb, and how old.
 */
export type TopicMeta = { kind: 'app'; checked: string } | { kind: 'riding'; reviewed: string | 'pending' }

const DATE = /^\d{4}-\d{2}-\d{2}$/

export function parseTopic(raw: string): { meta: TopicMeta | null; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(raw)
  if (!m) return { meta: null, body: raw.trim() }
  const fields = Object.fromEntries(
    m[1].split('\n').map((l) => {
      const at = l.indexOf(':')
      return [l.slice(0, at).trim(), l.slice(at + 1).trim()]
    }),
  )
  const body = raw.slice(m[0].length).trim()
  if (fields.kind === 'app' && DATE.test(fields.checked ?? ''))
    return { meta: { kind: 'app', checked: fields.checked }, body }
  if (fields.kind === 'riding' && (fields.reviewed === 'pending' || DATE.test(fields.reviewed ?? '')))
    return { meta: { kind: 'riding', reviewed: fields.reviewed }, body }
  return { meta: null, body }
}

export function aboutLine(meta: TopicMeta): string {
  if (meta.kind === 'app')
    return `About this topic: it describes Routeloop as checked against the app on ${meta.checked}.`
  if (meta.reviewed === 'pending')
    return 'About this topic: rules of thumb drafted from research and Ziad’s own trip notes, not yet reviewed by Ziad. Present every number as a rule of thumb, never as a current fact.'
  return `About this topic: rules of thumb reviewed by Ziad on ${meta.reviewed}. They are still rules of thumb, not current facts.`
}

const read = (name: string): string => readFileSync(join(DIR, `${name}.md`), 'utf8').trim()

/** The always-present part, for the system prompt and the MCP instructions. */
export const CORE = parseTopic(read('core')).body

const cache = new Map<Topic, string>()

export function topicText(topic: Topic): string {
  let text = cache.get(topic)
  if (text === undefined) {
    const { meta, body } = parseTopic(read(topic))
    text = meta ? `${aboutLine(meta)}\n\n${body}` : body
    cache.set(topic, text)
  }
  return text
}

/** For the test that every topic carries valid front matter. */
export const topicMeta = (topic: Topic): TopicMeta | null => parseTopic(read(topic)).meta
