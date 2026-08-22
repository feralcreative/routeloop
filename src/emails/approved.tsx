// "You're in" — the message a rider has actually been waiting for.
//
// Before this existed, approval was silent: /admin flipped users.status and the
// rider found out by guessing, having been told on /welcome that they would "be
// able to sign in and start planning once yours comes up". This is the only
// email in the set that someone is waiting on, which is why it is also the only
// one with real idempotency machinery behind it (see users.approved_email_at and
// shouldSendApproval in ./rules).
//
// The display name IS used here, unlike the waitlist email — by this point the
// rider has been through /choose-name and picked one, so it is a name they gave
// rather than one derived from their address. It is still untrusted input and
// still escaped by JSX.
import { APP_ORIGIN } from '../config'
import { A, Button, Muted, P } from './shell'
import { defineEmail } from './types'

type Props = { displayName: string }

const LOGIN_URL = `${APP_ORIGIN}/login`
const BUILDER_URL = `${APP_ORIGIN}/builder`
const IMPORT_URL = `${APP_ORIGIN}/import`

export const approvedEmail = defineEmail<Props>({
  key: 'approved',

  subject: () => 'Your Routeloop account is approved',

  preheader: () => 'You’re in. Sign in and start planning.',

  text: ({ displayName }) =>
    [
      `You’re in, ${displayName}.`,
      '',
      'Your Routeloop account is approved, so you can sign in and start planning.',
      '',
      `Sign in: ${LOGIN_URL}`,
      '',
      'Two ways to start:',
      `  Plan a ride from scratch: ${BUILDER_URL}`,
      `  Import a route you already have (KML, GPX, GeoJSON, CSV): ${IMPORT_URL}`,
    ].join('\n'),

  html: ({ displayName }) =>
    (
      <>
        <P>You’re in, {displayName}.</P>
        <P>Your Routeloop account is approved, so you can sign in and start&nbsp;planning.</P>
        <Button href={LOGIN_URL}>Sign in</Button>
        <Muted>
          Two ways to start: <A href={BUILDER_URL}>plan a ride from scratch</A>, or{' '}
          <A href={IMPORT_URL}>import a route you already have</A>—KML, GPX, GeoJSON, or&nbsp;CSV.
        </Muted>
      </>
    ).toString(),

  sample: { displayName: 'Ziad' },
})
