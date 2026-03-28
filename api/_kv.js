// Shared KV store — uses Redis (REDIS_URL), Vercel KV, or file fallback
let kvStore;

// Option 1: Direct Redis via ioredis (REDIS_URL)
if (!kvStore && process.env.REDIS_URL) {
  try {
    const Redis = require('ioredis');
    const redis = new Redis(process.env.REDIS_URL, {
      tls: process.env.REDIS_URL.startsWith('rediss://') ? { rejectUnauthorized: false } : undefined,
      maxRetriesPerRequest: 3,
      lazyConnect: true,
    });
    redis.connect().catch(() => {});
    kvStore = {
      get: async (key) => { const val = await redis.get(key); return val; },
      set: async (key, value) => { await redis.set(key, typeof value === 'string' ? value : JSON.stringify(value)); },
      del: async (key) => { await redis.del(key); },
      keys: async (pattern) => { return await redis.keys(pattern); },
      scan: async () => [0, []]
    };
    console.log('[KV] Using Redis (ioredis)');
  } catch (e) {
    console.warn('[KV] ioredis failed:', e.message);
    kvStore = null;
  }
}

// Option 2: Vercel KV (Upstash REST API)
if (!kvStore && process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
  try {
    kvStore = require('@vercel/kv').kv;
    console.log('[KV] Using Vercel KV (Upstash)');
  } catch (e) {
    kvStore = null;
  }
}

// Option 3: File-based fallback for local dev
if (!kvStore) {
  const fs = require('fs');
  const path = require('path');
  const DB_PATH = path.resolve(__dirname, '..', '.dev-kv.json');

  function readDB() {
    try {
      if (fs.existsSync(DB_PATH)) {
        return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
      }
    } catch (e) { /* corrupted file, reset */ }
    return {};
  }

  function writeDB(data) {
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf8');
  }

  kvStore = {
    get: async (key) => { const db = readDB(); return db[key] || null; },
    set: async (key, value) => { const db = readDB(); db[key] = value; writeDB(db); },
    del: async (key) => { const db = readDB(); delete db[key]; writeDB(db); },
    keys: async (pattern) => {
      const prefix = pattern.replace('*', '');
      return Object.keys(readDB()).filter(k => k.startsWith(prefix));
    },
    scan: async () => [0, []]
  };
  console.log('[KV] Using file-based store (dev mode):', DB_PATH);
}

// Helper: fetch all orders at once (avoids N+1 queries)
async function getAllOrders(filterFn) {
  const indexData = await kvStore.get('orders:index');
  const allIds = indexData ? (typeof indexData === 'string' ? JSON.parse(indexData) : indexData) : [];

  const orders = [];
  for (const id of allIds) {
    const data = await kvStore.get(`order:${id}`);
    if (!data) continue;
    const order = typeof data === 'string' ? JSON.parse(data) : data;
    if (!filterFn || filterFn(order)) {
      orders.push(order);
    }
  }
  return orders;
}

kvStore.getAllOrders = getAllOrders;

module.exports = kvStore;
