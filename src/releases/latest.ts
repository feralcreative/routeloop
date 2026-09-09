// THE TOP RELEASE IN src/content/release-notes.html, AS SOMETHING THAT CAN BE
// ANNOUNCED.
//
// Pure — a function of the file's text and nothing else — so it is testable
// under the house rule that governs test/. Reading the file and inserting rows
// both live in ../notifications/announce.ts.
//
// **COMMENTS ARE MASKED BEFORE SEARCHING, AND THIS IS THE THIRD PLACE THAT TRAP
// HAS BEEN HIT.** The file opens with its own authoring contract as an HTML
// comment, and that contract contains a worked example of a stamped release
// block — so a naive search finds the EXAMPLE and announces "24 August 2026" to
// every rider on the first deploy. utils/stamp-release.ts masks for the same
// reason and would have rewritten the documentation instead of the release;
// test/content.test.ts strips comments for the same reason again. The mask
// preserves length so indices into it stay valid in the original.
const maskComments = (html: string): string => html.replace(/<!--[^]*?-->/g, (c) => ' '.repeat(c.length))

/** What a release looks like once it is something to tell riders about. */
export type Release = {
  /** The stable id, and what makes announcing idempotent. See releaseId. */
  id: string
  /** The heading as a rider reads it, with the build stamp taken back off. */
  title: string
}

/**
 * The release's identity, and the whole of what stops it being announced twice.
 *
 * **THE HEADING, NOT THE BUILD.** `BUILD_SHA` is the identity of the running
 * CODE, and every deploy has a new one whether or not a release note was
 * written — so keying on it announces the same unchanged entry again on the next
 * unrelated deploy. The heading is the identity of the ENTRY, which is the thing
 * a rider is being told about.
 *
 * **THE HEADING RATHER THAN THE WHOLE SECTION**, which would also be stable and
 * is the wrong sensitivity: fixing a typo in a bullet would re-announce a
 * release every rider has already read. A heading is edited rarely and
 * deliberately, so keying on it puts re-announcing behind an act that looks like
 * one.
 *
 * The stamp is stripped first, so running `stamp-release.ts` after a deploy —
 * which is the documented order — does not mint a second id for one release.
 */
export function releaseId(title: string): string {
  return title
    .toLowerCase()
    .replace(/&[a-z]+;|&#\d+;/g, ' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120)
}

/**
 * The newest release in the notes, or null when there is not one to announce.
 *
 * Null is a real answer and not a failure: a file with no release section at all
 * is what a fresh checkout of this app would have, and announcing nothing is
 * correct there. The caller does not have to tell that apart from an error
 * because there is no error to tell it apart from.
 */
export function latestRelease(html: string): Release | null {
  const masked = maskComments(html)
  // The FIRST heading of the FIRST release section. `[^]` rather than `.` with
  // the s flag, so a heading prettier has wrapped across lines still matches —
  // which is what a stamp appended to a long one produces.
  const m = /<section class="rn-release">\s*<h3>([^]*?)<\/h3>/.exec(masked)
  if (!m) return null
  const raw = html.slice(m.index + m[0].indexOf('<h3>') + 4, m.index + m[0].lastIndexOf('</h3>'))
  const title = stripStamp(raw)
  if (!title) return null
  return { id: releaseId(title), title }
}

/**
 * The entities the notes actually use, and nothing else.
 *
 * **DECODED HERE, WHICH REVERSES WHAT THIS FUNCTION DID FOR ONE BUILD.** The
 * first version left them alone, reasoning that the title is rendered into HTML
 * by the centre — but views are Hono JSX and JSX ESCAPES BY DEFAULT, so what a
 * rider actually saw was the literal text "8 September 2026 &mdash; a place
 * found…". The stored title is PROSE, and every consumer escapes it: the centre,
 * the email's HTML arm, and the email's text arm, which could not have taken an
 * entity at all.
 *
 * A TABLE RATHER THAN A GENERAL DECODER. This reads one authored file whose
 * vocabulary is known, and a general one would have to decide what to do with
 * `&lt;` — which is the one case where decoding turns stored prose back into
 * something a careless consumer could render as markup.
 */
const ENTITIES: ReadonlyArray<readonly [RegExp, string]> = [
  [/&mdash;/g, '\u2014'],
  [/&ndash;/g, '\u2013'],
  [/&nbsp;/g, '\u00a0'],
  [/&rsquo;/g, '\u2019'],
  [/&lsquo;/g, '\u2018'],
  [/&ldquo;/g, '\u201c'],
  [/&rdquo;/g, '\u201d'],
  [/&hellip;/g, '\u2026'],
  [/&rarr;/g, '\u2192'],
  // Last, or it would decode the ampersand of every entity above it.
  [/&amp;/g, '&'],
]

const decodeEntities = (s: string): string =>
  ENTITIES.reduce((out, [re, ch]) => out.replace(re, ch), s).replace(/&#(\d+);/g, (_, n) =>
    String.fromCodePoint(Number(n)),
  )

/**
 * The heading as prose: the build stamp and the commit link taken off, entities
 * decoded to the characters they stand for.
 */
function stripStamp(heading: string): string {
  const bare = heading
    .replace(/<a class="rn-sha"[^]*?<\/a>/g, '')
    .replace(/<code>[^<]*<\/code>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return decodeEntities(bare)
}
