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
// amber column with a white glyph would be recommending the bug. The flip sets
// `--icon-ink`, the same property _account.scss sets.
//
// **NOT EVERY FILE IN THE FOLDER IS A BADGE, AND DRAWING THEM AS THOUGH THEY
// WERE IS WHAT PRODUCED THE INVISIBLE CELLS.** Ziad's call, 2026-09-09, off
// this page. Eight marks — close, collapse, expand, redo, reverse, undo,
// waypoint, waypoint-auto — are one path in `currentColor` with no disc and no
// knockout at all, so a field column asks a question they cannot answer: in the
// $speed column they rendered as #efefef on a near-white cell, and the flip had
// nothing to bite on. They get their own section, painted the way they are
// actually used, on the page ground. `vmc` is a third kind again and is listed
// with them: a club logo with a fixed palette and no `currentColor` anywhere,
// which is why views/icon.ts exempts it from the knockout normalization.
//
// Read from disk per request like src/views/icon.ts, so re-exporting a mark from
// the drawing tool and reloading shows the new one — `tsx watch` does not restart
// for an .svg.
import { Hono } from 'hono'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { currentUser, requireActive, type AuthEnv } from '../auth/middleware'
import { readFileSync } from 'node:fs'
import { contrast, parsePalettes } from '../views/tokens'
import { icon } from '../views/icon'
import { EVENTS } from '../notifications/catalog'
import { page } from '../views/layout'

export const iconRoutes = new Hono<AuthEnv>()

/**
 * The fields that can actually hold a glyph, MEASURED rather than listed.
 *
 * **THE TWO HAND LISTS IN test/palette-contrast.test.ts ARE NOT THE LIMIT, AND
 * TREATING THEM AS ONE IS WHAT SENT THIS PAGE OFF TO PICK HEXES.** Those name
 * the pairings that test asserts; they were never meant to enumerate what the
 * palette can do. Measured across all six palettes, twenty-four tokens hold a
 * legend at 4.5:1 — eleven white and thirteen black — against the nine those
 * lists carry.
 *
 * **THERE IS NO PAGE-CONTRAST REQUIREMENT HERE, DELIBERATELY.** A first version
 * of this also demanded the disc clear the page ground at 3:1 and returned a
 * list of eleven oddities with $disabled and $stop not among them — the three
 * fields the centre already draws. A disc carrying a high-contrast glyph does
 * not have to clear the page: the glyph is what is being read, and the disc is
 * its ground. That rule belongs to the role ring, where the bar IS the data.
 *
 * Read from the BUILT stylesheet, because this runs in a request — see
 * parsePalettes.
 */
const AA = 4.5

type Field = { name: string; legend: 'white' | 'black'; ratio: number }

function legendFields(): { fields: Field[]; palettes: number } {
  const palettes = parsePalettes(readFileSync(join(process.cwd(), 'public', 'style', 'main.min.css'), 'utf8'))
  const first = [...palettes.values()][0]
  if (!first) return { fields: [], palettes: 0 }
  const out: Field[] = []
  for (const name of first.keys()) {
    let white = Infinity
    let black = Infinity
    let usable = true
    for (const vals of palettes.values()) {
      const field = vals.get(name)
      const w = field ? contrast(field, '#ffffff') : null
      const b = field ? contrast(field, '#000000') : null
      if (w == null || b == null) {
        usable = false
        break
      }
      white = Math.min(white, w)
      black = Math.min(black, b)
    }
    if (!usable) continue
    if (white >= AA) out.push({ name, legend: 'white', ratio: white })
    else if (black >= AA) out.push({ name, legend: 'black', ratio: black })
  }
  return { fields: out.sort((a, b) => b.ratio - a.ratio), palettes: palettes.size }
}

