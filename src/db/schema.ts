import { integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const gxEmailSignups = pgTable('gx_email_signups', {
  email: text('email').primaryKey().notNull(),
  name: text('name').notNull(),
  source: text('source').notNull(),
  gxVersion: text('gx_version'),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  submissionCount: integer('submission_count').default(1).notNull(),
  lastIpHash: text('last_ip_hash'),
  lastUserAgent: text('last_user_agent'),
});
