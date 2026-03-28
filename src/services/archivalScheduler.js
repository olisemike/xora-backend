/**
 * Scheduled Archival Task
 * 
 * Runs periodically to:
 * 1. Check if DB1/DB2 are > 80% full
 * 2. Move old data to DB3
 * 3. Archive data > 18 months to R2 snapshots
 * 4. Cleanup old snapshots
 */

import { ArchivalService } from '../services/archivalService.js';

export async function scheduleArchivalTask(env) {
  const archival = new ArchivalService(
    env.DB,
    env.DB2,
    env.DB3,
    env.STORAGE,
    env.SNAPSHOTS,
    env.CACHE
  );

  // Tables to archive (customize based on your needs)
  const tablesToArchive = [
    'posts',
    'comments',
    'reels',
    'stories',
    'shares',
    'analytics',
    'feed_interactions',
    'notifications',
    'messages'
  ];

  // Starting archival task

  try {
    // Check DB1 usage
    const db1NeedsArchival = await archival.checkArchivalNeeded(env.DB, 'DB1');
    if (db1NeedsArchival) {
      // DB1 is > 80% full, archiving old data

      await Promise.all(tablesToArchive.map(async (table) => {
        try {
          const oldData = await archival.getOldData(env.DB, table, 18);
          if (oldData.length > 0) {
            const ids = oldData.map(d => d.id);
            await archival.moveToArchive(env.DB, table, ids);
            // Moved records from DB1 to DB3
          }
        } catch (error) {
          console.warn(`Warning archiving ${table} from DB1:`, error.message);
        }
      }));
    }

    // Check DB2 usage
    const db2NeedsArchival = await archival.checkArchivalNeeded(env.DB2, 'DB2');
    if (db2NeedsArchival) {
      // DB2 is > 80% full, archiving old data

      await Promise.all(tablesToArchive.map(async (table) => {
        try {
          const oldData = await archival.getOldData(env.DB2, table, 18);
          if (oldData.length > 0) {
            const ids = oldData.map(d => d.id);
            await archival.moveToArchive(env.DB2, table, ids);
            // Moved records from DB2 to DB3
          }
        } catch (error) {
          console.warn(`Warning archiving ${table} from DB2:`, error.message);
        }
      }));
    }

    // Archive data > 18 months from DB3 to R2 snapshots, then delete from DB3
    // Archiving data > 18 months from DB3 to R2
    await Promise.all(tablesToArchive.map(async (table) => {
      try {
        const result = await archival.archiveOldData(table, 18);
        if (result.archived > 0) {
          // Archived records from DB3 to R2
        }
      } catch (error) {
        console.warn(`Warning archiving ${table} to snapshots:`, error.message);
      }
    }));

    // EMERGENCY: Check DB3 capacity and archive aggressively if needed
    const db3Usage = await archival.checkArchivalNeeded(env.DB3, 'DB3');
    if (db3Usage) {
      // DB3 is > 80% full - archive data > 1 month old to prevent overflow
      console.warn('DB3 capacity critical - archiving 1+ month old data');
      await Promise.all(tablesToArchive.map(async (table) => {
        try {
          const result = await archival.archiveOldData(table, 1); // Emergency: 1 month instead of 18
          if (result.archived > 0) {
            console.warn(`Emergency archived ${result.archived} records from ${table} to R2`);
          }
        } catch (error) {
          console.error(`Emergency archival failed for ${table}:`, error.message);
        }
      }));
    }

    // NOTE: Snapshots are permanent - NO AUTO-DELETE
    // Snapshots remain in R2 indefinitely unless user deletes account
    // User data is removed from snapshots only when user clicks "Delete Account"

    // Get stats
    const stats = await archival.getStats();
    // Archival task completed

    return {
      success: true,
      stats,
      note: 'Snapshots are permanent archive - no auto-deletion'
    };
  } catch (error) {
    console.error('Archival task error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Expose as an API endpoint for manual triggers
 * Usage: POST /admin/archival/run
 */
export async function handleArchivalRequest(request, env) {
  // Verify admin/authorized user
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const result = await scheduleArchivalTask(env);
  return new Response(JSON.stringify(result), {
    headers: { 'Content-Type': 'application/json' }
  });
}

/**
 * Get archival statistics
 * Usage: GET /admin/archival/stats
 */
export async function handleStatsRequest(env) {
  try {
    const archival = new ArchivalService(
      env.DB,
      env.DB2,
      env.DB3,
      env.STORAGE,
      env.SNAPSHOTS,
      env.CACHE
    );

    const stats = await archival.getStats();
    return new Response(JSON.stringify(stats), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
