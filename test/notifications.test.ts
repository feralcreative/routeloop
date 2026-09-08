// The notification catalog and the preference rule.
//
// Pure, like everything under test/. The database half — `notify`, `savePrefs`,
// `claimPending` and the three sweep warnings — has no test and cannot have one
// here: `vitest.config.ts` is deliberately scoped to pure logic and CI runs no
// Postgres. What IS covered is the decision each of those makes before it
// touches a row, which is where the interesting failures are.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  CHANNELS,
  EVENTS,
  GROUPS,
  eventDef,
  eventsInGroup,
  isChannel,
  isEvent,
  type NotificationEvent,
} from '../src/notifications/catalog'
import { channelsFor, checkedKeys, defaultFor, enabledFor, prefMap, rowsFromForm } from '../src/notifications/policy'
import { ALL_EMAILS } from '../src/emails/index'

describe('the catalog', () => {
  it('has unique keys', () => {
    const keys = EVENTS.map((e) => e.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('files every event under a real group', () => {
    const groups = new Set(GROUPS.map((g) => g.id))
    for (const e of EVENTS) expect(groups.has(e.group)).toBe(true)
  })

  it('leaves no group empty', () => {
    // A group with no events renders as a heading over nothing, which reads as
    // a broken page rather than as an empty category.
    for (const g of GROUPS) expect(eventsInGroup(g.id).length).toBeGreaterThan(0)
  })

  it('renders every event exactly once across the groups', () => {
    // The settings page walks GROUPS and asks for each one's events, so an
    // event whose group is misfiled would be invisible — present in the
    // catalog, absent from the page, and impossible to switch off.
    const rendered = GROUPS.flatMap((g) => eventsInGroup(g.id).map((e) => e.key))
    expect(rendered.sort()).toEqual(EVENTS.map((e) => e.key).sort())
  })

  it('recognizes its own keys and nothing else', () => {
    for (const e of EVENTS) expect(isEvent(e.key)).toBe(true)
    expect(isEvent('ride_comments')).toBe(false)
    expect(isEvent('')).toBe(false)
    expect(isEvent(null)).toBe(false)
    expect(isEvent(42)).toBe(false)
  })

  it('answers with null for an event it does not know', () => {
    // Null rather than a throw: this is reached from the send path, and a
    // notification that cannot be described should be skipped rather than take
    // a request down with it.
    expect(eventDef('made_up')).toBeNull()
    expect(eventDef(EVENTS[0].key)?.key).toBe(EVENTS[0].key)
  })

  it('knows two channels and no others', () => {
    expect([...CHANNELS]).toEqual(['email', 'browser'])
    expect(isChannel('email')).toBe(true)
    expect(isChannel('browser')).toBe(true)
    expect(isChannel('sms')).toBe(false)
  })
})

describe('the defaults', () => {
  // The whole of Ziad's call, 2026-09-07, in two assertions.
  it('is email on and browser off', () => {
    expect(defaultFor('email')).toBe(true)
    expect(defaultFor('browser')).toBe(false)
  })

  it('gives a rider with no rows at all every default', () => {
    const prefs = prefMap([])
    for (const e of EVENTS) {
      expect(enabledFor(prefs, e.key, 'email')).toBe(true)
      expect(enabledFor(prefs, e.key, 'browser')).toBe(false)
    }
  })
})

describe('a rider’s stored answers', () => {
  it('overrides the default in both directions', () => {
    const prefs = prefMap([
      { event: 'ride_comment', channel: 'email', enabled: false },
      { event: 'ride_comment', channel: 'browser', enabled: true },
    ])
    expect(enabledFor(prefs, 'ride_comment', 'email')).toBe(false)
    expect(enabledFor(prefs, 'ride_comment', 'browser')).toBe(true)
  })

  it('leaves every other event on its default', () => {
    const prefs = prefMap([{ event: 'ride_comment', channel: 'email', enabled: false }])
    expect(enabledFor(prefs, 'ride_rsvp', 'email')).toBe(true)
    expect(enabledFor(prefs, 'ride_comment', 'browser')).toBe(false)
  })

  it('ignores a row naming an event this build has never heard of', () => {
    // The ordinary result of REMOVING an event from the catalog, which is what
    // makes that removal safe with no migration behind it: the orphaned rows
    // stop being consulted rather than being trusted or crashing a read.
    const prefs = prefMap([
      { event: 'a_retired_event', channel: 'email', enabled: false },
      { event: 'ride_comment', channel: 'telepathy', enabled: false },
    ])
    expect(prefs.size).toBe(0)
    expect(enabledFor(prefs, 'ride_comment', 'email')).toBe(true)
  })

  it('reports both channels for one event together', () => {
    const prefs = prefMap([{ event: 'new_follower', channel: 'browser', enabled: true }])
    expect(channelsFor(prefs, 'new_follower')).toEqual({ email: true, browser: true })
  })
})

describe('what a submitted form stores', () => {
  const rides = eventsInGroup('rides').map((e) => e.key) as NotificationEvent[]

  it('writes a row for every event the form carried, off ones included', () => {
    // THE WHOLE POINT. An unticked checkbox sends nothing, so "off" and "not on
    // this form" are the same absence — writing every submitted event is what
    // tells them apart, and a delete would put them back together.
    const rows = rowsFromForm(rides, new Set([`${rides[0]}:email`]))
    expect(rows.length).toBe(rides.length * 2)
    expect(rows.filter((r) => r.enabled).map((r) => `${r.event}:${r.channel}`)).toEqual([`${rides[0]}:email`])
  })

  it('writes nothing for an event on a different form', () => {
    // Saving the Rides group must not switch off the People group, which is
    // exactly what would happen if absence alone decided.
    const rows = rowsFromForm(rides, new Set())
    expect(rows.some((r) => r.event === 'new_follower')).toBe(false)
  })

  it('reads the ticked keys out of a body and drops the rest', () => {
    const checked = checkedKeys({
      'ride_comment:email': 'on',
      'ride_comment:browser': 'on',
      group: 'rides',
      'made_up:email': 'on',
      'ride_comment:telepathy': 'on',
      csrf: 'x',
    })
    expect([...checked].sort()).toEqual(['ride_comment:browser', 'ride_comment:email'])
  })

  it('survives a body with nothing recognizable in it', () => {
    // Hand-crafted junk is dropped rather than 400ing, the contract every other
    // settings handler follows.
    expect(checkedKeys({ group: 'rides' }).size).toBe(0)
    expect(checkedKeys({}).size).toBe(0)
  })
})

describe('every event actually sends', () => {
  // **READ AS TEXT, THE `test/faq-links.test.ts` ARRANGEMENT**, because nothing
  // here can call a sender: they all read tables. What this catches is the
  // failure that has no other symptom — an event added to the catalog, given a
  // row on the settings page and a switch a rider can toggle, that nothing in
  // the app ever raises. A control that does nothing is worse than no control,
  // and it would look completely correct in a browser.
  const sources = [
    'src/notifications/senders.ts',
    'src/friends/notify.ts',
    'src/feedback/notify.ts',
  ].map((f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'))
  const all = sources.join('\n')

  it('names every catalog event at a send site', () => {
    const missing = EVENTS.filter((e) => !all.includes(`event: '${e.key}'`)).map((e) => e.key)
    expect(missing).toEqual([])
  })

  it('sends nothing this build cannot describe', () => {
    // The mirror: a sender naming an event the catalog does not carry would be
    // a notification with no switch, which nobody could turn off.
    const sent = [...all.matchAll(/event: '([a-z_]+)'/g)].map((m) => m[1])
    expect(sent.length).toBeGreaterThan(0)
    for (const key of new Set(sent)) expect(isEvent(key)).toBe(true)
  })
})

describe('the emails behind the catalog', () => {
  it('registers every template the senders reach for', () => {
    // The registry is what test/emails.test.ts iterates, so a template imported
    // by a sender and missing from src/emails/index.ts is a message that ships
    // with none of the contract tests the other nine pass — no subject-length
    // check, no text arm, no escaping.
    const registered = new Set(ALL_EMAILS.map((t) => t.key))
    const src = readFileSync(new URL('../src/notifications/senders.ts', import.meta.url), 'utf8')
    const imported = [...src.matchAll(/from '\.\.\/emails\/([a-z-]+)'/g)].map((m) => m[1])
    expect(imported.length).toBeGreaterThan(0)
    for (const key of imported) expect(registered.has(key)).toBe(true)
  })
})
