/**
 * Email Handler Worker
 * Receives incoming emails from Cloudflare Email Routing
 * Forwards to main API for processing
 */

import { logger } from '../utils/logger.js';

export default {
  async fetch(request, _env) {
    // Only accept POST requests
    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    try {
      const email = await request.json();

      // Log incoming email
      logger.info('Email received', { from: email.from, to: email.to });

      // Validate email structure
      if (!email.from || !email.to) {
        return new Response(JSON.stringify({ error: 'Invalid email format' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Forward to main API for processing and storage
      const response = await fetch('https://xora-workers-api-production.xorasocial.workers.dev/webhooks/email/incoming', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'xora-email-handler/1.0'
        },
        body: JSON.stringify({
          from_address: email.from,
          to_address: email.to,
          subject: email.subject || '(No subject)',
          text_body: email.text || '',
          html_body: email.html || '',
          timestamp: Math.floor(Date.now() / 1000)
        })
      });

      const result = await response.json();

      if (!response.ok) {
        console.error('API error:', result);
        return new Response(JSON.stringify({ error: 'Failed to process email' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      logger.info('Email processed successfully', { emailId: result.emailId });

      return new Response(JSON.stringify({
        success: true,
        emailId: result.emailId,
        message: 'Email received and queued for processing'
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      logger.error('Email handler error', error);
      return new Response(JSON.stringify({
        success: false,
        error: error.message || 'Internal server error'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
};
