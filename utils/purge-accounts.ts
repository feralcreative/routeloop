/**
 * Runs — or reports on — the account purge.
 *
 *   npx tsx utils/purge-accounts.ts --dry-run   # who WOULD be destroyed, changes nothing
 *   npx tsx utils/purge-accounts.ts             # destroy them, after a confirmation
 *
 * READ THE DRY RUN FIRST, AND TAKE A db-backup. This is the most destructive
 * operation in the app: it removes a rider's account, every ride they own, every
 * file they uploaded, and every row that cascades from any of it. None of it is
 * recoverable from anywhere but a backup.
 *
 * WHY THIS SCRIPT EXISTS RATHER THAN JUST THE TIMER. /account/delete has been
 * promising riders a destruction date since it shipped, and nothing has ever
 * kept that promise — src/account/purge.ts did not exist. So the first pass of
 * the new runner will find everyone who has been sitting past their deadline for
 * however long that has been, and destroy them all at once. That is the correct
 * behavior and it is also exactly the kind of thing to look at before it
 * happens. The in-process timer stays off until PURGE_ACCOUNTS=on; this is how
 * you see the list.
 *
 * `utils/` is not in tsconfig.json, so `npm run typecheck` does not cover this
 * file. Check it by hand — the invocation is in AGENTS.md.
 */
import { createInterface } from 'node:readline/promises'
import { dueAccounts, purgeDueAccounts } from '../src/account/purge'
import { DELETION_HOLD_DAYS } from '../src/account/policy'

const dryRun = process.argv.includes('--dry-run')
const now = new Date()

const due = await dueAccounts(now)

if (due.length === 0) {
  console.log(`No account has passed its ${DELETION_HOLD_DAYS}-day hold. Nothing to do.`)
  process.exit(0)
}

console.log(`\n${due.length} account${due.length === 1 ? '' : 's'} past the ${DELETION_HOLD_DAYS}-day hold:\n`)
for (const a of due) {
  const overdue = a.purgeAfter ? Math.floor((now.getTime() - a.purgeAfter.getTime()) / 86_400_000) : 0
  // The address is printed HERE and never logged by the runner: this is an
  // operator staring at a terminal deciding whether the list is right, which is
  // a different thing from a log file that outlives the account.
  console.log(`  #${a.id}  ${a.email ?? '(no email — identity-only account)'}`)
  console.log(
    `         due ${a.purgeAfter?.toISOString() ?? 'unknown'} (${overdue} day${overdue === 1 ? '' : 's'} ago)`,
  )
}

if (dryRun) {
  console.log('\n--dry-run: nothing was changed.\n')
  process.exit(0)
}

console.log('\nThis destroys those accounts, their rides, and their uploaded files. It cannot be undone.')
const rl = createInterface({ input: process.stdin, output: process.stdout })
const answer = await rl.question('Type DESTROY to continue: ')
rl.close()

if (answer.trim() !== 'DESTROY') {
  console.log('Not confirmed. Nothing was changed.\n')
  process.exit(1)
}

const n = await purgeDueAccounts(now)
console.log(`\nDestroyed ${n} account${n === 1 ? '' : 's'}.\n`)
process.exit(0)
