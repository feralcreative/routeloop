#!/usr/bin/env node
//
// American English, enforced.
//
// **A MEMORY WAS NOT ENOUGH, WHICH IS WHY THIS IS A SCRIPT.** "American English
// everywhere in code, comments, copy and docs" has been a line in AGENTS.md
// since the repo was young, and the repo still carried around 110 British
// spellings across 30 files: in comments, in release notes a rider reads, and
// in an email telling somebody their account deletion is "cancelled". A rule
// that is only written down is checked only when somebody remembers to look.
// The em-dash tightener and the smart-quote sweeper are the two prose rules
// that DO hold, and both hold because a script runs them. This is the third,
// built the same way and wired into the same hook.
//
// **THE LIST IS EXPLICIT AND THAT IS THE WHOLE DESIGN.** A blanket `ise` to
// `ize` rule is wrong in both directions: `advertise`, `compromise`,
// `exercise`, `franchise`, `improvise`, `merchandise`, `supervise` and
// `surprise` are spelled that way in American English too, and `analysis`,
// `cancellation` and `optimistic` are already correct. Every pair below is one
// somebody wrote down.
//
// **THREE EXEMPTIONS, EACH FOR A DIFFERENT REASON:**
//   - `labelledby` is the HTML attribute `aria-labelledby`. It is a spec name
//     rather than prose, and "correcting" it breaks the accessibility tree. It
//     is safe by construction here: the table matches whole words, and
//     `labelledby` is not one.
//   - `grey` is replaced in prose only. `$grey` is an SCSS identifier AGENTS.md
//     exempts by name, and `--grey`, `.grey` and `greyLevel` are the same claim
//     in other syntaxes, so its pattern refuses a `$`, `-` or `.` in front and
//     a word character on either side. **QUOTES ARE REFUSED TOO, and that one
//     was found by reading the diff rather than by reasoning**: `_palette.scss`
//     carries `"grey": $grey` in the sign-set map, so a sweep that took the KEY
//     would break every `map.get($s, "grey")` reading it — a Sass build error
//     rather than a silent one, but a rename of an identifier all the same.
//     A trailing `:` is refused for the same reason and was found the same way:
//     `src/emails/theme.ts` declares `grey: TOKEN_COLORS['neutral-88']`, and the
//     lookbehind already protected every READ of it (`COLORS.grey`), so taking
//     the declaration alone renamed one half of a pair. `test/email-theme.ts`
//     caught it, which is the argument for the test existing at all.
//     A BACKTICK is refused on the same principle rather than as a convenience:
//     a code span NAMES an identifier, so `$grey` and `grey` inside one are the
//     token being discussed and not a color being described in prose.
//   - URLs are left alone whole. A British spelling inside a link is somebody
//     else's spelling, and correcting it turns a working link into a 404.
//
// Usage:  node utils/us-english.mjs --check [files...]
//         node utils/us-english.mjs --write [files...]
// With no files it reads every tracked file the pre-commit hook cares about.
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const PAIRS = {
  // -our
  colour: 'color',
  colours: 'colors',
  coloured: 'colored',
  colouring: 'coloring',
  colourful: 'colorful',
  behaviour: 'behavior',
  behaviours: 'behaviors',
  favourite: 'favorite',
  favourites: 'favorites',
  favour: 'favor',
  favoured: 'favored',
  favours: 'favors',
  honour: 'honor',
  honoured: 'honored',
  honours: 'honors',
  humour: 'humor',
  neighbour: 'neighbor',
  neighbours: 'neighbors',
  rumour: 'rumor',
  flavour: 'flavor',
  flavours: 'flavors',
  harbour: 'harbor',
  labour: 'labor',
  odour: 'odor',
  vapour: 'vapor',
  armour: 'armor',
  endeavour: 'endeavor',
  savour: 'savor',
  // -re
  centre: 'center',
  centres: 'centers',
  centred: 'centered',
  centring: 'centering',
  metre: 'meter',
  metres: 'meters',
  kilometre: 'kilometer',
  kilometres: 'kilometers',
  litre: 'liter',
  litres: 'liters',
  theatre: 'theater',
  fibre: 'fiber',
  // doubled consonant
  labelled: 'labeled',
  labelling: 'labeling',
  cancelled: 'canceled',
  cancelling: 'canceling',
  travelled: 'traveled',
  travelling: 'traveling',
  traveller: 'traveler',
  travellers: 'travelers',
  modelled: 'modeled',
  modelling: 'modeling',
  signalled: 'signaled',
  signalling: 'signaling',
  fuelled: 'fueled',
  fuelling: 'fueling',
  marvelled: 'marveled',
  levelled: 'leveled',
  levelling: 'leveling',
  dialled: 'dialed',
  dialling: 'dialing',
  // -ise / -yse
  organise: 'organize',
  organised: 'organized',
  organising: 'organizing',
  organisation: 'organization',
  organisations: 'organizations',
  recognise: 'recognize',
  recognised: 'recognized',
  recognising: 'recognizing',
  analyse: 'analyze',
  analysed: 'analyzed',
  analysing: 'analyzing',
  customise: 'customize',
  customised: 'customized',
  customising: 'customizing',
  optimise: 'optimize',
  optimised: 'optimized',
  optimising: 'optimizing',
  optimisation: 'optimization',
  normalise: 'normalize',
  normalised: 'normalized',
  normalising: 'normalizing',
  initialise: 'initialize',
  initialised: 'initialized',
  initialising: 'initializing',
  serialise: 'serialize',
  serialised: 'serialized',
  serialising: 'serializing',
  utilise: 'utilize',
  utilised: 'utilized',
  utilising: 'utilizing',
  prioritise: 'prioritize',
  prioritised: 'prioritized',
  prioritising: 'prioritizing',
  summarise: 'summarize',
  summarised: 'summarized',
  summarising: 'summarizing',
  categorise: 'categorize',
  categorised: 'categorized',
  categorising: 'categorizing',
  minimise: 'minimize',
  minimised: 'minimized',
  minimising: 'minimizing',
  maximise: 'maximize',
  maximised: 'maximized',
  maximising: 'maximizing',
  emphasise: 'emphasize',
  emphasised: 'emphasized',
  emphasising: 'emphasizing',
  apologise: 'apologize',
  realise: 'realize',
  realised: 'realized',
  realising: 'realizing',
  // -ce / -se
  licence: 'license',
  defence: 'defense',
  offence: 'offense',
  practise: 'practice',
  practised: 'practiced',
  practising: 'practicing',
  // one-offs
  programme: 'program',
  programmes: 'programs',
  whilst: 'while',
  amongst: 'among',
  artefact: 'artifact',
  artefacts: 'artifacts',
  learnt: 'learned',
  spelt: 'spelled',
  dreamt: 'dreamed',
  enrol: 'enroll',
  fulfil: 'fulfill',
  skilful: 'skillful',
  wilful: 'willful',
  enquiry: 'inquiry',
  enquiries: 'inquiries',
  judgement: 'judgment',
  ageing: 'aging',
  cheque: 'check',
  tyre: 'tire',
  tyres: 'tires',
  kerb: 'curb',
  aluminium: 'aluminum',
  mould: 'mold',
  moulded: 'molded',
  smoulder: 'smolder',
  plough: 'plow',
  sceptic: 'skeptic',
  sceptical: 'skeptical',
  speciality: 'specialty',
  manoeuvre: 'maneuver',
  storey: 'story',
  storeys: 'stories',
}

