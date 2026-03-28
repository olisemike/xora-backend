/**
 * Sharding Utility for Durable Objects
 * Provides consistent hashing for distributing load across multiple DO instances
 */

/**
 * Simple hash function for consistent sharding
 * @param {string} key - Value to hash (userId, conversationId, etc.)
 * @returns {number} Hash value
 */
function hashKey(key) {
  if (!key) return 0;
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = ((hash << 5) - hash) + key.charCodeAt(i);
    hash |= 0; // Convert to 32-bit integer
  }
  return Math.abs(hash);
}

/**
 * Get shard ID for a given key using consistent hashing
 * @param {string} key - Value to shard (userId, conversationId, etc.)
 * @param {number} shardCount - Total number of shards
 * @returns {number} Shard ID (0 to shardCount-1)
 */
export function getShardId(key, shardCount = 16) {
  return hashKey(key) % shardCount;
}

/**
 * Get shard name for Durable Object idFromName
 * @param {string} prefix - Prefix for shard name (e.g., 'notify', 'chat')
 * @param {string} key - Value to shard
 * @param {number} shardCount - Total number of shards
 * @returns {string} Shard name (e.g., 'notify-0', 'notify-1', etc.)
 */
export function getShardName(prefix, key, shardCount = 16) {
  const shardId = getShardId(key, shardCount);
  return `${prefix}-${shardId}`;
}

/**
 * Get Durable Object stub for a sharded resource
 * @param {Object} doBinding - Durable Object binding from env
 * @param {string} prefix - Prefix for shard name
 * @param {string} key - Value to shard (userId, conversationId, etc.)
 * @param {number} shardCount - Total number of shards (default 16)
 * @returns {Object} Durable Object stub
 */
export function getShardedStub(doBinding, prefix, key, shardCount = 16) {
  if (!doBinding) {
    throw new Error(`Durable Object binding for ${prefix} not configured`);
  }

  const shardName = getShardName(prefix, key, shardCount);
  const id = doBinding.idFromName(shardName);
  return doBinding.get(id);
}

/**
 * Get all shards for a DO binding (useful for broadcast operations)
 * @param {Object} doBinding - Durable Object binding from env
 * @param {string} prefix - Prefix for shard name
 * @param {number} shardCount - Total number of shards (default 16)
 * @returns {Object[]} Array of Durable Object stubs
 */
export function getAllShards(doBinding, prefix, shardCount = 16) {
  if (!doBinding) {
    throw new Error(`Durable Object binding for ${prefix} not configured`);
  }

  const stubs = [];
  for (let i = 0; i < shardCount; i += 1) {
    const shardName = `${prefix}-${i}`;
    const id = doBinding.idFromName(shardName);
    stubs.push(doBinding.get(id));
  }
  return stubs;
}

export default {
  hashKey,
  getShardId,
  getShardName,
  getShardedStub,
  getAllShards
};
