// EVERY RELEASE IN src/content/release-notes.html, AS SOMETHING THAT CAN BE
// ANNOUNCED, PLUS THE ANCHORS THAT LET A NOTIFICATION LINK TO ONE.
//
// Pure — a function of the file's text and nothing else — so it is testable
// under the house rule that governs test/. Reading the file and inserting rows
// both live in ../notifications/announce.ts.
//
// **THE PAGE KEEPS 100% OF THE NOTES AND A NOTIFICATION CARRIES A REFERENCE.**
// Ziad's call, 2026-09-09. Thirty-one of the forty-two sections are longer than
// the 400-character `body` column and the largest is over six thousand, so a
// release cannot be stored whole in a row — and the two ways round that are both
// worse than linking: one row per bullet scatters a release into a list of
// unrelated lines, and widening the column puts authored HTML somewhere every
// other consumer escapes it.
//
// **COMMENTS ARE MASKED BEFORE SEARCHING, AND THIS IS THE THIRD PLACE THAT TRAP
// HAS BEEN HIT.** The file opens with its own authoring contract as an HTML
// comment, and that contract contains a worked example of a stamped release
// block — so a naive search finds the EXAMPLE and announces "24 August 2026" to
// every rider. utils/stamp-release.ts masks for the same reason and would have
// rewritten the documentation instead of the release; test/content.test.ts
// strips comments for the same reason again. The mask preserves length so
// indices into it stay valid in the original.
const maskComments = (html: string): string => html.replace(/<!--[^]*?-->/g, (c) => ' '.repeat(c.length))

/** What a release looks like once it is something to tell riders about. */
export type Release = {
  /** The stable id, the anchor on the page, and what makes announcing
   *  idempotent. See releaseId. */
  id: string
  /** The heading as a rider reads it, with the build stamp taken back off. */
  title: string
  /** One or two sentences, derived from the release's own first bullet. */
  summary: string
  /** When it shipped, read out of the heading. Epoch milliseconds, UTC. */
  at: number
}

/**
 * The release's identity, its anchor, and the whole of what stops it being
 * announced twice.
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

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
]

/**
 * When a release shipped, from its own heading.
 *
 * **THE DATE IS WHAT PUTS IT IN THE LIST, so this cannot fall back to "now".**
 * The center orders by `created_at`, and a backfill stamped with the moment it
 * ran would put forty-two releases in a block at the top in file order, which is
 * the opposite of mixing them chronologically with everything else.
 *
 * Two shapes, because the file has two. "8 September 2026" is every entry the
 * house style has produced; "Before all that, July 2026" is the single oldest
 * catch-all, and a month with no day is taken as the FIRST of it — which puts it
 * before everything that names a day in the same month, and it is the earliest
 * entry in the file either way.
 *
 * **MIDDAY UTC, NOT MIDNIGHT, AND THAT IS THE WHOLE OF WHY THE HOUR IS HERE.**
 * `notifications.created_at` is a real instant and the center renders it in the
 * RIDER'S zone — unlike `routes.start_at`, which is a wall clock read back with
 * `timeZone: 'UTC'`. Stamped at midnight a release dated 8 September renders as
 * the 7th to everybody west of Greenwich, which is what this file's own dev run
 * showed. Noon renders as the authored date from UTC-11 through UTC+11, which is
 * every rider there is.
 *
 * Null when neither shape matches, which `test/releases.test.ts` asserts never
 * happens for the shipped file — and it is DROPPED rather than given a fallback,
 * because a release that cannot be placed chronologically would be ordered
 * wrongly and look like a data problem rather than an authoring one.
 */
export function releaseDate(title: string): number | null {
  const dmy = /(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/.exec(title)
  if (dmy) {
    const m = MONTHS.indexOf(dmy[2].toLowerCase())
    if (m >= 0) return Date.UTC(Number(dmy[3]), m, Number(dmy[1]), 12)
  }
  const my = /([A-Za-z]+)\s+(\d{4})/.exec(title)
  if (my) {
    const m = MONTHS.indexOf(my[1].toLowerCase())
    if (m >= 0) return Date.UTC(Number(my[2]), m, 1, 12)
  }
  return null
}

/**
 * Every release in the file, newest first — the order the file itself is in.
 *
 * Sorted by nothing: the file is authored newest-at-the-top and that order is
 * what a reader of the page sees, so re-sorting here would let the two disagree.
 * `at` is what the center orders by once these are rows.
 */
export function allReleases(html: string): Release[] {
  const masked = maskComments(html)
  const out: Release[] = []
  const re = /<section class="rn-release">([^]*?)<\/section>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(masked)) !== null) {
    const body = html.slice(m.index + m[0].indexOf('>') + 1, m.index + m[0].lastIndexOf('</section>'))
    const head = /<h3>([^]*?)<\/h3>/.exec(body)
    if (!head) continue
    const title = stripStamp(head[1])
    if (!title) continue
    const at = releaseDate(title)
    if (at === null) continue
    out.push({ id: releaseId(title), title, summary: summarize(body), at })
  }
  return out
}

