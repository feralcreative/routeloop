// Widows, for the surfaces CSS cannot reach.
//
// The app's default answer is `text-wrap: pretty`, set on body copy in
// style/_base.scss, and it covers every page rendered in a browser. Two surfaces
// sit outside it: email, where no mail client supports the property, and the
// printed half of the roadbook, where a print engine cannot be relied on for it.
// Both bind the last two words of a paragraph with a non-breaking space instead,
// so the last word cannot be stranded alone on a line.
//
// Static JSX copy does NOT need this function. Writing `&nbsp;` straight into
// the markup works here: esbuild decodes the entity to U+00A0 while transpiling
// (verified 2026-08-19), and Hono's escaping leaves the character alone. Prefer
// that — the entity is visible in a diff and a raw U+00A0 in source is not.
//
// This exists for the strings the entity cannot reach: a constant shared between
// an email's HTML and text arms, where only the HTML arm should carry the
// character. Plain text has no line-breaking engine to defeat, and a stray
// non-breaking byte in a text/plain part is a liability rather than a fix.
const NBSP = '\u00a0'

/**
 * Bind the last two words of `s` with a non-breaking space.
 *
 * Only the last space is touched. Binding more pairs than that stops preventing
 * a widow and starts causing horizontal overflow, because a bound run cannot
 * break at any width.
 *
 * Returns the string unchanged when there is nothing to bind — a single word, or
 * an empty string. Trailing whitespace is ignored when finding the pair but is
 * preserved in the result, so this is safe to apply to copy that is concatenated.
 */
export function noWidow(s: string): string {
  const i = s.trimEnd().lastIndexOf(' ')
  if (i === -1) return s
  return s.slice(0, i) + NBSP + s.slice(i + 1)
}
