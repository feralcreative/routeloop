// The sign-in link.
//
// Migrated verbatim from the template literals that lived in auth/magic.ts. The
// wording is the copy of record in docs/ops/copy-inventory.md and is deliberately
// unchanged by the move — this template exists to prove the shell works against
// a message already in production, not to rewrite it.
//
// Note what it does NOT say: nothing about who the address belongs to, whether
// an account exists, or what happens next. requestMagicLink() mails every valid
// address identically so the endpoint cannot be used to discover who has an
// account, and copy that congratulated a known rider by name would give that
// away in the one place nobody thought to check.
import { defineEmail } from './types'
import { A, Button, Muted, P } from './shell'

type Props = { url: string }

// The curly apostrophe this line used to argue against.
//
// It was straight so that the migration off the old template literals produced a
// byte-identical message, and the comment here said typography was a separate
// decision to be taken for every template at once. That has now happened: all
// five carry real apostrophes, matching the rest of the rendered app.
//
// Single-quoted rather than double, because the apostrophe inside is now a
// character rather than a delimiter and the string no longer has to escape it.
const EXPIRY = 'This link works once and expires in 15 minutes. If you didn’t ask for it, ignore this email.'

export const magicLinkEmail = defineEmail<Props>({
  key: 'magic-link',

  subject: () => 'Your Routeloop sign-in link',

  preheader: () => 'Works once, expires in 15 minutes.',

  text: ({ url }) => ['Sign in to Routeloop:', '', url, '', EXPIRY].join('\n'),

  html: ({ url }) =>
    (
      <>
        <P>Sign in to Routeloop:</P>
        <Button href={url}>Sign in</Button>
        <Muted>
          Or paste this into your browser: <A href={url}>{url}</A>
        </Muted>
        <Muted>{EXPIRY}</Muted>
      </>
    ).toString(),

  // A syntactically real link, because the render tests assert every href is
  // absolute and a placeholder like 'https://example.com' would pass that while
  // hiding the shape of the actual value.
  sample: { url: 'https://routeloop.app/auth/magic/0123456789abcdef0123456789abcdef' },
})