// The tone-to-field mapping, mirroring the rules in _account.scss. Two copies,
// because that one paints the real page and this one only describes it — but
// they have to agree, or the swatch beside a name recommends a colour the centre
// does not use. Anything unassigned draws in the default.
const TONE_FIELD: Record<string, string> = { info: 'disabled', warn: 'warning', stop: 'stop' }

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Every mark on disk, by the name icon() takes. */
function iconNames(): string[] {
  return readdirSync(join(process.cwd(), 'public', 'img', 'icons'))
    .filter((f) => f.startsWith('icon-') && f.endsWith('.svg'))
    .map((f) => f.slice('icon-'.length, -'.svg'.length))
    .sort()
}

/**
 * What KIND of mark this is, read off the drawing rather than listed.
 *
 * A `badge` has a knockout, so views/icon.ts has exposed it as `--icon-ink` and
 * the field table is a real question about it. A `glyph` is one path in
 * `currentColor` with no disc — a chrome mark, painted with `color:` on the page
 * ground, which has no legend and no field to clear. A `logo` is fixed-palette
 * artwork the loader deliberately leaves alone.
 *
 * DERIVED, so a mark redrawn with a disc moves sections on reload rather than
 * needing a name added to a list here — which is the same property that makes
 * the whole page read from disk per request.
 */
type Kind = 'badge' | 'glyph' | 'logo'

