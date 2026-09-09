// The icon workbench: every mark in public/img/icons/, on every field it could
// legally be painted on.
//
// Internal and signed-in only, exactly like /brand and for the same reason — it
// is a workbench rather than a page with an audience, and a public route implies
// a promise to keep it presentable.
//
// **THE POINT OF IT IS THE PAIRING, NOT THE DRAWING.** These marks are two-tone:
// a disc in `currentColor` with the glyph knocked out in white. So a mark is
// never legible or illegible on its own — it is legible against a FIELD, and the
// field decides whether the knockout can stay white. Showing the drawings alone
// would leave exactly the question this page exists to answer.
//
// **BLACK-LEGEND FIELDS FLIP THE GLYPH HERE, THE SAME WAY THE REAL RULE DOES.**
// $warning carries white at about 1.4:1, which is #282, so a page that drew the
// amber column with a white glyph would be recommending the bug. The flip is the
// same `[fill="white"]` override _account.scss uses.
//
// Read from disk per request like src/views/icon.ts, so re-exporting a mark from
// the drawing tool and reloading shows the new one — `tsx watch` does not restart
// for an .svg.
import { Hono } from 'hono'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { currentUser, requireActive, type AuthEnv } from '../auth/middleware'
import { icon } from '../views/icon'
import { EVENTS } from '../notifications/catalog'
import { page } from '../views/layout'

export const iconRoutes = new Hono<AuthEnv>()

// The five fields audited to carry a WHITE legend and the four audited to carry
// a BLACK one, from test/palette-contrast.test.ts. Anything outside these two
// lists has not been measured against all six palettes and must not be offered
// here as though it had.
const WHITE_LEGEND = ['disabled', 'stop', 'interstate', 'tarmac', 'recreation']
const BLACK_LEGEND = ['warning', 'yield', 'detour', 'speed']

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Every mark on disk, by the name icon() takes. */
function iconNames(): string[] {
  return readdirSync(join(process.cwd(), 'public', 'img', 'icons'))
    .filter((f) => f.startsWith('icon-') && f.endsWith('.svg'))
    .map((f) => f.slice('icon-'.length, -'.svg'.length))
    .sort()
}

iconRoutes.get('/icons', requireActive, (c) => {
  const user = currentUser(c)
  const names = iconNames()

  // Which marks the notification catalog already spends, and on what tone, so
  // the page says what is DECIDED as well as what is possible.
  const inUse = new Map<string, string[]>()
  for (const e of EVENTS) {
    const at = inUse.get(e.icon) ?? []
    at.push(`${e.key} (${e.tone})`)
    inUse.set(e.icon, at)
  }

  const cell = (name: string, field: string, black: boolean) =>
    `<td class="ic-cell${black ? ' is-black' : ''}"><span class="ic-mark" style="color:var(--${esc(field)})">${icon(name)}</span></td>`

  const row = (name: string) => `
    <tr>
      <th scope="row">
        <code>${esc(name)}</code>
        ${inUse.has(name) ? `<span class="ic-used">${esc(inUse.get(name)!.join(', '))}</span>` : '<span class="ic-free">unused</span>'}
      </th>
      ${WHITE_LEGEND.map((f) => cell(name, f, false)).join('')}
      ${BLACK_LEGEND.map((f) => cell(name, f, true)).join('')}
    </tr>`

  const body = `
    <h1>Icons</h1>
    <p class="lede">
      Every mark in <code>public/img/icons/</code>, on every field measured to carry a legend. Read from disk when this
      page loads — re-export a mark and reload.
    </p>
    <p class="brand-sub">
      The five fields on the left carry a <strong>white</strong> legend and the four on the right a
      <strong>black</strong> one, from <code>test/palette-contrast.test.ts</code>. The glyph flips in the black columns
      exactly as <code>_account.scss</code> flips it, because a white knockout on <code>$warning</code> measures about
      1.4:1. What you see is the <strong>default light</strong> palette — one of six.
    </p>
    <p class="brand-sub">
      Each disc carries a hairline that is <em>not</em> part of the mark: <code>$speed</code> is a near-white field and
      its column is otherwise invisible against the page. Judge the glyph against the disc, not the disc against the
      page.
    </p>
    <div class="ic-scroll">
      <table class="ic-table">
        <thead>
          <tr>
            <th scope="col">Mark</th>
            ${WHITE_LEGEND.map((f) => `<th scope="col"><code>$${esc(f)}</code></th>`).join('')}
            ${BLACK_LEGEND.map((f) => `<th scope="col" class="is-black"><code>$${esc(f)}</code></th>`).join('')}
          </tr>
        </thead>
        <tbody>${names.map(row).join('')}</tbody>
      </table>
    </div>`

  return c.html(page({ title: 'Icons', user, body }))
})
