// The owner accepted or discarded your suggestion.
//
// **ONE TEMPLATE FOR BOTH OUTCOMES, AND THAT IS DELIBERATE.** Two templates
// would be two subjects, two bodies and two chances for the discarded one to
// read as an apology — which it must not, because discarding a suggestion is an
// ordinary editorial act on somebody's own ride. The verb is a prop, the shape
// is identical, and the difference between the two messages is one word.
//
// **A WITHDRAWN SUGGESTION SENDS NOTHING**: the proposer withdrew it themselves,
// so the message would be telling them what they just did. Only `accept` and
// `discard` reach here — see src/suggestions/service.ts.
import { APP_ORIGIN } from '../config'
import { defineEmail } from './types'
import { A, Button, Muted, P } from './shell'

type Props = {
  /** Whose ride it was. */
  ownerName: string
  rideTitle: string
  rideSlug: string
  routeLabel: string
  /** True for accepted, false for discarded. */
  accepted: boolean
}

const url = (slug: string) => `${APP_ORIGIN}/m/${slug}`

export const suggestionDecidedEmail = defineEmail<Props>({
  key: 'suggestion-decided',

  subject: ({ ownerName, accepted, rideTitle }) =>
    accepted ? `${ownerName} took your suggestion for ${rideTitle}` : `${ownerName} passed on your suggestion for ${rideTitle}`,

  preheader: ({ accepted, routeLabel }) =>
    accepted ? `${routeLabel} is your version now.` : `${routeLabel} is staying as it was.`,

  text: ({ ownerName, rideTitle, rideSlug, routeLabel, accepted }) =>
    [
      accepted
        ? `${ownerName} accepted your suggestion for ${routeLabel} of ${rideTitle}. That route is your version now.`
        : `${ownerName} discarded your suggestion for ${routeLabel} of ${rideTitle}. The route is staying as it was.`,
      '',
      url(rideSlug),
      '',
      accepted
        ? `Everyone on the ride is riding it.`
        : `Nothing stops you suggesting something else — a ride is a conversation about a road.`,
    ].join('\n'),

  html: ({ ownerName, rideTitle, rideSlug, routeLabel, accepted }) =>
    (
      <>
        <P>
          {ownerName} {accepted ? 'accepted' : 'discarded'} your suggestion for {routeLabel} of{' '}
          <A href={url(rideSlug)}>{rideTitle}</A>.{' '}
          {accepted ? 'That route is your version now.' : 'The route is staying as it was.'}
        </P>
        <Button href={url(rideSlug)}>Look at the ride</Button>
        <Muted>
          {accepted
            ? 'Everyone on the ride is riding it.'
            : 'Nothing stops you suggesting something else — a ride is a conversation about a road.'}
        </Muted>
      </>
    ).toString(),

  sample: {
    ownerName: 'Ziad Ezzat',
    rideTitle: 'Oakland to Ensenada',
    rideSlug: 'oakland-to-ensenada',
    routeLabel: 'Route 3',
    accepted: true,
  },
})
