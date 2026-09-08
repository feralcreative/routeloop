// The account deletion a rider asked for is about to happen.
//
// **SIGNING IN IS WHAT CANCELS IT, AND THE MESSAGE EXISTS TO SAY THAT ONCE MORE.**
// The rider was told the date when they asked, on a page they may not have read
// carefully, thirty days before it meant anything — and what happens on the date
// is that every ride, every saved place, every bike and every uploaded file is
// destroyed, with nothing to restore from. One reminder while it can still be
// stopped is the least this can do.
//
// **IT IS NOT A RETENTION EMAIL AND MUST NOT BECOME ONE.** No argument for
// staying, no list of what they will miss, no offer. They decided; this tells
// them the deadline and how to change their mind, and nothing else. A message
// that tries to talk somebody out of leaving is the reason people distrust the
// unsubscribe link on everything else.
//
// **THE CANCEL IS A SIGN-IN, NOT A LINK IN THIS MESSAGE.** A GET that cancels a
// deletion is a one-click undo handed to anyone who reads the mailbox, which for
// an account somebody is deliberately walking away from is exactly the wrong
// person to hand it to.
import { APP_ORIGIN } from '../config'
import { defineEmail } from './types'
import { A, Button, Muted, P } from './shell'

type Props = {
  /** How many days are left, as a whole number. */
  daysLeft: number
  /** The date, already formatted by the caller in the rider's own date format. */
  purgeOn: string
}

const SIGN_IN_URL = `${APP_ORIGIN}/login`

export const accountPurgeSoonEmail = defineEmail<Props>({
  key: 'account-purge-soon',

  subject: ({ daysLeft }) =>
    daysLeft === 1 ? 'Your Routeloop account is deleted tomorrow' : `Your Routeloop account is deleted in ${daysLeft} days`,

  preheader: () => 'Signing in cancels it. Doing nothing goes ahead with it.',

  text: ({ daysLeft, purgeOn }) =>
    [
      `You asked us to delete your account, and on ${purgeOn} we will — that is ${daysLeft === 1 ? 'tomorrow' : `${daysLeft} days from now`}.`,
      '',
      `Everything goes: every ride, every saved place, every bike, and every file you uploaded. There is nothing to restore from afterwards.`,
      '',
      `If you have changed your mind, sign in and the deletion is cancelled:`,
      SIGN_IN_URL,
      '',
      `If you have not, you need do nothing. This is the only reminder we will send.`,
    ].join('\n'),

  html: ({ daysLeft, purgeOn }) =>
    (
      <>
        <P>
          You asked us to delete your account, and on <b>{purgeOn}</b> we will — that is{' '}
          {daysLeft === 1 ? 'tomorrow' : `${daysLeft} days from now`}.
        </P>
        <P>
          Everything goes: every ride, every saved place, every bike, and every file you uploaded. There is nothing to
          restore from&nbsp;afterwards.
        </P>
        <Button href={SIGN_IN_URL}>Sign in to cancel it</Button>
        <Muted>
          Signing in at <A href={SIGN_IN_URL}>{SIGN_IN_URL}</A> is all it takes. If you have not changed your mind, you
          need do nothing — this is the only reminder we will&nbsp;send.
        </Muted>
      </>
    ).toString(),

  sample: {
    daysLeft: 7,
    purgeOn: '24-08-2026',
  },
})
