// Feed Controller - Advanced algorithm with suggested feed
// Optimized for 100k+ users with aggressive caching
import { DatabaseService } from '../services/database.js';
import { FeedAlgorithmService } from '../services/feedAlgorithm.js';
import { SensitiveContentHandler, TrendingSafetyFilter } from '../services/sensitiveContent.js';
import { AdService } from '../services/adService.js';
import { DbRouter } from '../services/dbRouter.js';
import { errorResponse, successResponse, parseCursor, createCursor, safeParseInt } from '../utils/helpers.js';

// Cache TTLs for different data types (increased to reduce KV writes on free tier)
const FEED_CACHE_TTL = 60; // 60 seconds - feed results (faster refresh, respects KV minimum)
const FOLLOW_LIST_CACHE_TTL = 600; // 10 minutes - follow relationships (was 5m)
const BLOCK_LIST_CACHE_TTL = 600; // 10 minutes - block relationships (was 5m)
const TRENDING_CACHE_TTL = 300; // 5 minutes - global trending (was 2m)

// Add jitter to cache TTL to prevent thundering herd (±15% but respect KV minimum of 60)
function getJitteredTTL(baseTTL) {
  const jitter = baseTTL * 0.15; // 15% jitter
  const result = Math.floor(baseTTL + (Math.random() * jitter * 2) - jitter);
  return Math.max(result, 60); // Cloudflare KV minimum is 60 seconds
}

