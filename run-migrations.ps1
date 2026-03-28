#!/usr/bin/env pwsh

$migrations = @(
    "0001_initial_schema.sql",
    "0002_advanced_tables.sql",
    "0003_messaging_and_analytics.sql",
    "0004_schema_fixes.sql",
    "0005_advertisements.sql",
    "0006_rate_limiting.sql",
    "0007_performance_indexes.sql",
    "0008_social_media_imports.sql",
    "0009_add_user_ban_flags.sql",
    "0010_session_management.sql",
    "0011_expo_push_tokens.sql",
    "0012_incoming_emails.sql",
    "0013_archival_metadata.sql",
    "0014_bootstrap_super_admin.sql",
    "0015_local_admin.sql",
    "0016_security_fixes.sql",
    "0017_feed_performance_indexes.sql",
    "0018_add_comment_media.sql",
    "0019_sdk_ads_support.sql",
    "0020_reel_comments.sql",
    "0021_add_missing_settings.sql",
    "0022_add_performance_indexes.sql",
    "0023_admin_security_rbac.sql",
    "0024_cloudflare_media_tracking.sql",
    "0025_story_video_tracking.sql",
    "0026_flexible_reel_views.sql",
    "0027_video_tracking.sql",
    "0028_add_platform_to_posts.sql"
    
)

# PRODUCTION DATABASES ONLY
$remoteDatabases = @("db1", "db2", "archive")

cd "C:\Users\user\Desktop\xora-social-project\backend"

Write-Host ""
Write-Host "=== PRODUCTION DATABASE MIGRATIONS ===" -ForegroundColor Cyan

foreach ($db in $remoteDatabases) {
    Write-Host ""
    Write-Host ">>> Migrating PRODUCTION DB: $db" -ForegroundColor Yellow

    foreach ($migration in $migrations) {
        Write-Host "Running $migration"
        npx wrangler d1 execute $db --remote --file "./migrations/$migration" -y
    }
}

Write-Host ""
Write-Host "=== PRODUCTION MIGRATIONS COMPLETE ===" -ForegroundColor Green
