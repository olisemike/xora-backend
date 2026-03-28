-- ============================================
-- XORA SOCIAL DATABASE SCHEMA
-- Migration 0004: Schema Fixes
-- ============================================

-- Stories table fixes - add missing columns
ALTER TABLE stories ADD COLUMN duration INTEGER DEFAULT 5;
ALTER TABLE stories ADD COLUMN is_sensitive BOOLEAN DEFAULT 0;
ALTER TABLE stories ADD COLUMN updated_at INTEGER;

-- Conversations fix - add created_by column
ALTER TABLE conversations ADD COLUMN created_by TEXT;

-- Messages table fixes
ALTER TABLE messages ADD COLUMN reply_to_id TEXT;
ALTER TABLE messages ADD COLUMN media_urls TEXT;
ALTER TABLE messages ADD COLUMN is_read BOOLEAN DEFAULT 0;
ALTER TABLE messages ADD COLUMN updated_at INTEGER;

-- Message reactions table (new) - required by ChatRoom.js
CREATE TABLE IF NOT EXISTS message_reactions (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  emoji TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(message_id, user_id, emoji),
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_message_reactions_message ON message_reactions(message_id);
CREATE INDEX IF NOT EXISTS idx_message_reactions_user ON message_reactions(user_id);

-- Two-factor authentication backup codes table
CREATE TABLE IF NOT EXISTS two_factor_backup_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  used BOOLEAN DEFAULT 0,
  used_at INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_2fa_backup_user ON two_factor_backup_codes(user_id);
CREATE INDEX IF NOT EXISTS idx_2fa_backup_used ON two_factor_backup_codes(used);
