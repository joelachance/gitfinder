CREATE TABLE IF NOT EXISTS gx_email_signups (
  email text PRIMARY KEY NOT NULL,
  name text NOT NULL,
  source text NOT NULL,
  gx_version text,
  first_seen_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  submission_count integer DEFAULT 1 NOT NULL,
  last_ip_hash text,
  last_user_agent text
);
