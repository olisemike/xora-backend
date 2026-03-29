# Xora Backend

Cloudflare Workers backend for the Xora social platform.

## Overview

This service powers the server-side side of Xora Social: authentication, feed APIs, posts, comments, reels, messaging, pages, notifications, media workflows, and supporting security middleware.

## Highlights

- auth, sessions, device verification, and 2FA support
- posts, comments, stories, reels, shares, pages, and messaging APIs
- push notifications and real-time notification hooks
- Cloudflare media integration for image/video workflows
- rate limiting, RBAC, internal route protection, and CSRF/security middleware
- D1, KV, R2, and Durable Object-backed infrastructure through Wrangler

## Stack

- Cloudflare Workers
- D1 / KV / R2 / Durable Objects
- JavaScript (ES modules)
- Wrangler

## Local Development

```bash
npm install
npm run dev
```

Main entry point:
- `src/index.js`

Important config files:
- `wrangler.toml`
- `.env.example`
- `.dev.vars.example`

## Structure

- `src/controllers/` - route handlers and business logic
- `src/services/` - integrations, database utilities, feed logic, notifications, auth helpers
- `src/middleware/` - security, RBAC, validation, rate limiting
- `src/durable-objects/` - real-time and shared-state workers
- `migrations/` - schema evolution for the backend data layer

## Security

Do not commit real secrets. Use Wrangler secrets or local `.dev.vars` for:

- JWT secret
- encryption keys
- email provider keys
- SMS provider keys
- Cloudflare media tokens
- internal route tokens

## Repo Scope

This repository is the standalone backend/API service for Xora.
