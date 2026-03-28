# Xora Backend Stress Testing

This directory contains comprehensive stress testing tools for the Xora social media backend.

## ⚠️ Important Warning

**1 Million concurrent users is EXTREMELY high for a Cloudflare Workers setup!**

- Cloudflare Workers typically handle 100-1000 requests/second per zone
- D1 Database has strict rate limits (typically 1000 writes/second, 10000 reads/second)
- R2 storage has bandwidth and request limits
- Your actual capacity will depend on your Cloudflare plan and configuration

**Realistic expectations:**
- Free plan: ~100-500 req/sec
- Paid plans: 1000-5000+ req/sec
- Enterprise: 10000+ req/sec

## 🚀 Quick Start

### 1. Start the Backend

```bash
npm run dev
```

### 2. Run Basic Load Test

```bash
set AUTH_TOKEN=your_access_token_here
npm run stress-test:load
```

### 3. Run Extreme Stress Test

```bash
set AUTH_TOKEN=your_access_token_here
npm run stress-test:extreme
```

### 4. Monitor System Resources

```bash
npm run stress-test:monitor
```

## 📊 Test Scenarios

### Load Test (`load-test.yml`)
- **Duration**: 17 minutes total
- **Phases**:
  - Warm up: 5 req/sec for 2 minutes
  - Ramp: 15 → 30 req/sec for 5 minutes
  - Sustained: 30 req/sec for 10 minutes
- **Scenarios**:
  - Core authenticated reads (45%)
  - Discovery feeds (35%)
  - Health probes (20%)

### Stress Test (`stress-test.yml`)
- **Duration**: 13 minutes total
- **Phases**:
  - Warm up: 25 req/sec for 1 minute
  - Ramp: 50 → 100 req/sec for 3 minutes
  - Sustained high: 100 req/sec for 5 minutes
  - Peak burst: 150 req/sec for 2 minutes
  - Recovery: 80 req/sec for 2 minutes
- **Scenarios**:
  - Read-heavy workload (70%) - feed, search, bookmarks, notifications, conversations
  - Discovery workload (20%) - reels, stories, suggested users, ads
  - Health probes (10%) - live/readiness checks

## 🛠️ Manual Testing

### Using Artillery Directly

```bash
# Install artillery globally (optional)
npm install -g artillery

# Run basic load test
artillery run load-test.yml

# Run with custom configuration
artillery run stress-test.yml --overrides '{"config": {"phases": [{"duration": 60, "arrivalRate": 10}]}}'

# Run with custom target
artillery run load-test.yml --target https://your-production-url.com
```

### Custom Test Configuration

Create your own test file:

```yaml
config:
  target: 'http://localhost:8787'
  phases:
    - duration: 60
      arrivalRate: 10
scenarios:
  - name: "Custom test"
    flow:
      - get:
          url: "/health"
```

## 📈 Monitoring & Metrics

### System Resource Monitoring

The `monitor-stress-test.js` script tracks:
- CPU usage (user + system time)
- Memory usage (RSS, heap used/total)
- Backend response times
- System memory usage

### Artillery Metrics

Artillery provides:
- Requests per second
- Response time percentiles (p50, p95, p99)
- Error rates
- Custom metrics via processors

### Key Performance Indicators

- **Response Time**: < 500ms for good UX
- **Error Rate**: < 1% acceptable
- **CPU Usage**: < 80% system capacity
- **Memory Usage**: < 90% available RAM

## 🔧 Configuration

### Environment Variables

Set these for production testing:

```bash
export ARTILLERY_DISABLE_TELEMETRY=1
export NODE_ENV=production
```

### Database Considerations

For high-load testing:
1. Use a separate test database
2. Pre-populate with test data
3. Monitor D1 usage in Cloudflare dashboard
4. Consider rate limiting during tests

### Scaling Considerations

1. **Vertical Scaling**: Increase Cloudflare Workers limits
2. **Horizontal Scaling**: Use multiple zones
3. **Caching**: Implement aggressive caching
4. **Database**: Consider read replicas
5. **CDN**: Use Cloudflare CDN for static assets

## 📋 Test Results Interpretation

### Success Criteria

✅ **Good Performance:**
- p95 response time < 1000ms
- Error rate < 1%
- Consistent throughput

⚠️ **Warning Signs:**
- Increasing response times
- Growing error rates
- Memory leaks

❌ **Critical Issues:**
- 5xx errors > 5%
- Response times > 5000ms
- System crashes

### Common Issues

1. **Rate Limiting**: Cloudflare/D1 limits hit
2. **Memory Leaks**: Monitor heap growth
3. **Database Contention**: Too many concurrent writes
4. **Network Issues**: Connection pooling problems

## 🐛 Troubleshooting

### Backend Not Starting

```bash
# Check if port 8787 is available
netstat -an | findstr :8787

# Kill process using port
# Windows: taskkill /PID <pid> /F
# Linux/Mac: kill -9 <pid>
```

### Artillery Issues

```bash
# Clear artillery cache
rm -rf ~/.artillery

# Update artillery
npm update -g artillery

# Debug mode
DEBUG=artillery:* artillery run load-test.yml
```

### High Error Rates

1. Check backend logs
2. Monitor database connections
3. Verify authentication tokens
4. Check rate limits

## 📝 Best Practices

1. **Start Small**: Begin with low load and gradually increase
2. **Monitor Always**: Use monitoring tools during tests
3. **Test Incrementally**: Fix issues before scaling up
4. **Use Realistic Data**: Test with production-like data
5. **Document Results**: Keep records of performance baselines

## 🔒 Security Testing

For security stress testing, consider:
- Authentication brute force protection
- Rate limiting effectiveness
- Input validation under load
- SQL injection prevention
- XSS protection

## 📞 Support

If you encounter issues:
1. Check the Artillery documentation: https://artillery.io/docs/
2. Review Cloudflare Workers limits: https://developers.cloudflare.com/workers/platform/limits/
3. Monitor your Cloudflare dashboard for usage metrics

---

**Remember**: Stress testing can impact your production environment. Always test in isolated environments first!