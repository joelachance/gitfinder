import { neon } from '@neondatabase/serverless';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/neon-http';
import { gxEmailSignups } from './schema.js';

export type SignupUpsert = {
  email: string;
  name: string;
  source: string;
  gxVersion: string | null;
  lastIpHash: string | null;
  lastUserAgent: string | null;
};

export interface EmailSignupStore {
  upsertSignup(input: SignupUpsert): Promise<void>;
}

let cachedStore: EmailSignupStore | null = null;

function getDatabaseUrl() {
  const value = process.env.DATABASE_URL?.trim();
  if (!value) {
    throw new Error('DATABASE_URL is required.');
  }
  return value;
}

export function createDbSignupStore(): EmailSignupStore {
  if (cachedStore) return cachedStore;

  const client = neon(getDatabaseUrl());
  const db = drizzle(client);

  cachedStore = {
    async upsertSignup(input) {
      await db
        .insert(gxEmailSignups)
        .values({
          email: input.email,
          name: input.name,
          source: input.source,
          gxVersion: input.gxVersion,
          lastIpHash: input.lastIpHash,
          lastUserAgent: input.lastUserAgent,
        })
        .onConflictDoUpdate({
          target: gxEmailSignups.email,
          set: {
            name: input.name,
            source: input.source,
            gxVersion: input.gxVersion,
            updatedAt: sql`now()`,
            submissionCount: sql`${gxEmailSignups.submissionCount} + 1`,
            lastIpHash: input.lastIpHash,
            lastUserAgent: input.lastUserAgent,
          },
        });
    },
  };

  return cachedStore;
}
