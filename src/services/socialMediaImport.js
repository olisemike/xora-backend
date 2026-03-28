// Social Media Import Service - Curator/Trending Model
// Handles importing TRENDING and PUBLIC posts from Twitter, Instagram, TikTok, etc.
// Uses centralized app credentials (not OAuth per admin)
import { generateId, now, safeParseInt } from '../utils/helpers.js';
import { logger } from '../utils/logger.js';

export class SocialMediaImportService {
  constructor(db, env) {
    this.db = db;
    this.env = env;
    // Centralized app-level credentials (NOT per-admin OAuth)
    this.twitterBearerToken = env.TWITTER_BEARER_TOKEN;
    this.instagramAccessToken = env.INSTAGRAM_ACCESS_TOKEN;
    this.tiktokAccessKey = env.TIKTOK_ACCESS_KEY;
    this.facebookAccessToken = env.FACEBOOK_ACCESS_TOKEN;
    this.googleApiKey = env.GOOGLE_API_KEY; // For YouTube
    logger.info('SocialMediaImportService initialized', { 
      hasTwitter: !!this.twitterBearerToken, 
      hasInstagram: !!this.instagramAccessToken, 
      hasTikTok: !!this.tiktokAccessKey, 
      hasFacebook: !!this.facebookAccessToken, 
      hasGoogle: !!this.googleApiKey 
    });
  }

