// A vote on an alternate route closed and a winner was elected.
//
// **ONLY WHEN SOMETHING WAS ACTUALLY DECIDED.** `electWinner()` returning null is
// the ORDINARY outcome rather than the edge one — a three-member ride with two
// alternates ties whenever one rider abstains, and there is deliberately no
// quorum and no tie-break — so a message on every deadline would mostly be
// telling riders that nothing happened. See src/votes/policy.ts.
//
// It goes to the ROSTER and not only to the owner, because the point of a vote
// is that the group chose the road; the person who most needs to know is the one
// who is going to ride it.
import { APP_ORIGIN } from '../config'
import { defineEmail } from './types'
import { A, Button, Muted, P } from './shell'

type Props = {
  rideTitle: string
  rideSlug: string
  /** The route that won, named as the rider sees it on the ride. */
  winnerLabel: string
  /** How many alternates were on the ballot, including the winner. */
  choices: number
}

const url = (slug: string) => `${APP_ORIGIN}/m/${slug}`

export const voteResolvedEmail = defineEmail<Props>({
  key: 'vote-resolved',

  subject: ({ rideTitle, winnerLabel }) => `${rideTitle}: the group picked ${winnerLabel}`,

  preheader: ({ winnerLabel }) => `${winnerLabel} is the active route now.`,

  text: ({ rideTitle, rideSlug, winnerLabel, choices }) =>
    [
      `The vote on ${rideTitle} closed. Out of ${choices} routes, the group picked ${winnerLabel}, and it is the active one now.`,
      '',
      url(rideSlug),
      '',
      `The others are still there as alternates — nothing was thrown away, and the owner can switch back.`,
    ].join('\n'),

  html: ({ rideTitle, rideSlug, winnerLabel, choices }) =>
    (
      <>
        <P>
          The vote on <A href={url(rideSlug)}>{rideTitle}</A> closed. Out of {choices} routes, the group picked{' '}
          {winnerLabel}, and it is the active one&nbsp;now.
        </P>
        <Button href={url(rideSlug)}>See the route</Button>
        <Muted>
          The others are still there as alternates — nothing was thrown away, and the owner can switch&nbsp;back.
        </Muted>
      </>
    ).toString(),

  sample: {
    rideTitle: 'Oakland to Ensenada',
    rideSlug: 'oakland-to-ensenada',
    winnerLabel: 'the coast road',
    choices: 3,
  },
})
