// You were put on a ride.
//
// **THIS IS NOT invite.tsx.** That one is the BETA invitation — an admin letting
// somebody into the app at all, sent to an address that may have no account
// behind it. This is a rider who already has an account being added to a ride's
// roster by a friend, which is a different event to a different person at a
// different moment, and folding them into one template would mean one of the two
// lying about what just happened.
//
// **YOU CAN ONLY ADD A FRIEND TO A RIDE**, so the sender is always somebody the
// recipient has already accepted — there is no stranger case and no refusal to
// be careful about. See docs/decisions.md.
//
// It does not carry an RSVP button, for the reason friend-request carries: an
// RSVP is a POST behind requireSameOrigin, and a GET link that answers on the
// rider's behalf is a one-click forgery of the one thing the roster is for.
import { APP_ORIGIN } from '../config'
import { defineEmail } from './types'
import { A, Button, Muted, P } from './shell'

type Props = {
  /** Who added them — the ride's owner, or a co-owner. */
  ownerName: string
  rideTitle: string
  rideSlug: string
  /** When it sets off, already formatted by the caller in the RECIPIENT'S own
   *  date format, or null for a ride nobody has dated. The formatting cannot
   *  happen here: src/emails/ is pure and the preference is a table read. */
  startsOn: string | null
}

const url = (slug: string) => `${APP_ORIGIN}/m/${slug}`

export const rideAddedEmail = defineEmail<Props>({
  key: 'ride-added',

  subject: ({ ownerName, rideTitle }) => `${ownerName} put you on ${rideTitle}`,

  preheader: ({ startsOn }) => (startsOn ? `It sets off ${startsOn}. Say whether you are coming.` : 'Say whether you are coming.'),

  text: ({ ownerName, rideTitle, rideSlug, startsOn }) =>
    [
      `${ownerName} added you to ${rideTitle}.`,
      ...(startsOn ? ['', `It sets off ${startsOn}.`] : []),
      '',
      url(rideSlug),
      '',
      `Going, Maybe and Not this time are on the ride page, under who is coming. Nobody is counting on an answer until you give one.`,
    ].join('\n'),

  html: ({ ownerName, rideTitle, rideSlug, startsOn }) =>
    (
      <>
        <P>
          {ownerName} added you to <A href={url(rideSlug)}>{rideTitle}</A>.
          {startsOn ? ` It sets off ${startsOn}.` : ''}
        </P>
        <Button href={url(rideSlug)}>Say whether you are coming</Button>
        <Muted>
          Going, Maybe and Not this time are on the ride page, under who is coming. Nobody is counting on an answer
          until you give&nbsp;one.
        </Muted>
      </>
    ).toString(),

  sample: {
    ownerName: 'Ziad Ezzat',
    rideTitle: 'Oakland to Ensenada',
    rideSlug: 'oakland-to-ensenada',
    startsOn: 'on 24-08-2026',
  },
})
