-- 0011_expo_push_tokens.sql
-- Table to store Expo push tokens for mobile apps (iOS/Android)

CREATE TABLE IF NOT EXISTS expo_push_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_expo_push_tokens_user
  ON expo_push_tokens (user_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_expo_push_tokens_token
  ON expo_push_tokens (token);
