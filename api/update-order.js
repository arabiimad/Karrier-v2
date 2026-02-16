const jwt = require('jsonwebtoken');

let kvStore;
try {
  kvStore = require('@vercel/kv').kv;
} catch (e) {
  kvStore = { get: async () => null, set: async () => {} };
}

function verifyAuth(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    throw new Error('Unauthorized');
  }
  return jwt.verify(auth.substring(7), process.env.JWT_SECRET);
}

const VALID_STATUSES = ['pending', 'activating', 'done', 'refunded'];

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'PATCH') return res.status(405).json({ error: 'Method not allowed' });

  try {
    verifyAuth(req);
  } catch (e) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { session_id, status } = req.body;

    if (!session_id || !status) {
      return res.status(400).json({ error: 'Missing session_id or status' });
    }
    if (!VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Must be: ${VALID_STATUSES.join(', ')}` });
    }

    const data = await kvStore.get(`order:${session_id}`);
    if (!data) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = typeof data === 'string' ? JSON.parse(data) : data;
    order.status = status;
    order.updatedAt = new Date().toISOString();

    await kvStore.set(`order:${session_id}`, JSON.stringify(order));

    res.status(200).json({ success: true, order });

  } catch (error) {
    console.error('Update order error:', error.message);
    res.status(500).json({ error: 'Failed to update order' });
  }
};
