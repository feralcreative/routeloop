// The owner's new-signup alert.
//
// Approval is a manual step with a person waiting on the other end of it, and
// until now the only way to discover a pending rider was to remember to open
// /admin. This is the message that closes that loop.
//
// It is the one email in the set written for a reader who is not a customer, so
// it is a notification rather than a piece of copy: the address is in the
// subject because that is what makes an inbox scannable and searchable, and the
// body is the four facts needed to decide, plus the link to act on them.
import { APP_ORIGIN } from '../config'
import { A, Button, Muted, P } from './shell'
import { defineEmail } from './types'

type Props = {
  /** The new rider's address. Untrusted — it reaches HTML, so it must be escaped,
   *  which is what makes JSX the right tool here rather than a template file. */
  email: string
  /** 'google' | 'email', from VerifiedIdentity. */
  provider: string
  /** How many riders are now waiting, this one included. */
  pendingCount: number
}

const ADMIN_URL = `${APP_ORIGIN}/admin`

// Subjects over ~78 characters get truncated by the client at a point you do not
// choose, and an address can be 255. Truncating here means the cut lands where
// it was decided rather than mid-domain in someone's list view.
const MAX_SUBJECT = 78
function subjectFor(email: string): string {
  const prefix = 'New RouteLoop signup: '
  const room = MAX_SUBJECT - prefix.length
  return prefix + (email.length <= room ? email : `${email.slice(0, room - 1)}…`)
}

export const ownerSignupEmail = defineEmail<Props>({
  key: 'owner-signup',

  subject: ({ email }) => subjectFor(email),

  preheader: ({ pendingCount }) =>
    pendingCount === 1 ? '1 rider waiting for approval.' : `${pendingCount} riders waiting for approval.`,

  text: ({ email, provider, pendingCount }) =>
    [
      `${email} just signed up for RouteLoop.`,
      '',
      `Signed in with: ${provider}`,
      `Waiting for approval: ${pendingCount}`,
      '',
      `Approve or block: ${ADMIN_URL}`,
    ].join('\n'),

  html: ({ email, provider, pendingCount }) =>
    (
      <>
        <P>
          <strong>{email}</strong> just signed up.
        </P>
        <P>
          Signed in with {provider}. {pendingCount === 1 ? '1 rider is' : `${pendingCount} riders are`} waiting for
          approval.
        </P>
        <Button href={ADMIN_URL}>Open the rider list</Button>
        <Muted>
          Reply to this message to reach them directly, or go to <A href={ADMIN_URL}>{ADMIN_URL}</A>.
        </Muted>
      </>
    ).toString(),

  sample: { email: 'new.rider@example.com', provider: 'google', pendingCount: 3 },
})
