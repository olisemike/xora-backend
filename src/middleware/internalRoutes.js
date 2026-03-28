/**
 * Middleware to protect internal/scheduled routes
 * 
 * These routes should only be accessible from:
 * 1. Cloudflare Scheduled Events (by checking scheduled event headers)
 * 2. Internal services with INTERNAL_TOKEN
 * 3. Whitelisted IPs (optional)
 */

export async function internalRouteMiddleware(req, env) {
  // Check 1: Cloudflare Scheduled Event
  // Scheduled events add specific headers/context
  const scheduledHeader = req.headers.get('CF-Scheduled');
  if (scheduledHeader === 'true' || req.cf?.colo) {
    // This is a scheduled event from Cloudflare
    return null; // Allow
  }

  // Check 2: Internal Service Token (from env or header)
  const internalToken = req.headers.get('X-Internal-Token');
  const expectedToken = env.INTERNAL_TOKEN || env.BACKEND_INTERNAL_TOKEN;
  
  if (internalToken && expectedToken && internalToken === expectedToken) {
    return null; // Allow
  }

  // Check 3: Request from Cloudflare Email Routing service (specific case)
  if (req.url.includes('/webhooks/email/incoming')) {
    const emailVerification = req.headers.get('X-Email-Verification-Token');
    const expectedEmailToken = env.EMAIL_WEBHOOK_TOKEN || env.CLOUDFLARE_EMAIL_TOKEN;
    
    if (emailVerification && expectedEmailToken && emailVerification === expectedEmailToken) {
      return null; // Allow
    }
  }

  // Check 4: IP Whitelist (if configured)
  const clientIp = req.headers.get('CF-Connecting-IP') || req.headers.get('X-Forwarded-For');
  if (env.INTERNAL_IP_WHITELIST && clientIp) {
    const whitelisted = env.INTERNAL_IP_WHITELIST.split(',').map(ip => ip.trim());
    if (whitelisted.includes(clientIp)) {
      return null; // Allow
    }
  }

  // All checks failed - deny access
  console.error('[Security] Unauthorized access to internal route', {
    route: req.url,
    method: req.method,
    ip: clientIp,
    hasInternalToken: !!internalToken,
    timestamp: new Date().toISOString()
  });

  return new Response(
    JSON.stringify({
      error: 'Unauthorized',
      message: 'This endpoint is for internal use only'
    }),
    {
      status: 403,
      headers: { 'Content-Type': 'application/json' }
    }
  );
}

/**
 * Apply internal route protection to a route handler
 */
export function protectInternalRoute(handler, env) {
  return async (req, ...args) => {
    const protection = await internalRouteMiddleware(req, env);
    if (protection) return protection;
    return handler(req, ...args);
  };
}
