-- Migration: Session Management and Device Tracking
-- Description: Adds token versioning, login history, and device verification

-- Add token_version to users table for invalidating all sessions
ALTER TABLE users ADD COLUMN token_version INTEGER DEFAULT 0;

-- Create login_history table to track all login attempts
CREATE TABLE IF NOT EXISTS login_history (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  platform TEXT NOT NULL CHECK(platform IN ('web', 'mobile', 'unknown')),
  device_info TEXT,
  ip_address TEXT,
  user_agent TEXT,
  status TEXT NOT NULL CHECK(status IN ('success', 'failed', 'pending_verification')),
  logged_in_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Create device_verifications table for email verification of new devices
CREATE TABLE IF NOT EXISTS device_verifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  device_fingerprint TEXT NOT NULL,
  platform TEXT NOT NULL,
  device_info TEXT,
  ip_address TEXT,
  verification_code TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  verified_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Create verified_devices table to track known/trusted devices
CREATE TABLE IF NOT EXISTS verified_devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  device_fingerprint TEXT NOT NULL,
  platform TEXT NOT NULL,
  device_info TEXT,
  first_verified_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(user_id, device_fingerprint)
);

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_login_history_user_id ON login_history(user_id);
CREATE INDEX IF NOT EXISTS idx_login_history_user_status ON login_history(user_id, status);
CREATE INDEX IF NOT EXISTS idx_device_verifications_user_id ON device_verifications(user_id);
CREATE INDEX IF NOT EXISTS idx_device_verifications_code ON device_verifications(verification_code);
CREATE INDEX IF NOT EXISTS idx_verified_devices_user_id ON verified_devices(user_id);
CREATE INDEX IF NOT EXISTS idx_verified_devices_fingerprint ON verified_devices(user_id, device_fingerprint);
