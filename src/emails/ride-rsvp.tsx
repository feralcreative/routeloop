// Somebody said whether they are coming.
//
// **ONE TEMPLATE FOR ALL THREE ANSWERS**, for the reason suggestion-decided
// carries: three templates would be three chances for the declining one to read
// as a reproach. The answer is a prop and the shape is identical.
//
// **`invited` NEVER REACHES HERE.** That is the state a rider is put in when they
// are added, not an answer they gave — mailing it would tell an owner that
// somebody has not replied, seconds after the owner added them. Only going,
// maybe and declined send. See src/members/policy.ts.
//
// **A CHANGED ANSWER SENDS AGAIN**, deliberately: "Dana was going and now is
// not" is the single most useful thing this message ever says, and suppressing
// it would leave an owner planning around a rider who dropped out.
import { APP_ORIGIN } from '../config'
import { defineEmail } from './types'
import { A, Button, Muted, P } from './shell'

type Props = {
  riderName: string
  rideTitle: string
  rideSlug: string
  /** RSVP_LABELS[rsvp] from src/members/policy.ts — resolved by the caller so
   *  the email never decides what an answer is called. */
  answer: string
  /** How many are going now, including this one if they are. */
  goingCount: number
}

const url = (slug: string) => `${APP_ORIGIN}/m/${slug}`

export const rideRsvpEmail = defineEmail<Props>({
  key: 'ride-rsvp',

  subject: ({ riderName, answer, rideTitle }) => `${riderName} on ${rideTitle}: ${answer}`,

  preheader: ({ goingCount }) => `${goingCount} going so far.`,

  text: ({ riderName, rideTitle, rideSlug, answer, goingCount }) =>
    [
      `${riderName} answered ${answer} on your ride ${rideTitle}.`,
      '',
      `That is ${goingCount} going so far.`,
      '',
      url(rideSlug),
      '',
      `Everyone on the roster can change their answer up to the day, so this is a picture rather than a promise.`,
    ].join('\n'),

  html: ({ riderName, rideTitle, rideSlug, answer, goingCount }) =>
    (
      <>
        <P>
          {riderName} answered <b>{answer}</b> on your ride <A href={url(rideSlug)}>{rideTitle}</A>. That is{' '}
          {goingCount} going so&nbsp;far.
        </P>
        <Button href={url(rideSlug)}>See who is coming</Button>
        <Muted>
          Everyone on the roster can change their answer up to the day, so this is a picture rather than a&nbsp;promise.
        </Muted>
      </>
    ).toString(),

  sample: {
    riderName: 'Dana Whitlock',
    rideTitle: 'Oakland to Ensenada',
    rideSlug: 'oakland-to-ensenada',
    answer: 'Going',
    goingCount: 4,
  },
})
