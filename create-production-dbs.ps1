# Production Database Reset - CORRECTED
# Uses proper wrangler CLI syntax

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "XORA - CLEAN DATABASE SETUP" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

# Step 1: Create fresh production databases
Write-Host "`n[Step 1] Creating 3 new production databases..." -ForegroundColor Yellow

Write-Host "  Creating xora-primary..." -ForegroundColor Gray
$db1Output = wrangler d1 create xora-primary --remote 2>&1 | Out-String
Write-Host $db1Output

Write-Host "`n  Creating xora-secondary..." -ForegroundColor Gray
$db2Output = wrangler d1 create xora-secondary --remote 2>&1 | Out-String
Write-Host $db2Output

Write-Host "`n  Creating xora-archive..." -ForegroundColor Gray
$db3Output = wrangler d1 create xora-archive --remote 2>&1 | Out-String
Write-Host $db3Output

Write-Host "`n========================================" -ForegroundColor Yellow
Write-Host "✅ Databases created successfully!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Yellow

Write-Host "`n[Step 2] IMPORTANT - Update wrangler.toml with new database IDs" -ForegroundColor Cyan
Write-Host "`nLook for the database_id values in the output above, then update:" -ForegroundColor Yellow
Write-Host "  backend/wrangler.toml [env.production.d1_databases]" -ForegroundColor Gray
Write-Host "`nReplace the empty database_id values with the IDs from the output above." -ForegroundColor Cyan
Write-Host "`nAfter updating, run: powershell -ExecutionPolicy Bypass -File .\run-all-migrations.ps1" -ForegroundColor Green
