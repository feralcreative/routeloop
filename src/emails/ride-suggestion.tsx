// Somebody proposed a change to a ride you own.
//
// **A SUGGESTION IS A WHOLE ROUTE, NOT A FIELD-LEFT DIFF**, so there is nothing
// to summarize in a message — the only useful thing an email can do here is say
// who proposed what and get the owner in front of the map, where the proposal is
// drawn against what is there now. See src/suggestions/policy.ts.
//
// It does NOT carry Accept and Discard buttons. Those are POSTs behind
// requireSameOrigin, and a GET link that rewrites a ride is a one-click CSRF
// handed to anyone who can read the message — the same rule friend-request
// follows for the same reason.
import { APP_ORIGIN } from '../config'
import { defineEmail } from './types'
import { A, Button, Muted, P } from './shell'

type Props = {
  proposerName: string
  rideTitle: string
  rideSlug: string
  /** Which route of the ride it proposes to replace, named as the rider sees
   *  it — "Route 3" when it has no title of its own. */
  routeLabel: string
  /** What they said about it, or null. Optional on the form and usually empty:
   *  the map is the argument. */
  note: string | null
}

const url = (slug: string) => `${APP_ORIGIN}/m/${slug}`

export const rideSuggestionEmail = defineEmail<Props>({
  key: 'ride-suggestion',

  subject: ({ proposerName, rideTitle }) => `${proposerName} suggested a change to ${rideTitle}`,

  preheader: ({ routeLabel }) => `A new version of ${routeLabel}, for you to accept or discard.`,

  text: ({ proposerName, rideTitle, rideSlug, routeLabel, note }) =>
    [
      `${proposerName} suggested a change to ${routeLabel} of your ride ${rideTitle}.`,
      ...(note ? ['', `They said: “${note}”`] : []),
      '',
      url(rideSlug),
      '',
      `Their version is drawn against yours there, with Accept and Discard beside it.`,
      '',
      `A suggestion goes stale on its own if you change that route first, so there is no way to accept one that no longer describes your ride.`,
    ].join('\n'),

  html: ({ proposerName, rideTitle, rideSlug, routeLabel, note }) =>
    (
      <>
        <P>
          {proposerName} suggested a change to {routeLabel} of your ride <A href={url(rideSlug)}>{rideTitle}</A>.
        </P>
        {note ? <P>They said: “{note}”</P> : <></>}
        <Button href={url(rideSlug)}>Look at their version</Button>
        <Muted>It is drawn against yours there, with Accept and Discard beside&nbsp;it.</Muted>
        <Muted>
          A suggestion goes stale on its own if you change that route first, so there is no way to accept one that no
          longer describes your&nbsp;ride.
        </Muted>
      </>
    ).toString(),

  sample: {
    proposerName: 'Dana Whitlock',
    rideTitle: 'Oakland to Ensenada',
    rideSlug: 'oakland-to-ensenada',
    routeLabel: 'Route 3',
    note: 'The coast road is shut past Ragged Point — this goes inland at Cambria.',
  },
})
