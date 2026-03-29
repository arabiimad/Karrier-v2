require('./_env');
const { verifyAuth } = require('./_auth');
const kvStore = require('./_kv');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'DELETE') return res.status(405).json({ error: 'Method not allowed' });

  try {
    verifyAuth(req);
  } catch (e) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { session_id } = req.query;

    if (!session_id) {
      return res.status(400).json({ error: 'Missing session_id' });
    }

    // Check if order exists
    const data = await kvStore.get(`order:${session_id}`);
    if (!data) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Delete order from KV
    await kvStore.del(`order:${session_id}`);

    // Remove from index
    const indexData = await kvStore.get('orders:index');
    if (indexData) {
      const allIds = typeof indexData === 'string' ? JSON.parse(indexData) : indexData;
      const updatedIds = allIds.filter(id => id !== session_id);
      await kvStore.set('orders:index', JSON.stringify(updatedIds));
    }

    // Log action
    await logAction(kvStore, {
      action: 'order_deleted',
      sessionId: session_id,
      timestamp: new Date().toISOString()
    });

    console.log(`[Order] Deleted: ${session_id}`);
    res.status(200).json({ success: true, message: 'Order deleted successfully' });

  } catch (error) {
    console.error('Delete order error:', error.message);
    res.status(500).json({ error: 'Failed to delete order' });
  }
};

async function logAction(kv, entry) {
  try {
    const logData = await kv.get('audit:log');
    const logs = logData ? (typeof logData === 'string' ? JSON.parse(logData) : logData) : [];
    logs.unshift(entry);
    if (logs.length > 500) logs.length = 500;
    await kv.set('audit:log', JSON.stringify(logs));
  } catch (e) {
    console.error('Audit log error:', e.message);
  }
}
