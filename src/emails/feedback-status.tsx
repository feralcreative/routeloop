// "Here's what happened to the thing you told us."
//
// The message that closes the loop. Before this, a rider who reported something
// found out what came of it by remembering to check /feedback/mine, which nobody
// does — so from their side every report vanished into a form, which is exactly
// the experience that stops people reporting anything a second time.
//
// **The copy is not written here.** Every label and sub-line comes from
// STATUS_META in src/feedback/policy.ts, which is the single source for the
// words a rider reads and is pinned exhaustively by
// test/feedback-status-labels.test.ts. Restating any of it in this file would
// create a second place for "we're not doing this one" to be phrased, and the
// two would drift on the first edit.
//
// The rider's own words are quoted back so the message stands alone in an inbox
// three weeks later. Untrusted, escaped by JSX.
import { APP_ORIGIN } from '../config'
import { A, Button, Muted, P } from './shell'
import { defineEmail } from './types'

type Props = {
  /** Already resolved through statusLabel(status, kind), so this file never
   *  decides whether a thing was fixed or built. */
  statusLabel: string
  /** STATUS_META[status].sub. */
  statusSub: string
  /** What the rider wrote, or the title derived from it. Untrusted. */
  title: string
  /** The owner's public response, when there is one. `not_doing` always has one
   *  — the queue refuses to save that status without it. */
  response: string | null
  /** Where to read it in full. The public id, never the row id. */
  publicId: string
  /** Whether it is on the board now, which changes what the link is for. */
  onBoard: boolean
}

export const feedbackStatusEmail = defineEmail<Props>({
  key: 'feedback-status',

  // The status leads, because that is the news. "An update on your report" is a
  // subject line that makes someone open a message to find out nothing.
  subject: ({ statusLabel, title }) => {
    const s = `${statusLabel}: ${title}`
    return s.length <= 78 ? s : `${s.slice(0, 77)}…`
  },

  preheader: ({ statusSub }) => statusSub,

  text: ({ statusLabel, statusSub, title, response, publicId, onBoard }) =>
    [
      `You told us: ${title}`,
      '',
      `${statusLabel} — ${statusSub}`,
      ...(response ? ['', response] : []),
      '',
      onBoard ? `See it on the board: ${APP_ORIGIN}/board` : `Read it: ${APP_ORIGIN}/feedback/${publicId}`,
      '',
      // Every link in the HTML arm has to appear here too — test/emails.test.ts
      // enforces it, because a text-only client that silently loses a link is
      // the failure the two-arm contract exists to prevent.
      `Everything you have sent us: ${APP_ORIGIN}/feedback/mine`,
    ].join('\n'),

  html: ({ statusLabel, statusSub, title, response, publicId, onBoard }) =>
    (
      <>
        <P>
          You told us: <em>{title}</em>
        </P>
        <P>
          <strong>{statusLabel}</strong> — {statusSub}
        </P>
        {response ? <P>{response}</P> : ''}
        <Button href={onBoard ? `${APP_ORIGIN}/board` : `${APP_ORIGIN}/feedback/${publicId}`}>
          {onBoard ? 'See it on the board' : 'Read it'}
        </Button>
        <Muted>
          Everything you have sent us is at <A href={`${APP_ORIGIN}/feedback/mine`}>{`${APP_ORIGIN}/feedback/mine`}</A>.
        </Muted>
      </>
    ).toString(),

  sample: {
    statusLabel: 'Built and live',
    statusSub: 'Go try it',
    title: 'Show me where I would end up each night',
    response: 'Day-end towns now show on the timeline.',
    publicId: '0XpUREEtUt4FwTnE9c1cYf',
    onBoard: true,
  },
})
