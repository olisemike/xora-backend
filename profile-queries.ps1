# Database Query Profiling Script
# Analyzes production query performance

Write-Host "=== D1 Query Performance Profiling ===" -ForegroundColor Cyan
Write-Host ""

$queries = @(
    @{
        Name = "User Feed (Main)"
        Query = "EXPLAIN QUERY PLAN SELECT * FROM posts WHERE actor_type = 'user' AND created_at < datetime('now') ORDER BY created_at DESC LIMIT 20;"
    },
    @{
        Name = "User Followers"
        Query = "EXPLAIN QUERY PLAN SELECT * FROM follows WHERE followee_id = 'u_test' AND is_active = 1;"
    },
    @{
        Name = "Post Likes Count"
        Query = "EXPLAIN QUERY PLAN SELECT COUNT(*) FROM likes WHERE post_id = 'p_test' AND is_active = 1;"
    },
    @{
        Name = "User's Posts"
        Query = "EXPLAIN QUERY PLAN SELECT * FROM posts WHERE actor_type = 'user' AND actor_id = 'u_test' ORDER BY created_at DESC LIMIT 20;"
    },
    @{
        Name = "Post Comments"
        Query = "EXPLAIN QUERY PLAN SELECT * FROM comments WHERE post_id = 'p_test' ORDER BY created_at DESC LIMIT 50;"
    },
    @{
        Name = "User Blocks Check"
        Query = "EXPLAIN QUERY PLAN SELECT * FROM blocks WHERE blocker_id = 'u_test' AND target_id = 'u_other' AND is_active = 1;"
    }
)

foreach ($q in $queries) {
    Write-Host "Query: $($q.Name)" -ForegroundColor Yellow
    Write-Host "-----------------------------------"
    
    $result = wrangler d1 execute xora-prod-db-1 --remote --command $q.Query 2>&1
    
    if ($LASTEXITCODE -eq 0) {
        Write-Host $result -ForegroundColor Green
        
        # Check for performance issues
        if ($result -match "SCAN TABLE") {
            Write-Host "⚠️  WARNING: Full table scan detected!" -ForegroundColor Red
        }
        if ($result -match "USING INDEX") {
            Write-Host "✅ Using index (good)" -ForegroundColor Green
        }
    } else {
        Write-Host "❌ Error: $result" -ForegroundColor Red
    }
    
    Write-Host ""
}

Write-Host "=== Profiling Complete ===" -ForegroundColor Cyan
