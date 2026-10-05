-- ============================================================
-- 004_auth.sql
-- Tables for Better Auth, mapped onto our existing snake_case `users` table.
-- Passwords now live in accounts.password as a salted hash. users.password_hash is dropped.
-- ============================================================

ALTER TABLE users DROP COLUMN password_hash;
ALTER TABLE users
  ADD COLUMN email_verified boolean NOT NULL DEFAULT false,
  ADD COLUMN image text;

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token text UNIQUE NOT NULL,
  expires_at timestamptz NOT NULL,
  ip_address text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- One row per way a user can sign in. For email + password, provider_id = 'credential'.
CREATE TABLE accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id text NOT NULL,
  provider_id text NOT NULL,
  access_token text,
  refresh_token text,
  id_token text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  scope text,
  password text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, account_id)
);
CREATE INDEX idx_accounts_user ON accounts(user_id);

-- Email verification and password reset tokens
CREATE TABLE verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identifier text NOT NULL,
  value text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_verifications_identifier ON verifications(identifier);

-- Rate limit counters kept in the database, so limits hold across several server instances
CREATE TABLE rate_limits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text UNIQUE NOT NULL,
  count integer NOT NULL,
  last_request bigint NOT NULL
);
