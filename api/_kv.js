// Shared KV store — uses Vercel KV in production, in-memory fallback for dev
let kvStore;

if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
  try {
    kvStore = require('@vercel/kv').kv;
  } catch (e) {
    kvStore = null;
  }
}

if (!kvStore) {
  // File-based store for local development (persists between vercel dev processes)
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
