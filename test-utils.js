// Artillery processor for Xora backend stress testing
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// Pre-generated tokens for performance (in real scenario, use proper auth)
const testTokens = [
  'eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOiJ1X21sNXFjM2MzMWYybDRhNmg2c2gzciIsImVtYWlsIjoic2xvYW5lbW9yZ2FuMTk5OEBnbWFpbC5jb20iLCJ0eXBlIjoiYWNjZXNzIiwidG9rZW5WZXJzaW9uIjowLCJpYXQiOjE3NzA0MTU5MzQsImV4cCI6MTc3MDQxNjgzNCwic3ViIjoidV9tbDVxYzNjMzFmMmw0YTZoNnNoM3IifQ.2A9Kf8gVHPgxpXiZvVD5fndCX2xa0RlJKiM9wHf4DwY'
];

module.exports = {
  generateAuthToken: function(requestParams, context, ee, next) {
    // Initialize vars if not exists
    context.vars = context.vars || {};
    // Use a pre-generated token for performance
    context.vars.authToken = testTokens[Math.floor(Math.random() * testTokens.length)];
    return next();
  },

  generateRandomUserId: function(requestParams, context, ee, next) {
    context.vars.userId = Math.floor(Math.random() * 1000) + 1;
    return next();
  },

  generateRandomPostId: function(requestParams, context, ee, next) {
    context.vars.postId = Math.floor(Math.random() * 10000) + 1;
    return next();
  },

  logResponseTime: function(requestParams, response, context, ee, next) {
    if (response.timings) {
      console.log(`Response time: ${response.timings.phases.total}ms`);
    }
    return next();
  },

  checkRateLimit: function(requestParams, response, context, ee, next) {
    if (response.statusCode === 429) {
      console.log('Rate limit hit!');
    }
    return next();
  }
};