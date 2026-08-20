// The rider-facing copy, pinned to the enum.
//
// This file exists for one failure: adding a status to feedback_status in
// schema.ts, shipping it, and rendering the raw enum value to a rider. "Your
// report is needs_info" is the kind of thing that gets noticed by the person it
// was written to, not by us.
//
// The second half is the vocabulary ban. Every word in BANNED_WORDS is either
// jargon a rider does not have or a judgment about the rider rather than the
// report, and the two that lose a rider permanently — "invalid" and "user
// error" — are both words an engineer reaches for without thinking. The test
// cannot police a view, so it polices the one table every view reads from.
import { describe, expect, it } from 'vitest'
import { BANNED_WORDS, KIND_META, STATUS_META, statusLabel } from '../src/feedback/policy'
import { feedbackKindEnum, feedbackStatusEnum } from '../src/db/schema'

describe('STATUS_META', () => {
  it('covers every status in the enum', () => {
    for (const status of feedbackStatusEnum.enumValues) {
      expect(STATUS_META[status], `no copy for status "${status}"`).toBeDefined()
    }
  })

  it('has no copy for a status that is not in the enum', () => {
    const known = new Set<string>(feedbackStatusEnum.enumValues)
    for (const key of Object.keys(STATUS_META)) {
      expect(known.has(key), `STATUS_META has "${key}" but the enum does not`).toBe(true)
    }
  })

  it('gives every status a non-empty label and sub-line', () => {
    for (const status of feedbackStatusEnum.enumValues) {
      const meta = STATUS_META[status]
      expect(meta.label.trim().length, `empty label for "${status}"`).toBeGreaterThan(0)
      expect(meta.sub.trim().length, `empty sub-line for "${status}"`).toBeGreaterThan(0)
    }
  })

  // A label that is a sentence is a label that wraps to three lines on a phone.
  it('keeps labels short enough to render on one line', () => {
    for (const status of feedbackStatusEnum.enumValues) {
      expect(statusLabel(status, 'bug').length, `label too long for "${status}"`).toBeLessThanOrEqual(40)
    }
  })

  it('never renders the raw enum value as its own label', () => {
    for (const status of feedbackStatusEnum.enumValues) {
      for (const kind of feedbackKindEnum.enumValues) {
        expect(statusLabel(status, kind)).not.toBe(status)
      }
    }
  })
})

describe('statusLabel', () => {
  // The one status whose news genuinely differs by kind: a bug is fixed, an idea
  // is built. Telling a rider their bug was "built" reads as a machine talking.
  it('says fixed for a bug and built for an idea', () => {
    expect(statusLabel('shipped', 'bug')).toBe('Fixed and live')
    expect(statusLabel('shipped', 'idea')).toBe('Built and live')
  })

  it('falls back to the shared label when a kind has no override', () => {
    for (const kind of feedbackKindEnum.enumValues) {
      expect(statusLabel('in_progress', kind)).toBe('In the shop')
    }
  })

  it('returns a string for every status and kind pair', () => {
    for (const status of feedbackStatusEnum.enumValues) {
      for (const kind of feedbackKindEnum.enumValues) {
        expect(typeof statusLabel(status, kind)).toBe('string')
      }
    }
  })
})

describe('the vocabulary ban', () => {
  // Assembled from every string a rider can read out of the policy module. If a
  // new copy table is added there, add it here too.
  function riderFacingStrings(): { where: string; text: string }[] {
    const out: { where: string; text: string }[] = []
    for (const status of feedbackStatusEnum.enumValues) {
      const meta = STATUS_META[status]
      out.push({ where: `STATUS_META.${status}.label`, text: meta.label })
      out.push({ where: `STATUS_META.${status}.sub`, text: meta.sub })
      for (const [kind, label] of Object.entries(meta.labelByKind ?? {})) {
        out.push({ where: `STATUS_META.${status}.labelByKind.${kind}`, text: label })
      }
    }
    for (const kind of feedbackKindEnum.enumValues) {
      const meta = KIND_META[kind]
      out.push({ where: `KIND_META.${kind}.label`, text: meta.label })
      out.push({ where: `KIND_META.${kind}.blurb`, text: meta.blurb })
      out.push({ where: `KIND_META.${kind}.prompt`, text: meta.prompt })
    }
    return out
  }

  // Matched on word boundaries, never as substrings. The ban is on the jargon
  // TOKEN: "repro" is banned, "We reproduced it" is plain English and is exactly
  // what we want a rider to read. A naive includes() fails that sentence, and
  // would fail "several" on "sev" too.
  function usesBannedWord(text: string): string | null {
    const flat = text.toLowerCase().replace(/[‘’]/g, "'")
    for (const word of BANNED_WORDS) {
      const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      if (new RegExp(`\\b${escaped}\\b`).test(flat)) return word
    }
    return null
  }

  it('holds across every rider-facing string in the policy module', () => {
    for (const { where, text } of riderFacingStrings()) {
      expect(usesBannedWord(text), `banned word in ${where}: "${text}"`).toBe(null)
    }
  })

  it('matches the token and not a word that merely contains it', () => {
    expect(usesBannedWord('We reproduced it. It is ours to fix.')).toBe(null)
    expect(usesBannedWord('There are several reports of this')).toBe(null)
    expect(usesBannedWord('No repro on our side')).toBe('repro')
    expect(usesBannedWord('Moved to the backlog')).toBe('backlog')
    expect(usesBannedWord('That is user error')).toBe('user error')
  })

  it('bans the two that lose a rider permanently', () => {
    expect(BANNED_WORDS).toContain('invalid')
    expect(BANNED_WORDS).toContain('user error')
  })

  it('is lowercase throughout, since matching is case-folded', () => {
    for (const word of BANNED_WORDS) {
      expect(word).toBe(word.toLowerCase())
    }
  })
})

describe('one motorcycle metaphor', () => {
  // The rule from docs/rider-feedback.md: at most one. "In the shop" is it.
  // A second turns the whole surface into mechanic cosplay, which reads as a
  // brand voice rather than as an answer.
  const METAPHORS = ['in the shop', 'kickstand', 'throttle', 'in the garage', 'on the rack', 'wrench']

  it('uses exactly one across every status label', () => {
    const labels = feedbackStatusEnum.enumValues.flatMap((s) =>
      feedbackKindEnum.enumValues.map((k) => statusLabel(s, k).toLowerCase()),
    )
    const used = METAPHORS.filter((m) => labels.some((l) => l.includes(m)))
    expect(used).toEqual(['in the shop'])
  })
})
