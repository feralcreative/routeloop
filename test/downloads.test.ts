// Which of two true answers a download gives back.
//
// An imported ride keeps the file it arrived as, and the download route prefers
// it — rightly, because it carries styling, folders and per-point detail this
// app does not model. Nothing rewrites that file when the builder saves and
// nothing clears it, so once a rider has re-cut the ride here the two answers
// disagree and one of them is out of date. originalIsCurrent() is the whole
// rule; this pins it, including the two readings of null that go opposite ways.
import { describe, expect, it } from 'vitest'
import { originalIsCurrent } from '../src/maps/downloads'

const at = (iso: string) => new Date(iso)
const IMPORTED = at('2026-08-01T10:00:00Z')

describe('originalIsCurrent', () => {
  it('keeps the stored original for a ride nobody has edited since importing it', () => {
    expect(originalIsCurrent({ originalStoredAt: IMPORTED, updatedAt: IMPORTED })).toBe(true)
  })

  it('drops it the moment the ride is saved from the builder', () => {
    // The bug in one line: an hour of re-cutting, and Export handing back the
    // pre-edit upload.
    expect(originalIsCurrent({ originalStoredAt: IMPORTED, updatedAt: at('2026-08-01T11:00:00Z') })).toBe(false)
  })

  it('reads NULL as current, not as stale', () => {
    // Null means nothing recorded the write. After the 0023 backfill that is
    // only true of a ride with NO stored original, and every caller checks
    // hasStored() first — so the direction never fires in practice. It matters
    // anyway: reading null as stale would hand the lossy generated file to any
    // row the backfill missed, silently, and those are the rides nobody looked
    // at.
    expect(originalIsCurrent({ originalStoredAt: null, updatedAt: at('2026-08-09T00:00:00Z') })).toBe(true)
  })

  it('does not treat a save one second later as a rewrite of the file', () => {
    // The comparison is <=, so equal timestamps are current. A ride whose
    // updated_at was stamped in the same transaction as the file — which is
    // every import — must not read as edited on the strength of a tie.
    expect(originalIsCurrent({ originalStoredAt: IMPORTED, updatedAt: IMPORTED })).toBe(true)
    expect(originalIsCurrent({ originalStoredAt: IMPORTED, updatedAt: at('2026-08-01T10:00:01Z') })).toBe(false)
  })

  it('treats a clock that went backwards as current rather than as an edit', () => {
    // An updated_at BEFORE the file was written is not a state the app can
    // reach; it is a restored backup or a clock skew. Answering with the file
    // the rider uploaded is the conservative half of a wrong pair.
    expect(originalIsCurrent({ originalStoredAt: IMPORTED, updatedAt: at('2026-07-01T00:00:00Z') })).toBe(true)
  })
})
