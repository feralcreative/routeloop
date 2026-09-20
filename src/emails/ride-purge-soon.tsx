// The rides in the bin are about to be destroyed for good.
//
// **THIS IS THE ONLY WARNING, AND IT IS THE ONLY ONE THAT CAN EXIST.** The purge
// is the one piece of code in the app that genuinely destroys a ride — row,
// routes, points and the stored original off disk — and nothing after it can be
// undone by anybody. A rider who binned something in March and forgot has thirty
// days of silence and then no ride.
//
// **ONE MESSAGE FOR THE WHOLE BIN, SINCE 2026-09-20.** It was one per ride, on
// the reasoning that several rides due in the same sweep are several messages
// and that is the correct noise level for something irreversible. Ziad's call
// reversed it after a month of real use: rides reach the end of their thirty
// days in batches, and eight messages about one bin is noise about one fact.
// What survives is that **IT NAMES THE RIDES RATHER THAN COUNTING THEM** —
// every ride in the bin, soonest first, with its date — because a number is
// something a rider cannot act on without going and looking, and the names are
// what make them remember whether they meant it.
//
// Restoring is a POST behind requireSameOrigin, so this links to the bin rather
// than restoring from a GET — the same rule friend-request follows, and it
// matters more here, because a link that could be prefetched into a restore
// would silently un-bin rides for anybody whose mail client fetches links.
import { APP_ORIGIN } from '../config'
import { defineEmail } from './types'
import { wordsIn, type WithWords } from './words'
import { wds } from '../views/vocab'
import { A, Button, Muted, P } from './shell'

type Line = {
  title: string
  /** The date it goes, already formatted by the caller in the RECIPIENT'S own
   *  date format — src/emails/ is pure and the preference is a table read. */
  purgeOn: string
  /** How many days are left, as a whole number, never below one. */
  daysLeft: number
}

type Props = WithWords & {
  /** Every ride in the bin, soonest first. Never empty: the sender does not
   *  send for an empty bin. */
  rides: Line[]
}

const BIN_URL = `${APP_ORIGIN}/trash`

const inDays = (n: number): string => (n === 1 ? 'tomorrow' : `in ${n} days`)

export const ridePurgeSoonEmail = defineEmail<Props>({
  key: 'ride-purge-soon',

  subject: ({ rides }) =>
    rides.length === 1
      ? `${rides[0].title} is deleted for good ${inDays(rides[0].daysLeft)}`
      : `${rides.length} rides in your bin are deleted for good, the first ${inDays(rides[0].daysLeft)}`,

  preheader: ({ rides }) =>
    rides.length === 1
      ? `Restoring it from your bin before ${rides[0].purgeOn} keeps it.`
      : `${rides[0].title} goes first, on ${rides[0].purgeOn}. Restore anything you want to keep.`,

  text: ({ rides, ...p }) =>
    [
      rides.length === 1
        ? `${rides[0].title} has been in your bin for a while, and on ${rides[0].purgeOn} it is destroyed for good — that is ${inDays(rides[0].daysLeft)}.`
        : `These ${wds(wordsIn(p), 'journey')} are in your bin and are destroyed for good on the dates below, the first ${inDays(rides[0].daysLeft)}:`,
      ...(rides.length === 1 ? [] : ['', ...rides.map((r) => `  ${r.title} — ${r.purgeOn}`)]),
      '',
      `Nothing brings ${rides.length === 1 ? 'it' : 'them'} back after that. The ${wds(wordsIn(p), 'route')}, every stop, and the files you uploaded all go.`,
      '',
      BIN_URL,
      '',
      `Restoring ${rides.length === 1 ? 'it' : 'one'} from your bin resets its thirty days, so there is no hurry beyond the date${rides.length === 1 ? '' : 's'} above. If you meant to delete ${rides.length === 1 ? 'it' : 'them'}, you need do nothing at all.`,
    ].join('\n'),

  html: ({ rides, ...p }) =>
    (
      <>
        {rides.length === 1 ? (
          <P>
            <b>{rides[0].title}</b> has been in your bin for a while, and on {rides[0].purgeOn} it is destroyed for good
            — that is {inDays(rides[0].daysLeft)}.
          </P>
        ) : (
          <>
            <P>
              These {wds(wordsIn(p), 'journey')} are in your bin and are destroyed for good on the dates below, the
              first {inDays(rides[0].daysLeft)}:
            </P>
            <ul>
              {rides.map((r) => (
                <li>
                  <b>{r.title}</b> — {r.purgeOn}
                </li>
              ))}
            </ul>
          </>
        )}
        <P>
          Nothing brings {rides.length === 1 ? 'it' : 'them'} back after that. The {wds(wordsIn(p), 'route')}, every
          stop, and the files you uploaded all&nbsp;go.
        </P>
        <Button href={BIN_URL}>Open your bin</Button>
        <Muted>
          Restoring {rides.length === 1 ? 'it' : 'one'} from <A href={BIN_URL}>{BIN_URL}</A> resets its thirty days, so
          there is no hurry beyond the date{rides.length === 1 ? '' : 's'} above. If you meant to delete{' '}
          {rides.length === 1 ? 'it' : 'them'}, you need do nothing at&nbsp;all.
        </Muted>
      </>
    ).toString(),

  sample: {
    rides: [
      { title: 'Oakland to Ensenada', purgeOn: '24-08-2026', daysLeft: 7 },
      { title: 'Weaverville rally', purgeOn: '26-08-2026', daysLeft: 9 },
      { title: 'Coast run', purgeOn: '30-08-2026', daysLeft: 13 },
    ],
  },
})
