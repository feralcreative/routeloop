// The contract every email has to satisfy, applied to all of them at once.
//
// This iterates ALL_EMAILS and renders each template with its own `sample`,
// which is the whole reason `sample` is on the type: a generic test can render
// every template without knowing any template's prop shape, so a new email is
// covered the moment it joins the registry rather than whenever someone
// remembers to write tests for it.
//
// None of this can check that a message LOOKS right — that needs a real client
// and stays a manual pass. What it checks is the set of mistakes that are
// invisible in review and fatal in an inbox: a relative href, markup pasted into
// the text arm, an unescaped name, a CTA that only exists as a button.
import { describe, expect, it } from 'vitest'
import { APP_ORIGIN } from '../src/config'
import { ALL_EMAILS } from '../src/emails/index'
import { renderEmail } from '../src/emails/shell'
import { esc } from '../src/views/esc'

const rendered = ALL_EMAILS.map((t) => ({ t, out: renderEmail(t, t.sample) }))

describe('the registry', () => {
  it('has templates in it', () => {
    expect(ALL_EMAILS.length).toBeGreaterThan(0)
  })

  it('has unique keys', () => {
    const keys = ALL_EMAILS.map((t) => t.key)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe.each(rendered)('$t.key', ({ t, out }) => {
  it('renders all three parts', () => {
    expect(out.subject.length).toBeGreaterThan(0)
    expect(out.text.length).toBeGreaterThan(0)
    expect(out.html.length).toBeGreaterThan(0)
  })

  // Long subjects are truncated by every client and the truncation point is not
  // yours to choose. 78 is the RFC 2822 recommended line length and a good deal
  // longer than any list view actually shows.
  it('has a single-line subject under 78 characters', () => {
    expect(out.subject).not.toMatch(/[\r\n]/)
    expect(out.subject.length).toBeLessThanOrEqual(78)
  })

  // The commonest way a text arm rots is someone copying a line over from the
  // HTML one.
  it('has a text arm with no markup in it', () => {
    expect(out.text).not.toMatch(/<[a-z/][^>]*>/i)
  })

  it('is a complete HTML document', () => {
    expect(out.html.startsWith('<!doctype html>')).toBe(true)
    expect(out.html.match(/<body/g)).toHaveLength(1)
    expect(out.html).toContain('max-width:600px')
  })

  // A <link> to a stylesheet is stripped by every major client, so anything
  // depending on one is invisible. http:// in a mail body trips mixed-content
  // and spam heuristics both.
  //
  // Two exemptions, both narrow. The XML namespace declarations in the <html>
  // tag are http: identifiers rather than links and are never fetched. And
  // APP_ORIGIN is legitimately http://127.0.0.1:6686 in development — it is
  // https in every deployed environment, which config.ts:24 depends on for the
  // Secure cookie flag, so a plaintext origin cannot reach a real inbox. What
  // this catches is a hardcoded http:// URL, which is the actual mistake.
  it('has no external stylesheet and no hardcoded http:// link', () => {
    expect(out.html).not.toContain('<link rel="stylesheet"')
    const insecure = [...out.html.matchAll(/http:\/\/[^"'\s<>]+/g)]
      .map((m) => m[0])
      .filter((u) => !u.includes('schemas-microsoft-com') && !u.startsWith(APP_ORIGIN))
    expect(insecure).toEqual([])
  })

  // Compared through esc() rather than raw, because the shell escapes the
  // preheader on the way in — so this asserts both that it is present and that
  // it went through escaping. A raw comparison passes only for preheaders that
  // happen to contain no apostrophe, which is a test that works by luck.
  it('shows its preheader, escaped, before the body', () => {
    expect(out.html).toContain(esc(t.preheader(t.sample)))
  })

  // The highest-value assertion here. Every view in this app writes site-relative
  // hrefs, so `/login` in an email template is the natural thing to type and is
  // a dead link in every inbox — there is no origin to resolve it against.
  it('has only absolute links', () => {
    const hrefs = [...out.html.matchAll(/href="([^"]*)"/g)].map((m) => m[1])
    expect(hrefs.length).toBeGreaterThan(0)
    for (const href of hrefs) expect(href, `relative href: ${href}`).toMatch(/^(https?:\/\/|mailto:)/)
  })

  // Scoped to the template's own body, not the rendered document: the header and
  // footer links are chrome and belong in the HTML arm alone. What must not
  // happen is a template putting its call to action in a button and nowhere
  // else, leaving a plain-text reader with no way to act on the message.
  it('repeats every body link in the text arm', () => {
    const body = t.html(t.sample)
    const urls = [...new Set([...body.matchAll(/href="(https?:\/\/[^"]+)"/g)].map((m) => m[1]))]
    for (const url of urls) expect(out.text, `${url} is in the HTML body but not the text arm`).toContain(url)
  })
})

// The reason src/emails/ is JSX and not src/content/*.html: content.ts
// substitutes tokens with a bare String() and no escaping at all, and these
// messages interpolate rider-supplied names and addresses.
describe('interpolated values are escaped', () => {
  const NASTY = '"><script>alert(1)</script> & Co'

  // Only string props that are not URL-shaped. A poisoned href would fail the
  // absolute-link assertion above for an unrelated reason, and the URLs in these
  // templates are all server-built anyway.
  const poison = (sample: unknown): unknown => {
    if (typeof sample !== 'object' || sample === null) return sample
    const out: Record<string, unknown> = { ...(sample as Record<string, unknown>) }
    for (const [k, v] of Object.entries(out)) {
      if (typeof v === 'string' && !/^https?:\/\//.test(v)) out[k] = NASTY
    }
    return out
  }

  for (const t of ALL_EMAILS) {
    const props = poison(t.sample)
    const stringProps = Object.values((t.sample ?? {}) as Record<string, unknown>).filter(
      (v) => typeof v === 'string' && !/^https?:\/\//.test(v),
    )
    // Templates whose props are all URLs have nothing to poison, and asserting
    // on them would pass vacuously and mean nothing.
    const test = stringProps.length > 0 ? it : it.skip

    test(`${t.key} escapes them`, () => {
      const { html } = renderEmail(t, props)
      expect(html).not.toContain('<script>')
      expect(html).toContain('&lt;script&gt;')
    })
  }
})
