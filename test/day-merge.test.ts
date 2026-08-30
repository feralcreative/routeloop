// Whose day wins when two riders save the same ride.
//
// The cases that matter are the two that look alike and need opposite answers:
// a day the client did not send because the rider DELETED it, and a day the
// client did not send because it did not exist when they loaded. Getting the
// second wrong means one rider's save silently deletes everything the other has
// added — which is the exact failure the whole merge exists to prevent, arriving
// through the fix for it.
import { describe, expect, it } from 'vitest'
import { mergeDays, storedUidsNeeded, type StoredDay } from '../src/maps/day-merge'

const stored = (...pairs: Array<[string, string | null]>): StoredDay[] => pairs.map(([uid, hash]) => ({ uid, hash }))

const takenFrom = (r: ReturnType<typeof mergeDays>, uid: string) => r.decisions.find((d) => d.uid === uid)?.take
const order = (r: ReturnType<typeof mergeDays>) => r.decisions.map((d) => d.uid)

describe('mergeDays', () => {
  it('takes the client version of a day nobody else touched', () => {
    const r = mergeDays(stored(['a', 'h1']), ['a'], { a: 'h1' })
    expect(takenFrom(r, 'a')).toBe('incoming')
    expect(r.superseded).toEqual([])
    expect(storedUidsNeeded(r)).toEqual([])
  })

  it('keeps the stored version of a day somebody else changed, and says so', () => {
    const r = mergeDays(stored(['a', 'h2']), ['a'], { a: 'h1' })
    expect(takenFrom(r, 'a')).toBe('stored')
    expect(r.superseded).toEqual(['a'])
    expect(storedUidsNeeded(r)).toEqual(['a'])
  })

  it('lets two riders edit different days without either losing anything', () => {
    // They each loaded {a:h1, b:h1}. The other rider has since saved b as h2.
    const r = mergeDays(stored(['a', 'h1'], ['b', 'h2']), ['a', 'b'], { a: 'h1', b: 'h1' })
    expect(takenFrom(r, 'a')).toBe('incoming')
    expect(takenFrom(r, 'b')).toBe('stored')
    expect(r.superseded).toEqual(['b'])
  })

  it('takes a day the client just created', () => {
    const r = mergeDays(stored(['a', 'h1']), ['a', 'new'], { a: 'h1' })
    expect(takenFrom(r, 'new')).toBe('incoming')
    expect(r.superseded).toEqual([])
  })

  // THE LEG THAT MAKES IT THREE-WAY. Without base, this day is indistinguishable
  // from one the rider deleted, and a two-way merge drops it.
  it('keeps a day another rider added while this one was working', () => {
    const r = mergeDays(stored(['a', 'h1'], ['theirs', 'h9']), ['a'], { a: 'h1' })
    expect(takenFrom(r, 'theirs')).toBe('stored')
    expect(r.adopted).toEqual(['theirs'])
  })

  it('honours a delete of a day nobody else had touched', () => {
    const r = mergeDays(stored(['a', 'h1'], ['gone', 'h1']), ['a'], { a: 'h1', gone: 'h1' })
    expect(order(r)).toEqual(['a'])
    expect(r.adopted).toEqual([])
  })

  // A delete aimed at an older version of a day loses to the edit. Keeping a day
  // somebody wanted gone is one click to undo; deleting work somebody just did
  // is not recoverable at all.
  it('refuses a delete of a day somebody else has since edited', () => {
    const r = mergeDays(stored(['gone', 'h2']), [], { gone: 'h1' })
    expect(takenFrom(r, 'gone')).toBe('stored')
    expect(r.adopted).toEqual(['gone'])
  })

  it('preserves the client ordering and appends what it adopts', () => {
    const r = mergeDays(stored(['a', 'h1'], ['b', 'h1'], ['late', 'h9']), ['b', 'a'], { a: 'h1', b: 'h1' })
    expect(order(r)).toEqual(['b', 'a', 'late'])
  })

  // The blue/green overlap: an old builder posts no base at all. Refusing here
  // would fail every save from the draining color.
  it('takes the client version when it sent no base for the day', () => {
    const r = mergeDays(stored(['a', 'h2']), ['a'], {})
    expect(takenFrom(r, 'a')).toBe('incoming')
    expect(r.superseded).toEqual([])
  })

  it('takes the client version when the stored day predates hashing', () => {
    const r = mergeDays(stored(['a', null]), ['a'], { a: 'h1' })
    expect(takenFrom(r, 'a')).toBe('incoming')
  })

  it('drops an unhashed day the client deleted rather than resurrecting it', () => {
    const r = mergeDays(stored(['gone', null]), [], { gone: 'h1' })
    expect(order(r)).toEqual([])
  })

  it('is a no-op shape for a ride with no days on either side', () => {
    const r = mergeDays([], [], {})
    expect(r.decisions).toEqual([])
    expect(r.superseded).toEqual([])
    expect(r.adopted).toEqual([])
  })

  // A save that changes nothing must not report a conflict, or an idle second
  // builder would tell its rider to reload every twenty seconds.
  it('reports nothing for a repeated identical save', () => {
    const one = mergeDays(stored(['a', 'h1'], ['b', 'h1']), ['a', 'b'], { a: 'h1', b: 'h1' })
    expect(one.superseded).toEqual([])
    expect(one.adopted).toEqual([])
    expect(storedUidsNeeded(one)).toEqual([])
  })
})
