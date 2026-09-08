// A ride in the bin is about to be destroyed for good.
//
// **THIS IS THE ONLY WARNING, AND IT IS THE ONLY ONE THAT CAN EXIST.** The purge
// is the one piece of code in the app that genuinely destroys a ride — row,
// routes, points and the stored original off disk — and nothing after it can be
// undone by anybody. A rider who binned something in March and forgot has thirty
// days of silence and then no ride.
//
// **IT NAMES THE RIDE RATHER THAN COUNTING THEM.** "3 rides will be destroyed" is
// a number a rider cannot act on without going and looking; the name is the
// thing that makes them remember whether they meant it. Several rides due in the
// same sweep are several messages, which is the correct noise level for
// something irreversible.
//
// Restoring is a POST behind requireSameOrigin, so this links to the bin rather
// than restoring from a GET — the same rule friend-request follows, and it
// matters more here, because a link that could be prefetched into a restore
// would silently un-bin rides for anybody whose mail client fetches links.
import { APP_ORIGIN } from '../config'
import { defineEmail } from './types'
import { A, Button, Muted, P } from './shell'

type Props = {
  rideTitle: string
  /** How many days are left, as a whole number. */
  daysLeft: number
  /** The date it goes, already formatted by the caller in the RECIPIENT'S own
   *  date format — src/emails/ is pure and the preference is a table read. */
  purgeOn: string
}

const BIN_URL = `${APP_ORIGIN}/trash`

export const ridePurgeSoonEmail = defineEmail<Props>({
  key: 'ride-purge-soon',

  subject: ({ rideTitle, daysLeft }) =>
    daysLeft === 1 ? `${rideTitle} is deleted for good tomorrow` : `${rideTitle} is deleted for good in ${daysLeft} days`,

  preheader: ({ purgeOn }) => `Restoring it from your bin before ${purgeOn} keeps it.`,

  text: ({ rideTitle, daysLeft, purgeOn }) =>
    [
      `${rideTitle} has been in your bin for a while, and on ${purgeOn} it is destroyed for good — that is ${daysLeft === 1 ? 'tomorrow' : `${daysLeft} days from now`}.`,
      '',
      `Nothing brings a ride back after that. The route, every stop on it, and the file you uploaded all go.`,
      '',
      BIN_URL,
      '',
      `Restoring it from your bin resets the thirty days, so there is no hurry beyond the date above. If you meant to delete it, you need do nothing at all.`,
    ].join('\n'),

  html: ({ rideTitle, daysLeft, purgeOn }) =>
    (
      <>
        <P>
          <b>{rideTitle}</b> has been in your bin for a while, and on {purgeOn} it is destroyed for good — that is{' '}
          {daysLeft === 1 ? 'tomorrow' : `${daysLeft} days from now`}.
        </P>
        <P>Nothing brings a ride back after that. The route, every stop on it, and the file you uploaded all&nbsp;go.</P>
        <Button href={BIN_URL}>Open your bin</Button>
        <Muted>
          Restoring it from <A href={BIN_URL}>{BIN_URL}</A> resets the thirty days, so there is no hurry beyond the date
          above. If you meant to delete it, you need do nothing at&nbsp;all.
        </Muted>
      </>
    ).toString(),

  sample: {
    rideTitle: 'Oakland to Ensenada',
    daysLeft: 7,
    purgeOn: '24-08-2026',
  },
})
