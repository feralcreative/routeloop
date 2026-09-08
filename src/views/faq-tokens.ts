// The tokens `src/content/faq.html` carries, in one place.
//
// TWO READERS NOW, WHICH IS WHY IT MOVED HERE. `/faq` renders the whole file,
// and `faqLink()` in ./layout.tsx pulls a single answer out of it for a popover
// (#268). `content()` throws on an unsupplied token rather than leaving
// `{{FOO}}` visible, so the second reader has to supply the same set as the
// first — and a second copy of the years would go stale independently, which is
// exactly what stating them as durations was for.
//
// Computed on the server rather than in the browser so there is no flash of the
// wrong number and the page still reads correctly with JS off.
const yearsSince = (year: number): number => new Date().getFullYear() - year

/** Worked out per call, not at module load: a process that has been up since
 *  December must not still be saying last year's number in January. */
export const faqTokens = () => ({ RIDING_YEARS: yearsSince(1999), WEB_YEARS: yearsSince(1993) })
