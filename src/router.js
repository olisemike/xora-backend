// ============================================
// MAIN ROUTER
// ============================================

import { Router } from 'itty-router';
import { authMiddleware, optionalAuthMiddleware, adminMiddleware } from './middleware/auth.js';
import { getCsrfProtection } from './middleware/csrfProtection.js';
import { protectInternalRoute } from './middleware/internalRoutes.js';
import { validateRequest, ValidationSchemas } from './middleware/inputValidation.js';
import { rbacMiddleware, checkPermission, ADMIN_ROLES } from './middleware/rbac.js';
import { checkRequestSize } from './middleware/requestSizeLimit.js';
import { adminOperationRateLimit, logAdminOperation } from './middleware/adminRateLimit.js';
import { AuthController } from './controllers/auth.js';
import { UsersController } from './controllers/users.js';
import { PagesController } from './controllers/pages.js';
import { PostsController } from './controllers/posts.js';
import { CommentsController, LikesController, BookmarksController, FollowsController, BlocksController } from './controllers/comments.js';
import { FeedController } from './controllers/feed.js';
import { SearchController, SettingsController, NotificationsController, ReportsController, AdminController } from './controllers/all-remaining.js';
import { ScheduledJobsController } from './controllers/scheduled.js';
import { StoriesController } from './controllers/stories.js';
import { ReelsController } from './controllers/reels.js';
import { SharesController } from './controllers/shares.js';
import { MessagingController } from './controllers/messaging.js';
import { PushNotificationsController, AnalyticsController } from './controllers/pushNotifications.js';
import { IntegrationsController } from './controllers/integrations.js';
import { AdvertisementController } from './controllers/advertisements.js';
import { SocialMediaImportController } from './controllers/socialMediaImport.js';
import { HealthController } from './controllers/health.js';
import { MediaController } from './controllers/media.js';
import { logoutAllDevices, verifyDevice, getUserLoginHistory, getUserVerifiedDevices } from './controllers/authExtensions.js';
import { errorResponse } from './utils/helpers.js';
import { isValidTableName } from './utils/validation.js';

