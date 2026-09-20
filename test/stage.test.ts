// The release-stage switch: every stage has every phrase, none of them says
// alpha, and the content files carry no stage sentence the module does not own.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { RELEASE_STAGE, RELEASE_STAGES, stage, stageTokens } from '../src/views/stage'

describe('the release stage', () => {
  it('is a beta', () => {
    expect(RELEASE_STAGES).toContain(RELEASE_STAGE)
    expect(stage().phase).toMatch(/beta$/)
  })

  it('has every phrase for every stage, and none of them says alpha', () => {
    for (const s of RELEASE_STAGES) {
      const p = stage(s)
      for (const [k, v] of Object.entries(p)) {
        expect(v, `${s}.${k}`).toMatch(/\S/)
        expect(v, `${s}.${k}`).not.toMatch(/alpha/i)
      }
      expect(p.phase).toMatch(/beta$/)
      expect(p.access).not.toMatch(/\.$/)
      expect(p.signup).toMatch(/^<p>/)
      expect(p.signup).toContain('href="/login"')
    }
  })

  it('names the tokens the content files use', () => {
    expect(Object.keys(stageTokens())).toEqual(['STAGE_PHASE', 'STAGE_ACCESS', 'STAGE_SIGNUP'])
    expect(stageTokens('public-beta').STAGE_PHASE).toBe('public beta')
  })

  // The sweep this module replaced. A sentence about the stage typed into a
  // content file or a template is the thing that goes stale on the next flip.
  it('is the only place rider-facing copy says which stage this is', () => {
    const files = [
      'src/content/faq.html',
      'src/content/terms.html',
      'src/content/privacy.html',
      'src/views/splash.tsx',
      'src/views/layout.tsx',
      'src/routes/auth.tsx',
      'src/routes/profile.tsx',
    ]
    for (const f of files) {
      const text = readFileSync(f, 'utf8').replace(/<!--[^]*?-->|\/\*[^]*?\*\/|^\s*\/\/.*$/gm, '')
      expect(text, f).not.toMatch(/closed (alpha|beta)|public beta|an alpha/i)
    }
    // Only the lede, and only "in beta": true of both beta stages.
    const notes = readFileSync('src/content/release-notes.html', 'utf8').replace(/<!--[^]*?-->/g, '')
    expect(notes.match(/closed alpha/g) ?? []).toHaveLength(0)
  })
})