/**
 * The newest release, or null when there is not one to announce.
 *
 * Null is a real answer and not a failure: a file with no release section at all
 * is what a fresh checkout of this app would have, and announcing nothing is
 * correct there.
 */
export function latestRelease(html: string): Release | null {
  return allReleases(html)[0] ?? null
}

/**
 * A release's own first bullet, as one or two sentences.
 *
 * **DERIVED RATHER THAN AUTHORED, so it cannot drift.** Forty-two hand-written
 * summaries is forty-two more things to keep in step with the notes they
 * summarize, and the first bullet is already written as the headline change —
 * thirty-one of the forty-two open with a `<strong>` lead that is exactly this
 * sentence. The eleven that do not still open with a plain readable one.
 *
 * Cut on a SENTENCE boundary and only then on a word, so a summary ends as
 * something somebody wrote rather than mid-clause.
 */
function summarize(sectionHtml: string): string {
  const li = /<li>([^]*?)<\/li>/.exec(sectionHtml)
  const text = plain(li ? li[1] : sectionHtml)
  if (text.length <= SUMMARY_MAX) return text
  // Two sentences at most, and only while they fit.
  let cut = ''
  for (const part of text.split(/(?<=[.!?])\s+/).slice(0, 2)) {
    // The JOINED length, including the space — measuring `cut + part` let a
    // two-sentence summary land one character over the cap.
    const joined = cut ? `${cut} ${part}` : part
    if (joined.length > SUMMARY_MAX) break
    cut = joined
  }
  if (cut) return cut
  const hard = text.slice(0, SUMMARY_MAX - 1)
  const sp = hard.lastIndexOf(' ')
  return `${(sp > SUMMARY_MAX * 0.6 ? hard.slice(0, sp) : hard).trimEnd()}…`
}

/** Comfortably inside the 400-character `body` column, and short enough to read
 *  as a line in a list rather than as the release itself. */
const SUMMARY_MAX = 220

/**
 * Give every release section the id its notification links to.
 *
 * **INJECTED AT RENDER, NOT WRITTEN INTO THE FILE.** The anchor has to equal
 * `releaseId(title)` exactly or a notification links to nothing, and an id
 * somebody types by hand is one transposed character from that — the same
 * argument `stamp-release.ts` makes about the commit. It also leaves the
 * authoring contract at the top of the file true as written: copy the block,
 * fill it in, and the anchor exists.
 *
 * A section that already carries an id is left alone, so this is safe to run
 * twice and safe if the file ever gains hand-written ones.
 */
export function withAnchors(html: string): string {
  const masked = maskComments(html)
  const re = /<section class="rn-release"(\s[^>]*)?>/g
  let out = ''
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(masked)) !== null) {
    const tag = html.slice(m.index, m.index + m[0].length)
    out += html.slice(last, m.index)
    last = m.index + m[0].length
    if (/\sid=/.test(tag)) {
      out += tag
      continue
    }
    const rest = html.slice(m.index)
    const head = /<h3>([^]*?)<\/h3>/.exec(rest)
    const title = head ? stripStamp(head[1]) : ''
    out += title ? `<section class="rn-release" id="${releaseId(title)}">` : tag
  }
  return out + html.slice(last)
}

/**
 * The heading as prose: the build stamp and the commit link taken off, entities
 * decoded to the characters they stand for.
 */
function stripStamp(heading: string): string {
  return plain(heading.replace(/<a class="rn-sha"[^]*?<\/a>/g, '').replace(/<code>[^<]*<\/code>/g, ''))
}

/**
 * The entities the notes actually use, and nothing else.
 *
 * **DECODED, WHICH REVERSED AFTER ONE BUILD.** The first version left them
 * alone, reasoning that the title is rendered into HTML by the center — but
 * views are Hono JSX and JSX ESCAPES BY DEFAULT, so what a rider actually saw
 * was the literal text "8 September 2026 &mdash; a place found…". The stored
 * title and summary are PROSE, and every consumer escapes them: the center, the
 * email's HTML arm, and the email's text arm, which could not have taken an
 * entity at all.
 *
 * A TABLE RATHER THAN A GENERAL DECODER. This reads one authored file whose
 * vocabulary is known, and a general one would have to decide what to do with
 * `&lt;` — the one case where decoding turns stored prose back into something a
 * careless consumer could render as markup.
 */
const ENTITIES: ReadonlyArray<readonly [RegExp, string]> = [
  [/&mdash;/g, '—'],
  [/&ndash;/g, '–'],
  [/&nbsp;/g, ' '],
  [/&rsquo;/g, '’'],
  [/&lsquo;/g, '‘'],
  [/&ldquo;/g, '“'],
  [/&rdquo;/g, '”'],
  [/&hellip;/g, '…'],
  [/&rarr;/g, '→'],
  // Last, or it would decode the ampersand of every entity above it.
  [/&amp;/g, '&'],
]

/** Tags out, entities decoded, whitespace collapsed. */
function plain(html: string): string {
  const bare = html
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return ENTITIES.reduce((out, [re, ch]) => out.replace(re, ch), bare).replace(/&#(\d+);/g, (_, n) =>
    String.fromCodePoint(Number(n)),
  )
}
