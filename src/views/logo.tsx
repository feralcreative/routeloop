// The wordmark, in whichever ink the scheme needs.
//
// TWO <img>s AND A STYLESHEET RULE, NOT <picture>. A `<source media="(prefers-color-scheme: dark)">`
// would follow the OS and ignore a rider who chose light on a dark machine —
// the case `_theme.scss` is written twice to get right — and an `<img>` cannot
// take its `src` from a custom property. So both files are in the markup and
// `.logo-light` / `.logo-dark` in `_theme.scss` show one, keyed on exactly the
// selectors the palette switches on. Solved without JavaScript for the reason
// that file gives: a script deciding the artwork flashes the wrong one first.
//
// The suffix names the GROUND, not the ink: no suffix is the dark artwork for a
// light ground and `-dk` is the reversed white one for a dark ground. See the
// note above `siteHeader()` in layout.tsx. #317.
type Mark = 'hz' | 'stacked'

const FILE: Record<Mark, { light: string; dark: string; w: number; h: number }> = {
  hz: { light: '/img/logo-routeloop-hz.svg', dark: '/img/logo-routeloop-hz-dk.svg', w: 1500, h: 184 },
  stacked: { light: '/img/logo-routeloop.svg', dark: '/img/logo-routeloop-dk.svg', w: 920, h: 518 },
}

/** Both inks of the mark; the stylesheet shows the one the scheme wants.
 *  `alt` goes on both — one is always hidden, so a screen reader meets it once. */
export function wordmark(mark: Mark, alt: string, className = ''): string {
  const f = FILE[mark]
  const cls = (ink: string) => (className ? `${className} ${ink}` : ink)
  return (
    <>
      <img class={cls('logo-light')} src={f.light} alt={alt} width={f.w} height={f.h} />
      <img class={cls('logo-dark')} src={f.dark} alt={alt} width={f.w} height={f.h} />
    </>
  ).toString()
}
