// A rider's storage is nearly full.
//
// **ONLY IMPORTED FILES COUNT AGAINST IT, AND THE COPY HAS TO SAY SO.** A ride
// built in the builder writes nothing to disk, so a rider told "your storage is
// nearly full" who concludes they should stop planning rides has been driven
// away from the thing the app is for by a message about something else entirely.
// What fills it is uploads.
//
// **SENT ONCE PER CROSSING, NOT ONCE PER SWEEP.** The quota sweep runs every five
// minutes; `users.quota_warned_at` is stamped when this goes and CLEARED when the
// rider drops back under the line, so somebody sitting at 95% for a month hears
// once and somebody who frees space and fills it again hears again. See
// src/account/quota-sweep.ts.
import { APP_ORIGIN } from '../config'
import { defineEmail } from './types'
import { A, Button, Muted, P } from './shell'

type Props = {
  /** Whole percent of the allowance in use. */
  percent: number
  /** Both already formatted by the caller, in whichever unit reads best. */
  used: string
  quota: string
}

const BIN_URL = `${APP_ORIGIN}/trash`
const RIDES_URL = `${APP_ORIGIN}/`

export const quotaFullEmail = defineEmail<Props>({
  key: 'quota-full',

  subject: ({ percent }) => `Your Routeloop storage is ${percent}% full`,

  preheader: ({ used, quota }) => `${used} of ${quota}. Only uploaded files count.`,

  text: ({ percent, used, quota }) =>
    [
      `Your storage is ${percent}% full — ${used} of ${quota}.`,
      '',
      `Only files you IMPORTED count against this. A ride you planned in the builder writes nothing to disk and costs you nothing, however long it is, so this is not a limit on how much you can plan.`,
      '',
      `Two things free space up. Deleting an imported ride you no longer want:`,
      RIDES_URL,
      '',
      `And emptying your bin, where a deleted ride still counts for thirty days:`,
      BIN_URL,
      '',
      `If neither is enough, reply to this and we will sort it out.`,
    ].join('\n'),

  html: ({ percent, used, quota }) =>
    (
      <>
        <P>
          Your storage is <b>{percent}% full</b> — {used} of&nbsp;{quota}.
        </P>
        <P>
          Only files you <b>imported</b> count against this. A ride you planned in the builder writes nothing to disk
          and costs you nothing, however long it is, so this is not a limit on how much you can&nbsp;plan.
        </P>
        <Button href={RIDES_URL}>Look at your rides</Button>
        <Muted>
          Deleting an imported ride frees its space, and so does emptying <A href={BIN_URL}>your bin</A> — a ride in
          there still counts for thirty&nbsp;days.
        </Muted>
        <Muted>If neither is enough, reply to this and we will sort it&nbsp;out.</Muted>
      </>
    ).toString(),

  sample: {
    percent: 90,
    used: '90 MB',
    quota: '100 MB',
  },
})
