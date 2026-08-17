// The feedback rules, as a table.
//
// Two of these matter more than the rest and are the reason the file exists.
//
// `visibleTo` IS the private-bug feature. There is no separate mechanism keeping
// a rider's bug report off the public board — only this function returning false
// for a report that is not published and not theirs. Getting it wrong publishes
// something a rider told us in confidence, and nothing about that is visible in
// review.
//
// `titleFrom` runs inside the submit transaction and its output is what the
// owner's queue is read by. It has to be total: a body it cannot summarize must
// still yield a string, because the alternative is losing the report.
//
// The rate limit, the vote uniqueness and every query are deliberately NOT here.
// SUBMIT_LIMIT is a number this file states and service.ts enforces with a
// count; one-want-per-rider is the composite primary key on feedback_votes, and
// Postgres is what tests it. This covers the policy.
import { describe, expect, it } from 'vitest'
import {
  areaFromPath,
  areaLabel,
  canModerate,
  canWant,
  frequencyLabel,
  impactLabel,
  isAreaId,
  isFrequencyId,
  isImpactId,
  KIND_META,
  KIND_ORDER,
  TITLE_MAX,
  titleFrom,
  visibleTo,
} from '../src/feedback/policy'
import type { ReportState, ViewerState } from '../src/feedback/policy'
import { feedbackKindEnum, feedbackStateEnum } from '../src/db/schema'

const AUTHOR: ViewerState = { id: 1, status: 'active', canManageRiders: false }
const STRANGER: ViewerState = { id: 2, status: 'active', canManageRiders: false }
const OWNER: ViewerState = { id: 3, status: 'active', canManageRiders: true }
const PENDING: ViewerState = { id: 4, status: 'pending', canManageRiders: false }

function report(over: Partial<ReportState> = {}): ReportState {
  return { authorId: 1, kind: 'idea', state: 'published', ...over }
}

describe('visibleTo', () => {
  // Every state, against every class of viewer. The point of the exhaustive
  // form is that adding a state to the enum without deciding who sees it shows
  // up as a failure here rather than as a leak.
  const states = feedbackStateEnum.enumValues

  it('shows a published report to anyone signed in', () => {
    for (const viewer of [AUTHOR, STRANGER, OWNER, PENDING]) {
      expect(visibleTo(report({ state: 'published' }), viewer)).toBe(true)
    }
  })

  it('shows the author their own report in every state', () => {
    for (const state of states) {
      expect(visibleTo(report({ state }), AUTHOR)).toBe(true)
    }
  })

  it('shows the owner everything in every state', () => {
    for (const state of states) {
      expect(visibleTo(report({ state }), OWNER)).toBe(true)
    }
  })

  it('hides every unpublished state from a stranger', () => {
    for (const state of states) {
      if (state === 'published') continue
      expect(visibleTo(report({ state }), STRANGER)).toBe(false)
    }
  })

  // The one that matters: a bug is private BECAUSE nothing publishes it, not
  // because of a flag on the row.
  it('keeps a pending bug away from everyone but its author and the owner', () => {
    const bug = report({ kind: 'bug', state: 'pending' })
    expect(visibleTo(bug, AUTHOR)).toBe(true)
    expect(visibleTo(bug, OWNER)).toBe(true)
    expect(visibleTo(bug, STRANGER)).toBe(false)
  })

  it('does not leak a spam or declined report to a stranger', () => {
    expect(visibleTo(report({ state: 'spam' }), STRANGER)).toBe(false)
    expect(visibleTo(report({ state: 'declined' }), STRANGER)).toBe(false)
    expect(visibleTo(report({ state: 'duplicate' }), STRANGER)).toBe(false)
  })
})

describe('canWant', () => {
  it('lets an active stranger want a published idea', () => {
    expect(canWant(report(), STRANGER)).toBe(true)
  })

  it('refuses the author, whose want is auto-cast at publish', () => {
    expect(canWant(report(), AUTHOR)).toBe(false)
  })

  it('refuses a rider who is not active', () => {
    expect(canWant(report(), PENDING)).toBe(false)
  })

  it('refuses every state but published', () => {
    for (const state of feedbackStateEnum.enumValues) {
      if (state === 'published') continue
      expect(canWant(report({ state }), STRANGER)).toBe(false)
    }
  })

  // Wants are an idea mechanism. A bug is not a thing riders vote for, and a
  // question even less so.
  it('refuses every kind but idea', () => {
    for (const kind of feedbackKindEnum.enumValues) {
      expect(canWant(report({ kind }), STRANGER)).toBe(kind === 'idea')
    }
  })

  it('lets the owner want another rider idea like anyone else', () => {
    expect(canWant(report(), OWNER)).toBe(true)
  })
})

describe('canModerate', () => {
  it('is exactly canManageRiders', () => {
    expect(canModerate(OWNER)).toBe(true)
    expect(canModerate(STRANGER)).toBe(false)
  })
})

