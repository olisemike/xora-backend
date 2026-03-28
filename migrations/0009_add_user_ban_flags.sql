-- Migration 0009: Add user ban flags
-- Adds is_banned and banned_until columns to users for fast ban checks

ALTER TABLE users ADD COLUMN is_banned BOOLEAN DEFAULT 0;
ALTER TABLE users ADD COLUMN banned_until INTEGER;

CREATE INDEX IF NOT EXISTS idx_users_banned ON users(is_banned, banned_until);
