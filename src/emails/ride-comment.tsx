// Somebody commented on a ride you own.
//
// **COMMENTING IS ROSTER-ONLY, WHICH IS WHY THIS CAN NAME THE PERSON.** A share
// link is permission to SEE a route, not to write on one, so whoever this is was
// put on the ride by the owner reading the message — there is no stranger case
// to be careful about and no handle to look up first.
//
// It carries an EXCERPT rather than the whole comment. The point of the message
// is to bring somebody back to the ride, where the comment sits in its thread
// beside the stop it is about; reproducing the conversation in email makes the
// email the place it happens, and nothing there can be replied to.
import { APP_ORIGIN } from '../config'
import { defineEmail } from './types'
import { A, Button, Muted, P } from './shell'

type Props = {
  /** Who wrote it, as they are shown everywhere else — users.display_name. */
  commenterName: string
  rideTitle: string
  rideSlug: string
  /** The first line or so, already trimmed by the caller. */
  excerpt: string
  /** The stop it was left on, or null for a comment about the whole ride.
   *  Denormalized at post time, so it still reads correctly for a comment whose
   *  point has since been deleted — see comments.point_label. */
  pointLabel: string | null
}

const url = (slug: string) => `${APP_ORIGIN}/m/${slug}`

export const rideCommentEmail = defineEmail<Props>({
  key: 'ride-comment',

  subject: ({ commenterName, rideTitle }) => `${commenterName} commented on ${rideTitle}`,

  preheader: ({ excerpt }) => excerpt,

  text: ({ commenterName, rideTitle, rideSlug, excerpt, pointLabel }) =>
    [
      pointLabel
        ? `${commenterName} commented on ${pointLabel}, on your ride ${rideTitle}.`
        : `${commenterName} commented on your ride ${rideTitle}.`,
      '',
      `“${excerpt}”`,
      '',
      url(rideSlug),
      '',
      `Only riders on the ride can comment, and only you and they can read it.`,
    ].join('\n'),

  html: ({ commenterName, rideTitle, rideSlug, excerpt, pointLabel }) =>
    (
      <>
        <P>
          {commenterName} commented on {pointLabel ? `${pointLabel}, on` : ''} your ride{' '}
          <A href={url(rideSlug)}>{rideTitle}</A>.
        </P>
        <P>“{excerpt}”</P>
        <Button href={url(rideSlug)}>Read it on the ride</Button>
        <Muted>Only riders on the ride can comment, and only you and they can read&nbsp;it.</Muted>
      </>
    ).toString(),

  sample: {
    commenterName: 'Dana Whitlock',
    rideTitle: 'Oakland to Ensenada',
    rideSlug: 'oakland-to-ensenada',
    excerpt: 'Is the pass still closed this early in the year?',
    pointLabel: 'Sonora Pass',
  },
})