export function createRouter(env, ctx) {
  const router = Router();

  // Initialize controllers
  const auth = new AuthController(env);
  const users = new UsersController(env);
  const socialMediaImport = new SocialMediaImportController(env);
  const pages = new PagesController(env);
  const posts = new PostsController(env);
  const comments = new CommentsController(env);
  const likes = new LikesController(env);
  const bookmarks = new BookmarksController(env);
  const follows = new FollowsController(env);
  const blocks = new BlocksController(env);
  const feed = new FeedController(env);
  const search = new SearchController(env);
  const settings = new SettingsController(env);
  const notifications = new NotificationsController(env);
  const reports = new ReportsController(env);
  const admin = new AdminController(env);
  const scheduled = new ScheduledJobsController(env);
  const stories = new StoriesController(env);
  const reels = new ReelsController(env);
  const shares = new SharesController(env);
  const messaging = new MessagingController(env);
  const push = new PushNotificationsController(env);
  const analytics = new AnalyticsController(env);
  const integrations = new IntegrationsController(env);
  const advertisements = new AdvertisementController(env);
  const health = new HealthController(env);
  const media = new MediaController(env);

  // Initialize CSRF protection
  const csrfProtection = getCsrfProtection(env);

  // ============================================
  // PUBLIC ROUTES (No Auth Required)
  // ============================================

  // Auth routes with input validation
  router.post('/auth/signup', async (req) => {
    // Validate input
    const validationError = await validateRequest(ValidationSchemas.register)(req);
    if (validationError) return validationError;

    return auth.signup(req);
  });

  router.post('/auth/login', async (req) => {
    // Validate input
    const validationError = await validateRequest(ValidationSchemas.login)(req);
    if (validationError) return validationError;

    return await auth.login(req);
  });

  router.post('/auth/refresh', async (req) => {
    const validationError = await validateRequest(ValidationSchemas.refresh)(req);
    if (validationError) return validationError;
    return await auth.refresh(req);
  });
  router.post('/auth/forgot-password', async (req) => {
    const validationError = await validateRequest(ValidationSchemas.forgotPassword)(req);
    if (validationError) return validationError;
    return await auth.forgotPassword(req);
  });
  router.post('/auth/reset-password', async (req) => {
    const validationError = await validateRequest(ValidationSchemas.resetPassword)(req);
    if (validationError) return validationError;
    return await auth.resetPassword(req);
  });

  // Email verification for signup (public - no auth needed, uses tempToken)
  router.post('/auth/complete-signup', async (req) => await auth.completeSignup(req));
  router.post('/auth/resend-signup-verification', async (req) => await auth.resendSignupVerification(req));

  // Public profile views
  // IMPORTANT: define specific routes like /users/suggested BEFORE the generic /users/:username route
  router.get('/users/suggested', async (req) => {
    const { userId } = await optionalAuthMiddleware(req, env);
    return await users.getSuggestedUsers(req, userId);
  });

  router.get('/users/:username', async (req) => {
    const { userId } = await optionalAuthMiddleware(req, env);
    return await users.getProfile(req, userId, req.params.username);
  });

  router.get('/pages/:id', async (req) => {
    const { userId } = await optionalAuthMiddleware(req, env);
    return await pages.get(req, userId, req.params.id);
  });

  // Health checks (public, for monitoring)
  router.get('/health', async (req) => {
    return await health.getHealth(req);
  });

  router.get('/health/detailed', async (req) => {
    return await health.getDetailedHealth(req);
  });

  router.get('/health/ready', async (req) => {
    return await health.getReadiness(req);
  });

  router.get('/health/live', async (req) => {
    return await health.getLiveness(req);
  });

  // Cache statistics (admin only)
  router.get('/admin/cache/stats', async (req) => {
    try {
      const authResult = await authMiddleware(req, env);
      if (authResult.error) return authResult.error;
      
      // Check if user is admin by querying admin_users table
      const adminRow = await env.DB.prepare(`
        SELECT role FROM admin_users WHERE user_id = ? ORDER BY created_at DESC LIMIT 1
      `).bind(authResult.userId).first();

      console.debug('Admin check (stats)', { userId: authResult.userId, adminRow });

      if (!adminRow || !['super_admin','admin','moderator'].includes(adminRow.role)) {
        return errorResponse('Forbidden', 403);
      }

      const { getCache } = await import('./services/dbCache.js');
      const cache = getCache();
      if (!cache) {
        return errorResponse('Cache not initialized', 500);
      }
      
      const stats = cache.getStats();
      
      return Response.json({
        success: true,
        data: stats
      });
    } catch (error) {
      console.error('Cache stats error:', error);
      return errorResponse(error?.message || 'Internal server error', 500);
    }
  });

  // Clear cache (admin only)
  router.post('/admin/cache/clear', async (req) => {
    try {
      const authResult = await authMiddleware(req, env);
      if (authResult.error) return authResult.error;
      
      // Check if user is admin by querying admin_users table
      const adminRow = await env.DB.prepare(`
        SELECT role FROM admin_users WHERE user_id = ? ORDER BY created_at DESC LIMIT 1
      `).bind(authResult.userId).first();

      console.debug('Admin check (clear)', { userId: authResult.userId, adminRow });

      if (!adminRow || !['super_admin','admin','moderator'].includes(adminRow.role)) {
        return errorResponse('Forbidden', 403);
      }

      const { getCache } = await import('./services/dbCache.js');
      const cache = getCache();
      if (!cache) {
        return errorResponse('Cache not initialized', 500);
      }
      
      cache.clear();
      
      return Response.json({
        success: true,
        message: 'Cache cleared'
      });
    } catch (error) {
      console.error('Cache clear error:', error);
      return errorResponse(error?.message || 'Internal server error', 500);
    }
  });

  // ============================================
  // CLOUDFLARE EMAIL ROUTING (Protected, Webhook)
  // ============================================
  router.post('/webhooks/email/incoming', protectInternalRoute(async (req) => {
    try {
      // Validate request size (limit to 5MB for email)
      const contentLength = req.headers.get('content-length');
      if (contentLength && parseInt(contentLength) > 5 * 1024 * 1024) {
        return new Response(JSON.stringify({ error: 'Payload too large' }), {
          status: 413,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const emailData = await req.json();
      const emailService = new (await import('./services/email.js')).EmailService(env);
      const result = await emailService.processIncomingEmail(emailData);
      
      if (result.success) {
        return new Response(JSON.stringify({ success: true, emailId: result.emailId }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return new Response(JSON.stringify({ success: false, error: result.error }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.error('Webhook error:', error);
      return new Response(JSON.stringify({ success: false, error: 'Internal server error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }, env));

  // ============================================
  // PROTECTED ROUTES (Auth Required)
  // ============================================

  // Auth - protected
  router.post('/auth/logout', async (req) => {
    // CSRF protection for web clients
    const csrfError = csrfProtection.protect(req);
    if (csrfError) return csrfError;

    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await auth.logout(req, authResult.userId);
  });

  router.get('/auth/me', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await auth.me(req, authResult.userId);
  });

  router.post('/auth/change-password', async (req) => {
    // CSRF protection for web clients
    const csrfError = csrfProtection.protect(req);
    if (csrfError) return csrfError;

    const validationError = await validateRequest(ValidationSchemas.changePassword)(req);
    if (validationError) return validationError;

    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return auth.changePassword(req, authResult.userId);
  });

  router.post('/auth/send-verification', async (req) => {
    const validationError = await validateRequest(ValidationSchemas.sendVerification)(req);
    if (validationError) return validationError;
    // CSRF protection for web clients
    const csrfError = csrfProtection.protect(req);
    if (csrfError) return csrfError;

    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await auth.sendVerification(req, authResult.userId);
  });

  router.post('/auth/verify-email', async (req) => {
    const validationError = await validateRequest(ValidationSchemas.verifyEmail)(req);
    if (validationError) return validationError;
    // CSRF protection for web clients
    const csrfError = csrfProtection.protect(req);
    if (csrfError) return csrfError;

    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await auth.verifyEmail(req, authResult.userId);
  });

  router.post('/auth/enable-2fa', async (req) => {
    const validationError = await validateRequest(ValidationSchemas.enable2FA)(req);
    if (validationError) return validationError;
    // CSRF protection for web clients
    const csrfError = csrfProtection.protect(req);
    if (csrfError) return csrfError;

    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await auth.enable2FA(req, authResult.userId);
  });

  router.post('/auth/verify-2fa-setup', async (req) => {
    const validationError = await validateRequest(ValidationSchemas.verify2FASetup)(req);
    if (validationError) return validationError;
    // CSRF protection for web clients
    const csrfError = csrfProtection.protect(req);
    if (csrfError) return csrfError;

    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await auth.verify2FASetup(req, authResult.userId);
  });

  router.post('/auth/disable-2fa', async (req) => {
    const validationError = await validateRequest(ValidationSchemas.disable2FA)(req);
    if (validationError) return validationError;
    // CSRF protection for web clients
    const csrfError = csrfProtection.protect(req);
    if (csrfError) return csrfError;

    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await auth.disable2FA(req, authResult.userId);
  });

  router.get('/auth/2fa/backup-codes', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await auth.getBackupCodesCount(req, authResult.userId);
  });

  router.post('/auth/2fa/regenerate-backup-codes', async (req) => {
    const validationError = await validateRequest(ValidationSchemas.regenerateBackupCodes)(req);
    if (validationError) return validationError;
    // CSRF protection for web clients
    const csrfError = csrfProtection.protect(req);
    if (csrfError) return csrfError;

    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await auth.regenerateBackupCodes(req, authResult.userId);
  });

  // Session management: logout all devices & device history
  router.post('/auth/logout-all-devices', async (req) => {
    // CSRF protection for web clients
    const csrfError = csrfProtection.protect(req);
    if (csrfError) return csrfError;

    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await logoutAllDevices(env.DB, env, authResult.userId, req);
  });

  router.post('/auth/verify-device', async (req) => {
    const validationError = await validateRequest(ValidationSchemas.verifyDevice)(req);
    if (validationError) return validationError;
    // Device verification uses a temporary token instead of authenticated JWT
    return await verifyDevice(env.DB, env, req);
  });

  router.post('/auth/verify-2fa-login', async (req) => {
    // 2FA verification uses a temporary token instead of authenticated JWT
    return await auth.verify2FALogin(req);
  });

  router.get('/auth/login-history', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await getUserLoginHistory(env.DB, env, authResult.userId);
  });

  router.get('/auth/verified-devices', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await getUserVerifiedDevices(env.DB, env, authResult.userId);
  });

  // Users
  router.patch('/users/me', async (req) => {
    // CSRF protection for web clients
    const csrfError = csrfProtection.protect(req);
    if (csrfError) return csrfError;

    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await users.updateProfile(req, authResult.userId);
  });

  router.delete('/users/me', async (req) => {
    // CSRF protection for web clients
    const csrfError = csrfProtection.protect(req);
    if (csrfError) return csrfError;

    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await users.deleteAccount(req, authResult.userId);
  });

  router.get('/users/me/export', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await users.exportData(req, authResult.userId);
  });

  router.get('/users/:username/feed', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await users.getUserFeed(req, authResult.userId, req.params.username);
  });

    router.get('/users/:username/bookmarks', async (req) => {
      const authResult = await authMiddleware(req, env);
      if (authResult.error) return authResult.error;
      return await users.getUserBookmarks(req, authResult.userId, req.params.username);
    });

  router.get('/users/:username/followers', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await users.getFollowers(req, authResult.userId, req.params.username);
  });

  router.get('/users/:username/following', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await users.getFollowing(req, authResult.userId, req.params.username);
  });

  // Note: /users/suggested is defined above as a public route with optionalAuth

  // Pages
  router.get('/pages', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await pages.list(req, authResult.userId);
  });

  router.post('/pages', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await pages.create(req, authResult.userId);
  });

  router.patch('/pages/:id', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await pages.update(req, authResult.userId, req.params.id);
  });

  router.delete('/pages/:id', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await pages.delete(req, authResult.userId, req.params.id);
  });

  router.get('/pages/:id/feed', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await pages.getFeed(req, authResult.userId, req.params.id);
  });

  router.get('/pages/:id/followers', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await pages.getFollowers(req, authResult.userId, req.params.id);
  });

  // Posts (with CSRF protection and validation)
  router.post('/posts', async (req) => {
    // Validate request size first (before parsing)
    const sizeError = checkRequestSize(req, '/posts');
    if (sizeError) return sizeError;

    // CSRF protection
    const csrfError = csrfProtection.protect(req);
    if (csrfError) return csrfError;

    // Authentication
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;

    // Input validation
    const validationError = await validateRequest(ValidationSchemas.createPost)(req);
    if (validationError) return validationError;

    return await posts.create(req, authResult.userId, ctx);
  });

  router.get('/posts/:id', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await posts.get(req, authResult.userId, req.params.id);
  });

  router.patch('/posts/:id', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await posts.update(req, authResult.userId, req.params.id);
  });

  router.delete('/posts/:id', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await posts.delete(req, authResult.userId, req.params.id, ctx);
  });

  // Media Upload URLs
  router.post('/media/images/upload-url', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await media.createImageUploadURL(req);
  });

  router.post('/media/videos/upload-url', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await media.createVideoUploadURL(req);
  });

  // Comments
  router.get('/posts/:id/comments', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await comments.list(req, authResult.userId, req.params.id);
  });

  router.post('/posts/:id/comments', async (req) => {
    // CSRF protection for web clients
    const csrfError = csrfProtection.protect(req);
    if (csrfError) return csrfError;

    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;

    // Input validation
    const validationError = await validateRequest(ValidationSchemas.createComment)(req);
    if (validationError) return validationError;

    return await comments.create(req, authResult.userId, req.params.id);
  });

  router.delete('/comments/:id', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await comments.delete(req, authResult.userId, req.params.id);
  });

  // Likes
  router.post('/posts/:id/likes', async (req) => {
    // CSRF protection for web clients
    const csrfError = csrfProtection.protect(req);
    if (csrfError) return csrfError;

    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await likes.likePost(req, authResult.userId, req.params.id);
  });

  router.delete('/posts/:id/likes', async (req) => {
    // CSRF protection for web clients
    const csrfError = csrfProtection.protect(req);
    if (csrfError) return csrfError;

    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await likes.unlikePost(req, authResult.userId, req.params.id);
  });

  // Bookmarks
  router.post('/posts/:id/bookmarks', async (req) => {
    // CSRF protection for web clients
    const csrfError = csrfProtection.protect(req);
    if (csrfError) return csrfError;

    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await bookmarks.add(req, authResult.userId, req.params.id);
  });

  router.delete('/posts/:id/bookmarks', async (req) => {
    // CSRF protection for web clients
    const csrfError = csrfProtection.protect(req);
    if (csrfError) return csrfError;

    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await bookmarks.remove(req, authResult.userId, req.params.id);
  });

  router.get('/bookmarks', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await bookmarks.list(req, authResult.userId);
  });

  // Follows
  router.post('/follows', async (req) => {
    // CSRF protection for web clients
    const csrfError = csrfProtection.protect(req);
    if (csrfError) return csrfError;

    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await follows.follow(req, authResult.userId);
  });

  router.delete('/follows', async (req) => {
    // CSRF protection for web clients
    const csrfError = csrfProtection.protect(req);
    if (csrfError) return csrfError;

    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await follows.unfollow(req, authResult.userId);
  });

  // Blocks
  router.post('/blocks', async (req) => {
    // CSRF protection for web clients
    const csrfError = csrfProtection.protect(req);
    if (csrfError) return csrfError;

    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await blocks.block(req, authResult.userId);
  });

  router.delete('/blocks', async (req) => {
    // CSRF protection for web clients
    const csrfError = csrfProtection.protect(req);
    if (csrfError) return csrfError;

    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await blocks.unblock(req, authResult.userId);
  });

  router.get('/blocks', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await blocks.list(req, authResult.userId);
  });

  // Feed
  router.get('/feed', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await feed.getFeed(req, authResult.userId);
  });

  // Search
  router.get('/search', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await search.search(req, authResult.userId);
  });

  // Settings
  router.get('/settings', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await settings.get(req, authResult.userId);
  });

  router.patch('/settings', async (req) => {
    // CSRF protection for web clients
    const csrfError = csrfProtection.protect(req);
    if (csrfError) return csrfError;

    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await settings.update(req, authResult.userId);
  });

  // Notifications
  router.get('/notifications', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await notifications.list(req, authResult.userId);
  });

  router.get('/notifications/count', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await notifications.getUnreadCount(req, authResult.userId);
  });

  router.post('/notifications/mark-all-read', async (req) => {
    // CSRF protection for web clients
    const csrfError = csrfProtection.protect(req);
    if (csrfError) return csrfError;

    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await notifications.markAllRead(req, authResult.userId);
  });

  router.patch('/notifications/:id/read', async (req) => {
    // CSRF protection for web clients
    const csrfError = csrfProtection.protect(req);
    if (csrfError) return csrfError;

    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await notifications.markRead(req, authResult.userId, req.params.id);
  });

  // Expo push notifications for mobile apps
  router.post('/push/expo/subscribe', async (req) => {
    // CSRF protection for web clients
    const csrfError = csrfProtection.protect(req);
    if (csrfError) return csrfError;

    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await push.subscribeExpo(req, authResult.userId);
  });

  // Reports
  router.post('/reports', async (req) => {
    // CSRF protection for web clients
    const csrfError = csrfProtection.protect(req);
    if (csrfError) return csrfError;

    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await reports.create(req, authResult.userId);
  });

  // ============================================
  // STORIES ROUTES
  // ============================================

  router.post('/stories', async (req) => {
    // Validate request size first
    const sizeError = checkRequestSize(req, '/stories');
    if (sizeError) return sizeError;

    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;

    // Input validation
    const validationError = await validateRequest(ValidationSchemas.createStory)(req);
    if (validationError) return validationError;

    return await stories.create(req, authResult.userId);
  });

  router.get('/stories/feed', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await stories.getFeed(req, authResult.userId);
  });

  router.get('/stories/:username', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await stories.getUserStories(req, authResult.userId, req.params.username);
  });

  router.post('/stories/:id/view', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await stories.markViewed(req, authResult.userId, req.params.id);
  });

  router.get('/stories/:id/viewers', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await stories.getViewers(req, authResult.userId, req.params.id);
  });

  router.delete('/stories/:id', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await stories.delete(req, authResult.userId, req.params.id);
  });

  // ============================================
  // REELS ROUTES
  // ============================================

  router.post('/reels', async (req) => {
    // CSRF protection for web clients
    const csrfError = csrfProtection.protect(req);
    if (csrfError) return csrfError;

    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await reels.create(req, authResult.userId);
  });

  router.get('/reels/feed', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await reels.getFeed(req, authResult.userId);
  });

  router.get('/reels/user/:username', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await reels.getUserReels(req, authResult.userId, req.params.username);
  });

  router.get('/reels/:id', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await reels.get(req, authResult.userId, req.params.id);
  });

  router.post('/reels/:id/view', async (req) => {
    // CSRF protection for web clients
    const csrfError = csrfProtection.protect(req);
    if (csrfError) return csrfError;

    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await reels.view(req, authResult.userId, req.params.id);
  });

  router.post('/reels/:id/like', async (req) => {
    // CSRF protection for web clients
    const csrfError = csrfProtection.protect(req);
    if (csrfError) return csrfError;

    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await reels.like(req, authResult.userId, req.params.id);
  });

  router.delete('/reels/:id/like', async (req) => {
    // CSRF protection for web clients
    const csrfError = csrfProtection.protect(req);
    if (csrfError) return csrfError;

    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await reels.unlike(req, authResult.userId, req.params.id);
  });

  router.delete('/reels/:id', async (req) => {
    // CSRF protection for web clients
    const csrfError = csrfProtection.protect(req);
    if (csrfError) return csrfError;

    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await reels.delete(req, authResult.userId, req.params.id);
  });

  router.post('/reels/exit-sensitive-mode', async (req) => {
    // CSRF protection for web clients
    const csrfError = csrfProtection.protect(req);
    if (csrfError) return csrfError;

    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await reels.exitSensitiveMode(req, authResult.userId);
  });

  // Reel comments
  router.get('/reels/:id/comments', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await reels.getComments(req, authResult.userId, req.params.id);
  });

  router.post('/reels/:id/comments', async (req) => {
    // CSRF protection for web clients
    const csrfError = csrfProtection.protect(req);
    if (csrfError) return csrfError;

    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await reels.createComment(req, authResult.userId, req.params.id);
  });

  router.delete('/reels/:id/comments/:commentId', async (req) => {
    // CSRF protection for web clients
    const csrfError = csrfProtection.protect(req);
    if (csrfError) return csrfError;

    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await reels.deleteComment(req, authResult.userId, req.params.id, req.params.commentId);
  });

  // ============================================
  // SHARES ROUTES
  // ============================================
 
  router.post('/shares', async (req) => {
    // CSRF protection for web clients
    const csrfError = csrfProtection.protect(req);
    if (csrfError) return csrfError;

    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await shares.create(req, authResult.userId, ctx);
  });
 
  // Get all shares created by the authenticated user
  router.get('/shares/mine', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await shares.listMine(req, authResult.userId);
  });
 
  router.get('/shares/:id', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await shares.get(req, authResult.userId, req.params.id);
  });

  router.delete('/shares/:id', async (req) => {
    // CSRF protection for web clients
    const csrfError = csrfProtection.protect(req);
    if (csrfError) return csrfError;

    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await shares.delete(req, authResult.userId, req.params.id);
  });

  router.get('/posts/:id/shares', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await shares.getPostShares(req, authResult.userId, req.params.id);
  });

  router.post('/stories/share', async (req) => {
    // CSRF protection for web clients
    const csrfError = csrfProtection.protect(req);
    if (csrfError) return csrfError;

    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await shares.shareToStory(req, authResult.userId);
  });

  // ============================================
  // MESSAGING ROUTES (Real-time Chat)
  // ============================================

  router.post('/conversations', async (req) => {
    // CSRF protection for web clients
    const csrfError = csrfProtection.protect(req);
    if (csrfError) return csrfError;

    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await messaging.create(req, authResult.userId);
  });

  router.get('/conversations', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await messaging.list(req, authResult.userId);
  });

  router.get('/conversations/:id', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await messaging.get(req, authResult.userId, req.params.id);
  });

  router.get('/conversations/:id/connect', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await messaging.connect(req, authResult.userId, req.params.id);
  });

  router.get('/conversations/:id/messages', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await messaging.getMessages(req, authResult.userId, req.params.id);
  });

  router.post('/conversations/:id/messages', async (req) => {
    // CSRF protection for web clients
    const csrfError = csrfProtection.protect(req);
    if (csrfError) return csrfError;

    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await messaging.sendMessage(req, authResult.userId, req.params.id);
  });

  router.post('/conversations/:id/members', async (req) => {
    // CSRF protection for web clients
    const csrfError = csrfProtection.protect(req);
    if (csrfError) return csrfError;

    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await messaging.addMember(req, authResult.userId, req.params.id);
  });

  router.delete('/conversations/:id/members/:userId', async (req) => {
    // CSRF protection for web clients
    const csrfError = csrfProtection.protect(req);
    if (csrfError) return csrfError;

    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await messaging.removeMember(req, authResult.userId, req.params.id, req.params.userId);
  });

  router.delete('/conversations/:id', async (req) => {
    // CSRF protection for web clients
    const csrfError = csrfProtection.protect(req);
    if (csrfError) return csrfError;

    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await messaging.delete(req, authResult.userId, req.params.id);
  });

  // Delete a single message
  router.delete('/messages/:id', async (req) => {
    // CSRF protection for web clients
    const csrfError = csrfProtection.protect(req);
    if (csrfError) return csrfError;

    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await messaging.deleteMessage(req, authResult.userId, req.params.id);
  });

  // WebSocket route for real-time chat
  router.get('/chat/:conversationId', async (req) => {
    const upgradeHeader = req.headers.get('Upgrade');
    let token = null;

    // Extract token from multiple sources (in order of preference)
    // 1. Query parameter (for browser WebSocket API compatibility) - MOST RELIABLE
    const url = new URL(req.url);
    token = url.searchParams.get('token');

    // 2. Sec-WebSocket-Protocol header (for clients that support it)
    if (!token && upgradeHeader && upgradeHeader.toLowerCase() === 'websocket') {
      const protocols = req.headers.get('Sec-WebSocket-Protocol');
      if (protocols) {
        // Parse comma-separated protocols: "bearer, <token>" or just "<token>"
        const parts = protocols.split(',').map(p => p.trim());
        // Find the token part - it's either after 'bearer' or is the second element
        if (parts.length >= 2) {
          token = parts[1]; // Get the part after 'bearer'
        } else if (parts.length === 1 && parts[0] !== 'bearer') {
          token = parts[0]; // If only one part and it's not 'bearer', it's the token
        }
      }
    }

    // 3. Authorization header (standard HTTP auth)
    if (!token) {
      const authHeader = req.headers.get('Authorization');
      if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.slice(7);
      }
    }

    // For WebSocket upgrades, do not recreate the request to preserve the upgrade.
    if (upgradeHeader && upgradeHeader.toLowerCase() === 'websocket') {
      const { conversationId } = req.params;
      const id = env.CHAT_ROOM.idFromName(conversationId);
      const stub = env.CHAT_ROOM.get(id);
      return await stub.fetch(req);
    }

    // Non-WebSocket requests still require auth
    if (!token) {
      return errorResponse('Authentication required', 401);
    }

    const newHeaders = new Headers(req.headers);
    newHeaders.set('Authorization', `Bearer ${token}`);
    const authenticatedReq = new Request(req.url, {
      headers: newHeaders,
      method: req.method,
    });

    const authResult = await authMiddleware(authenticatedReq, env);
    if (authResult.error) return authResult.error;

    return errorResponse('WebSocket upgrade required', 426);
  });

  // WebSocket route for real-time notifications
  router.get('/notifications/stream', async (req) => {
    const upgradeHeader = req.headers.get('Upgrade');
    let authCheckReq = req;
    let token = null;

    // Extract token from multiple sources (in order of preference)
    // 1. Query parameter (for browser WebSocket API compatibility) - MOST RELIABLE
    const url = new URL(req.url);
    token = url.searchParams.get('token');

    // 2. Sec-WebSocket-Protocol header (for clients that support it)
    if (!token && upgradeHeader && upgradeHeader.toLowerCase() === 'websocket') {
      const protocols = req.headers.get('Sec-WebSocket-Protocol');
      if (protocols) {
        // Parse comma-separated protocols: "bearer, <token>" or just "<token>"
        const parts = protocols.split(',').map(p => p.trim());
        // Find the token part - it's either after 'bearer' or is the second element
        if (parts.length >= 2) {
          token = parts[1]; // Get the part after 'bearer'
        } else if (parts.length === 1 && parts[0] !== 'bearer') {
          token = parts[0]; // If only one part and it's not 'bearer', it's the token
        }
      }
    }

    // 3. Authorization header (standard HTTP auth)
    if (!token) {
      const authHeader = req.headers.get('Authorization');
      if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.slice(7);
      }
    }

    // Create authenticated request with token
    if (token) {
      const newHeaders = new Headers(req.headers);
      newHeaders.set('Authorization', `Bearer ${token}`);
      authCheckReq = new Request(req.url, {
        headers: newHeaders,
        method: req.method,
      });
    }

    // Verify token via Authorization header
    const authResult = await authMiddleware(authCheckReq, env);
    if (authResult.error) return authResult.error;

    // Extract userId from query params (non-sensitive) - reuse url from above
    const userId = url.searchParams.get('userId');

    if (!userId) {
      return errorResponse('Unauthorized: Missing userId', 401);
    }

    // Verify userId matches authenticated user
    if (userId !== authResult.userId) {
      return errorResponse('Unauthorized: User ID mismatch', 403);
    }

    // Route to NotificationHub (use sharded instance for scale to 100k+ users)
    const userIdHash = Array.from(userId).reduce((h, c) => ((h << 5) - h) + c.charCodeAt(0), 0);
    const shardId = Math.abs(userIdHash) % 16; // 16 shards for load distribution
    const id = env.NOTIFICATION_HUB.idFromName(`notify-${shardId}`);
    const stub = env.NOTIFICATION_HUB.get(id);

    // For websocket upgrades, forward the ORIGINAL request to preserve upgrade semantics.
    // For non-upgrade requests, forward the authenticated request.
    const requestForHub = (upgradeHeader && upgradeHeader.toLowerCase() === 'websocket')
      ? req
      : authCheckReq;

    return stub.fetch(requestForHub);
  });

  // ============================================
  // PUSH NOTIFICATIONS ROUTES
  // ============================================

  router.post('/push/subscribe', async (req) => {
    // CSRF protection for web clients
    const csrfError = csrfProtection.protect(req);
    if (csrfError) return csrfError;

    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await push.subscribe(req, authResult.userId);
  });

  router.post('/push/unsubscribe', async (req) => {
    // CSRF protection for web clients
    const csrfError = csrfProtection.protect(req);
    if (csrfError) return csrfError;

    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await push.unsubscribe(req, authResult.userId);
  });

  router.get('/push/subscriptions', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await push.getSubscriptions(req, authResult.userId);
  });

  router.post('/push/test', async (req) => {
    // CSRF protection for web clients
    const csrfError = csrfProtection.protect(req);
    if (csrfError) return csrfError;

    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await push.testNotification(req, authResult.userId);
  });

  // ============================================
  // ANALYTICS ROUTES (Admin & Public)
  // ============================================

  // Public analytics
  router.get('/analytics/overview', async (req) => {
    return await analytics.getOverview(req);
  });

  router.get('/analytics/trending', async (req) => {
    return await analytics.getTrending(req);
  });

  // Admin analytics
  router.get('/admin/analytics/overview', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    
    const adminResult = await adminMiddleware(req, env, authResult.userId);
    if (adminResult.error) return adminResult.error;
    
    // RBAC: Moderators can view analytics
    const rbacError = rbacMiddleware(adminResult, ADMIN_ROLES.MODERATOR.name, 'view_analytics');
    if (rbacError) return rbacError;
    
    // Rate limiting for analytics queries
    const rateLimitResult = await adminOperationRateLimit(req, env, authResult.userId, 'view_analytics');
    if (!rateLimitResult.allowed) return rateLimitResult.error;
    
    return await analytics.getOverview(req);
  });

  router.get('/admin/analytics/users', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    
    const adminResult = await adminMiddleware(req, env, authResult.userId);
    if (adminResult.error) return adminResult.error;
    
    const rbacError = rbacMiddleware(adminResult, ADMIN_ROLES.MODERATOR.name, 'view_analytics');
    if (rbacError) return rbacError;
    
    const rateLimitResult = await adminOperationRateLimit(req, env, authResult.userId, 'view_analytics');
    if (!rateLimitResult.allowed) return rateLimitResult.error;
    
    return await analytics.getUserGrowth(req);
  });

  router.get('/admin/analytics/engagement', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    
    const adminResult = await adminMiddleware(req, env, authResult.userId);
    if (adminResult.error) return adminResult.error;
    
    const rbacError = rbacMiddleware(adminResult, ADMIN_ROLES.MODERATOR.name, 'view_analytics');
    if (rbacError) return rbacError;
    
    const rateLimitResult = await adminOperationRateLimit(req, env, authResult.userId, 'view_analytics');
    if (!rateLimitResult.allowed) return rateLimitResult.error;
    
    return await analytics.getEngagement(req);
  });

  router.get('/admin/analytics/active', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    
    const adminResult = await adminMiddleware(req, env, authResult.userId);
    if (adminResult.error) return adminResult.error;
    
    const rbacError = rbacMiddleware(adminResult, ADMIN_ROLES.MODERATOR.name, 'view_analytics');
    if (rbacError) return rbacError;
    
    const rateLimitResult = await adminOperationRateLimit(req, env, authResult.userId, 'view_analytics');
    if (!rateLimitResult.allowed) return rateLimitResult.error;
    
    return await analytics.getActiveUsers(req);
  });

  router.get('/admin/analytics/content', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    
    const adminResult = await adminMiddleware(req, env, authResult.userId);
    if (adminResult.error) return adminResult.error;
    
    const rbacError = rbacMiddleware(adminResult, ADMIN_ROLES.MODERATOR.name, 'view_analytics');
    if (rbacError) return rbacError;
    
    const rateLimitResult = await adminOperationRateLimit(req, env, authResult.userId, 'view_analytics');
    if (!rateLimitResult.allowed) return rateLimitResult.error;
    
    return await analytics.getTopContent(req);
  });

  router.get('/admin/analytics/retention', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    
    const adminResult = await adminMiddleware(req, env, authResult.userId);
    if (adminResult.error) return adminResult.error;
    
    const rbacError = rbacMiddleware(adminResult, ADMIN_ROLES.MODERATOR.name, 'view_analytics');
    if (rbacError) return rbacError;
    
    const rateLimitResult = await adminOperationRateLimit(req, env, authResult.userId, 'view_analytics');
    if (!rateLimitResult.allowed) return rateLimitResult.error;
    
    return await analytics.getRetention(req);
  });

  router.get('/admin/analytics/messaging', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    
    const adminResult = await adminMiddleware(req, env, authResult.userId);
    if (adminResult.error) return adminResult.error;
    
    const rbacError = rbacMiddleware(adminResult, ADMIN_ROLES.MODERATOR.name, 'view_analytics');
    if (rbacError) return rbacError;
    
    const rateLimitResult = await adminOperationRateLimit(req, env, authResult.userId, 'view_analytics');
    if (!rateLimitResult.allowed) return rateLimitResult.error;
    
    return await analytics.getMessaging(req);
  });

  router.get('/admin/analytics/moderation', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    
    const adminResult = await adminMiddleware(req, env, authResult.userId);
    if (adminResult.error) return adminResult.error;
    
    const rbacError = rbacMiddleware(adminResult, ADMIN_ROLES.MODERATOR.name, 'view_analytics');
    if (rbacError) return rbacError;
    
    const rateLimitResult = await adminOperationRateLimit(req, env, authResult.userId, 'view_analytics');
    if (!rateLimitResult.allowed) return rateLimitResult.error;
    
    return await analytics.getModeration(req);
  });

  router.get('/admin/analytics/export', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    
    const adminResult = await adminMiddleware(req, env, authResult.userId);
    if (adminResult.error) return adminResult.error;
    
    // RBAC: Only admins can export analytics (more restrictive than view)
    const rbacError = rbacMiddleware(adminResult, ADMIN_ROLES.ADMIN.name, 'export_analytics');
    if (rbacError) return rbacError;
    
    // Expensive operation - strict rate limit
    const rateLimitResult = await adminOperationRateLimit(req, env, authResult.userId, 'export_analytics');
    if (!rateLimitResult.allowed) return rateLimitResult.error;
    
    return await analytics.exportReport(req);
  });

  // ============================================
  // INTEGRATIONS ROUTES
  // ============================================

  // Email
  router.post('/integrations/email/test', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await integrations.sendTestEmail(req, authResult.userId);
  });

  // SMS
  router.post('/integrations/sms/test', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await integrations.sendTestSMS(req, authResult.userId);
  });

  router.post('/integrations/sms/verify/initiate', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await integrations.initiatePhoneVerification(req, authResult.userId);
  });

  router.post('/integrations/sms/verify/confirm', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await integrations.verifyPhone(req, authResult.userId);
  });

  // Images
  router.post('/integrations/images/upload-url', async (req) => {
    // CSRF protection for web clients
    const csrfError = csrfProtection.protect(req);
    if (csrfError) return csrfError;

    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await integrations.getImageUploadUrl(req, authResult.userId);
  });

  router.get('/integrations/images', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await integrations.listImages(req, authResult.userId);
  });

  router.delete('/integrations/images/:id', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await integrations.deleteImage(req, authResult.userId, req.params.id);
  });

  // Videos (Stream)
  router.post('/integrations/videos/upload-url', async (req) => {
    // CSRF protection for web clients
    const csrfError = csrfProtection.protect(req);
    if (csrfError) return csrfError;

    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await integrations.getVideoUploadUrl(req, authResult.userId);
  });

  router.get('/integrations/videos', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await integrations.listVideos(req, authResult.userId);
  });

  router.get('/integrations/videos/:id', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await integrations.getVideoDetails(req, authResult.userId, req.params.id);
  });

  router.delete('/integrations/videos/:id', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await integrations.deleteVideo(req, authResult.userId, req.params.id);
  });

  router.post('/integrations/videos/live', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    return await integrations.createLiveStream(req, authResult.userId);
  });

  // ============================================
  // ADMIN ROUTES (Admin Auth Required)
  // ============================================

  router.get('/admin/reports', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    
    const adminResult = await adminMiddleware(req, env, authResult.userId);
    if (adminResult.error) return adminResult.error;
    
    // RBAC: Moderators can view reports
    const rbacError = rbacMiddleware(adminResult, ADMIN_ROLES.MODERATOR.name, 'view_reports');
    if (rbacError) return rbacError;
    
    // Rate limiting for report queries
    const rateLimitResult = await adminOperationRateLimit(req, env, authResult.userId, 'view_reports');
    if (!rateLimitResult.allowed) return rateLimitResult.error;
    
    return await admin.getReports(req, adminResult);
  });

  router.get('/admin/users', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;

    const adminResult = await adminMiddleware(req, env, authResult.userId);
    if (adminResult.error) return adminResult.error;

    // RBAC: Support role can view users
    const rbacError = rbacMiddleware(adminResult, ADMIN_ROLES.SUPPORT.name, 'view_all_user_data');
    if (rbacError) return rbacError;
    
    // Rate limiting for user queries
    const rateLimitResult = await adminOperationRateLimit(req, env, authResult.userId, 'view_all_user_data');
    if (!rateLimitResult.allowed) return rateLimitResult.error;

    return await admin.listUsers(req, adminResult);
  });

  router.post('/admin/reports/:id/resolve', async (req) => {
    // Input validation
    const validationError = await validateRequest(ValidationSchemas.resolveReport)(req);
    if (validationError) return validationError;
    
    // Request size limit check
    const sizeError = checkRequestSize(req, '/admin/reports/:id/resolve');
    if (sizeError) return sizeError;
    
    // CSRF protection (state-changing operation on admin panel)
    const csrfError = csrfProtection.protect(req);
    if (csrfError) return csrfError;
    
    // Authentication
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    
    // Admin verification
    const adminResult = await adminMiddleware(req, env, authResult.userId);
    if (adminResult.error) return adminResult.error;
    
    // RBAC: Must be at least moderator to resolve reports
    const rbacError = rbacMiddleware(adminResult, ADMIN_ROLES.MODERATOR.name, 'resolve_reports');
    if (rbacError) return rbacError;
    
    // Admin operation rate limiting
    const rateLimitResult = await adminOperationRateLimit(req, env, authResult.userId, 'resolve_reports');
    if (!rateLimitResult.allowed) return rateLimitResult.error;
    
    // Log the operation
    await logAdminOperation(env, authResult.userId, 'resolve_reports', req.params.id, {
      clientIp: req.headers.get('CF-Connecting-IP'),
      userAgent: req.headers.get('User-Agent')
    });
    
    return await admin.resolveReport(req, adminResult, req.params.id);
  });

  router.post('/admin/users/:id/ban', async (req) => {
    // Input validation
    const validationError = await validateRequest(ValidationSchemas.banUser)(req);
    if (validationError) return validationError;
    
    // Request size limit check
    const sizeError = checkRequestSize(req, '/admin/users/:id/ban');
    if (sizeError) return sizeError;
    
    // CSRF protection (sensitive admin action)
    const csrfError = csrfProtection.protect(req);
    if (csrfError) return csrfError;
    
    // Authentication
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    
    // Admin verification
    const adminResult = await adminMiddleware(req, env, authResult.userId);
    if (adminResult.error) return adminResult.error;
    
    // RBAC: Must be at least admin (moderators cannot ban users)
    const rbacError = rbacMiddleware(adminResult, ADMIN_ROLES.ADMIN.name, 'ban_users');
    if (rbacError) return rbacError;
    
    // Admin operation rate limiting
    const rateLimitResult = await adminOperationRateLimit(req, env, authResult.userId, 'ban_users');
    if (!rateLimitResult.allowed) return rateLimitResult.error;
    
    // Log the operation
    await logAdminOperation(env, authResult.userId, 'ban_users', req.params.id, {
      clientIp: req.headers.get('CF-Connecting-IP'),
      userAgent: req.headers.get('User-Agent')
    });
    
    return await admin.banUser(req, adminResult, req.params.id);
  });

  router.post('/admin/users/:id/verify', async (req) => {
    // Request size limit check
    const sizeError = checkRequestSize(req, '/admin/users/:id/verify');
    if (sizeError) return sizeError;
    
    // CSRF protection (state-changing operation)
    const csrfError = csrfProtection.protect(req);
    if (csrfError) return csrfError;
    
    // Authentication
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    
    // Admin verification
    const adminResult = await adminMiddleware(req, env, authResult.userId);
    if (adminResult.error) return adminResult.error;
    
    // RBAC: Support role can verify users
    const rbacError = rbacMiddleware(adminResult, ADMIN_ROLES.SUPPORT.name, 'verify_users');
    if (rbacError) return rbacError;
    
    // Admin operation rate limiting
    const rateLimitResult = await adminOperationRateLimit(req, env, authResult.userId, 'verify_users');
    if (!rateLimitResult.allowed) return rateLimitResult.error;
    
    // Log the operation
    await logAdminOperation(env, authResult.userId, 'verify_users', req.params.id, {
      clientIp: req.headers.get('CF-Connecting-IP'),
      userAgent: req.headers.get('User-Agent')
    });
    
    return await admin.verifyUser(req, adminResult, req.params.id);
  });

  router.delete('/admin/posts/:id', async (req) => {
    // Request size limit check
    const sizeError = checkRequestSize(req, '/admin/posts/:id');
    if (sizeError) return sizeError;
    
    // CSRF protection (DELETE operation - sensitive)
    const csrfError = csrfProtection.protect(req);
    if (csrfError) return csrfError;
    
    // Authentication
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;
    
    // Admin verification
    const adminResult = await adminMiddleware(req, env, authResult.userId);
    if (adminResult.error) return adminResult.error;
    
    // RBAC: Moderators can delete posts
    const rbacError = rbacMiddleware(adminResult, ADMIN_ROLES.MODERATOR.name, 'delete_posts');
    if (rbacError) return rbacError;
    
    // Admin operation rate limiting
    const rateLimitResult = await adminOperationRateLimit(req, env, authResult.userId, 'delete_posts');
    if (!rateLimitResult.allowed) return rateLimitResult.error;
    
    // Log the operation
    await logAdminOperation(env, authResult.userId, 'delete_posts', req.params.id, {
      clientIp: req.headers.get('CF-Connecting-IP'),
      userAgent: req.headers.get('User-Agent')
    });
    
    return await admin.deletePost(req, adminResult, req.params.id);
  });

  router.get('/admin/analytics', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;

    const adminResult = await adminMiddleware(req, env, authResult.userId);
    if (adminResult.error) return adminResult.error;

    // RBAC: Admins can view system analytics (more restrictive than individual analytics)
    const rbacError = rbacMiddleware(adminResult, ADMIN_ROLES.ADMIN.name, 'view_system_analytics');
    if (rbacError) return rbacError;
    
    // Rate limiting for system analytics
    const rateLimitResult = await adminOperationRateLimit(req, env, authResult.userId, 'view_system_analytics');
    if (!rateLimitResult.allowed) return rateLimitResult.error;

    return await admin.getAnalytics(req, adminResult);
  });

  // Full logical export of the database (super admin only)
  router.get('/admin/export/all', async (req) => {
    // Request size limit check
    const sizeError = checkRequestSize(req, '/admin/export/all');
    if (sizeError) return sizeError;
    
    // Authentication
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;

    // Admin verification
    const adminResult = await adminMiddleware(req, env, authResult.userId);
    if (adminResult.error) return adminResult.error;

    // RBAC: Super admin only (highest permission)
    const rbacError = rbacMiddleware(adminResult, ADMIN_ROLES.SUPER_ADMIN.name, 'export_data');
    if (rbacError) return rbacError;
    
    // Extremely restrictive rate limit for data exports
    const rateLimitResult = await adminOperationRateLimit(req, env, authResult.userId, 'export_data');
    if (!rateLimitResult.allowed) return rateLimitResult.error;
    
    // Log the operation
    await logAdminOperation(env, authResult.userId, 'export_data', null, {
      clientIp: req.headers.get('CF-Connecting-IP'),
      userAgent: req.headers.get('User-Agent')
    });

    return await admin.exportAllData(req, adminResult);
  });

  // Full logical import of the database from a snapshot (super admin only)
  router.post('/admin/import/all', async (req) => {
    // Request size limit check (very large for imports)
    const sizeError = checkRequestSize(req, '/admin/import/all');
    if (sizeError) return sizeError;
    
    // CSRF protection (critical operation)
    const csrfError = csrfProtection.protect(req);
    if (csrfError) return csrfError;
    
    // Authentication
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;

    // Admin verification
    const adminResult = await adminMiddleware(req, env, authResult.userId);
    if (adminResult.error) return adminResult.error;

    // RBAC: Super admin only (most restrictive)
    const rbacError = rbacMiddleware(adminResult, ADMIN_ROLES.SUPER_ADMIN.name, 'import_data');
    if (rbacError) return rbacError;
    
    // Extremely restrictive rate limit for data imports (2 per hour)
    const rateLimitResult = await adminOperationRateLimit(req, env, authResult.userId, 'import_data');
    if (!rateLimitResult.allowed) return rateLimitResult.error;
    
    // Log the operation
    await logAdminOperation(env, authResult.userId, 'import_data', null, {
      clientIp: req.headers.get('CF-Connecting-IP'),
      userAgent: req.headers.get('User-Agent')
    });

    return await admin.importAllData(req, adminResult);
  });

  // ============================================
  // PUBLIC: ADVERTISEMENT ROUTES (User-facing)
  // ============================================

  // Get eligible ads for user
  router.get('/ads/eligible', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;

    const advertisements = new AdvertisementController(env);
    return await advertisements.getEligibleAds(req, authResult.userId);
  });

  // Track ad impression
  router.post('/ads/:adId/impression', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;

    const advertisements = new AdvertisementController(env);
    return await advertisements.trackImpression(req, authResult.userId);
  });

  // Batch track ad impressions
  router.post('/ads/impressions/batch', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;

    const advertisements = new AdvertisementController(env);
    return await advertisements.batchTrackImpressions(req, authResult.userId);
  });

  // Get impression buffer stats (admin only)
  router.get('/admin/ads/buffer-stats', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;

    const advertisements = new AdvertisementController(env);
    return await advertisements.getBufferStats(req, authResult.adminInfo);
  });

  // Flush impression buffer (admin only)
  router.post('/admin/ads/flush-buffer', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;

    const advertisements = new AdvertisementController(env);
    return await advertisements.flushBufferManually(req, authResult.adminInfo);
  });

  // Track ad click
  router.post('/ads/:adId/click', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;

    const advertisements = new AdvertisementController(env);
    return await advertisements.trackClick(req, authResult.userId);
  });

  // ============================================
  // ADMIN: ADMIN MANAGEMENT ROUTES (Super Admin Only)
  // ============================================

  // List all admins
  router.get('/admin/admins', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;

    const adminResult = await adminMiddleware(req, env, authResult.userId);
    if (adminResult.error) return adminResult.error;

    return await admin.listAdmins(req, adminResult);
  });

  // Create new admin
  router.post('/admin/admins', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;

    const adminResult = await adminMiddleware(req, env, authResult.userId);
    if (adminResult.error) return adminResult.error;

    return await admin.createAdmin(req, adminResult);
  });

  // Update admin role/permissions
  router.patch('/admin/admins/:id', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;

    const adminResult = await adminMiddleware(req, env, authResult.userId);
    if (adminResult.error) return adminResult.error;

    return await admin.updateAdminRole(req, adminResult, req.params.id);
  });

  // Delete admin
  router.delete('/admin/admins/:id', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;

    const adminResult = await adminMiddleware(req, env, authResult.userId);
    if (adminResult.error) return adminResult.error;

    return await admin.deleteAdmin(req, adminResult, req.params.id);
  });

  // Get audit logs
  router.get('/admin/audit-logs', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;

    const adminResult = await adminMiddleware(req, env, authResult.userId);
    if (adminResult.error) return adminResult.error;

    return await admin.getAuditLogs(req, adminResult);
  });

  // ============================================
  // ADMIN: ADVERTISEMENT ROUTES
  // ============================================

  // Create advertisement
  router.post('/admin/ads', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;

    const adminResult = await adminMiddleware(req, env, authResult.userId);
    if (adminResult.error) return adminResult.error;

    return await advertisements.createAd(req, adminResult);
  });

  // List advertisements
  router.get('/admin/ads', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;

    const adminResult = await adminMiddleware(req, env, authResult.userId);
    if (adminResult.error) return adminResult.error;

    return await advertisements.listAds(req, adminResult);
  });

  // Get advertisement details
  router.get('/admin/ads/:id', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;

    const adminResult = await adminMiddleware(req, env, authResult.userId);
    if (adminResult.error) return adminResult.error;

    return await advertisements.getAd(req, adminResult, req.params.id);
  });

  // Update advertisement
  router.patch('/admin/ads/:id', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;

    const adminResult = await adminMiddleware(req, env, authResult.userId);
    if (adminResult.error) return adminResult.error;

    return await advertisements.updateAd(req, adminResult, req.params.id);
  });

  // Moderate advertisement (approve/reject)
  router.post('/admin/ads/:id/moderate', async (req) => {
    const validationError = await validateRequest(ValidationSchemas.moderateAd)(req);
    if (validationError) return validationError;
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;

    const adminResult = await adminMiddleware(req, env, authResult.userId);
    if (adminResult.error) return adminResult.error;

    return await advertisements.moderateAd(req, adminResult, req.params.id);
  });

  // Toggle ad status (activate/pause)
  router.post('/admin/ads/:id/toggle', async (req) => {
    const validationError = await validateRequest(ValidationSchemas.toggleAd)(req);
    if (validationError) return validationError;
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;

    const adminResult = await adminMiddleware(req, env, authResult.userId);
    if (adminResult.error) return adminResult.error;

    return await advertisements.toggleAdStatus(req, adminResult, req.params.id);
  });

  // Delete advertisement
  router.delete('/admin/ads/:id', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;

    const adminResult = await adminMiddleware(req, env, authResult.userId);
    if (adminResult.error) return adminResult.error;

    return await advertisements.deleteAd(req, adminResult, req.params.id);
  });

  // Get advertisement analytics
  router.get('/admin/ads/:id/analytics', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;

    const adminResult = await adminMiddleware(req, env, authResult.userId);
    if (adminResult.error) return adminResult.error;

    return await advertisements.getAdAnalytics(req, adminResult, req.params.id);
  });

  // Get global ad analytics
  router.get('/admin/ads/analytics/global', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;

    const adminResult = await adminMiddleware(req, env, authResult.userId);
    if (adminResult.error) return adminResult.error;

    return await advertisements.getGlobalAnalytics(req, adminResult);
  });

  // ============================================
  // ADMIN: SOCIAL MEDIA IMPORT ROUTES
  // ============================================

  // Search trending content
  router.post('/admin/social-media/search/trending', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;

    const adminResult = await adminMiddleware(req, env, authResult.userId);
    if (adminResult.error) return adminResult.error;

    const socialMediaImport = new SocialMediaImportController(env);
    return await socialMediaImport.searchTrending(req, adminResult);
  });

  // Search public user content
  router.post('/admin/social-media/search/user/:username', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;

    const adminResult = await adminMiddleware(req, env, authResult.userId);
    if (adminResult.error) return adminResult.error;

    const socialMediaImport = new SocialMediaImportController(env);
    return await socialMediaImport.searchPublicUser(req, adminResult, req.params.username);
  });

  // Import selected content
  router.post('/admin/social-media/import/selected', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;

    const adminResult = await adminMiddleware(req, env, authResult.userId);
    if (adminResult.error) return adminResult.error;

    const socialMediaImport = new SocialMediaImportController(env);
    return await socialMediaImport.importSelected(req, adminResult);
  });

  // Get trending hashtags
  router.get('/admin/social-media/trending/hashtags', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;

    const adminResult = await adminMiddleware(req, env, authResult.userId);
    if (adminResult.error) return adminResult.error;

    const socialMediaImport = new SocialMediaImportController(env);
    return await socialMediaImport.getTrendingHashtags(req, adminResult);
  });

  // ============================================
  // ADMIN: DATABASE MANAGEMENT (Super Admin Only)
  // ============================================

  // Get current DB capacity status (uses the same logic as scheduled jobs)
  router.get('/admin/db/status', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;

    const adminResult = await adminMiddleware(req, env, authResult.userId);
    if (adminResult.error) return adminResult.error;

    // Reuse ScheduledJobsController capacity logic
    return await scheduled.checkDatabaseCapacity(req);
  });

  // Manually trigger a DB snapshot to R2
  router.post('/admin/db/snapshot', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;

    const adminResult = await adminMiddleware(req, env, authResult.userId);
    if (adminResult.error) return adminResult.error;

    return await scheduled.exportSnapshot(req);
  });

  // List available DB snapshots in R2
  router.get('/admin/db/snapshots', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;

    const adminResult = await adminMiddleware(req, env, authResult.userId);
    if (adminResult.error) return adminResult.error;

    return await scheduled.listSnapshots(req);
  });

  router.get('/admin/ads-analytics', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;

    const adminResult = await adminMiddleware(req, env, authResult.userId);
    if (adminResult.error) return adminResult.error;

    return await advertisements.getGlobalAnalytics(req, adminResult);
  });

  // Get supported geographic locations
  router.get('/admin/social-media/locations', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;

    const adminResult = await adminMiddleware(req, env, authResult.userId);
    if (adminResult.error) return adminResult.error;

    return await socialMediaImport.getSupportedLocations(req, adminResult);
  });

  // Get import/search history
  router.get('/admin/social-media/jobs', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;

    const adminResult = await adminMiddleware(req, env, authResult.userId);
    if (adminResult.error) return adminResult.error;

    return await socialMediaImport.getJobs(req, adminResult);
  });

  // ============================================
  // ADMIN: ARCHIVAL SYSTEM (Super Admin Only)
  // 3-tier database system with snapshots
  // ============================================

  // Get archival statistics and database usage
  router.get('/admin/archival/stats', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;

    const adminResult = await adminMiddleware(req, env, authResult.userId);
    if (adminResult.error) return adminResult.error;

    try {
      const { handleStatsRequest } = await import('./services/archivalScheduler.js');
      return await handleStatsRequest(env);
    } catch (error) {
      console.error('Archival stats error:', error);
      return errorResponse('Failed to fetch archival stats', 500);
    }
  });

  // Get data distribution across databases
  router.get('/admin/archival/distribution/:table', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;

    const adminResult = await adminMiddleware(req, env, authResult.userId);
    if (adminResult.error) return adminResult.error;

    // SECURITY: Validate table name to prevent SQL injection
    const tableName = req.params.table;
    if (!isValidTableName(tableName)) {
      return errorResponse('Invalid table name', 400);
    }

    try {
      const { MultiDbRouter } = await import('./services/multiDbRouter.js');
      const dbRouter = new MultiDbRouter(env.DB, env.DB2, env.DB3, env.STORAGE, env.SNAPSHOTS, env.CACHE);
      const distribution = await dbRouter.getDistribution(tableName);
      return new Response(JSON.stringify(distribution), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.error('Distribution error:', error);
      return errorResponse('Failed to fetch distribution data', 500);
    }
  });

  // Manually trigger archival process
  router.post('/admin/archival/run', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;

    const adminResult = await adminMiddleware(req, env, authResult.userId);
    if (adminResult.error) return adminResult.error;

    try {
      const { scheduleArchivalTask } = await import('./services/archivalScheduler.js');
      const result = await scheduleArchivalTask(env);
      return new Response(JSON.stringify(result), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.error('Archival error:', error);
      return errorResponse('Failed to run archival process', 500);
    }
  });

  // List available snapshots for a table
  router.get('/admin/archival/snapshots/:table', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;

    const adminResult = await adminMiddleware(req, env, authResult.userId);
    if (adminResult.error) return adminResult.error;

    // SECURITY: Validate table name to prevent SQL injection
    const tableName = req.params.table;
    if (!isValidTableName(tableName)) {
      return errorResponse('Invalid table name', 400);
    }

    try {
      const { ArchivalService } = await import('./services/archivalService.js');
      const archival = new ArchivalService(env.DB, env.DB2, env.DB3, env.STORAGE, env.SNAPSHOTS, env.CACHE);
      const snapshots = await archival.listSnapshots(tableName);
      return new Response(JSON.stringify({ table: tableName, snapshots }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.error('Snapshots error:', error);
      return errorResponse('Failed to list snapshots', 500);
    }
  });

  // Get snapshot details
  router.get('/admin/archival/snapshots/:table/:snapshotId', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;

    const adminResult = await adminMiddleware(req, env, authResult.userId);
    if (adminResult.error) return adminResult.error;

    // SECURITY: Validate table name to prevent path traversal
    const tableName = req.params.table;
    if (!isValidTableName(tableName)) {
      return errorResponse('Invalid table name', 400);
    }

    // Validate snapshotId format (should be a date like 2024-01-15.json)
    const {snapshotId} = req.params;
    if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(snapshotId)) {
      return errorResponse('Invalid snapshot ID format', 400);
    }

    try {
      const { ArchivalService } = await import('./services/archivalService.js');
      const archival = new ArchivalService(env.DB, env.DB2, env.DB3, env.STORAGE, env.SNAPSHOTS, env.CACHE);
      const snapshotKey = `snapshots/${tableName}/${snapshotId}`;
      const snapshot = await archival.loadSnapshot(snapshotKey);
      if (!snapshot) return errorResponse('Snapshot not found', 404);
      return new Response(JSON.stringify(snapshot), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.error('Snapshot error:', error);
      return errorResponse('Failed to load snapshot', 500);
    }
  });

  // Cleanup old snapshots
  router.post('/admin/archival/cleanup', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;

    const adminResult = await adminMiddleware(req, env, authResult.userId);
    if (adminResult.error) return adminResult.error;

    try {
      const { ArchivalService } = await import('./services/archivalService.js');
      const archival = new ArchivalService(env.DB, env.DB2, env.DB3, env.STORAGE, env.SNAPSHOTS, env.CACHE);
      const snapshots = await archival.listAllSnapshots();
      
      return new Response(JSON.stringify({ 
        snapshots,
        total_snapshots: snapshots.length,
        note: 'Snapshots are permanent archive - no auto-deletion' 
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.error('Snapshots list error:', error);
      return errorResponse('Failed to list all snapshots', 500);
    }
  });

  // ============================================
  // ADMIN: INCOMING EMAIL MANAGEMENT
  // ============================================

  // List all incoming emails (with pagination)
  router.get('/admin/emails/incoming', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;

    const adminResult = await adminMiddleware(req, env, authResult.userId);
    if (adminResult.error) return adminResult.error;

    try {
// SECURITY: Cap pagination to prevent DoS via massive queries
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

      const result = await env.DB.prepare(`
        SELECT * FROM incoming_emails 
        ORDER BY received_at DESC 
        LIMIT ? OFFSET ?
      `).bind(limit, offset).all();

      const countResult = await env.DB.prepare('SELECT COUNT(*) as count FROM incoming_emails').first();

      return new Response(JSON.stringify({
        emails: result.results || [],
        total: countResult?.count || 0,
        limit,
        offset
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.error('Failed to fetch incoming emails:', error);
      return errorResponse('Failed to fetch incoming emails', 500);
    }
  });

  // Get single incoming email
  router.get('/admin/emails/incoming/:emailId', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;

    const adminResult = await adminMiddleware(req, env, authResult.userId);
    if (adminResult.error) return adminResult.error;

    try {
      const result = await env.DB.prepare(`
        SELECT * FROM incoming_emails WHERE id = ?
      `).bind(req.params.emailId).first();

      if (!result) {
        return errorResponse('Email not found', 404);
      }

      return new Response(JSON.stringify(result), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.error('Failed to fetch email:', error);
      return errorResponse('Failed to fetch email', 500);
    }
  });

  // Filter incoming emails by sender
  router.get('/admin/emails/incoming/from/:fromAddress', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;

    const adminResult = await adminMiddleware(req, env, authResult.userId);
    if (adminResult.error) return adminResult.error;

    try {
      const result = await env.DB.prepare(`
        SELECT * FROM incoming_emails 
        WHERE from_address = ? 
        ORDER BY received_at DESC
      `).bind(req.params.fromAddress).all();

      return new Response(JSON.stringify({
        from: req.params.fromAddress,
        emails: result.results || [],
        count: result.results?.length || 0
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.error('Failed to filter emails:', error);
      return errorResponse('Failed to filter emails', 500);
    }
  });

  // Search incoming emails by subject
  router.get('/admin/emails/incoming/search/subject', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;

    const adminResult = await adminMiddleware(req, env, authResult.userId);
    if (adminResult.error) return adminResult.error;

    try {
      const query = req.query.q || '';
      if (!query) {
        return errorResponse('Search query required', 400);
      }

      const result = await env.DB.prepare(`
        SELECT * FROM incoming_emails 
        WHERE subject LIKE ? 
        ORDER BY received_at DESC
      `).bind(`%${query}%`).all();

      return new Response(JSON.stringify({
        query,
        emails: result.results || [],
        count: result.results?.length || 0
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.error('Email search failed:', error);
      return errorResponse('Search failed', 500);
    }
  });

  // Get email statistics
  router.get('/admin/emails/stats', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;

    const adminResult = await adminMiddleware(req, env, authResult.userId);
    if (adminResult.error) return adminResult.error;

    try {
      const totalResult = await env.DB.prepare('SELECT COUNT(*) as count FROM incoming_emails').first();
      const todayResult = await env.DB.prepare(`
        SELECT COUNT(*) as count FROM incoming_emails 
        WHERE DATE(received_at) = DATE('now')
      `).first();
      
      const topSendersResult = await env.DB.prepare(`
        SELECT from_address, COUNT(*) as count FROM incoming_emails 
        GROUP BY from_address 
        ORDER BY count DESC 
        LIMIT 10
      `).all();

      return new Response(JSON.stringify({
        total_emails: totalResult?.count || 0,
        today_emails: todayResult?.count || 0,
        top_senders: topSendersResult.results || []
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.error('Email stats failed:', error);
      return errorResponse('Failed to fetch stats', 500);
    }
  });

  // Delete incoming email
  router.delete('/admin/emails/incoming/:emailId', async (req) => {
    const authResult = await authMiddleware(req, env);
    if (authResult.error) return authResult.error;

    const adminResult = await adminMiddleware(req, env, authResult.userId);
    if (adminResult.error) return adminResult.error;

    try {
      await env.DB.prepare('DELETE FROM incoming_emails WHERE id = ?').bind(req.params.emailId).run();

      return new Response(JSON.stringify({
        success: true,
        message: 'Email deleted'
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.error('Email delete failed:', error);
      return errorResponse('Failed to delete email', 500);
    }
  });

  // ============================================
  // CRON/SCHEDULED JOBS (Protected, Internal only)
  // ============================================

  router.post('/cron/process-batches', protectInternalRoute(async (req) => {
    return await scheduled.processExpiredBatches(req);
  }, env));

  router.post('/cron/cleanup', protectInternalRoute(async (req) => {
    return await scheduled.cleanupOldData(req);
  }, env));

  router.post('/cron/update-trending', protectInternalRoute(async (req) => {
    return await scheduled.updateTrendingScores(req);
  }, env));

  router.post('/cron/export-snapshot', protectInternalRoute(async (req) => {
    return await scheduled.exportSnapshot(req);
  }, env));

  router.post('/cron/archival', protectInternalRoute(async (_req) => {
    try {
      const { scheduleArchivalTask } = await import('./services/archivalScheduler.js');
      const result = await scheduleArchivalTask(env);
      return new Response(JSON.stringify(result), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }
  }, env));

  // 404 handler
  router.all('*', () => errorResponse('Route not found', 404));

  return router;
}
