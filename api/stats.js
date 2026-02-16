const jwt = require('jsonwebtoken');

let kvStore;
try {
  kvStore = require('@vercel/kv').kv;
} catch (e) {
  kvStore = { get: async () => null };
}

function verifyAuth(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    throw new Error('Unauthorized');
  }
  return jwt.verify(auth.substring(7), process.env.JWT_SECRET);
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    verifyAuth(req);
  } catch (e) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const indexData = await kvStore.get('orders:index');
    const allIds = indexData ? (typeof indexData === 'string' ? JSON.parse(indexData) : indexData) : [];

    let totalRevenue = 0;
    let totalOrders = 0;
    let pendingCount = 0;
    let activatingCount = 0;
    let doneCount = 0;
    let todayOrders = 0;
    let todayRevenue = 0;

    const today = new Date().toISOString().split('T')[0];

    for (const id of allIds) {
      const data = await kvStore.get(`order:${id}`);
      if (!data) continue;
      const order = typeof data === 'string' ? JSON.parse(data) : data;

      totalOrders++;
      totalRevenue += order.amount || 0;

      if (order.status === 'pending') pendingCount++;
      else if (order.status === 'activating') activatingCount++;
      else if (order.status === 'done') doneCount++;

      if (order.createdAt && order.createdAt.startsWith(today)) {
        todayOrders++;
        todayRevenue += order.amount || 0;
      }
    }

    res.status(200).json({
      totalRevenue,
      totalOrders,
      pendingCount,
      activatingCount,
      doneCount,
      todayOrders,
      todayRevenue
    });

  } catch (error) {
    console.error('Stats error:', error.message);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
};
