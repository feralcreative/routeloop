// The /brand page reads the palette out of the SCSS rather than restating it,
// so these assertions guard the parse. A silent miss here does not crash the
// page — it just quietly drops a token from the design system's only inventory,
// which is the failure mode the page exists to prevent.
import { describe, expect, it } from 'vitest'
import { contrast, findLiterals, parseTokens } from '../src/views/tokens'

describe('parseTokens', () => {
  it('reads a plain declaration', () => {
    const [t] = parseTokens('$url: #1565c0;')
    expect(t.name).toBe('url')
    expect(t.value).toBe('#1565c0')
    expect(t.isColor).toBe(true)
  })

  // $brand and $ride are both aliases of $url. Showing the swatch as the
  // literal while keeping the alias visible is the point: two names pointing at
  // one color is exactly the sort of thing a trim pass wants to see.
  it('follows an alias to its literal but keeps the raw text', () => {
    const [, brand] = parseTokens('$url: #1565c0;\n$brand: $url;')
    expect(brand.value).toBe('#1565c0')
    expect(brand.raw).toBe('$url')
  })

  it('carries the comment block above a declaration', () => {
    const [t] = parseTokens('// Amber reads as attention-needed\n// without the alarm of $kml.\n$pending: #b26a00;')
    expect(t.note).toBe('Amber reads as attention-needed without the alarm of $kml.')
  })

  // A blank line ends the block, so a file header does not attach itself to
  // whatever happens to be declared first. This is why _tokens.scss has a blank
  // line after its "Color Variables" heading.
  it('does not attach a heading separated by a blank line', () => {
    const [t] = parseTokens('// Color Variables\n\n$url: #1565c0;')
    expect(t.note).toBe('')
  })

  it('marks non-colors so the page can list them apart', () => {
    const out = parseTokens('$font: lato;\n$z-modal: 3000;\n$panel-bg: rgba(255, 255, 255, 0.9);')
    expect(out.map((t) => t.isColor)).toEqual([false, false, true])
  })
})

describe('findLiterals', () => {
  const tokens = parseTokens('$url: #1565c0;\n$grey: #ddd;')

  it('counts occurrences and records which files they are in', () => {
    const [hit] = findLiterals(
      [
        { name: '_a.scss', text: 'color: #777; border: 1px solid #777;' },
        { name: '_b.scss', text: 'color: #777;' },
      ],
      tokens,
    )
    expect(hit.value).toBe('#777777')
    expect(hit.count).toBe(3)
    expect(hit.files).toEqual(['_a.scss', '_b.scss'])
  })

  // #06c and #0066cc are the same color. Counting them separately would split
  // one finding into two and understate both.
  it('folds shorthand and longhand into one entry', () => {
    const out = findLiterals([{ name: '_a.scss', text: 'a { color: #06c; } b { color: #0066cc; }' }], tokens)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ value: '#0066cc', count: 2 })
  })

  it('names the token a literal duplicates', () => {
    const out = findLiterals([{ name: '_a.scss', text: 'color: #1565c0; border-color: #ddd;' }], tokens)
    expect(out.find((l) => l.value === '#1565c0')?.duplicates).toBe('url')
    // Shorthand in the token, longhand in the usage, still the same color.
    expect(out.find((l) => l.value === '#dddddd')?.duplicates).toBe('grey')
  })

  it('reports no token when there is none', () => {
    const out = findLiterals([{ name: '_a.scss', text: 'color: #777;' }], tokens)
    expect(out[0].duplicates).toBeNull()
  })
})

describe('contrast', () => {
  it('matches the WCAG reference values at the extremes', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5)
    expect(contrast('#ffffff', '#ffffff')).toBeCloseTo(1, 5)
  })

  it('is order-independent', () => {
    expect(contrast('#1565c0', '#ffffff')).toBeCloseTo(contrast('#ffffff', '#1565c0')!, 10)
  })

  it('returns null rather than a number for a value it cannot read', () => {
    expect(contrast('rgba(0, 0, 0, 0.18)', '#ffffff')).toBeNull()
  })
})
