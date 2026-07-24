// Shared HTML shell. The viewer page deliberately does NOT use this — it has its
// own full-bleed map layout — but every chrome page (home, login, dashboard)
// does, so the header and auth state stay consistent.
import type { UserRow } from '../db/schema'

export const esc = (s: unknown): string =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  )

const CHROME_CSS = `
  body { font: 400 16px/1.5 Lato, system-ui, sans-serif; margin: 0; padding: 2rem; color: #333; background: #f4f4f4; }
  a { color: #06c; }
  h1 { margin: 0 0 0.25rem; }
  .sub { color: #777; margin-bottom: 2rem; }
  .topbar { display: flex; align-items: baseline; gap: 1rem; max-width: 640px; margin-bottom: 2rem; }
  .topbar .spacer { margin-left: auto; }
  .topbar form { display: inline; }
  .linkbtn { background: none; border: 0; padding: 0; font: inherit; color: #06c; cursor: pointer; text-decoration: underline; }
  ul.cards { list-style: none; padding: 0; display: grid; gap: 0.75rem; max-width: 640px; }
  ul.cards li { background: #fff; border-radius: 10px; box-shadow: 0 1px 4px rgba(0, 0, 0, 0.1); }
  a.card { display: flex; align-items: center; gap: 0.75rem; padding: 1rem; text-decoration: none; color: inherit; }
  .swatch { width: 14px; height: 14px; border-radius: 50%; flex: 0 0 auto; }
  .meta { color: #888; font-size: 0.85em; margin-left: auto; }
  .pill { font-size: 0.75em; text-transform: uppercase; letter-spacing: 0.04em; padding: 0.1rem 0.45rem; border-radius: 999px; background: #eee; color: #666; }
  .empty { color: #999; }
  .provider { display: block; max-width: 320px; margin-bottom: 0.75rem; padding: 0.85rem 1rem; text-align: center;
              background: #fff; border: 1px solid #ddd; border-radius: 8px; text-decoration: none; color: #333; font-weight: 700; }
  .provider:hover { border-color: #bbb; }
  .note { color: #999; font-size: 0.9em; max-width: 480px; }
  .btn { display: inline-block; background: #06c; color: #fff; border: 0; border-radius: 8px;
         padding: 0.6rem 1.2rem; font: inherit; font-weight: 700; text-decoration: none; cursor: pointer; }
  .btn:hover { background: #05a; }
  .cardrow { display: flex; align-items: center; }
  .cardrow .card { flex: 1; }
  .editlink { padding: 0 1rem; font-size: 0.85em; }
`

function header(user: UserRow | null): string {
  const right = user
    ? `<span class="spacer"></span><a href="/dashboard">${esc(user.displayName)}</a>
       <form method="post" action="/logout"><button class="linkbtn" type="submit">Sign out</button></form>`
    : `<span class="spacer"></span><a href="/login">Sign in</a>`
  return `<div class="topbar"><a href="/"><strong>tankbag</strong></a>${right}</div>`
}

export function page(opts: { title: string; user: UserRow | null; body: string }): string {
  return `<!doctype html>
<html lang="en-US">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(opts.title)}</title>
  <link href="https://fonts.googleapis.com/css?family=Lato:300,400,700,900" rel="stylesheet">
  <style>${CHROME_CSS}</style>
</head>
<body>
${header(opts.user)}
${opts.body}
</body>
</html>`
}
