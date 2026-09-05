// Stamp the top release-notes block with the build it shipped as.
//
// Run at release time, from the commit you are about to deploy:
//
//   npx tsx utils/stamp-release.ts --dry-run
//   npx tsx utils/stamp-release.ts
//
// It finds the FIRST <section class="rn-release"> in src/content/release-notes.html
// — the newest one, because the file is newest-first — and writes the version
// stamp and a link to the commit into its <h3>.
//
// WHY A SCRIPT AND NOT A TYPED HASH. A stamp typed by hand is one transposed
// character away from linking to a commit that is not the one that shipped, and
// there is nothing anywhere that would catch it: the link resolves to a real
// page or a 404 and neither is checked. The version stamp has the same problem
// one grade milder — it is a date, so a wrong one looks plausible.
//
// WHY NOT DERIVED AT RENDER. The container ships no git history, and
// src/version.ts deliberately spawns no subprocess in the request path. And a
// token in the content file is refused by test/content.test.ts, because the file
// is served at two routes and a token would have to be supplied identically at
// both.
//
// **THE VERSION COMPUTATION MIRRORS utils/deploy/deploy.sh AND THE TWO HAVE TO
// STAY IN STEP.** Same arrangement as src/maps/filename.ts and its client twin:
// if the format there changes, change it here in the same commit, or the notes
// will name a build that no footer ever reports. The deploy is the authority;
// this is the copy.
//
// Note utils/ is NOT in tsconfig.json, so `npm run typecheck` does not cover
// this file. Check it by hand:
//
//   npx tsc --noEmit --strict --target ES2022 --module ESNext --moduleResolution Bundler \
//     --types node --esModuleInterop --skipLibCheck utils/stamp-release.ts
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const NOTES = 'src/content/release-notes.html'
const REPO_URL = 'https://github.com/feralcreative/routeloop'

const git = (...args: string[]): string => execFileSync('git', args, { encoding: 'utf8' }).trim()

/**
 * The commit's minute in Pacific time, plus a literal `PT`.
 *
 * Mirrors the BUILD_STAMP block in utils/deploy/deploy.sh. `PT` is part of the
 * value and not decoration — see the header of src/version.ts for why it is not
 * `PDT`/`PST`.
 */
function versionStamp(): string {
  const stamp = execFileSync('git', ['show', '-s', '--format=%cd', '--date=format-local:%Y-%m-%d-%H%M', 'HEAD'], {
    encoding: 'utf8',
    env: { ...process.env, TZ: 'America/Los_Angeles' },
  }).trim()
  if (!stamp) throw new Error('could not read HEAD committer date')
  return `${stamp}PT`
}

function main(): void {
  const dryRun = process.argv.includes('--dry-run')
  const force = process.argv.includes('--force')

  // A dirty tree cannot be stamped honestly. deploy.sh ships BUILD_SHA as the
  // bare commit even for a --force deploy of uncommitted work, so a stamp
  // written from a dirty tree names a tree that is not the one running.
  if (git('status', '--porcelain') !== '' && !force) {
    console.error('Working tree is dirty. Commit the release first, or pass --force if you know why.')
    process.exit(1)
  }

  const short = git('rev-parse', '--short', 'HEAD')
  const full = git('rev-parse', 'HEAD')
  const version = versionStamp()

  const html = readFileSync(NOTES, 'utf8')

  // COMMENTS ARE MASKED BEFORE SEARCHING, AND THE MASK KEEPS THE LENGTH.
  //
  // The file opens with its own authoring contract as an HTML comment, and that
  // contract contains a worked example of a stamped release block. Searched
  // naively, the FIRST match is that example — so the script cheerfully reports
  // it is about to stamp "24 August 2026" and, run for real, would rewrite the
  // documentation instead of the release. Replacing each comment with an equal
  // run of spaces means every index into the masked text is still valid in the
  // original, so the write below can use them directly.
  const masked = html.replace(/<!--[^]*?-->/g, (c) => ' '.repeat(c.length))

  // The FIRST heading of the FIRST release section. `[^]` rather than `.` with
  // the s flag so a heading that has been wrapped across lines still matches —
  // prettier does that to a long one, and a stamp appended to it makes it long.
  const re = /(<section class="rn-release">\s*<h3>)([^]*?)(<\/h3>)/
  const m = re.exec(masked)
  if (!m || m.index === undefined) {
    console.error(`No <section class="rn-release"> with an <h3> found in ${NOTES}.`)
    process.exit(1)
  }

  const headStart = m.index + m[1].length
  const headEnd = headStart + m[2].length
  const heading = html.slice(headStart, headEnd)
  if (/class="rn-sha"/.test(heading) && !force) {
    console.error('The top release block is already stamped. Add the new block first, or pass --force to restamp.')
    process.exit(1)
  }

  // Strip any existing stamp before writing a new one, so --force replaces
  // rather than appending a second copy beside the first.
  const bare = heading
    .replace(/\s*<a class="rn-sha"[^]*?<\/a>/g, '')
    .replace(/\s*<code>\d{4}-\d{2}-\d{2}-\d{4}PT<\/code>/g, '')
    .trimEnd()

  const stamped = `${bare} <code>${version}</code>\n    <a class="rn-sha" href="${REPO_URL}/commit/${full}"><code>${short}</code></a>\n  `
  // Spliced by index rather than by `html.replace(re, …)`: the regex was run
  // against the masked copy, so re-running it on the original would find the
  // commented-out example first and rewrite that instead.
  const next = html.slice(0, headStart) + stamped + html.slice(headEnd)

  console.log(`${dryRun ? 'Would stamp' : 'Stamping'}: ${version}  ${short}`)
  console.log(`  ${bare.split('\n')[0].trim()}`)
  if (dryRun) return

  writeFileSync(NOTES, next)
  console.log(`Wrote ${NOTES}. Check it renders at /release-notes and in the What's new dialog.`)
}

main()
