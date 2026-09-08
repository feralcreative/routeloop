// Somebody followed you.
//
// **THE COPY HAS TO SAY THAT THIS GRANTS NOTHING, AND THAT IS THE WHOLE POINT OF
// THE MESSAGE HAVING A SECOND PARAGRAPH.** Following is a one-way relation that
// gives no visibility at any level, ever — `canView()` does not know the table
// exists — so a rider who reads "Dana is following you" and concludes Dana can
// now see their private rides has been misinformed by a notification we sent.
// See src/access/policy.ts and src/follows/policy.ts.
//
// It offers no Follow back button: that is a POST behind requireSameOrigin, and
// the link goes to their profile, where the button lives beside everything else
// that decides whether you want to.
import { APP_ORIGIN } from '../config'
import { defineEmail } from './types'
import { A, Button, Muted, P } from './shell'

type Props = {
  followerName: string
  /** Their handle, without the @. */
  followerHandle: string
}

const profile = (handle: string) => `${APP_ORIGIN}/@${handle}`

export const newFollowerEmail = defineEmail<Props>({
  key: 'new-follower',

  subject: ({ followerName }) => `${followerName} is following you on Routeloop`,

  preheader: () => 'Following is one-way and opens nothing of yours.',

  text: ({ followerName, followerHandle }) =>
    [
      `${followerName} (@${followerHandle}) is following you.`,
      '',
      profile(followerHandle),
      '',
      `Following means they see the rides you have already made public. It opens nothing else — not your private rides, not your friends-only ones, and not anything about you that was not already public.`,
      '',
      `Follow them back, or do nothing, from their page above.`,
    ].join('\n'),

  html: ({ followerName, followerHandle }) =>
    (
      <>
        <P>
          {followerName} (<A href={profile(followerHandle)}>@{followerHandle}</A>) is following&nbsp;you.
        </P>
        <Button href={profile(followerHandle)}>Look at who they are</Button>
        <Muted>
          Following means they see the rides you have already made public. It opens nothing else — not your private
          rides, not your friends-only ones, and not anything about you that was not already&nbsp;public.
        </Muted>
      </>
    ).toString(),

  sample: {
    followerName: 'Dana Whitlock',
    followerHandle: 'dana',
  },
})
