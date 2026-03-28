// ============================================
// XORA SOCIAL API - MAIN WORKER
// ============================================

import { createRouter } from './router.js';
import { handleCors, addCorsHeaders } from './middleware/cors.js';
import { rateLimitMiddleware, addRateLimitHeaders, cleanupExpiredRateLimits } from './middleware/rateLimit.js';
import { initJWT } from './services/jwt.js';
import { initCache } from './services/dbCache.js';
import { errorResponse, getNoCacheHeaders } from './utils/helpers.js';

// One-time initialization flag to avoid reinitializing per request
let xoraInitialized = false;
let lastCleanupTime = 0;

function ensureInitialized(env) {
  if (xoraInitialized) return;
  try {
    // Initialize JWT with environment
    initJWT(env);
  } catch (e) {
    console.error('initJWT error:', e);
  }

  try {
    // Initialize database cache (1 min TTL, max 5000 items)
    initCache({ ttl: 60000, maxSize: 5000 });
  } catch (e) {
    console.error('initCache error:', e);
  }

  xoraInitialized = true;
}

/**
 * Periodic background cleanup for expired stories
 */
async function triggerStoryCleanup(env, ctx) {
  try {
    const now = Date.now();
    // Run cleanup every 30 minutes
    if (now - lastCleanupTime < 30 * 60 * 1000) {
      return;
    }
    
    lastCleanupTime = now;
    
    // Import stories controller and run cleanup
    const { StoriesController } = await import('./controllers/stories.js');
    const controller = new StoriesController(env);
    
    if (ctx && typeof ctx.waitUntil === 'function') {
      ctx.waitUntil(controller.cleanupExpiredStories().catch(e => {
        console.warn('Background story cleanup failed:', e);
      }));
    }
  } catch (e) {
    console.warn('Failed to trigger story cleanup:', e);
  }
}

// Export Durable Objects for WebSocket
export { ChatRoom } from './durable-objects/ChatRoom.js';
export { NotificationHub } from './durable-objects/NotificationHub.js';
export { RateLimiter } from './durable-objects/RateLimiter.js';

export default {
  async fetch(request, env, ctx) {
    // Ensure one-time initialization (avoid re-initializing per request)
    ensureInitialized(env);
    
    // Trigger periodic story cleanup (runs in background)
    if (ctx?.waitUntil) {
      ctx.waitUntil(triggerStoryCleanup(env, ctx));
    } else {
      triggerStoryCleanup(env, ctx);
    }

    const url = new URL(request.url);
    // Intercept WebSocket upgrade requests to /notifications/stream
    if (
      url.pathname === '/notifications/stream' &&
      request.headers.get('Upgrade') === 'websocket' &&
      env.NOTIFICATION_HUB
    ) {
      // Route to NotificationHub Durable Object
      const hubName = env.NOTIFICATION_HUB_ID || 'notifications';
      const id = env.NOTIFICATION_HUB.idFromName(hubName);
      const obj = env.NOTIFICATION_HUB.get(id);
      return await obj.fetch(request);
    }

    // Intercept WebSocket upgrade requests to /chat/:conversationId
    if (
      url.pathname.startsWith('/chat/') &&
      request.headers.get('Upgrade') === 'websocket' &&
      env.CHAT_ROOM
    ) {
      const conversationId = url.pathname.split('/').filter(Boolean)[1];
      if (conversationId) {
        const id = env.CHAT_ROOM.idFromName(conversationId);
        const obj = env.CHAT_ROOM.get(id);
        return await obj.fetch(request);
      }
    }

    // Handle CORS preflight
    const corsResponse = handleCors(request, env);
    if (corsResponse) {
      return corsResponse;
    }

    try {
      // Apply rate limiting
      const rateLimitResult = await rateLimitMiddleware(request, env);
      
      if (!rateLimitResult.allowed) {
        const errorRes = new Response(
          JSON.stringify(rateLimitResult.error),
          {
            status: 429,
            headers: {
              'Content-Type': 'application/json'
            }
          }
        );
        return addRateLimitHeaders(addCorsHeaders(errorRes, request, env), rateLimitResult);
      }

      // Create router
      const router = createRouter(env, ctx);

      // Handle request
      const response = await router.handle(request, env, ctx);

      // If response is an object (from controllers), convert to Response
      if (response && typeof response === 'object' && !response.headers) {
        const url = new URL(request.url);
        const isAuthEndpoint = url.pathname.startsWith('/auth/') || 
                               url.pathname.startsWith('/users/') ||
                               url.pathname.startsWith('/settings');
        
        // Add no-cache headers for sensitive endpoints
        const headers = {
          'Content-Type': 'application/json',
          ...(isAuthEndpoint ? getNoCacheHeaders() : {})
        };

        const jsonResponse = new Response(JSON.stringify(response), {
          status: response.success ? 200 : (response.error?.code || 500),
          headers
        });
        return addRateLimitHeaders(addCorsHeaders(jsonResponse, request, env), rateLimitResult);
      }

      // Add CORS and rate limit headers to response
      return addRateLimitHeaders(addCorsHeaders(response, request, env), rateLimitResult);

    } catch (error) {
      console.error('Worker error:', error);
      
      const errorRes = new Response(
        JSON.stringify(errorResponse('Internal server error', 500)),
        {
          status: 500,
          headers: {
            'Content-Type': 'application/json'
          }
        }
      );

      return addCorsHeaders(errorRes, request, env);
    }
  },

  // Handle scheduled cron events
  async scheduled(event, env, _ctx) {
    try {
      // Initialize JWT for scheduled jobs
      initJWT(env);

      const { ScheduledJobsController } = await import('./controllers/scheduled.js');
      const scheduler = new ScheduledJobsController(env);

      // Determine which job to run based on cron schedule
      // Merged crons to stay within Cloudflare's 5 trigger limit
      const { cron } = event;

      if (cron === '0 * * * *') {
        // Hourly: trending scores + archival check + expired batches + rate limit cleanup
        await scheduler.updateTrendingScores({});

        const { scheduleArchivalTask } = await import('./services/archivalScheduler.js');
        await scheduleArchivalTask(env);

        await scheduler.processExpiredBatches({});
        await cleanupExpiredRateLimits(env);

      } else if (cron === '0 2 * * *') {
        // Daily at 2 AM: cleanup + weekly snapshot (check if Monday)
        await scheduler.cleanupOldData({});

        // Export DB snapshot on Mondays only
        const today = new Date();
        if (today.getUTCDay() === 1) { // Monday = 1
          await scheduler.exportSnapshot({});
        }
      }

      // Scheduled job completed
    } catch (error) {
      console.error('Scheduled job error:', error);
    }
  }
};