describe('titleFrom', () => {
  it('takes the first sentence and drops its period', () => {
    expect(titleFrom('The map went white. It happened after I hit save.')).toBe('The map went white')
  })

  it('keeps a question mark, which carries meaning', () => {
    expect(titleFrom('Where did my day 3 go? It was there yesterday.')).toBe('Where did my day 3 go?')
  })

  it('keeps an exclamation mark', () => {
    expect(titleFrom('It lost everything! Two hours of planning.')).toBe('It lost everything!')
  })

  // The common shape: riders write one run-on line with no punctuation at all.
  it('returns a short unpunctuated body whole', () => {
    expect(titleFrom('map went white when I hit save')).toBe('map went white when I hit save')
  })

  it('cuts a long unpunctuated body at a word boundary', () => {
    const body =
      'I was planning a three day ride through the Cascades and the whole thing disappeared when I tapped save on the second day'
    const out = titleFrom(body)
    expect(out.length).toBeLessThanOrEqual(TITLE_MAX)
    expect(out.endsWith('…')).toBe(true)
    // A word boundary, not a chopped word.
    expect(body.startsWith(out.slice(0, -1))).toBe(true)
    expect(out).not.toMatch(/\s…$/)
  })

  // No boundary to find, so it is cut hard rather than returned whole — a title
  // longer than the budget defeats the point of having one.
  it('hard-cuts a single word longer than the budget', () => {
    const out = titleFrom('a'.repeat(200))
    expect(out.length).toBeLessThanOrEqual(TITLE_MAX)
    expect(out.endsWith('…')).toBe(true)
  })

  it('ignores a sentence break that lands past the budget', () => {
    const body = `${'word '.repeat(30)}. and then more`
    const out = titleFrom(body)
    expect(out.length).toBeLessThanOrEqual(TITLE_MAX)
  })

  it('flattens leading whitespace and newlines', () => {
    expect(titleFrom('\n\n   the map   went\n white  ')).toBe('the map went white')
  })

  it('is total: empty and whitespace-only bodies return a string', () => {
    expect(titleFrom('')).toBe('')
    expect(titleFrom('   \n\t ')).toBe('')
  })

  it('handles the column maximum without exceeding the title budget', () => {
    expect(titleFrom('x'.repeat(4000)).length).toBeLessThanOrEqual(TITLE_MAX)
  })

  it('is deterministic', () => {
    const body = 'The map went white. Twice.'
    expect(titleFrom(body)).toBe(titleFrom(body))
  })
})

describe('areaFromPath', () => {
  it('maps the builder to planning and the viewer to map', () => {
    expect(areaFromPath('/build')).toBe('planning')
    expect(areaFromPath('/build/abc123')).toBe('planning')
    expect(areaFromPath('/m/abc123')).toBe('map')
    expect(areaFromPath('/m/abc123/roadbook')).toBe('map')
  })

  it('ignores a query string and a fragment', () => {
    expect(areaFromPath('/build?day=2#top')).toBe('planning')
  })

  it('ignores a trailing slash', () => {
    expect(areaFromPath('/rides/')).toBe('my_rides')
  })

  // Inference, not truth. Null is always safe: the flow falls back to the cold
  // chip group and asks.
  it('returns null for a path it does not know', () => {
    expect(areaFromPath('/')).toBe(null)
    expect(areaFromPath('/board')).toBe(null)
    expect(areaFromPath('/nonsense/deep/path')).toBe(null)
  })

  it('never returns an id that is not offered', () => {
    for (const p of ['/build', '/m/x', '/rides', '/import', '/account', '/login']) {
      const id = areaFromPath(p)
      expect(id === null || isAreaId(id)).toBe(true)
    }
  })
})

describe('label lookups', () => {
  // Every one of these is called on a stored value, so an id that is no longer
  // offered must come back null rather than throw. A queue that 500s on one old
  // row is worse than a queue with one blank cell.
  it('return null for null and for an unknown id', () => {
    expect(areaLabel(null)).toBe(null)
    expect(areaLabel('gone')).toBe(null)
    expect(frequencyLabel(null)).toBe(null)
    expect(frequencyLabel('gone')).toBe(null)
    expect(impactLabel(null)).toBe(null)
    expect(impactLabel('gone')).toBe(null)
  })

  it('resolve every offered id', () => {
    expect(areaLabel('planning')).toBe('Planning a route')
    expect(frequencyLabel('every_time')).toBe('Every time')
    expect(impactLabel('every_ride')).toBe('I work around this every single ride')
  })

  it('guard functions reject non-strings', () => {
    for (const bad of [null, undefined, 3, {}, []]) {
      expect(isAreaId(bad)).toBe(false)
      expect(isFrequencyId(bad)).toBe(false)
      expect(isImpactId(bad)).toBe(false)
    }
  })
})

describe('KIND_META', () => {
  it('covers the enum exhaustively and in a fixed order', () => {
    expect([...KIND_ORDER].sort()).toEqual([...feedbackKindEnum.enumValues].sort())
    for (const kind of feedbackKindEnum.enumValues) {
      expect(KIND_META[kind]).toBeDefined()
    }
  })

  // The prompt is the heading on the only required screen. A blank one is a
  // screen with a textarea and no question above it.
  it('gives every kind a label, a blurb and a prompt', () => {
    for (const kind of feedbackKindEnum.enumValues) {
      const m = KIND_META[kind]
      expect(m.label.length).toBeGreaterThan(0)
      expect(m.blurb.length).toBeGreaterThan(0)
      expect(m.prompt.length).toBeGreaterThan(0)
    }
  })

  it('opens wants for ideas only', () => {
    expect(KIND_META.idea.wantable).toBe(true)
    expect(KIND_META.bug.wantable).toBe(false)
    expect(KIND_META.question.wantable).toBe(false)
  })

  // Frequency is a bug question and impact is an idea question. Asking either of
  // the other kind produces an answer nothing reads.
  it('asks frequency of bugs only and impact of ideas only', () => {
    for (const kind of feedbackKindEnum.enumValues) {
      expect(KIND_META[kind].asksFrequency).toBe(kind === 'bug')
      expect(KIND_META[kind].asksImpact).toBe(kind === 'idea')
      expect(KIND_META[kind].asksContext).toBe(kind === 'idea')
    }
  })
})
