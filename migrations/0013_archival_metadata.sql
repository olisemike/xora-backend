-- 0013_archival_metadata.sql
-- Track archival and snapshot information

-- Archival log table
CREATE TABLE IF NOT EXISTS archival_log (
  id TEXT PRIMARY KEY,
  table_name TEXT NOT NULL,
  record_count INTEGER NOT NULL,
  source_db TEXT NOT NULL, -- 'db1', 'db2', 'db3'
  destination_db TEXT, -- 'db3', 'snapshots', or NULL if deleted
  snapshot_key TEXT,
  archived_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  archived_by TEXT DEFAULT 'system',
  reason TEXT, -- 'auto_archival', 'manual', 'expiration'
  status TEXT DEFAULT 'success', -- 'success', 'partial', 'failed'
  details TEXT -- JSON metadata
);

CREATE INDEX IF NOT EXISTS idx_archival_log_table ON archival_log(table_name);
CREATE INDEX IF NOT EXISTS idx_archival_log_date ON archival_log(archived_at);
CREATE INDEX IF NOT EXISTS idx_archival_log_status ON archival_log(status);

-- Archive metadata table
CREATE TABLE IF NOT EXISTS archive_metadata (
  id TEXT PRIMARY KEY,
  table_name TEXT NOT NULL,
  snapshot_key TEXT NOT NULL,
  record_count INTEGER NOT NULL,
  created_at DATETIME NOT NULL,
  archived_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  data_age_months INTEGER,
  compression_ratio REAL,
  file_size_bytes INTEGER,
  checksum TEXT,
  expiration_date DATETIME, -- When this snapshot expires and can be deleted
  retrieved_count INTEGER DEFAULT 0,
  last_retrieved_at DATETIME
);

CREATE INDEX IF NOT EXISTS idx_archive_metadata_table ON archive_metadata(table_name);
CREATE INDEX IF NOT EXISTS idx_archive_metadata_snapshot ON archive_metadata(snapshot_key);
CREATE INDEX IF NOT EXISTS idx_archive_metadata_expiration ON archive_metadata(expiration_date);

-- Database usage tracking
CREATE TABLE IF NOT EXISTS db_usage_history (
  id TEXT PRIMARY KEY,
  database_name TEXT NOT NULL, -- 'db1', 'db2', 'db3'
  usage_percent REAL NOT NULL,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  status TEXT DEFAULT 'ok' -- 'ok', 'warning', 'critical'
);

CREATE INDEX IF NOT EXISTS idx_db_usage_database ON db_usage_history(database_name);
CREATE INDEX IF NOT EXISTS idx_db_usage_timestamp ON db_usage_history(timestamp);

-- Archival statistics
CREATE TABLE IF NOT EXISTS archival_stats (
  id TEXT PRIMARY KEY,
  period TEXT NOT NULL, -- 'daily', 'weekly', 'monthly'
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  records_archived INTEGER DEFAULT 0,
  records_deleted INTEGER DEFAULT 0,
  snapshots_created INTEGER DEFAULT 0,
  snapshots_deleted INTEGER DEFAULT 0,
  total_storage_saved_mb REAL DEFAULT 0,
  avg_retrieval_time_ms REAL,
  failed_operations INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_archival_stats_period ON archival_stats(period, start_date);
