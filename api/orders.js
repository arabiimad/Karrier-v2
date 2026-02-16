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
    const { status, page = '1', limit = '50' } = req.query;
    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);

    // Get order index
    const indexData = await kvStore.get('orders:index');
    const allIds = indexData ? (typeof indexData === 'string' ? JSON.parse(indexData) : indexData) : [];

    // Fetch all orders
    const orders = [];
    for (const id of allIds) {
      const data = await kvStore.get(`order:${id}`);
      if (data) {
        const order = typeof data === 'string' ? JSON.parse(data) : data;
        if (!status || order.status === status) {
          orders.push(order);
        }
      }
    }

    // Paginate
    const start = (pageNum - 1) * limitNum;
    const paginated = orders.slice(start, start + limitNum);

    res.status(200).json({
      orders: paginated,
      total: orders.length,
      page: pageNum,
      totalPages: Math.ceil(orders.length / limitNum)
    });

  } catch (error) {
    console.error('Orders error:', error.message);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
};
