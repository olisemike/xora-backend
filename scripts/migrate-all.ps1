# ============================================
# XORA SOCIAL - RUN ALL MIGRATIONS
# Runs migrations 0001-0025 on specified D1 database
# Usage: scripts/migrate-all.ps1 -Database DB -Mode local
# ============================================

param(
  [string]$Database = "DB",  # DB, DB2, or DB3
  [string]$Mode = "local"     # local or remote
)

$migrationsDir = "./migrations"
$migrations = @(Get-ChildItem "$migrationsDir/*.sql" | Sort-Object Name)

if ($migrations.Count -eq 0) {
  Write-Host "❌ No migration files found" -ForegroundColor Red
  exit 1
}

Write-Host "================================"
Write-Host "XORA SOCIAL - MIGRATIONS" -ForegroundColor Cyan
Write-Host "Database: $Database | Mode: $Mode" -ForegroundColor Cyan
Write-Host "Running $($migrations.Count) migrations..." -ForegroundColor Cyan
Write-Host "================================" ""

$modeFlag = if ($Mode -eq "local") { "--local" } else { "--remote" }
$successCount = 0
$failCount = 0

foreach ($migration in $migrations) {
  $filename = $migration.Name
  $filePath = $migration.FullName
  
  Write-Host "  ▶ $filename" -ForegroundColor Yellow
  
  $cmd = "wrangler d1 execute $Database $modeFlag --file=`"$filePath`" 2>&1"
  $output = Invoke-Expression $cmd
  
  if ($LASTEXITCODE -eq 0) {
    Write-Host "    ✅ Done" -ForegroundColor Green
    $successCount++
  } else {
    Write-Host "    ❌ Failed" -ForegroundColor Red
    $failCount++
  }
}

Write-Host ""
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "✅ Completed: $successCount | ❌ Failed: $failCount" -ForegroundColor Green
Write-Host "=========================================" -ForegroundColor Cyan

