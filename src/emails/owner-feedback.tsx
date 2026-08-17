// The owner's new-report alert.
//
// Named `owner-feedback` rather than the `feedback-received` in
// docs/rider-feedback.md, following owner-signup.tsx: in this directory the
// `owner-` prefix means "written for the person running the site", and
// waitlist.tsx / approved.tsx are the rider-facing half. A file called
// feedback-received would read as a receipt sent to the rider, which is a
// different message and a different commit.
//
// A notification, not a piece of copy. The whole point is that a report can be
// triaged from the inbox on a phone: the kind and the first line are in the
// subject, the body is what is needed to decide whether it is urgent, and there
// is one link.
//
// **The rider's own words are quoted verbatim and untrusted.** They reach HTML,
// which is why this is JSX rather than a template string — the escaping is the
// framework's job and must not become anyone's discipline.
import { APP_ORIGIN } from '../config'
import { A, Button, Muted, P } from './shell'
import { defineEmail } from './types'

type Props = {
  /** Row id, which is what the queue addresses and what a reply can quote. */
  id: number
  /** 'bug' | 'idea' | 'question'. */
  kind: string
  /** Derived by titleFrom(), so it is a sentence rather than a label. */
  title: string
  /** What the rider actually wrote. Untrusted. */
  body: string
  /** Who sent it, for a reply. */
  riderName: string
  /** Which screen, already resolved to its rider-facing label, or null. */
  area: string | null
  /** How many reports are now sitting at `pending`, this one included. */
  pendingCount: number
}

const QUEUE_URL = `${APP_ORIGIN}/admin/feedback`

// Same 78-character ceiling as owner-signup.tsx, and for the same reason: a
// longer subject is truncated by the client at a point you do not choose.
const MAX_SUBJECT = 78

const KIND_WORD: Record<string, string> = { bug: 'Bug', idea: 'Idea', question: 'Question' }

function subjectFor(kind: string, title: string): string {
  const prefix = `${KIND_WORD[kind] ?? 'Report'}: `
  const room = MAX_SUBJECT - prefix.length
  return prefix + (title.length <= room ? title : `${title.slice(0, room - 1)}…`)
}

export const ownerFeedbackEmail = defineEmail<Props>({
  key: 'owner-feedback',

  subject: ({ kind, title }) => subjectFor(kind, title),

  preheader: ({ riderName, pendingCount }) =>
    pendingCount === 1 ? `From ${riderName}. 1 waiting.` : `From ${riderName}. ${pendingCount} waiting.`,

  text: ({ id, kind, body, riderName, area, pendingCount }) =>
    [
      `${riderName} sent a ${kind}.`,
      ...(area ? [`Where: ${area}`] : []),
      '',
      body,
      '',
      `Waiting in the queue: ${pendingCount}`,
      `Report ${id}: ${QUEUE_URL}`,
    ].join('\n'),

  html: ({ id, kind, body, riderName, area, pendingCount }) =>
    (
      <>
        <P>
          <strong>{riderName}</strong> sent a {kind}
          {area ? ` from ${area}` : ''}.
        </P>
        {/* Quoted rather than paraphrased. The rider's exact words are the whole
            content of the message, and a summary here would mean opening the
            queue to find out what they actually said. */}
        <P>
          <em>{body}</em>
        </P>
        <Button href={QUEUE_URL}>Open the queue</Button>
        {/*
          "Report 1042", not "Report #1042", and that is not a style choice.
          test/email-theme.test.ts scans the rendered HTML for `#` followed by
          3–6 hex characters to catch a template inventing a color, and every
          decimal digit is also a hex digit — so `#1042` in body copy is
          indistinguishable from a stray `#1042` swatch and fails the guard.

          The guard is worth more than the hash. It cannot be narrowed to
          attribute values either: shell.tsx puts most colors in <style> blocks,
          so scanning only attributes would miss 36 of the 42 colors in a
          rendered email. Any future template referring to a numbered thing has
          the same constraint.
        */}
        <Muted>
          Report {id}. {pendingCount === 1 ? '1 report is' : `${pendingCount} reports are`} waiting. Go to{' '}
          <A href={QUEUE_URL}>{QUEUE_URL}</A>.
        </Muted>
      </>
    ).toString(),

  sample: {
    id: 1042,
    kind: 'bug',
    title: 'The map went white when I hit save',
    body: 'I hit save on my Blue Ridge route and the map went white. Happened twice today.',
    riderName: 'Dana Reyes',
    area: 'Planning a route',
    pendingCount: 3,
  },
})
