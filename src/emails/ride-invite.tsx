// You're invited on a ride — to somebody who is not on Routeloop (#428).
//
// **NOT ride-added.tsx AND NOT invite.tsx.** ride-added tells a rider with an
// account that a friend put them on a ride. invite.tsx is an admin letting
// somebody into the beta. This is an organizer inviting a person by name and
// address, who may never make an account at all — and the email has to say that
// they do not have to: the link opens the ride and its downloads as it stands.
//
// ONE LINK, to the landing page, which holds the three choices — look, join,
// decline. Not three links here: a decline is a POST behind an origin check, and
// a GET in an email that declines on somebody's behalf is a one-click forgery
// that every mail scanner would press.
import { APP_ORIGIN } from '../config'
import { defineEmail } from './types'
import { Button, Muted, P } from './shell'

type Props = {
  /** Who sent it — the organizer. */
  fromName: string
  /** The name the organizer planned with, for the greeting. */
  name: string
  rideTitle: string
  /** The personal link's PATH, from rideInvitePath(). */
  path: string
  /** When it sets off, already formatted, or null for an undated ride. */
  startsOn: string | null
}

const url = (path: string) => `${APP_ORIGIN}${path}`

export const rideInviteEmail = defineEmail<Props>({
  key: 'ride-invite',

  subject: ({ fromName, rideTitle }) => `${fromName} invited you on ${rideTitle}`,

  preheader: ({ startsOn }) =>
    startsOn ? `It sets off ${startsOn}. Have a look at the route.` : 'Have a look at the route.',

  text: ({ fromName, name, rideTitle, path, startsOn }) =>
    [
      `Hi ${name},`,
      '',
      `${fromName} is planning ${rideTitle} on Routeloop and invited you.${startsOn ? ` It sets off ${startsOn}.` : ''}`,
      '',
      url(path),
      '',
      'That link is yours. It opens the ride and its maps and GPX files, with no account needed. If you want to be on the roster and say whether you are coming, you can join Routeloop from the same page, and if you are not coming you can say so there too.',
    ].join('\n'),

  html: ({ fromName, name, rideTitle, path, startsOn }) =>
    (
      <>
        <P>Hi {name},</P>
        <P>
          {fromName} is planning <strong>{rideTitle}</strong> on Routeloop and invited&nbsp;you.
          {startsOn ? ` It sets off ${startsOn}.` : ''}
        </P>
        <Button href={url(path)}>See the ride</Button>
        <Muted>
          That link is yours. It opens the ride and its maps and GPX files, with no account needed. If you want to be
          on the roster and say whether you are coming, you can join Routeloop from the same page, and if you are not
          coming you can say so there&nbsp;too.
        </Muted>
      </>
    ).toString(),

  sample: {
    fromName: 'Ziad Ezzat',
    name: 'Sam',
    rideTitle: 'Oakland to Ensenada',
    path: '/ride-invite/0123456789abcdef0123456789abcdef0123456789abcdef',
    startsOn: 'on 24-08-2026',
  },
})
