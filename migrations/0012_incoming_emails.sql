-- 0012_incoming_emails.sql
-- Table to store incoming emails from Cloudflare Email Routing

CREATE TABLE IF NOT EXISTS incoming_emails (
  id TEXT PRIMARY KEY,
  from_address TEXT NOT NULL,
  to_address TEXT NOT NULL,
  subject TEXT,
  text_body TEXT,
  html_body TEXT,
  received_at INTEGER NOT NULL,
  processed_at INTEGER NOT NULL,
  created_at INTEGER DEFAULT (CAST(strftime('%s', 'now') AS INTEGER))
);

CREATE INDEX IF NOT EXISTS idx_incoming_emails_from
  ON incoming_emails (from_address);

CREATE INDEX IF NOT EXISTS idx_incoming_emails_to
  ON incoming_emails (to_address);

CREATE INDEX IF NOT EXISTS idx_incoming_emails_received_at
  ON incoming_emails (received_at DESC);