// `grey` is kept out of the table because it needs a guard none of the others
// do — see the exemption note at the top of this file.
const GREY = /(?<![$\-.\w"'`])grey(?!["'`\w:])/gi
const URL = /\bhttps?:\/\/[^\s"'`)<>]+/g
const WORDS = new RegExp(`\\b(${Object.keys(PAIRS).join('|')})\\b`, 'gi')

/** Case-preserving: `Colour` becomes `Color`, `COLOUR` becomes `COLOR`. */
const cased = (found, us) =>
  found === found.toUpperCase() && found.length > 1
    ? us.toUpperCase()
    : found[0] === found[0].toUpperCase()
      ? us[0].toUpperCase() + us.slice(1)
      : us

const fix = (s) => s.replace(WORDS, (w) => cased(w, PAIRS[w.toLowerCase()])).replace(GREY, (w) => cased(w, 'gray'))

/**
 * SPLIT ON URLS RATHER THAN MASKING THEM. A same-length placeholder swapped
 * back afterwards is the shape that looks obvious and is not: the mask has to
 * be a run of characters that cannot occur naturally, and every candidate
 * either does occur (spaces, which are everywhere in indentation) or is a
 * control character that would then be invisible in a diff. Splitting has
 * neither problem — the URL segments are simply not passed to the replacer.
 */
export function americanize(src) {
  const out = []
  let last = 0
  for (const m of src.matchAll(URL)) {
    out.push(fix(src.slice(last, m.index)), m[0])
    last = m.index + m[0].length
  }
  out.push(fix(src.slice(last)))
  return out.join('')
}

// **THE CLI HALF IS GUARDED BECAUSE THE TEST IMPORTS THE OTHER HALF.** Without
// this, `import { americanize }` runs the whole sweep and then calls
// process.exit, which kills the importing process before it asserts anything —
// silently, and looking like a test that produced no output.
const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href
if (isMain) {
  const args = process.argv.slice(2)
  const write = args.includes('--write')
  const check = args.includes('--check')
  let files = args.filter((a) => !a.startsWith('--'))
  if (files.length === 0) {
    files = execSync('git ls-files "*.md" "*.ts" "*.tsx" "*.js" "*.mjs" "*.html" "*.scss"', { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
  }
  // This file IS a list of British spellings and the test asserts against it, so
  // neither can ever be clean. Excluded whether they were named or globbed.
  files = files.filter((f) => f !== 'utils/us-english.mjs' && f !== 'test/us-english.test.ts')

  let bad = 0
  for (const f of files) {
    let src
    try {
      src = readFileSync(f, 'utf8')
    } catch {
      continue
    }
    const out = americanize(src)
    if (out === src) continue
    bad++
    if (write) writeFileSync(f, out)
    else if (check) console.log(f)
  }

  if (check) console.log(bad === 0 ? 'US English: clean' : `US English: ${bad} file(s) with British spellings`)
  if (write && bad) console.log(`US English: rewrote ${bad} file(s)`)
  process.exit(check && bad ? 1 : 0)
}
