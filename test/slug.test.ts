import { describe, expect, it } from 'vitest'
import { generateSlug, isSlug } from '../src/maps/slug'

// isSlug() is what lets /choose-name carry a ride into a redirect (#428), so its
// job is to refuse anything that could become somebody else's path.
describe('isSlug', () => {
  it('accepts what generateSlug makes', () => {
    for (let i = 0; i < 50; i++) expect(isSlug(generateSlug())).toBe(true)
  })

  it('refuses anything carrying a path, a scheme or an encoding', () => {
    for (const bad of ['', '/evil', '//evil.com', 'a/b', 'a.b', 'https:x', '%2F%2Fevil', 'a\\b', 'x'.repeat(23)]) {
      expect(isSlug(bad)).toBe(false)
    }
  })

  it('refuses a non-string', () => {
    expect(isSlug(undefined)).toBe(false)
    expect(isSlug(['abc'])).toBe(false)
  })
})
