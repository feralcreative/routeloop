// Writes docs/jargon.csv from the jargon table in src/views/vocab.ts (#321).
//
// The CSV is documentation — the readable copy of TERMS for anyone who does
// not want to read TypeScript — and test/vocab.test.ts fails when it drifts
// from the table, so a change to a word is a re-run of this:
//
//   npx tsx utils/build-jargon-csv.ts
import { writeFileSync } from 'node:fs'
import { TERMS } from '../src/views/vocab'

export const CSV_HEADER = 'Term,Motorcycle,Car,Bicycle,Gas,Electric,Regional'

export function jargonCsv(): string {
  const rows = TERMS.map((t) => {
    const cell = (k: keyof typeof t.by) => t.by[k]?.one ?? '—'
    const regional = t.options?.map((o) => o.one).join(' / ') ?? ''
    return [t.id, cell('motorcycle'), cell('car'), cell('bicycle'), cell('gas'), cell('electric'), regional].join(',')
  })
  return [CSV_HEADER, ...rows].join('\n') + '\n'
}

if (process.argv[1]?.endsWith('build-jargon-csv.ts')) {
  writeFileSync('docs/jargon.csv', jargonCsv())
  console.log(`[jargon] wrote docs/jargon.csv (${TERMS.length} terms)`)
}
