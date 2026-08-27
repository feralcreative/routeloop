// What a tally elects.
//
// The tie cases carry this file, because a tie is the ordinary state rather
// than the edge one — a three-member ride with two alternates ties the moment
// anybody abstains, and every ride ties at 0–0 on the day it is created. A rule
// that elected a winner from a tie would silently rewrite which road a ride
// takes, on no information, on a schedule.
import { describe, expect, it } from 'vitest'
import { dueToResolve, electWinner, hasVotes, votingOpen, type Tally } from '../src/votes/policy'

const t = (uid: string, votes: number, active = false): Tally => ({ uid, votes, active })

describe('electWinner', () => {
  it('elects a clear leader that is not already active', () => {
    expect(electWinner([t('aaaaaaaaaaaa', 3), t('bbbbbbbbbbbb', 1, true)])).toBe('aaaaaaaaaaaa')
  })

  it('returns null when the leader is already active, so the sweep writes nothing', () => {
    expect(electWinner([t('aaaaaaaaaaaa', 3, true), t('bbbbbbbbbbbb', 1)])).toBeNull()
  })

  it('leaves a tie alone', () => {
    expect(electWinner([t('aaaaaaaaaaaa', 2), t('bbbbbbbbbbbb', 2, true)])).toBeNull()
    // A three-way tie is the same answer, not a different rule.
    expect(electWinner([t('aaaaaaaaaaaa', 1), t('bbbbbbbbbbbb', 1), t('cccccccccccc', 1, true)])).toBeNull()
  })

  it('leaves a group nobody voted in alone', () => {
    expect(electWinner([t('aaaaaaaaaaaa', 0), t('bbbbbbbbbbbb', 0, true)])).toBeNull()
  })

  // No quorum, deliberately: two of five bothering to vote is an answer, and
  // "nothing happens" is indistinguishable from a broken tally.
  it('elects on a minority when the rest abstain', () => {
    expect(electWinner([t('aaaaaaaaaaaa', 2), t('bbbbbbbbbbbb', 0, true)])).toBe('aaaaaaaaaaaa')
  })

  it('has nothing to elect in a group of one', () => {
    expect(electWinner([t('aaaaaaaaaaaa', 5, true)])).toBeNull()
    expect(electWinner([])).toBeNull()
  })
})

describe('hasVotes', () => {
  it('is false for a group of zeroes, which must not render as a result', () => {
    expect(hasVotes([t('aaaaaaaaaaaa', 0), t('bbbbbbbbbbbb', 0)])).toBe(false)
    expect(hasVotes([t('aaaaaaaaaaaa', 0), t('bbbbbbbbbbbb', 1)])).toBe(true)
  })
})

const NOW = new Date('2026-08-26T12:00:00.000Z')
const at = (ms: number) => new Date(NOW.getTime() + ms)

describe('the deadline', () => {
  it('leaves a ride with no deadline open forever and never due', () => {
    expect(votingOpen(null, NOW)).toBe(true)
    expect(dueToResolve(null, NOW)).toBe(false)
  })

  it('closes and becomes due at the same instant', () => {
    expect(votingOpen(NOW, NOW)).toBe(false)
    expect(dueToResolve(NOW, NOW)).toBe(true)
  })

  it('is open right up to the deadline', () => {
    expect(votingOpen(at(1), NOW)).toBe(true)
    expect(dueToResolve(at(1), NOW)).toBe(false)
  })

  // A closed vote still shows its numbers. Someone arriving late should see what
  // was decided rather than an empty box.
  it('stays closed afterwards', () => {
    expect(votingOpen(at(-1), NOW)).toBe(false)
    expect(dueToResolve(at(-1), NOW)).toBe(true)
  })
})