function parseMediaUrlsField(mediaValue) {
  if (!mediaValue) return [];
  if (Array.isArray(mediaValue)) return mediaValue;
  if (typeof mediaValue === 'string') {
    try {
      const parsed = JSON.parse(mediaValue);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

export class FeedController {
  constructor(env) {
    this.db = DatabaseService.fromEnv(env);
    this.env = env;
    this.cache = env.CACHE;
    this.dbRouter = this.db.router || DbRouter.fromEnv(env);
    const primaryDb = this.dbRouter.getPrimaryDb();
    this.feedAlgo = new FeedAlgorithmService(primaryDb, env.CACHE);
    this.sensitiveHandler = new SensitiveContentHandler(primaryDb, env.CACHE);
    this.trendingFilter = new TrendingSafetyFilter(primaryDb);
    this.adService = new AdService(primaryDb, env.CACHE);
  }

  async resolveEngagementActor(userId, actorTypeParam, actorIdParam) {
    const fallback = { actorType: 'user', actorId: userId };
    if (!userId) return fallback;

    if (actorTypeParam === 'page' && actorIdParam) {
      try {
        const isOwner = await this.db.isPageOwner(actorIdParam, userId);
        if (isOwner) {
          return { actorType: 'page', actorId: actorIdParam };
        }
      } catch {
        // Fall back to user identity on errors
      }
      return fallback;
    }

    if (actorTypeParam === 'user') {
      if (!actorIdParam || String(actorIdParam) === String(userId)) {
        return fallback;
      }
    }

    return fallback;
  }

  async attachEngagementFlags(userId, items, actorContext = null) {
    if (!userId || !Array.isArray(items) || items.length === 0) return items;

    const resolvedActorType = actorContext?.actorType === 'page' ? 'page' : 'user';
    const resolvedActorId = actorContext?.actorId || userId;

    const postIds = new Set();
    for (const item of items) {
      if (!item || item.type === 'ad') continue;
      if (item.isShare && item.originalPost?.id) {
        postIds.add(String(item.originalPost.id));
      } else if (item.id) {
        postIds.add(String(item.id));
      }
    }

    const ids = [...postIds];
    if (ids.length === 0) return items;

    const placeholders = ids.map(() => '?').join(',');

    const likesResult = await this.env.DB.prepare(`
      SELECT target_id FROM likes
      WHERE target_type = 'post'
        AND actor_type = ?
        AND actor_id = ?
        AND target_id IN (${placeholders})
    `).bind(resolvedActorType, resolvedActorId, ...ids).all();

    const bookmarksResult = await this.env.DB.prepare(`
      SELECT post_id FROM bookmarks
      WHERE user_id = ?
        AND post_id IN (${placeholders})
    `).bind(userId, ...ids).all();

    const likedSet = new Set((likesResult.results || []).map((r) => String(r.target_id)));
    const bookmarkedSet = new Set((bookmarksResult.results || []).map((r) => String(r.post_id)));

    return items.map((item) => {
      if (!item || item.type === 'ad') return item;

      if (item.isShare && item.originalPost) {
        const originalId = String(item.originalPost.id);
        return {
          ...item,
          originalPost: {
            ...item.originalPost,
            liked_by_me: likedSet.has(originalId),
            bookmarked_by_me: bookmarkedSet.has(originalId),
          },
        };
      }

      if (!item.id) return item;

      const itemId = String(item.id);
      return {
        ...item,
        liked_by_me: likedSet.has(itemId),
        bookmarked_by_me: bookmarkedSet.has(itemId),
      };
    });
  }

  async attachEngagementCounts(items) {
    if (!Array.isArray(items) || items.length === 0) return items;

    const postIds = new Set();
    for (const item of items) {
      if (!item || item.type === 'ad') continue;
      if (item.isShare && item.originalPost?.id) {
        postIds.add(String(item.originalPost.id));
      } else if (item.id) {
        postIds.add(String(item.id));
      }
    }

    const ids = [...postIds];
    if (ids.length === 0) return items;

    const counts = await this.db.getPostEngagementCounts(ids);

    return items.map((item) => {
      if (!item || item.type === 'ad') return item;

      if (item.isShare && item.originalPost) {
        const originalId = String(item.originalPost.id);
        return {
          ...item,
          originalPost: {
            ...item.originalPost,
            likes_count: counts.likes.has(originalId)
              ? counts.likes.get(originalId)
              : (item.originalPost.likes_count ?? item.originalPost.likes ?? 0),
            comments_count: counts.comments.has(originalId)
              ? counts.comments.get(originalId)
              : (item.originalPost.comments_count ?? item.originalPost.comments ?? 0),
            shares_count: counts.shares.has(originalId)
              ? counts.shares.get(originalId)
              : (item.originalPost.shares_count ?? item.originalPost.shares ?? 0)
          }
        };
      }

      if (!item.id) return item;
      const itemId = String(item.id);

      return {
        ...item,
        likes_count: counts.likes.has(itemId)
          ? counts.likes.get(itemId)
          : (item.likes_count ?? item.likes ?? 0),
        comments_count: counts.comments.has(itemId)
          ? counts.comments.get(itemId)
          : (item.comments_count ?? item.comments ?? 0),
        shares_count: counts.shares.has(itemId)
          ? counts.shares.get(itemId)
          : (item.shares_count ?? item.shares ?? 0)
      };
    });
  }

  /**
   * Get fallback posts when main sources (following, trending, suggested, imported) are exhausted
   * Returns ONLY posts not yet fetched in this request, ordered by engagement + recency
   * NEVER shows empty feeds - always sustainable as long as posts exist in backend
   */
  buildFallbackQuery(allFetchedPostIds, blockedSet, lang, cursor) {
    const params = [];
    let query = `SELECT p.* FROM posts p WHERE 1=1`;

    if (allFetchedPostIds?.size > 0) {
      const ids = Array.from(allFetchedPostIds);
      query += ` AND p.id NOT IN (${ids.map(() => '?').join(',')})`;
      params.push(...ids);
    }

    if (blockedSet?.size > 0) {
      const blockedArray = Array.from(blockedSet).map(b => {
        const [type, id] = b.split(':');
        return { type, id };
      });
      const userBlocked = blockedArray.filter(p => p.type === 'user').map(p => p.id);
      const pageBlocked = blockedArray.filter(p => p.type === 'page').map(p => p.id);
      
      if (userBlocked.length > 0) {
        query += ` AND NOT (p.actor_type = 'user' AND p.actor_id IN (${userBlocked.map(() => '?').join(',')}))`;
        params.push(...userBlocked);
      }
      if (pageBlocked.length > 0) {
        query += ` AND NOT (p.actor_type = 'page' AND p.actor_id IN (${pageBlocked.map(() => '?').join(',')}))`;
        params.push(...pageBlocked);
      }
    }

    if (lang) {
      query += ` AND p.language = ?`;
      params.push(lang);
    }

    if (cursor) {
      const cursorData = parseCursor(cursor);
      if (cursorData?.created_at) {
        query += ` AND p.created_at < ?`;
        params.push(cursorData.created_at);
      }
    }

    return { query, params };
  }

  async fetchFallbackBatch(lang, blockedSet, batchLimit) {
    // Fetch large batch from DB for caching - with size caps for load safety
    // Hard limit to prevent memory explosion under heavy load (200 posts max per cache batch)
    const safeBatchLimit = Math.min(batchLimit, 200);
    
    const { query: baseQuery, params } = this.buildFallbackQuery(
      new Set(), blockedSet, lang, null
    );
    const query = `${baseQuery} ORDER BY p.created_at DESC, (p.likes_count + p.comments_count * 2) DESC LIMIT ?`;
    params.push(safeBatchLimit);

    const result = await this.env.DB.prepare(query).bind(...params).all();
    const rawPosts = result.results || [];
    if (rawPosts.length === 0) return [];

    // Batch fetch actors
    const uniqueActors = new Map();
    for (const p of rawPosts) {
      const key = `${p.actor_type}:${p.actor_id}`;
      if (!uniqueActors.has(key)) {
        uniqueActors.set(key, { type: p.actor_type, id: p.actor_id });
      }
    }
    const actorMap = await this.batchFetchActors([...uniqueActors.values()]);

    // Enrich posts
    return rawPosts.map(post => {
      const actorInfo = actorMap.get(`${post.actor_type}:${post.actor_id}`) || {};
      const processed = {
        ...post,
        username: actorInfo.username || null,
        actor_name: actorInfo.name || actorInfo.username || 'Unknown',
        avatar_url: actorInfo.avatar_url || null,
        verified: actorInfo.verified || 0,
        actor: {
          id: post.actor_id,
          username: actorInfo.username || null,
          name: actorInfo.name || null,
          avatar_url: actorInfo.avatar_url || null,
          verified: actorInfo.verified || 0
        }
      };
      processed.media_urls = parseMediaUrlsField(processed.media_urls);
      return processed;
    });
  }

  async getFallbackPosts(options = {}) {
    try {
      const { limit, allFetchedPostIds, cursor, lang, blockedSet } = options;
      if (limit <= 0) return [];

      const cacheKey = `feed:fallback:${lang || 'all'}:${blockedSet?.size || 0}`;
      const cached = await this.cache.get(cacheKey);
      const allFallbackPosts = cached ? JSON.parse(cached) : 
        await this.fetchFallbackBatch(lang, blockedSet, Math.max(50, limit * 2));
      
      if (!cached && allFallbackPosts.length > 0) {
        await this.cache.put(cacheKey, JSON.stringify(allFallbackPosts), {
          expirationTtl: 60
        });
      }

      if (allFallbackPosts.length === 0) return [];

      let paginated = allFallbackPosts.filter(p => !allFetchedPostIds?.has(p.id));
      if (cursor && paginated.length > 10) {
        const cursorTime = parseCursor(cursor)?.created_at;
        if (cursorTime) {
          let left = 0;
          let right = paginated.length - 1;
          let firstOlderIdx = paginated.length;
          while (left <= right) {
            const mid = Math.floor((left + right) / 2);

            // paginated is sorted DESC by created_at (newest -> oldest)
            // We need first item where created_at < cursorTime (strictly older)
            if (paginated[mid].created_at < cursorTime) {
              firstOlderIdx = mid;
              right = mid - 1;
            } else {
              left = mid + 1;
            }
          }
          paginated = firstOlderIdx < paginated.length ? paginated.slice(firstOlderIdx) : [];
        }
      }
      return paginated.slice(0, limit);
    } catch (error) {
      console.error('Get fallback posts error:', error);
      return [];
    }
  }

  /**
   * Get cached follow list for a user (who they follow)
   * Dramatically speeds up feed queries at scale
   */
  async getCachedFollowList(userId) {
    const cacheKey = `follows:${userId}`;

    if (this.cache) {
      try {
        const cached = await this.cache.get(cacheKey);
        if (cached) return JSON.parse(cached);
      } catch { /* ignore */ }
    }

    // Cache miss - query and cache
    const result = await this.env.DB.prepare(`
      SELECT followee_type, followee_id FROM follows
      WHERE follower_type = 'user' AND follower_id = ?
    `).bind(userId).all();

    const followList = result.results || [];

    if (this.cache) {
      try {
        await this.cache.put(cacheKey, JSON.stringify(followList), { expirationTtl: FOLLOW_LIST_CACHE_TTL });
      } catch { /* ignore */ }
    }

    return followList;
  }

  /**
   * Get cached block list for a user
   */
  async getCachedBlockList(userId) {
    const cacheKey = `blocks:${userId}`;

    if (this.cache) {
      try {
        const cached = await this.cache.get(cacheKey);
        if (cached) return JSON.parse(cached);
      } catch { /* ignore */ }
    }

    const result = await this.env.DB.prepare(`
      SELECT blocked_type, blocked_id FROM blocks WHERE blocker_type = 'user' AND blocker_id = ?
      UNION
      SELECT blocker_type, blocker_id FROM blocks WHERE blocked_type = 'user' AND blocked_id = ?
    `).bind(userId, userId).all();

    const blockList = result.results || [];

    if (this.cache) {
      try {
        await this.cache.put(cacheKey, JSON.stringify(blockList), { expirationTtl: BLOCK_LIST_CACHE_TTL });
      } catch { /* ignore */ }
    }

    return blockList;
  }

  /**
   * Batch fetch user/page info for multiple actor IDs
   * Eliminates N+1 queries
   */
  async batchFetchActors(actorIds) {
    if (!actorIds || actorIds.length === 0) return new Map();

    const userIds = actorIds.filter(a => a.type === 'user').map(a => a.id);
    const pageIds = actorIds.filter(a => a.type === 'page').map(a => a.id);

    const actorMap = new Map();

    // Batch fetch users
    if (userIds.length > 0) {
      const placeholders = userIds.map(() => '?').join(',');
      const users = await this.env.DB.prepare(`
        SELECT id, username, name, avatar_url, verified FROM users WHERE id IN (${placeholders})
      `).bind(...userIds).all();

      for (const u of users.results || []) {
        actorMap.set(`user:${u.id}`, {
          username: u.username,
          name: u.name || u.username,
          avatar_url: u.avatar_url,
          verified: u.verified
        });
      }
    }

    // Batch fetch pages (pages don't have username column, use name as identifier)
    if (pageIds.length > 0) {
      const placeholders = pageIds.map(() => '?').join(',');
      const pages = await this.env.DB.prepare(`
        SELECT id, name, avatar_url, verified FROM pages WHERE id IN (${placeholders})
      `).bind(...pageIds).all();

      for (const p of pages.results || []) {
        actorMap.set(`page:${p.id}`, {
          username: p.name, // Pages use name as their display handle
          name: p.name,
          avatar_url: p.avatar_url,
          verified: p.verified
        });
      }
    }

    return actorMap;
  }

  async getFeed(request, userId) {
    try {
      const url = new URL(request.url);
      const limit = safeParseInt(url.searchParams.get('limit'), 20, 1, 100);
      const cursor = url.searchParams.get('cursor');
      const type = url.searchParams.get('type') || 'home';
      const lang = url.searchParams.get('lang');
      const actorTypeParam = url.searchParams.get('actorType');
      const actorIdParam = url.searchParams.get('actorId');

      const actorContext = await this.resolveEngagementActor(userId, actorTypeParam, actorIdParam);

      if (type === 'home') {
        return await this.getHomeFeed(userId, limit, cursor, lang, actorContext);
      }
      if (type === 'trending') {
        return await this.getTrendingFeed(userId, limit, lang, actorContext);
      }
      if (type === 'suggested') {
        return await this.getSuggestedFeed(userId, limit, cursor, lang, actorContext);
      }

      return errorResponse('Invalid feed type', 400);
    } catch (error) {
      console.error('Get feed error:', error);
      return errorResponse('Failed to get feed', 500);
    }
  }

  /**
   * Get home feed - OPTIMIZED for 100k+ users
   * For users with no follows, includes posts from trending and suggested feeds
   * Uses cached follow/block lists and simpler queries
   */
  async getHomeFeed(userId, limit, cursor, lang, actorContext) {
    try {
      // Check feed cache first (60 second TTL)
      const actorKey = actorContext?.actorType === 'page'
        ? `page:${actorContext.actorId}`
        : `user:${userId}`;
      const cacheKey = `feed:home:${userId}:${actorKey}:${limit}:${cursor || 'start'}:${lang || 'all'}`;
      if (this.cache) {
        try {
          const cached = await this.cache.get(cacheKey);
          if (cached) {
            return successResponse(JSON.parse(cached));
          }
        } catch { /* ignore cache errors */ }
      }

      // Get cached follow list to check if user has follows
      const followList = await this.getCachedFollowList(userId);
      const hasFollows = followList.length > 0;

      // Get cached block list for filtering
      const blockList = await this.getCachedBlockList(userId);
      const blockedSet = new Set(blockList.map(b => `${b.blocked_type || b.blocker_type}:${b.blocked_id || b.blocker_id}`));

      let combinedPosts = [];
      let hasMore = false;
      let nextCursor = null;

      // Fetch all post sources and merge chronologically
      let allPosts = [];

      if (hasFollows) {
        // Get followed posts - APPLY CURSOR to source query for correct chronological window
        const params = [userId, userId];
        let query = `
          SELECT DISTINCT p.* FROM posts p
          LEFT JOIN follows f ON (
            f.follower_type = 'user' AND f.follower_id = ?
            AND f.followee_type = p.actor_type AND f.followee_id = p.actor_id
          )
          WHERE (
            (p.actor_type = 'user' AND p.actor_id = ?)
            OR f.id IS NOT NULL
          )
        `;

        if (lang) {
          query += ` AND p.language = ?`;
          params.push(lang);
        }

        // Apply cursor at source level - ensures we fetch from correct chronological window
        if (cursor) {
          const cursorData = parseCursor(cursor);
          if (cursorData?.created_at) {
            query += ` AND p.created_at < ?`;
            params.push(cursorData.created_at);
          }
        }

        query += ` ORDER BY p.created_at DESC LIMIT ?`;
        params.push(limit * 3); // Fetch extra for merging

        const result = await this.env.DB.prepare(query).bind(...params).all();
        allPosts.push(...(result.results || []));

        // Also fetch shares
        const sharesResult = await this.getFollowedSharesOptimized(userId, limit, null, blockedSet);
        const hydratedShares = await this.hydrateSharesBatched(sharesResult);
        allPosts.push(...hydratedShares);
      }

      // Get trending posts
      const trendingResponse = await this.getTrendingFeed(userId, Math.ceil(limit * 1.5), lang, actorContext);
      const trendingPosts = trendingResponse.success ? (trendingResponse.data?.posts || []) : [];
      allPosts.push(...trendingPosts);

      // Get suggested posts
      const suggestedResponse = await this.getSuggestedFeed(userId, limit * 2, null, lang, actorContext);
      const suggestedPosts = suggestedResponse.success ? (suggestedResponse.data?.posts || []) : [];
      allPosts.push(...suggestedPosts);

      // Get imported posts (always available to all users) - with cursor for pagination
      const importedPosts = await this.getImportedPosts(userId, limit * 2, blockedSet, cursor, lang);
      allPosts.push(...importedPosts);

      // Normalize posts from mixed internal sources (some already camelCased via successResponse)
      allPosts = allPosts
        .filter(Boolean)
        .map((post) => {
          const normalizedPost = {
            ...post,
            actor_type: post.actor_type || post.actorType || null,
            actor_id: post.actor_id || post.actorId || null,
            created_at: post.created_at || post.createdAt || post.timestamp || null,
            media_urls: post.media_urls ?? post.mediaUrls ?? null,
          };

          if (normalizedPost.isShare && normalizedPost.originalPost) {
            normalizedPost.originalPost = {
              ...normalizedPost.originalPost,
              actor_type: normalizedPost.originalPost.actor_type || normalizedPost.originalPost.actorType || null,
              actor_id: normalizedPost.originalPost.actor_id || normalizedPost.originalPost.actorId || null,
              created_at: normalizedPost.originalPost.created_at || normalizedPost.originalPost.createdAt || null,
              media_urls: normalizedPost.originalPost.media_urls ?? normalizedPost.originalPost.mediaUrls ?? null,
            };
          }

          return normalizedPost;
        });

      // Filter out blocked actors
      allPosts = allPosts.filter(p => !blockedSet.has(`${p.actor_type}:${p.actor_id}`));

      // Batch fetch actor info for all posts
      const uniqueActors = new Map();
      for (const p of allPosts) {
        if (!p || !p.id) continue;
        const key = `${p.actor_type}:${p.actor_id}`;
        if (!uniqueActors.has(key)) {
          uniqueActors.set(key, { type: p.actor_type, id: p.actor_id });
        }
      }
      const actorIds = [...uniqueActors.values()];
      const actorMap = await this.batchFetchActors(actorIds);

      // Enrich all posts with actor info and deduplicate
      const postMap = new Map();
      for (const post of allPosts) {
        if (!post || !post.id) continue;
        if (postMap.has(post.id)) continue; // Skip duplicates

        const actorInfo = actorMap.get(`${post.actor_type}:${post.actor_id}`) || {};
        const fallbackActor = post.actor || {};
        const resolvedActorId = post.actor_id || fallbackActor.id || null;
        const processedPost = {
          ...post,
          username: actorInfo.username || post.username || fallbackActor.username || null,
          actor_name: actorInfo.name || actorInfo.username || post.actor_name || post.actorName || fallbackActor.name || post.username || fallbackActor.username || 'Unknown',
          avatar_url: actorInfo.avatar_url || post.avatar_url || post.avatarUrl || fallbackActor.avatar_url || fallbackActor.avatarUrl || null,
          verified: actorInfo.verified ?? post.verified ?? fallbackActor.verified ?? 0,
          actor: {
            id: resolvedActorId,
            username: actorInfo.username || post.username || fallbackActor.username || null,
            name: actorInfo.name || post.actor_name || post.actorName || fallbackActor.name || null,
            avatar_url: actorInfo.avatar_url || post.avatar_url || post.avatarUrl || fallbackActor.avatar_url || fallbackActor.avatarUrl || null,
            verified: actorInfo.verified ?? post.verified ?? fallbackActor.verified ?? 0
          }
        };
        processedPost.media_urls = parseMediaUrlsField(processedPost.media_urls);
        postMap.set(post.id, processedPost);
      }

      // Sort all posts chronologically (newest first)
      const sortedPosts = Array.from(postMap.values())
        .sort((a, b) => new Date(b.created_at || b.createdAt || 0) - new Date(a.created_at || a.createdAt || 0));

      // CRITICAL: Cursor already applied at source level, so no need to filter again here
      // This ensures we capture ALL posts in the chronological window

      // FALLBACK MECHANISM: If main sources exhausted, fetch remaining posts
      // This ensures user NEVER sees an empty feed (unless truly no posts exist)
      // Since cursor is now applied at source level, fallback must also respect the timeline
      if (sortedPosts.length < limit) {
        const seenPostIds = new Set(postMap.keys()); // Use deduped postMap keys, not raw allPosts
        const postsNeeded = limit - sortedPosts.length;

        const fallbackPosts = await this.getFallbackPosts({
          userId,
          limit: postsNeeded,
          allFetchedPostIds: seenPostIds,
          cursor,
          lang,
          blockedSet
        });

        // Add fallback posts to our collection (no dupes because seenPostIds excludes them)
        for (const post of fallbackPosts) {
          if (!postMap.has(post.id)) {
            postMap.set(post.id, post);
            sortedPosts.push(post);
          }
        }

        // Re-sort if fallback posts were added
        if (fallbackPosts.length > 0) {
          sortedPosts.sort((a, b) => new Date(b.created_at || b.createdAt || 0) - new Date(a.created_at || a.createdAt || 0));
        }
      }

      // Take limit + 1 to check if there are more posts
      hasMore = sortedPosts.length > limit;
      combinedPosts = sortedPosts.slice(0, limit);

      // Build next cursor
      if (hasMore && combinedPosts.length > 0) {
        const lastPost = combinedPosts[combinedPosts.length - 1];
        nextCursor = createCursor({ created_at: lastPost.created_at || lastPost.createdAt });
      }

      // Filter sensitive content
      const filtered = await this.sensitiveHandler.filterFeedPosts(combinedPosts, userId);

      // Inject advertisements into feed
      const ads = await this.adService.selectAdsForUser(userId, 'feed', 2, { language: lang });
      const feedWithAds = this.adService.injectAdsIntoFeed(filtered, ads, 5);

      // Attach engagement data to the final feed (including ads)
      const feedWithCounts = await this.attachEngagementCounts(feedWithAds);
      const enrichedFeed = await this.attachEngagementFlags(userId, feedWithCounts, actorContext);
      const feedResult = { posts: enrichedFeed, pagination: { hasMore, nextCursor } };

      // Cache the feed result
      if (this.cache) {
        try {
          await this.cache.put(cacheKey, JSON.stringify(feedResult), { expirationTtl: getJitteredTTL(FEED_CACHE_TTL) });
        } catch { /* ignore */ }
      }

      return successResponse(feedResult);
    } catch (error) {
      console.error('Get home feed error:', error);
      return errorResponse('Failed to get home feed', 500);
    }
  }

  /**
   * OPTIMIZED: Get shares from followed accounts using JOIN - scales to unlimited follows
   */
  async getFollowedSharesOptimized(userId, limit, cursor, blockedSet) {
    try {
      const params = [userId, userId];

      // Use JOIN with follows table - scales to unlimited follows
      let query = `
        SELECT DISTINCT s.* FROM shares s
        LEFT JOIN follows f ON (
          f.follower_type = 'user' AND f.follower_id = ?
          AND f.followee_type = s.actor_type AND f.followee_id = s.actor_id
        )
        WHERE (
          (s.actor_type = 'user' AND s.actor_id = ?)
          OR f.id IS NOT NULL
        )
      `;

      if (cursor) {
        const cursorData = parseCursor(cursor);
        if (cursorData?.created_at) {
          query += ` AND s.created_at < ?`;
          params.push(cursorData.created_at);
        }
      }

      query += ` ORDER BY s.created_at DESC LIMIT ?`;
      params.push(limit + 1);

      const result = await this.env.DB.prepare(query).bind(...params).all();
      let shares = result.results || [];

      // Filter blocked in memory
      shares = shares.filter(s => !blockedSet.has(`${s.actor_type}:${s.actor_id}`));

      return shares;
    } catch (error) {
      console.error('Get followed shares error:', error);
      return [];
    }
  }

  /**
   * OPTIMIZED: Hydrate shares with batched queries (no N+1)
   */
  async hydrateSharesBatched(shares) {
    if (!shares || shares.length === 0) return [];

    // Collect all original post IDs
    const originalPostIds = [...new Set(shares.map(s => s.original_post_id).filter(Boolean))];
    if (originalPostIds.length === 0) return [];

    // Batch fetch all original posts
    const placeholders = originalPostIds.map(() => '?').join(',');
    const postsResult = await this.env.DB.prepare(`
      SELECT * FROM posts WHERE id IN (${placeholders})
    `).bind(...originalPostIds).all();

    const postsMap = new Map();
    for (const p of postsResult.results || []) {
      postsMap.set(p.id, p);
    }

    // Collect actor IDs from both shares and original posts
    const actorIds = [];
    for (const share of shares) {
      actorIds.push({ type: share.actor_type, id: share.actor_id });
      const originalPost = postsMap.get(share.original_post_id);
      if (originalPost) {
        actorIds.push({ type: originalPost.actor_type, id: originalPost.actor_id });
      }
    }

    // Batch fetch all actors
    const actorMap = await this.batchFetchActors(actorIds);

    // Build hydrated shares
    const hydrated = [];
    for (const share of shares) {
      const originalPost = postsMap.get(share.original_post_id);
      if (!originalPost) continue;

      const shareActorInfo = actorMap.get(`${share.actor_type}:${share.actor_id}`) || {};
      const origActorInfo = actorMap.get(`${originalPost.actor_type}:${originalPost.actor_id}`) || {};

      // Parse media URLs
      const mediaUrls = parseMediaUrlsField(originalPost.media_urls);

      hydrated.push({
        ...share,
        username: shareActorInfo.username || null,
        actor_name: shareActorInfo.name || shareActorInfo.username || 'Unknown',
        avatar_url: shareActorInfo.avatar_url || null,
        verified: shareActorInfo.verified || 0,
        isShare: true,
        originalPost: {
          id: originalPost.id,
          content: originalPost.content,
          media_urls: mediaUrls,
          media_type: originalPost.media_type,
          likes_count: originalPost.likes_count,
          comments_count: originalPost.comments_count,
          shares_count: originalPost.shares_count,
          actor_type: originalPost.actor_type,
          actor_id: originalPost.actor_id,
          username: origActorInfo.username || null,
          actor_name: origActorInfo.name || origActorInfo.username || 'Unknown',
          avatar_url: origActorInfo.avatar_url || null,
          verified: origActorInfo.verified || 0,
          created_at: originalPost.created_at
        }
      });
    }

    return hydrated;
  }

  /**
   * Get suggested feed - OPTIMIZED with caching
   * Falls back to recent posts when no exposures exist (new users)
   * Supports both exposed_at and created_at cursors for home feed compatibility
   */
  async getSuggestedFeed(userId, limit, cursor, lang, actorContext) {
    try {
      // Check cache first (60 second TTL)
      const actorKey = actorContext?.actorType === 'page'
        ? `page:${actorContext.actorId}`
        : `user:${userId}`;
      const cacheKey = `feed:suggested:${userId}:${actorKey}:${limit}:${cursor || 'start'}:${lang || 'all'}`;
      if (this.cache) {
        try {
          const cached = await this.cache.get(cacheKey);
          if (cached) return successResponse(JSON.parse(cached));
        } catch { /* ignore */ }
      }

      // Get cached block list for filtering
      const blockList = await this.getCachedBlockList(userId);
      const blockedSet = new Set(blockList.map(b => `${b.blocked_type || b.blocker_type}:${b.blocked_id || b.blocker_id}`));

      // Parse cursor to support both exposed_at (native) and created_at (from home feed)
      let cursorData = null;
      if (cursor) {
        cursorData = parseCursor(cursor);
      }

      // Try to get posts from exposures first
      let posts = [];

      // Query post_exposures for suggested content
      let query = `
        SELECT DISTINCT p.*, pe.exposed_at
        FROM post_exposures pe
        JOIN posts p ON pe.post_id = p.id
        WHERE pe.user_id = ?
      `;

      const params = [userId];

      if (lang) {
        query += ` AND p.language = ?`;
        params.push(lang);
      }

      // Support both cursor types for pagination compatibility
      if (cursorData?.exposed_at) {
        query += ` AND pe.exposed_at < ?`;
        params.push(cursorData.exposed_at);
      } else if (cursorData?.created_at) {
        // Fallback: use created_at cursor from home feed
        query += ` AND p.created_at < ?`;
        params.push(cursorData.created_at);
      }

      query += ` ORDER BY pe.exposed_at DESC LIMIT ?`;
      params.push((limit + 1) * 2); // Fetch extra for filtering

      const result = await this.env.DB.prepare(query).bind(...params).all();
      posts = result.results || [];

      // Fallback: If no exposures, fetch recent posts from users the user doesn't follow
      if (posts.length === 0) {
        const followList = await this.getCachedFollowList(userId);

        // Build exclusion list (self + followed accounts)
        const excludeIds = [userId];
        const excludeConditions = [`(p.actor_type = 'user' AND p.actor_id = ?)`];

        for (const f of followList) {
          excludeConditions.push(`(p.actor_type = ? AND p.actor_id = ?)`);
          excludeIds.push(f.followee_type, f.followee_id);
        }

        let fallbackQuery = `
          SELECT DISTINCT p.*, p.created_at as exposed_at
          FROM posts p
          WHERE NOT (${excludeConditions.join(' OR ')})
        `;

        const fallbackParams = [...excludeIds];

        if (lang) {
          fallbackQuery += ` AND p.language = ?`;
          fallbackParams.push(lang);
        }

        if (cursorData?.created_at) {
          fallbackQuery += ` AND p.created_at < ?`;
          fallbackParams.push(cursorData.created_at);
        } else if (cursorData?.exposed_at) {
          // Treat exposed_at as created_at for fallback
          fallbackQuery += ` AND p.created_at < ?`;
          fallbackParams.push(cursorData.exposed_at);
        }

        fallbackQuery += ` ORDER BY p.created_at DESC LIMIT ?`;
        fallbackParams.push((limit + 1) * 2);

        const fallbackResult = await this.env.DB.prepare(fallbackQuery).bind(...fallbackParams).all();
        posts = fallbackResult.results || [];
      }

      // Filter blocked actors in memory
      posts = posts.filter(p => !blockedSet.has(`${p.actor_type}:${p.actor_id}`));

      const hasMore = posts.length > limit;
      posts = posts.slice(0, limit);

      // Create cursor with both fields for maximum compatibility
      let nextCursor = null;
      if (hasMore && posts.length > 0) {
        const lastPost = posts[posts.length - 1];
        nextCursor = createCursor({
          exposed_at: lastPost.exposed_at,
          created_at: lastPost.created_at || lastPost.exposed_at
        });
      }

      // Batch fetch actor info (dedupe actors properly)
      const uniqueActors = new Map();
      for (const p of posts) {
        const key = `${p.actor_type}:${p.actor_id}`;
        if (!uniqueActors.has(key)) {
          uniqueActors.set(key, { type: p.actor_type, id: p.actor_id });
        }
      }
      const actorIds = [...uniqueActors.values()];
      const actorMap = await this.batchFetchActors(actorIds);

      const processedPosts = posts.map(post => {
        const actorInfo = actorMap.get(`${post.actor_type}:${post.actor_id}`) || {};
        const processedPost = {
          ...post,
          username: actorInfo.username || null,
          actor_name: actorInfo.name || actorInfo.username || 'Unknown',
          avatar_url: actorInfo.avatar_url || null,
          verified: actorInfo.verified || 0,
          actor: {
            id: post.actor_id,
            username: actorInfo.username || null,
            name: actorInfo.name || null,
            avatar_url: actorInfo.avatar_url || null,
            verified: actorInfo.verified || 0
          }
        };
        processedPost.media_urls = parseMediaUrlsField(processedPost.media_urls);
        return processedPost;
      });

      // Filter sensitive content
      const filtered = await this.sensitiveHandler.filterFeedPosts(processedPosts, userId);

      const filteredWithCounts = await this.attachEngagementCounts(filtered);
      const enrichedFeed = await this.attachEngagementFlags(userId, filteredWithCounts, actorContext);
      const feedResult = { posts: enrichedFeed, pagination: { hasMore, nextCursor } };

      // Cache the result
      if (this.cache) {
        try {
          await this.cache.put(cacheKey, JSON.stringify(feedResult), { expirationTtl: getJitteredTTL(FEED_CACHE_TTL) });
        } catch { /* ignore */ }
      }

      return successResponse(feedResult);
    } catch (error) {
      console.error('Get suggested feed error:', error);
      return errorResponse('Failed to get suggested feed', 500);
    }
  }

  /**
   * Get trending feed - OPTIMIZED with GLOBAL cache per language
   * All users see the same trending posts (just filtered for their blocks)
   */
  async getTrendingFeed(userId, limit, lang, actorContext) {
    try {
      // Use GLOBAL cache key (same for all users per language) - much better cache hit rate
      const globalCacheKey = `feed:trending:global:${limit}:${lang || 'all'}`;

      let trendingPosts = null;

      // Check global cache first (60 second TTL)
      if (this.cache) {
        try {
          const cached = await this.cache.get(globalCacheKey);
          if (cached) {
            trendingPosts = JSON.parse(cached);
          }
        } catch { /* ignore */ }
      }

      // Cache miss - fetch from DB
      if (!trendingPosts) {
        let query = `
          SELECT p.*, tp.score
          FROM trending_posts tp
          JOIN posts p ON tp.post_id = p.id
        `;

        const params = [];

        if (lang) {
          query += ` WHERE tp.language = ?`;
          params.push(lang);
        }

        query += ` ORDER BY tp.score DESC, tp.started_trending_at DESC LIMIT ?`;
        params.push(limit * 3); // Fetch extra to account for filtered posts across all users

        const result = await this.env.DB.prepare(query).bind(...params).all();
        const posts = result.results || [];

        // Batch fetch actor info
        const uniqueActors = new Map();
        for (const p of posts) {
          const key = `${p.actor_type}:${p.actor_id}`;
          if (!uniqueActors.has(key)) {
            uniqueActors.set(key, { type: p.actor_type, id: p.actor_id });
          }
        }
        const actorIds = [...uniqueActors.values()];
        const actorMap = await this.batchFetchActors(actorIds);

        trendingPosts = posts.map(post => {
          const actorInfo = actorMap.get(`${post.actor_type}:${post.actor_id}`) || {};
          const processedPost = {
            ...post,
            username: actorInfo.username || null,
            actor_name: actorInfo.name || actorInfo.username || 'Unknown',
            avatar_url: actorInfo.avatar_url || null,
            verified: actorInfo.verified || 0,
            actor: {
              id: post.actor_id,
              username: actorInfo.username || null,
              name: actorInfo.name || null,
              avatar_url: actorInfo.avatar_url || null,
              verified: actorInfo.verified || 0
            }
          };
          processedPost.media_urls = parseMediaUrlsField(processedPost.media_urls);
          delete processedPost.score;
          return processedPost;
        });

        // Filter for safety (done once for all users)
        trendingPosts = await this.trendingFilter.filterTrendingPosts(trendingPosts);

        // Cache globally with jittered TTL to prevent thundering herd
        if (this.cache) {
          try {
            await this.cache.put(globalCacheKey, JSON.stringify(trendingPosts), {
              expirationTtl: getJitteredTTL(TRENDING_CACHE_TTL)
            });
          } catch { /* ignore */ }
        }
      }

      // Per-user filtering (fast, in-memory)
      const blockList = await this.getCachedBlockList(userId);
      const blockedSet = new Set(blockList.map(b => `${b.blocked_type || b.blocker_type}:${b.blocked_id || b.blocker_id}`));

      // Filter blocked actors for this specific user
      let userFiltered = trendingPosts.filter(p => !blockedSet.has(`${p.actor_type}:${p.actor_id}`));

      // Limit to requested size
      userFiltered = userFiltered.slice(0, limit);

      // Filter sensitive content for this user
      userFiltered = await this.sensitiveHandler.filterFeedPosts(userFiltered, userId);

      const userFilteredWithCounts = await this.attachEngagementCounts(userFiltered);
      const enrichedFeed = await this.attachEngagementFlags(userId, userFilteredWithCounts, actorContext);
      const feedResult = { posts: enrichedFeed };

      return successResponse(feedResult);
    } catch (error) {
      console.error('Get trending feed error:', error);
      return errorResponse('Failed to get trending feed', 500);
    }
  }

  /**
   * Invalidate feed cache for a user
   * Call this when user follows/unfollows or blocks/unblocks someone
   */
  async invalidateFeedCache(userId) {
    if (!this.cache) return;
    try {
      // Invalidate all feed caches for user
      await Promise.all([
        this.cache.delete(`feed:home:${userId}:*`),
        this.cache.delete(`feed:suggested:${userId}:*`),
        this.cache.delete(`feed:trending:${userId}:*`),
        this.cache.delete(`follows:${userId}`),
        this.cache.delete(`blocks:${userId}`)
      ]);
    } catch { /* ignore cache errors */ }
  }

  /**
   * Invalidate follow list cache
   * Call this when user follows/unfollows someone
   */
  async invalidateFollowCache(userId) {
    if (!this.cache) return;
    try {
      await this.cache.delete(`follows:${userId}`);
    } catch { /* ignore */ }
  }

  /**
   * Get imported posts from external platforms (YouTube, TikTok, Instagram, etc.)
   * Available to all users, ordered by recency, with cursor pagination support
   */
  async getImportedPosts(userId, limit, blockedSet = new Set(), cursor = null, lang = null) {
    try {
      // Fetch imported posts (where platform IS NOT NULL)
      let query = `
        SELECT p.* FROM posts p
        WHERE p.platform IS NOT NULL
      `;

      const params = [];

      // Apply language filter if specified
      if (lang) {
        query += ` AND p.language = ?`;
        params.push(lang);
      }

      // Apply cursor for pagination
      if (cursor) {
        const cursorData = parseCursor(cursor);
        if (cursorData?.created_at) {
          query += ` AND p.created_at < ?`;
          params.push(cursorData.created_at);
        }
      }

      query += ` ORDER BY p.created_at DESC LIMIT ?`;
      params.push(limit);

      const result = await this.env.DB.prepare(query).bind(...params).all();
      let posts = result.results || [];

      // Filter blocked actors
      if (blockedSet.size > 0) {
        posts = posts.filter(p => !blockedSet.has(`${p.actor_type}:${p.actor_id}`));
      }

      // Batch fetch actor info
      const uniqueActors = new Map();
      for (const p of posts) {
        const key = `${p.actor_type}:${p.actor_id}`;
        if (!uniqueActors.has(key)) {
          uniqueActors.set(key, { type: p.actor_type, id: p.actor_id });
        }
      }
      const actorIds = [...uniqueActors.values()];
      const actorMap = await this.batchFetchActors(actorIds);

      // Enrich posts
      const processedPosts = posts.map(post => {
        const actorInfo = actorMap.get(`${post.actor_type}:${post.actor_id}`) || {};
        const processedPost = {
          ...post,
          username: actorInfo.username || null,
          actor_name: actorInfo.name || actorInfo.username || 'Unknown',
          avatar_url: actorInfo.avatar_url || null,
          verified: actorInfo.verified || 0,
          actor: {
            id: post.actor_id,
            username: actorInfo.username || null,
            name: actorInfo.name || null,
            avatar_url: actorInfo.avatar_url || null,
            verified: actorInfo.verified || 0
          }
        };
        processedPost.media_urls = parseMediaUrlsField(processedPost.media_urls);
        return processedPost;
      });

      return processedPosts;
    } catch (error) {
      return [];
    }
  }

  /**
   * Invalidate block list cache
   * Call this when user blocks/unblocks someone
   */
  async invalidateBlockCache(userId) {
    if (!this.cache) return;
    try {
      await this.cache.delete(`blocks:${userId}`);
    } catch { /* ignore */ }
  }
}
