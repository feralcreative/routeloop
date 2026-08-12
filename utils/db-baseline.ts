#!/usr/bin/env tsx
/**
 * db-baseline — mark migrations as already applied, without running them.
 *
 * Needed exactly once per database that predates the drizzle/ folder. Before
 * 2026-08-10 the schema was applied declaratively with `drizzle-kit push`, so
 * prod, stage and both dev machines already carry every table in
 * drizzle/0000_baseline.sql. Running `drizzle-kit migrate` against one of them
 * would try to CREATE TYPE / CREATE TABLE over the top and fail on the first
 * statement.
 *
 * This writes the bookkeeping rows migrate() would have written — the same
 * (hash, created_at) pairs, read through drizzle's own readMigrationFiles so
 * the hashes cannot drift from however that version computes them — and
 * touches nothing else. Afterwards `db:migrate` sees the baseline as done and
 * applies only what comes after it.
 *
 *   DATABASE_URL=... npx tsx utils/db-baseline.ts            # baseline all
 *   DATABASE_URL=... npx tsx utils/db-baseline.ts --through 0000_baseline
 *
 * Two guards, because the cost of being wrong is a database whose recorded
 * state is a lie — every later migration silently skipped:
 *
 *   - It refuses a database with NO application tables. An empty database
 *     wants `db:migrate`, not this; baselining one would mark the schema
 *     created when nothing was.
 *   - It refuses a database that already has bookkeeping rows, rather than
 *     adding duplicates.
 *
 * Neither guard proves the database matches the schema — nothing here can.
 * Verify that separately (see docs/database.md) before trusting a baseline.
 */
import 'dotenv/config'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { Pool } from 'pg'

const MIGRATIONS_FOLDER = './drizzle'
const SCHEMA = 'drizzle'
const TABLE = '__drizzle_migrations'

/** A table every version of this app has had, used to tell "existing" from "empty". */
const SENTINEL_TABLE = 'users'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

async function main() {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('[baseline] DATABASE_URL is not set.')
    process.exit(1)
  }

  const through = arg('through')
  const all = readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER })
  if (all.length === 0) {
    console.error(`[baseline] No migrations found in ${MIGRATIONS_FOLDER}.`)
    process.exit(1)
  }

  // Migration names are not in MigrationMeta, so `--through` is resolved by
  // position in folderMillis order — the same order migrate() walks.
  const ordered = [...all].sort((a, b) => a.folderMillis - b.folderMillis)
  let migrations = ordered
  if (through) {
    const names = ordered.map((_, i) => String(i).padStart(4, '0'))
    const idx = names.findIndex((n) => through.startsWith(n))
    if (idx === -1) {
      console.error(`[baseline] --through ${through} does not match a migration.`)
      process.exit(1)
    }
    migrations = ordered.slice(0, idx + 1)
  }

  const pool = new Pool({ connectionString: url })
  try {
    const { rows: present } = await pool.query<{ exists: boolean }>(
      `select exists (
         select 1 from information_schema.tables
         where table_schema = 'public' and table_name = $1
       ) as exists`,
      [SENTINEL_TABLE],
    )
    if (!present[0]?.exists) {
      console.error(
        `[baseline] This database has no "${SENTINEL_TABLE}" table, so it is not an existing\n` +
          '           routeloop database. Run `npm run db:migrate` instead—it will create the\n' +
          '           schema and record itself. Baselining an empty database would mark the\n' +
          '           migrations applied when they never ran.',
      )
      process.exit(1)
    }

    await pool.query(`create schema if not exists "${SCHEMA}"`)
    await pool.query(
      `create table if not exists "${SCHEMA}"."${TABLE}" (
         id SERIAL PRIMARY KEY,
         hash text NOT NULL,
         created_at bigint
       )`,
    )

    const { rows: existing } = await pool.query<{ count: string }>(
      `select count(*)::text as count from "${SCHEMA}"."${TABLE}"`,
    )
    if (Number(existing[0]!.count) > 0) {
      console.error(
        `[baseline] "${SCHEMA}"."${TABLE}" already has ${existing[0]!.count} row(s), so this\n` +
          '           database is already tracked. Nothing to baseline—use `npm run db:migrate`.',
      )
      process.exit(1)
    }

    for (const m of migrations) {
      await pool.query(
        `insert into "${SCHEMA}"."${TABLE}" ("hash", "created_at") values ($1, $2)`,
        [m.hash, m.folderMillis],
      )
    }

    console.log(
      `[baseline] Marked ${migrations.length} migration(s) as applied. ` +
        'No schema statements were run.',
    )
    console.log('[baseline] `npm run db:migrate` will now apply only what comes after them.')
  } finally {
    await pool.end()
  }
}

main().catch((err) => {
  console.error('[baseline] Failed:', err)
  process.exit(1)
})
