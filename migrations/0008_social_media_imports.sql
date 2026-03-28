-- Migration: Social Media Import System - CURATOR/TRENDING MODEL
-- Created: 2024-12-29
-- Model: Centralized trending content curation (NOT OAuth-based personal feeds)

-- Social media SEARCH JOBS (trending/user searches)
-- Tracks when admins search for trending content or specific users
CREATE TABLE IF NOT EXISTS social_media_search_jobs (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL,
  platform TEXT NOT NULL CHECK(platform IN ('twitter', 'instagram', 'tiktok', 'facebook', 'youtube', 'reddit')),
  search_type TEXT NOT NULL CHECK(search_type IN ('trending', 'user', 'hashtag')),
  query TEXT NOT NULL,  -- Hashtag, keyword, or username
  location TEXT,         -- Geographic filter (US, UK, global, etc)
  language TEXT,         -- Language filter (en, es, etc)
  min_engagement INTEGER DEFAULT 0,  -- Minimum likes/retweets for trending
  status TEXT NOT NULL DEFAULT 'completed' CHECK(status IN ('pending', 'processing', 'completed', 'failed')),
  results_count INTEGER DEFAULT 0,
  error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Social media IMPORT JOBS (importing selected posts to Xora DB)
-- Tracks when admins import curated posts into the database
CREATE TABLE IF NOT EXISTS social_media_import_jobs (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL,
  platform TEXT NOT NULL CHECK(platform IN ('twitter', 'instagram', 'tiktok', 'facebook', 'youtube', 'reddit')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'completed', 'failed')),
  total_posts INTEGER DEFAULT 0,
  imported_posts INTEGER DEFAULT 0,
  failed_posts INTEGER DEFAULT 0,
  error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);

-- Mapping of imported posts to original social media posts
-- Links Xora posts to their external source for tracking
CREATE TABLE IF NOT EXISTS imported_post_mapping (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  external_post_id TEXT NOT NULL,
  external_post_url TEXT,
  external_author TEXT,  -- Original author username (not admin who imported)
  imported_at INTEGER NOT NULL,
  UNIQUE(platform, external_post_id),
  FOREIGN KEY (post_id) REFERENCES posts(id)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_search_jobs_admin ON social_media_search_jobs(admin_id, platform);
CREATE INDEX IF NOT EXISTS idx_search_jobs_created ON social_media_search_jobs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_search_jobs_location ON social_media_search_jobs(location, search_type);
CREATE INDEX IF NOT EXISTS idx_import_jobs_admin ON social_media_import_jobs(admin_id, status);
CREATE INDEX IF NOT EXISTS idx_import_jobs_platform ON social_media_import_jobs(platform, status);
CREATE INDEX IF NOT EXISTS idx_import_jobs_created ON social_media_import_jobs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_imported_mapping_post ON imported_post_mapping(post_id);
CREATE INDEX IF NOT EXISTS idx_imported_mapping_external ON imported_post_mapping(platform, external_post_id);
CREATE INDEX IF NOT EXISTS idx_imported_mapping_author ON imported_post_mapping(external_author);
