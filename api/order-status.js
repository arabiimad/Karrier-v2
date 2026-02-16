let kvStore;
try {
  kvStore = require('@vercel/kv').kv;
} catch (e) {
  kvStore = { get: async () => null };
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { session_id } = req.query;
  if (!session_id) {
    return res.status(400).json({ error: 'Missing session_id' });
  }

  try {
    const data = await kvStore.get(`order:${session_id}`);
    if (!data) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = typeof data === 'string' ? JSON.parse(data) : data;

    // Return public fields only — no credentials
    res.status(200).json({
      status: order.status,
      plan: order.plan,
      audience: order.audience,
      amount: order.amount,
      currency: order.currency,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt
    });
  } catch (error) {
    console.error('Order status error:', error.message);
    res.status(500).json({ error: 'Internal error' });
  }
};
