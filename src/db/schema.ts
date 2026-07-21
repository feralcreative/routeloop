import { sql } from 'drizzle-orm'
import {
  pgTable,
  pgEnum,
  bigserial,
  bigint,
  varchar,
  boolean,
  integer,
  smallint,
  numeric,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core'

export const providerEnum = pgEnum('provider', ['google', 'github'])
export const visibilityEnum = pgEnum('visibility', ['public', 'unlisted', 'private'])

export const users = pgTable('users', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  email: varchar('email', { length: 255 }).unique(),
  displayName: varchar('display_name', { length: 255 }).notNull(),
  avatarUrl: varchar('avatar_url', { length: 512 }),
  quotaBytes: bigint('quota_bytes', { mode: 'number' }).notNull().default(262144000), // 250 MB
  usedBytes: bigint('used_bytes', { mode: 'number' }).notNull().default(0), // denormalized cache
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  lastLoginAt: timestamp('last_login_at'),
})

// One user may link both Google and GitHub → normalized identities.
export const userIdentities = pgTable(
  'user_identities',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: providerEnum('provider').notNull(),
    providerUserId: varchar('provider_user_id', { length: 255 }).notNull(),
    providerEmail: varchar('provider_email', { length: 255 }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('uq_provider_identity').on(t.provider, t.providerUserId), index('idx_user').on(t.userId)],
)

// Server sessions. The primary key is the SHA-256 hash of the token we hand the
// browser, never the token itself — a leaked database therefore yields no usable
// session cookies.
export const sessions = pgTable(
  'sessions',
  {
    id: varchar('id', { length: 64 }).primaryKey(), // hex sha256 of the token
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [index('idx_session_user').on(t.userId), index('idx_session_expires').on(t.expiresAt)],
)

export const maps = pgTable(
  'maps',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    ownerId: bigint('owner_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    slug: varchar('slug', { length: 22 }).notNull(), // unguessable public id
    title: varchar('title', { length: 150 }).notNull(),
    description: varchar('description', { length: 2000 }),
    color: varchar('color', { length: 7 }).notNull().default('#0000cc'),
    visibility: visibilityEnum('visibility').notNull().default('private'),
    externalUrl: varchar('external_url', { length: 2048 }),
    gpxPresent: boolean('gpx_present').notNull().default(false),
    kmlBytes: integer('kml_bytes').notNull().default(0),
    gpxBytes: integer('gpx_bytes').notNull().default(0),
    sizeBytes: integer('size_bytes').generatedAlwaysAs(sql`kml_bytes + gpx_bytes`),
    waypointCount: smallint('waypoint_count').notNull().default(0),
    totalMiles: numeric('total_miles', { precision: 7, scale: 1 }).notNull().default('0'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uq_slug').on(t.slug),
    index('idx_owner').on(t.ownerId),
    index('idx_browse').on(t.visibility, t.createdAt),
  ],
)

export type MapRow = typeof maps.$inferSelect
export type UserRow = typeof users.$inferSelect
export type SessionRow = typeof sessions.$inferSelect