function kindOf(name: string): Kind {
  const svg = icon(name)
  if (svg.includes('--icon-ink')) return 'badge'
  // No knockout the loader could reach. Either it has no white at all (a chrome
  // glyph) or its whites are artwork it was exempted from (a logo).
  return /(?:fill|stroke)="(?:white|#fff|#ffffff)"/i.test(svg) ? 'logo' : 'glyph'
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

  // EVERY field a mark is painted in today, not the first one. `storage` is the
  // reason: it is drawn amber for the quota warning and red for the two
  // destructions, so showing one swatch for it would misreport the only mark
  // that actually carries two. A reserved mark has no event and takes the
  // default.
  const toneFields = (name: string): string[] => {
    const tones = [...new Set(EVENTS.filter((e) => e.icon === name).map((e) => e.tone))]
    if (tones.length === 0) return ['disabled']
    return tones.map((t) => TONE_FIELD[t] ?? 'disabled')
  }

  const { fields, palettes: paletteCount } = legendFields()

  const cell = (name: string, f: Field) =>
    `<td class="ic-cell${f.legend === 'black' ? ' is-black' : ''}"><span class="ic-mark" style="color:var(--${esc(f.name)})">${icon(name)}</span></td>`

  const heads = () =>
    fields
      .map(
        (f) =>
          `<th scope="col"${f.legend === 'black' ? ' class="is-black"' : ''}><code>$${esc(f.name)}</code><span class="ic-hex">${f.legend} ${f.ratio.toFixed(1)}</span></th>`,
      )
      .join('')

  const row = (name: string) => `
    <tr>
      <th scope="row">
        <code>${esc(name)}</code>
        ${inUse.has(name) ? `<span class="ic-used">${esc(inUse.get(name)!.join(', '))}</span>` : '<span class="ic-free">unused</span>'}
      </th>
      ${fields.map((f) => cell(name, f)).join('')}
    </tr>`

  // Marks the notification centre will draw. The catalog is the source for the
  // ones spent today; RESERVED is the short list his nine included for events
  // that do not exist yet, named with the issue that will bring them — a mark
  // with no event is not a mistake here, it is a decision made early.
  const RESERVED: ReadonlyArray<readonly [string, string]> = [
    ['road', 'road conditions and closures — #48, #53'],
    ['weather', 'weather along a dated ride — #24'],
  ]
  const notifMarks = [...new Set(EVENTS.map((e) => e.icon)), ...RESERVED.map(([n]) => n)]

  const notifRow = (name: string) => {
    const reserved = RESERVED.find(([n]) => n === name)
    return `
    <tr>
      <th scope="row">
        ${toneFields(name)
          .map((f) => `<span class="ic-real" style="color:var(--${esc(f)})">${icon(name)}</span>`)
          .join('')}
        <code>${esc(name)}</code>
        ${
          reserved
            ? `<span class="ic-free">reserved · ${esc(reserved[1])}</span>`
            : `<span class="ic-used">${esc(inUse.get(name)!.join(', '))}</span>`
        }
      </th>
      ${fields.map((f) => cell(name, f)).join('')}
    </tr>`
  }

  // Three kinds, and only the first has a legend to get wrong.
  const byKind = { badge: [] as string[], glyph: [] as string[], logo: [] as string[] }
  for (const n of names) byKind[kindOf(n)].push(n)

  // The marks the field table cannot ask a question about, painted the way they
  // are actually used: `currentColor` on the page ground. A row per mark rather
  // than a column per field, because there is no field.
  const plainRow = (name: string, kind: Kind) => `
    <li class="ic-plain">
      <span class="ic-mark ic-mark--plain">${icon(name)}</span>
      <code>${esc(name)}</code>
      <span class="ic-free">${kind === 'logo' ? 'fixed palette' : 'no knockout'}</span>
    </li>`

  const body = `
    <h1>Icons</h1>
    <p class="lede">
      Every mark in <code>public/img/icons/</code>, on every field measured to carry a legend. Read from disk when this
      page loads — re-export a mark and reload.
    </p>
    <p class="brand-sub">
      Every field that can hold a glyph, <strong>measured</strong> across all ${paletteCount} palettes rather than
      listed by hand — ${fields.filter((f) => f.legend === 'white').length} take a white one and
      ${fields.filter((f) => f.legend === 'black').length} take black, at 4.5:1 in the worst of the six. The head of
      each column says which and at what ratio. The glyph flips in the black columns exactly as
      <code>_account.scss</code> flips it, because a white knockout on <code>$warning</code> measures about 1.4:1. The
      discs are drawn in the <strong>default light</strong> palette; the ratios are the worst case across all six.
    </p>
    <p class="brand-sub">
      Each disc carries a hairline that is <em>not</em> part of the mark: <code>$speed</code> is a near-white field and
      its column is otherwise invisible against the page. Judge the glyph against the disc, not the disc against the
      page.
    </p>
    <h2>The notification marks</h2>
    <p class="brand-sub">
      The ${notifMarks.length} the centre draws, or will. The mark beside each name is at the size it actually renders
      there — <strong>26px</strong> — in the field it is assigned today, because a colour that works at 30px in a table
      can disappear at the size a rider sees.
    </p>
    <div class="ic-scroll">
      <table class="ic-table ic-table--notif">
        <thead>
          <tr>
            <th scope="col">Mark</th>
            ${heads()}
          </tr>
        </thead>
        <tbody>${notifMarks.map(notifRow).join('')}</tbody>
      </table>
    </div>

    <h2>Every badge mark</h2>
    <p class="brand-sub">
      The ${byKind.badge.length} marks in the folder that are two-tone — a disc in <code>color</code> with the glyph
      knocked out in <code>--icon-ink</code>. These are the only ones a field column asks a real question about.
    </p>
    <div class="ic-scroll">
      <table class="ic-table">
        <thead>
          <tr>
            <th scope="col">Mark</th>
            ${heads()}
          </tr>
        </thead>
        <tbody>${byKind.badge.map(row).join('')}</tbody>
      </table>
    </div>

    <h2>Not badge marks</h2>
    <p class="brand-sub">
      The other ${byKind.glyph.length + byKind.logo.length}, and they are <strong>deliberately not in the table
      above</strong>. ${byKind.glyph.length} are a single path in <code>currentColor</code> with no disc and no
      knockout — chrome marks, painted with <code>color</code> on the page ground — so there is no field to clear and
      no legend to flip; drawing them across the field columns is what produced the invisible cells. ${
        byKind.logo.length
      } is fixed-palette artwork that <code>views/icon.ts</code> exempts from the knockout normalization, because
      recoloring somebody else&rsquo;s logo is not a legend decision. Shown here at the page&rsquo;s own ink.
    </p>
    <ul class="ic-plain-list">
      ${byKind.glyph.map((n) => plainRow(n, 'glyph')).join('')}
      ${byKind.logo.map((n) => plainRow(n, 'logo')).join('')}
    </ul>`

  return c.html(page({ title: 'Icons', user, body }))
})
