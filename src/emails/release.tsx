// Routeloop changed, and here is what changed.
//
// **OFF BY DEFAULT, WHICH NO OTHER TEMPLATE HERE IS.** Prod deploys several
// times a day, so the house default of email-on would be a mail per deploy to
// every rider — the one shape of notification guaranteed to make somebody switch
// all of them off. `QUIET_BY_DEFAULT` in src/notifications/policy.ts is where
// that lives and why. This template exists so the switch has something to send
// when a rider turns it on: a preference that delivers nothing is a control that
// does nothing.
//
// **IT LINKS RATHER THAN INLINING THE NOTES.** A release section is arbitrary
// authored markup — headings, lists, <code>, entities — and every other template
// here is a function of typed props with no HTML passed through it. Piping the
// file's own markup into a mail client is the one way to make this the template
// that breaks the rule the whole directory is built on, and it would arrive
// unstyled in half of them anyway.
import { APP_ORIGIN } from '../config'
import { defineEmail } from './types'
import { Button, Muted, P } from './shell'

type Props = {
  /** The release heading as a rider reads it, stamp already stripped. */
  title: string
  /** The path to this release's own entry on the notes page, anchor and all.
   *  A PATH, so the origin is added here — the same value the notification
   *  carries, and the two must land in the same place. */
  url: string
}

/**
 * A heading with its leading date taken off.
 *
 * Headings are written `8 September 2026 — what changed`, so the dash is the
 * separator. Split on the FIRST dash only: a title may well contain another one,
 * and taking the last would throw away most of the sentence. Anything not in
 * that shape is returned whole rather than guessed at.
 */
function headline(title: string): string {
  const m = /^[^—–-]*\d{4}\s*[—–-]\s*(.+)$/.exec(title)
  return (m ? m[1] : title).trim()
}

/** Ellipsised on a word boundary, so a subject that is still too long ends as a
 *  phrase rather than mid-word. */
function clamp(s: string, max: number): string {
  if (s.length <= max) return s
  const cut = s.slice(0, max - 1)
  const sp = cut.lastIndexOf(' ')
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).trimEnd()}…`
}

const notesUrl = (path: string): string => `${APP_ORIGIN}${path}`
const PREFS_URL = `${APP_ORIGIN}/settings`

export const releaseEmail = defineEmail<Props>({
  key: 'release',

  // The heading is the subject, minus its date. It is written to be read by a
  // rider already — "a place found along the route lands where the road passes
  // it" — so putting a second sentence in front of it would be saying it twice.
  //
  // **THE DATE COMES OFF AND THAT IS WHAT MAKES IT FIT.** A real heading runs to
  // about 79 characters on its own, which is over the one-line subject rule
  // before the product name is even in front of it — and a mail already carries
  // its own date in every client, so the prefix is the half that says nothing.
  // The clamp is the backstop for a heading that is long even without it.
  subject: ({ title }) => clamp(`Routeloop: ${headline(title)}`, 78),

  preheader: () => 'What changed in this build, and what to look at.',

  text: ({ title, url }) =>
    [
      title,
      '',
      `That is the headline. The full notes, with everything else in this build:`,
      notesUrl(url),
      '',
      `You are getting this because you turned release notes on. They are off by default — turn them back off here:`,
      PREFS_URL,
    ].join('\n'),

  html: ({ title, url }) =>
    (
      <>
        <P>
          <b>{title}</b>
        </P>
        <P>That is the headline. The full notes have everything else in this&nbsp;build.</P>
        <Button href={notesUrl(url)}>Read what changed</Button>
        <Muted>
          You are getting this because you turned release notes on — they are off by default. Change that in your{' '}
          <a href={PREFS_URL}>notification settings</a>.
        </Muted>
      </>
    ).toString(),

  sample: {
    title: '8 September 2026 — a place found along the route lands where the road passes it',
    url: '/release-notes#8-september-2026-a-place-found-along-the-route-lands-where-the-road-passes-it',
  },
})
