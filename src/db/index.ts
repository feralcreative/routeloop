import 'dotenv/config'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import * as schema from './schema'

const { Pool } = pg

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

export const db = drizzle(pool, { schema })
// Exported for src/shutdown.ts, which ends it after the in-flight responses are
// done. Nothing else should reach past `db` for it.
export { schema, pool }