  /**
   * Search and import TRENDING content by location/hashtag (Multi-platform)
   * POST /admin/social-media/search/trending
   */
  async searchTrendingTweets(adminId, options = {}) {
    try {
      const {
        platform = 'twitter', // Platform to search
        query,          // Hashtag or keyword (e.g., "#bitcoin", "AI news")
        location,       // Geographic location (e.g., "US", "UK", "Global")
        limit = 100,
        language,       // Language code (e.g., "en", "es")
        minEngagement   // Minimum likes/retweets for trending threshold
      } = options;

      if (!query && !location) {
        return { success: false, error: 'Query or location required for trending search' };
      }

      // Create search job
      const jobId = generateId('search_job');
      await this.db.prepare(`
        INSERT INTO social_media_search_jobs (
          id, admin_id, platform, search_type, query, location,
          status, created_at, updated_at
        ) VALUES (?, ?, ?, 'trending', ?, ?, 'processing', ?, ?)
      `).bind(jobId, adminId, platform, query || 'trending', location || 'global', now(), now()).run();

      // Route to platform-specific fetch method
      let posts;
      switch (platform) {
        case 'twitter':
          posts = await this.fetchTrendingTweets({ query, location, limit, language, minEngagement });
          break;
        case 'instagram':
          posts = await this.fetchTrendingInstagramPosts({ query, location, limit, language, minEngagement });
          break;
        case 'tiktok':
          posts = await this.fetchTrendingTikToks({ query, location, limit, language, minEngagement });
          break;
        case 'facebook':
          posts = await this.fetchTrendingFacebookPosts({ query, location, limit, language, minEngagement });
          break;
        case 'youtube':
          posts = await this.fetchTrendingYouTubeVideos({ query, location, limit, language, minEngagement });
          break;
        default:
          throw new Error(`Unsupported platform: ${platform}`);
      }

      // Normalize response format (already normalized by platform-specific methods)
      return {
        success: true,
        jobId,
        tweets: posts, // Keeping 'tweets' for backward compatibility, but it's actually posts
        total: posts.length
      };
    } catch (error) {
      logger.error('Search trending content error', error, { adminId, options });
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Import posts from ANY public user (not just admin's feed) - Multi-platform
   * POST /admin/social-media/search/user/:username
   */
  async importPublicUserTweets(adminId, username, options = {}) {
    try {
      const { platform = 'twitter', limit = 100, startDate, endDate } = options;

      // Create search job
      const jobId = generateId('search_job');
      await this.db.prepare(`
        INSERT INTO social_media_search_jobs (
          id, admin_id, platform, search_type, query, status, created_at, updated_at
        ) VALUES (?, ?, ?, 'user', ?, 'processing', ?, ?)
      `).bind(jobId, adminId, platform, username, now(), now()).run();

      // Route to platform-specific user fetch method
      let posts;
      switch (platform) {
        case 'twitter':
          posts = await this.fetchPublicUserTweets(username, { limit, startDate, endDate });
          break;
        case 'instagram':
          posts = await this.fetchPublicInstagramUserPosts(username, { limit, startDate, endDate });
          break;
        case 'tiktok':
          posts = await this.fetchPublicTikTokUserVideos(username, { limit, startDate, endDate });
          break;
        case 'facebook':
          posts = await this.fetchPublicFacebookUserPosts(username, { limit, startDate, endDate });
          break;
        case 'youtube':
          posts = await this.fetchPublicYouTubeChannelVideos(username, { limit, startDate, endDate });
          break;
        default:
          throw new Error(`Unsupported platform: ${platform}`);
      }

      return {
        success: true,
        jobId,
        username,
        tweets: posts, // Normalized by platform-specific methods
        total: posts.length
      };
    } catch (error) {
      logger.error('Import public user posts error', error, { adminId, username, platform: options.platform });
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Import selected posts to Xora database
   * After admin curates/selects posts from search results
   */
  async importSelectedPosts(adminId, posts, platform = 'twitter') {
    try {
      // FIX 2: Limit posts per import to prevent abuse
      if (posts.length > 100) {
        return {
          success: false,
          error: 'Maximum 100 posts per import allowed'
        };
      }

      const jobId = generateId('import_job');
      await this.db.prepare(`
        INSERT INTO social_media_import_jobs (
          id, admin_id, platform, status, created_at, updated_at
        ) VALUES (?, ?, ?, 'processing', ?, ?)
      `).bind(jobId, adminId, platform, now(), now()).run();

      let imported = 0;
      let failed = 0;
      let skipped = 0;

      // Import each selected post
      // Import posts in parallel
      const importPromises = posts.map(async (post) => {
        try {
          // FIX 1: Check for duplicate imports before creating post
          const existing = await this.db.prepare(`
            SELECT post_id FROM imported_post_mapping
            WHERE platform = ? AND external_post_id = ?
          `).bind(platform, post.externalId).first();

          if (existing) {
            // Skip duplicate - post already imported
            logger.info('Skipping duplicate post', { platform, externalId: post.externalId });
            return { status: 'skipped' };
          }

          const postId = await this.createPostFromExternal(post, adminId, platform);

          // Create mapping to track origin
          await this.db.prepare(`
            INSERT INTO imported_post_mapping (
              id, post_id, platform, external_post_id, external_post_url,
              external_author, imported_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `).bind(
            generateId('mapping'),
            postId,
            platform,
            post.externalId,
            post.url,
            post.author || null,
            now()
          ).run();

          return { status: 'imported' };
        } catch (error) {
          logger.error('Failed to import post', error, { postId: post.externalId });
          return { status: 'failed' };
        }
      });

      const results = await Promise.allSettled(importPromises);
      const outcomes = results.map(result =>
        result.status === 'fulfilled' ? result.value : { status: 'failed' }
      );

      imported = outcomes.filter(outcome => outcome.status === 'imported').length;
      skipped = outcomes.filter(outcome => outcome.status === 'skipped').length;
      failed = outcomes.filter(outcome => outcome.status === 'failed').length;

      // Update job status
      await this.db.prepare(`
        UPDATE social_media_import_jobs
        SET status = 'completed',
            total_posts = ?,
            imported_posts = ?,
            failed_posts = ?,
            completed_at = ?,
            updated_at = ?
        WHERE id = ?
      `).bind(posts.length, imported, failed, now(), now(), jobId).run();

      logger.info('Imported selected posts', { jobId, imported, failed, skipped });

      return {
        success: true,
        jobId,
        total: posts.length,
        imported,
        failed,
        skipped
      };
    } catch (error) {
      logger.error('Import selected posts error', error, { adminId });
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Fetch TRENDING tweets with geographic filtering
   * Uses Twitter Search API v2 with app-level credentials
   */
  async fetchTrendingTweets(options = {}) {
    const {
      query,
      location,
      limit = 100,
      language,
      minEngagement = 50
    } = options;

    // FIX 3: Sanitize user input before API calls
    let searchQuery = query ? query.trim().replace(/[^\w\s#@]/g, '') : '';

    // Add engagement filter for trending content
    if (Number.isInteger(minEngagement) && minEngagement > 0) {
      searchQuery += ` min_retweets:${minEngagement}`;
    }

    // Filter by language (validate language code)
    if (language && /^[a-z]{2}$/.test(language)) {
      searchQuery += ` lang:${language}`;
    }

    // Remove leading/trailing spaces
    searchQuery = searchQuery.trim();

    const params = new URLSearchParams({
      query: searchQuery,
      max_results: Math.min(limit, 100),
      'tweet.fields': 'created_at,text,public_metrics,author_id,geo',
      'user.fields': 'username',
      'media.fields': 'url,preview_image_url,type',
      expansions: 'author_id,attachments.media_keys'
    });

    // Add geographic filter if specified
    if (location && location !== 'global') {
      // Twitter uses geocode for location filtering
      // Format: latitude,longitude,radius
      const geocodes = this.getGeocodeForLocation(location);
      if (geocodes) {
        params.append('query', `${searchQuery} place:"${location}"`);
      }
    }

    try {
      const response = await fetch(
        `https://api.twitter.com/2/tweets/search/recent?${params.toString()}`,
        {
          headers: {
            'Authorization': `Bearer ${this.twitterBearerToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(`Twitter API error: ${response.status} - ${errorData.detail || 'Unknown error'}`);
      }

      const data = await response.json();
      const tweets = data.data || [];
      const users = data.includes?.users || [];
      const media = data.includes?.media || [];

      // Enrich tweets with author username and media - return NORMALIZED format
      return tweets.map(tweet => {
        const author = users.find(u => u.id === tweet.author_id);
        const tweetMedia = tweet.attachments?.media_keys?.map(key =>
          media.find(m => m.media_key === key)
        ).filter(Boolean) || [];

        // Normalized format for cross-platform compatibility
        return {
          id: tweet.id,
          externalId: tweet.id,
          text: tweet.text,
          author: author?.username,
          authorId: tweet.author_id,
          createdAt: tweet.created_at,
          likes: tweet.public_metrics?.like_count || 0,
          retweets: tweet.public_metrics?.retweet_count || 0,
          media: tweetMedia.map(m => ({ url: m.url, type: m.type })),
          url: `https://twitter.com/${author?.username}/status/${tweet.id}`
        };
      });
    } catch (error) {
      logger.error('Fetch trending tweets error', error, { query, location });
      throw error;
    }
  }

  /**
   * Fetch public tweets from ANY Twitter user (not OAuth required)
   * Uses app-level credentials to access public data
   */
  async fetchPublicUserTweets(username, options = {}) {
    const { limit = 100, startDate, endDate } = options;

    try {
      // First, get user ID from username
      const userResponse = await fetch(
        `https://api.twitter.com/2/users/by/username/${username}`,
        {
          headers: {
            'Authorization': `Bearer ${this.twitterBearerToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      if (!userResponse.ok) {
        throw new Error(`Failed to fetch user: ${userResponse.status}`);
      }

      const userData = await userResponse.json();
      const userId = userData.data.id;

      // Fetch user's tweets
      const params = new URLSearchParams({
        max_results: Math.min(limit, 100),
        'tweet.fields': 'created_at,text,public_metrics,attachments',
        'media.fields': 'url,preview_image_url,type',
        expansions: 'attachments.media_keys'
      });

      if (startDate) {
        params.append('start_time', new Date(startDate * 1000).toISOString());
      }
      if (endDate) {
        params.append('end_time', new Date(endDate * 1000).toISOString());
      }

      const tweetsResponse = await fetch(
        `https://api.twitter.com/2/users/${userId}/tweets?${params.toString()}`,
        {
          headers: {
            'Authorization': `Bearer ${this.twitterBearerToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      if (!tweetsResponse.ok) {
        throw new Error(`Twitter API error: ${tweetsResponse.status}`);
      }

      const data = await tweetsResponse.json();
      const tweets = data.data || [];
      const media = data.includes?.media || [];

      // Return normalized format
      return tweets.map(tweet => {
        const tweetMedia = tweet.attachments?.media_keys?.map(key =>
          media.find(m => m.media_key === key)
        ).filter(Boolean) || [];

        return {
          id: tweet.id,
          externalId: tweet.id,
          text: tweet.text,
          author: username,
          createdAt: tweet.created_at,
          likes: tweet.public_metrics?.like_count || 0,
          retweets: tweet.public_metrics?.retweet_count || 0,
          media: tweetMedia.map(m => ({ url: m.url, type: m.type })),
          url: `https://twitter.com/${username}/status/${tweet.id}`
        };
      });
    } catch (error) {
      logger.error('Fetch public user tweets error', error, { username });
      throw error;
    }
  }

  /**
   * INSTAGRAM - Fetch trending posts by hashtag/location
   * Uses Instagram Graph API with app-level credentials
   */
  async fetchTrendingInstagramPosts(options = {}) {
    const { query, location, limit = 100, _language, minEngagement = 50 } = options;

    try {
      // FIX 3: Sanitize hashtag input
      const hashtag = query ? query.trim().replace(/[^\w]/g, '') : 'trending';

      // Get hashtag ID first
      const hashtagResponse = await fetch(
        `https://graph.instagram.com/ig_hashtag_search?user_id=me&q=${hashtag}&access_token=${this.instagramAccessToken}`
      );

      if (!hashtagResponse.ok) {
        throw new Error(`Instagram API error: ${hashtagResponse.status}`);
      }

      const hashtagData = await hashtagResponse.json();
      const hashtagId = hashtagData.data?.[0]?.id;

      if (!hashtagId) {
        return []; // No posts found
      }

      // Get recent media for hashtag
      const mediaResponse = await fetch(
        `https://graph.instagram.com/${hashtagId}/recent_media?user_id=me&fields=id,caption,media_type,media_url,permalink,timestamp,like_count,comments_count,username&limit=${Math.min(limit, 100)}&access_token=${this.instagramAccessToken}`
      );

      if (!mediaResponse.ok) {
        throw new Error(`Instagram API error: ${mediaResponse.status}`);
      }

      const mediaData = await mediaResponse.json();
      const posts = mediaData.data || [];

      // Return normalized format
      return posts
        .filter(p => (p.like_count || 0) >= minEngagement)
        .map(post => {
          const mediaType = post.media_type === 'VIDEO' || post.media_type === 'CAROUSEL' ? 'video' : 'image';
          return {
            id: post.id,
            externalId: post.id,
            text: post.caption || '',
            author: post.username,
            authorId: post.username,
            createdAt: post.timestamp,
            likes: post.like_count || 0,
            retweets: post.comments_count || 0, // Using comments as engagement
            media: [{ url: post.media_url, type: post.media_type.toLowerCase() }],
            mediaType,
            url: post.permalink
          };
        });
    } catch (error) {
      logger.error('Fetch trending Instagram posts error', error, { query, location });
      throw error;
    }
  }

  /**
   * INSTAGRAM - Fetch public user's posts
   */
  async fetchPublicInstagramUserPosts(username, options = {}) {
    const { limit = 100 } = options;

    try {
      // Get user ID from username
      const userResponse = await fetch(
        `https://graph.instagram.com/v12.0/${username}?fields=id,username&access_token=${this.instagramAccessToken}`
      );

      if (!userResponse.ok) {
        throw new Error(`Instagram user not found: ${username}`);
      }

      const userData = await userResponse.json();
      const userId = userData.id;

      // Get user's media
      const mediaResponse = await fetch(
        `https://graph.instagram.com/${userId}/media?fields=id,caption,media_type,media_url,permalink,timestamp,like_count,comments_count&limit=${Math.min(limit, 100)}&access_token=${this.instagramAccessToken}`
      );

      if (!mediaResponse.ok) {
        throw new Error(`Instagram API error: ${mediaResponse.status}`);
      }

      const mediaData = await mediaResponse.json();
      const posts = mediaData.data || [];

      return posts.map(post => {
        const mediaType = post.media_type === 'VIDEO' || post.media_type === 'CAROUSEL' ? 'video' : 'image';
        return {
          id: post.id,
          externalId: post.id,
          text: post.caption || '',
          author: username,
          createdAt: post.timestamp,
          likes: post.like_count || 0,
          retweets: post.comments_count || 0,
          media: [{ url: post.media_url, type: post.media_type.toLowerCase() }],
          mediaType,
          url: post.permalink
        };
      });
    } catch (error) {
      logger.error('Fetch Instagram user posts error', error, { username });
      throw error;
    }
  }

  /**
   * TIKTOK - Fetch trending videos by hashtag
   * Uses TikTok Research API
   */
  async fetchTrendingTikToks(options = {}) {
    const { query, location, limit = 100, _language, minEngagement = 50 } = options;

    try {
      // FIX 3: Sanitize hashtag input
      const hashtag = query ? query.trim().replace(/[^\w]/g, '') : 'trending';

      // TikTok Research API - Video query
      const response = await fetch('https://open.tiktokapis.com/v2/research/video/query/', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.tiktokAccessKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          query: {
            and: [
              { field_name: 'hashtag_name', field_values: [hashtag], operation: 'IN' }
            ]
          },
          max_count: Math.min(limit, 100),
          start_date: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0], // Last 30 days
          end_date: new Date().toISOString().split('T')[0]
        })
      });

      if (!response.ok) {
        throw new Error(`TikTok API error: ${response.status}`);
      }

      const data = await response.json();
      const videos = data.data?.videos || [];

      return videos
        .filter(v => (v.like_count || 0) >= minEngagement)
        .map(video => {
          const tiktokUrl = `https://www.tiktok.com/@${video.username}/video/${video.id}`;
          return {
            id: video.id,
            externalId: video.id,
            text: video.video_description || '',
            author: video.username,
            authorId: video.username,
            createdAt: video.create_time,
            likes: video.like_count || 0,
            retweets: video.share_count || 0,
            media: [
              { url: tiktokUrl, type: 'tiktok' },
              { url: video.cover_image_url, type: 'image' }
            ],
            mediaType: 'video',
            url: tiktokUrl
          };
        });
    } catch (error) {
      logger.error('Fetch trending TikToks error', error, { query, location });
      throw error;
    }
  }

  /**
   * TIKTOK - Fetch public user's videos
   */
  async fetchPublicTikTokUserVideos(username, options = {}) {
    const { limit = 100 } = options;

    try {
      // TikTok Research API - User videos
      const response = await fetch('https://open.tiktokapis.com/v2/research/video/query/', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.tiktokAccessKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          query: {
            and: [
              { field_name: 'username', field_values: [username], operation: 'EQ' }
            ]
          },
          max_count: Math.min(limit, 100),
          start_date: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
          end_date: new Date().toISOString().split('T')[0]
        })
      });

      if (!response.ok) {
        throw new Error(`TikTok API error: ${response.status}`);
      }

      const data = await response.json();
      const videos = data.data?.videos || [];

      return videos.map(video => {
        const tiktokUrl = `https://www.tiktok.com/@${username}/video/${video.id}`;
        return {
          id: video.id,
          externalId: video.id,
          text: video.video_description || '',
          author: username,
          createdAt: video.create_time,
          likes: video.like_count || 0,
          retweets: video.share_count || 0,
          media: [
            { url: tiktokUrl, type: 'tiktok' },
            { url: video.cover_image_url, type: 'image' }
          ],
          mediaType: 'video',
          url: tiktokUrl
        };
      });
    } catch (error) {
      logger.error('Fetch TikTok user videos error', error, { username });
      throw error;
    }
  }

  /**
   * FACEBOOK - Fetch trending posts by keyword/hashtag
   * Uses Facebook Graph API
   */
  async fetchTrendingFacebookPosts(options = {}) {
    const { query, location, limit = 100, _language, minEngagement = 50 } = options;

    try {
      // FIX 3: Sanitize search query
      const searchQuery = query ? query.trim().replace(/[^\w\s#]/g, '') : 'trending';
      const response = await fetch(
        `https://graph.facebook.com/v18.0/search?q=${encodeURIComponent(searchQuery)}&type=post&fields=id,message,created_time,from,permalink_url,likes.summary(true),shares&limit=${Math.min(limit, 100)}&access_token=${this.facebookAccessToken}`
      );

      if (!response.ok) {
        throw new Error(`Facebook API error: ${response.status}`);
      }

      const data = await response.json();
      const posts = data.data || [];

      return posts
        .filter(p => (p.likes?.summary?.total_count || 0) >= minEngagement)
        .map(post => ({
          id: post.id,
          externalId: post.id,
          text: post.message || '',
          author: post.from?.name,
          authorId: post.from?.id,
          createdAt: post.created_time,
          likes: post.likes?.summary?.total_count || 0,
          retweets: post.shares?.count || 0,
          media: [],
          url: post.permalink_url
        }));
    } catch (error) {
      logger.error('Fetch trending Facebook posts error', error, { query, location });
      throw error;
    }
  }

  /**
   * FACEBOOK - Fetch public user's posts
   */
  async fetchPublicFacebookUserPosts(username, options = {}) {
    const { limit = 100 } = options;

    try {
      // Facebook Graph API - User's posts
      const response = await fetch(
        `https://graph.facebook.com/v18.0/${username}/posts?fields=id,message,created_time,permalink_url,likes.summary(true),shares&limit=${Math.min(limit, 100)}&access_token=${this.facebookAccessToken}`
      );

      if (!response.ok) {
        throw new Error(`Facebook API error: ${response.status}`);
      }

      const data = await response.json();
      const posts = data.data || [];

      return posts.map(post => ({
        id: post.id,
        externalId: post.id,
        text: post.message || '',
        author: username,
        createdAt: post.created_time,
        likes: post.likes?.summary?.total_count || 0,
        retweets: post.shares?.count || 0,
        media: [],
        url: post.permalink_url
      }));
    } catch (error) {
      logger.error('Fetch Facebook user posts error', error, { username });
      throw error;
    }
  }

  /**
   * YOUTUBE - Fetch trending videos by keyword
   * Uses YouTube Data API v3
   */
  async fetchTrendingYouTubeVideos(options = {}) {
    const { query, location, limit = 100, _language, minEngagement = 0 } = options;

    try {
      // Validate API key
      if (!this.googleApiKey) {
        logger.warn('YouTube API key not configured - using mock data or returning empty');
        return [];
      }

      // FIX 3: Sanitize search query
      const searchQuery = query ? query.trim().replace(/[^\w\s]/g, '') : 'trending';
      const regionCode = this.getYouTubeRegionCode(location);

      logger.info('YouTube search starting', { searchQuery, regionCode, limit });

      // YouTube Data API - Search
      const response = await fetch(
        `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(searchQuery)}&type=video&maxResults=${Math.min(limit, 50)}&order=viewCount&regionCode=${regionCode}&key=${this.googleApiKey}`
      );

      if (!response.ok) {
        const errorText = await response.text();
        logger.error('YouTube API error details', { 
          status: response.status, 
          statusText: response.statusText, 
          body: errorText,
          apiKey: this.googleApiKey ? 'present' : 'missing'
        });
        
        // Return empty instead of throwing to allow UI to show "no results" gracefully
        return [];
      }

      const data = await response.json();
      const videos = data.items || [];

      logger.info('YouTube search results', { count: videos.length, searchQuery });

      if (videos.length === 0) {
        return [];
      }

      // Try to get video statistics, but don't fail if stats endpoint fails
      let stats = [];
      try {
        const videoIds = videos.map(v => v.id.videoId).join(',');
        const statsResponse = await fetch(
          `https://www.googleapis.com/youtube/v3/videos?part=statistics,contentDetails&id=${videoIds}&key=${this.googleApiKey}`
        );

        if (statsResponse.ok) {
          const statsData = await statsResponse.json();
          stats = statsData.items || [];
          logger.info('YouTube stats fetched', { count: stats.length });
        } else {
          logger.warn('YouTube stats API failed', { status: statsResponse.status });
          // Continue without stats - they're optional
        }
      } catch (statsError) {
        logger.warn('YouTube stats fetch error', { error: statsError.message });
        // Continue without stats - they're optional
      }

      return videos
        .map((video, _index) => {
          const videoStats = stats.find(s => s.id === video.id.videoId);
          const viewCount = safeParseInt(videoStats?.statistics?.viewCount, 0, 0, Number.MAX_SAFE_INTEGER);
          const likeCount = safeParseInt(videoStats?.statistics?.likeCount, 0, 0, Number.MAX_SAFE_INTEGER);
          const commentCount = safeParseInt(videoStats?.statistics?.commentCount, 0, 0, Number.MAX_SAFE_INTEGER);
          const youtubeUrl = `https://www.youtube.com/watch?v=${video.id.videoId}`;

          // Use viewCount as primary engagement metric if likes are unavailable
          const engagement = likeCount > 0 ? likeCount : viewCount;

          return {
            id: video.id.videoId,
            externalId: video.id.videoId,
            text: `${video.snippet.title}\n${video.snippet.description}`,
            author: video.snippet.channelTitle,
            authorId: video.snippet.channelId,
            createdAt: video.snippet.publishedAt,
            likes: likeCount,
            views: viewCount,
            retweets: commentCount,
            media: [
              { url: video.snippet.thumbnails.high?.url || video.snippet.thumbnails.medium?.url, type: 'image' },
              { url: youtubeUrl, type: 'youtube', videoId: video.id.videoId }
            ],
            mediaType: 'video',
            url: youtubeUrl,
            videoStats: videoStats?.statistics,
            engagement // For filtering
          };
        })
        .filter(v => {
          // Much more lenient filtering - check if engagement is reasonable
          // If minEngagement is 0 or very low, don't filter
          if (minEngagement <= 0) return true;
          
          // For YouTube, use viewCount as fallback if likes unavailable
          const hasEngagement = v.likes > 0 || v.views > 0;
          return hasEngagement && v.engagement >= minEngagement;
        });
    } catch (error) {
      logger.error('Fetch trending YouTube videos error', error, { query, location });
      // Return empty array instead of throwing - let UI handle gracefully
      return [];
    }
  }

  /**
   * YOUTUBE - Fetch public channel's videos
   * Accepts either a channel ID (UC...) or a username/handle (@username)
   */
  async fetchPublicYouTubeChannelVideos(usernameOrChannelId, options = {}) {
    const { limit = 100 } = options;

    try {
      // Resolve username to channel ID if needed
      let channelId = usernameOrChannelId;

      // If it doesn't look like a channel ID (UC prefix), try to resolve it
      if (!usernameOrChannelId.startsWith('UC')) {
        // Remove @ prefix if present
        const handle = usernameOrChannelId.replace(/^@/, '');

        // Try to find channel by handle/username using search
        const searchResponse = await fetch(
          `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(handle)}&type=channel&maxResults=1&key=${this.googleApiKey}`
        );

        if (!searchResponse.ok) {
          const errorText = await searchResponse.text();
          logger.error('YouTube API channel search error details', { status: searchResponse.status, statusText: searchResponse.statusText, body: errorText });
          throw new Error(`YouTube API channel search error: ${searchResponse.status} - ${searchResponse.statusText}`);
        }

        const searchData = await searchResponse.json();
        if (searchData.items && searchData.items.length > 0) {
          channelId = searchData.items[0].snippet.channelId;
        } else {
          // Fallback: try channels list with forUsername (legacy)
          const channelResponse = await fetch(
            `https://www.googleapis.com/youtube/v3/channels?part=id&forUsername=${encodeURIComponent(handle)}&key=${this.googleApiKey}`
          );
          if (!channelResponse.ok) {
            const errorText = await channelResponse.text();
            logger.error('YouTube API channels error details', { status: channelResponse.status, statusText: channelResponse.statusText, body: errorText });
            throw new Error(`YouTube API channels error: ${channelResponse.status} - ${channelResponse.statusText}`);
          }
          const channelData = await channelResponse.json();
          if (channelData.items && channelData.items.length > 0) {
            channelId = channelData.items[0].id;
          } else {
            throw new Error(`YouTube channel not found: ${usernameOrChannelId}`);
          }
        }
      }

      // YouTube Data API - Channel videos
      const response = await fetch(
        `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channelId}&type=video&maxResults=${Math.min(limit, 100)}&order=date&key=${this.googleApiKey}`
      );

      if (!response.ok) {
        const errorText = await response.text();
        logger.error('YouTube API channel videos error details', { status: response.status, statusText: response.statusText, body: errorText });
        throw new Error(`YouTube API error: ${response.status} - ${response.statusText}`);
      }

      const data = await response.json();
      const videos = data.items || [];

      if (videos.length === 0) {
        return [];
      }

      // Try to get video statistics, but don't fail if stats endpoint fails
      let stats = [];
      try {
        const videoIds = videos.map(v => v.id.videoId).join(',');
        const statsResponse = await fetch(
          `https://www.googleapis.com/youtube/v3/videos?part=statistics,contentDetails&id=${videoIds}&key=${this.googleApiKey}`
        );

        if (statsResponse.ok) {
          const statsData = await statsResponse.json();
          stats = statsData.items || [];
          logger.info('YouTube channel stats fetched', { count: stats.length });
        } else {
          logger.warn('YouTube stats API failed', { status: statsResponse.status });
          // Continue without stats
        }
      } catch (statsError) {
        logger.warn('YouTube stats fetch error', { error: statsError.message });
        // Continue without stats
      }

      return videos.map(video => {
        const videoStats = stats.find(s => s.id === video.id.videoId);
        const youtubeUrl = `https://www.youtube.com/watch?v=${video.id.videoId}`;

        return {
          id: video.id.videoId,
          externalId: video.id.videoId,
          text: `${video.snippet.title}\n${video.snippet.description}`,
          author: video.snippet.channelTitle,
          createdAt: video.snippet.publishedAt,
          likes: safeParseInt(videoStats?.statistics?.likeCount, 0, 0, Number.MAX_SAFE_INTEGER),
          views: safeParseInt(videoStats?.statistics?.viewCount, 0, 0, Number.MAX_SAFE_INTEGER),
          retweets: safeParseInt(videoStats?.statistics?.commentCount, 0, 0, Number.MAX_SAFE_INTEGER),
          media: [
            { url: youtubeUrl, type: 'youtube', videoId: video.id.videoId },
            { url: video.snippet.thumbnails.high?.url || video.snippet.thumbnails.medium?.url, type: 'image' }
          ],
          mediaType: 'video',
          url: youtubeUrl,
          videoStats: videoStats?.statistics
        };
      });
    } catch (error) {
      logger.error('Fetch YouTube channel videos error', error, { channelId: usernameOrChannelId });
      // Return empty array instead of throwing
      return [];
    }
  }

  /**
   * Get YouTube region code from location name
   */
  getYouTubeRegionCode(location) {
    const regions = {
      'global': 'US',
      'US': 'US',
      'UK': 'GB',
      'Canada': 'CA',
      'Australia': 'AU',
      'India': 'IN',
      'Germany': 'DE',
      'France': 'FR',
      'Brazil': 'BR',
      'Japan': 'JP',
      'Nigeria': 'NG'
    };

    return regions[location] || 'US';
  }

  /**
   * Get geocode for location name
   * Maps location names to geocodes for Twitter API
   */
  getGeocodeForLocation(location) {
    const locations = {
      'US': '37.09024,-95.712891,2500km',
      'UK': '54.313220,-2.235143,500km',
      'Canada': '56.130366,-106.346771,2500km',
      'Australia': '-25.274398,133.775136,2500km',
      'India': '20.593684,78.96288,1500km',
      'Germany': '51.165691,10.451526,500km',
      'France': '46.227638,2.213749,500km',
      'Brazil': '-14.235004,-51.92528,2000km',
      'Japan': '36.204824,138.252924,800km',
      'Nigeria': '9.081999,8.675277,700km'
    };

    return locations[location] || null;
  }

  /**
   * Get trending hashtags by location
   * GET /admin/social-media/trending/hashtags
   */
  async getTrendingHashtags(location = 'global', limit = 50, offset = 0) {
    try {
      // Twitter API for trending topics
      // Note: Requires Twitter API v1.1 for trends/place endpoint
      // Using WOEID (Where On Earth ID) for locations
      const woeid = this.getWOEIDForLocation(location);

      const response = await fetch(
        `https://api.twitter.com/1.1/trends/place.json?id=${woeid}`,
        {
          headers: {
            'Authorization': `Bearer ${this.twitterBearerToken}`
          }
        }
      );

      if (!response.ok) {
        throw new Error(`Twitter API error: ${response.status}`);
      }

      const data = await response.json();
      const trends = data[0]?.trends || [];
      const safeOffset = Math.max(0, Number(offset) || 0);
      const total = trends.length;

      return {
        success: true,
        location,
        total,
        hashtags: trends.slice(safeOffset, safeOffset + limit).map(t => ({
          name: t.name,
          query: t.query,
          tweetVolume: t.tweet_volume,
          url: t.url
        }))
      };
    } catch (error) {
      logger.error('Get trending hashtags error', error, { location });
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Get WOEID (Where On Earth ID) for location
   * Used by Twitter Trends API
   */
  getWOEIDForLocation(location) {
    const woeids = {
      'global': 1,
      'US': 23424977,
      'UK': 23424975,
      'Canada': 23424775,
      'Australia': 23424748,
      'India': 23424848,
      'Germany': 23424829,
      'France': 23424819,
      'Brazil': 23424768,
      'Japan': 23424856,
      'Nigeria': 23424908
    };

    return woeids[location] || 1; // Default to global
  }

  /**
   * Create a post from external social media data
   * Used for importing curated/selected posts
   */
  async createPostFromExternal(externalPost, adminId, _platform) {
    const postId = generateId('post');
    const mappingId = generateId('mapping');
    const timestamp = now();
    const platform = _platform || 'unknown';

    // Preserve full media metadata (including type information)
    let mediaUrls = [];
    const { mediaUrls: postMediaUrls, media: postMedia } = externalPost;
    
    if (postMediaUrls && Array.isArray(postMediaUrls)) {
      // If mediaUrls already provided, use as-is
      mediaUrls = postMediaUrls;
    } else if (postMedia && Array.isArray(postMedia)) {
      // Preserve media objects with full metadata (url, type, etc.)
      mediaUrls = postMedia;
    }

    // Get media type: prefer explicit mediaType field, or infer from media
    let mediaType = externalPost.mediaType || 'image';
    if (!externalPost.mediaType && postMedia && Array.isArray(postMedia) && postMedia.length > 0) {
      // Infer from first media item type
      const firstMediaType = postMedia[0].type;
      if (['youtube', 'video', 'gif'].includes(firstMediaType)) {
        mediaType = 'video';
      }
    }

    // Use a fixed system curator account for imported posts to avoid FK constraint issues
    // Individual admin who did the import is tracked in imported_post_mapping table
    const curatorAccountId = 'curator_system';

    // Add original author attribution to media metadata
    const enrichedMediaUrls = mediaUrls.map(m => ({
      ...m,
      external_author: externalPost.author || externalPost.authorId || 'Unknown Creator'
    }));

    // Create post - attributed to curator system account
    await this.db.prepare(`
      INSERT INTO posts (
        id, actor_type, actor_id, content, media_type, media_urls, language, is_sensitive,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      postId,
      'user',
      curatorAccountId, // Use fixed curator ID to satisfy FK constraint
      externalPost.content || externalPost.text || '',
      mediaType,
      JSON.stringify(enrichedMediaUrls),
      'en',
      0,
      externalPost.createdAt || timestamp,
      timestamp
    ).run();

    // Also create mapping entry for full attribution tracking
    try {
      await this.db.prepare(`
        INSERT INTO imported_post_mapping (
          id, post_id, platform, external_post_id, external_post_url, external_author, imported_at, admin_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        mappingId,
        postId,
        platform,
        externalPost.externalId || externalPost.id || '',
        externalPost.url || '',
        externalPost.author || externalPost.authorId || '',
        timestamp,
        adminId  // Track which admin did the import
      ).run();
    } catch (error) {
      // Log but don't fail - mapping is secondary to post creation
      logger.warn('Failed to create import mapping', error, { postId, platform });
    }

    return postId;
  }

  /**
   * Get import/search jobs history
   */
  async getImportJobs(adminId, limit = 50, beforeCreatedAt = null) {
    try {
      const limitPlus = limit + 1;

      // Get both import jobs and search jobs
      let importQuery = `
        SELECT *
        FROM social_media_import_jobs
        WHERE admin_id = ?
      `;

      const importParams = [adminId];
      if (beforeCreatedAt) {
        importQuery += ` AND created_at < ?`;
        importParams.push(beforeCreatedAt);
      }

      importQuery += ` ORDER BY created_at DESC LIMIT ?`;
      importParams.push(limitPlus);

      const importJobs = await this.db.prepare(importQuery).bind(...importParams).all();

      let searchQuery = `
        SELECT *
        FROM social_media_search_jobs
        WHERE admin_id = ?
      `;

      const searchParams = [adminId];
      if (beforeCreatedAt) {
        searchQuery += ` AND created_at < ?`;
        searchParams.push(beforeCreatedAt);
      }

      searchQuery += ` ORDER BY created_at DESC LIMIT ?`;
      searchParams.push(limitPlus);

      const searchJobs = await this.db.prepare(searchQuery).bind(...searchParams).all();

      // Combine and sort by created_at
      const allJobs = [
        ...(importJobs.results || []).map(j => ({ ...j, jobType: 'import' })),
        ...(searchJobs.results || []).map(j => ({ ...j, jobType: 'search' }))
      ].sort((a, b) => b.created_at - a.created_at).slice(0, limitPlus);

      return {
        success: true,
        jobs: allJobs
      };
    } catch (error) {
      logger.error('Get import jobs error', error, { adminId });
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Get supported locations for geographic filtering
   */
  getSupportedLocations() {
    return [
      { code: 'global', name: 'Global', woeid: 1 },
      { code: 'US', name: 'United States', woeid: 23424977 },
      { code: 'UK', name: 'United Kingdom', woeid: 23424975 },
      { code: 'Canada', name: 'Canada', woeid: 23424775 },
      { code: 'Australia', name: 'Australia', woeid: 23424748 },
      { code: 'India', name: 'India', woeid: 23424848 },
      { code: 'Germany', name: 'Germany', woeid: 23424829 },
      { code: 'France', name: 'France', woeid: 23424819 },
      { code: 'Brazil', name: 'Brazil', woeid: 23424768 },
      { code: 'Japan', name: 'Japan', woeid: 23424856 },
      { code: 'Nigeria', name: 'Nigeria', woeid: 23424908 }
    ];
  }
}
