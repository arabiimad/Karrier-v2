require('./_env');
const { verifyAuth } = require('./_auth');
const kvStore = require('./_kv');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    verifyAuth(req);
  } catch (e) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const allOrders = await kvStore.getAllOrders();
    const today = new Date().toISOString().split('T')[0];

    let totalRevenue = 0;
    let pendingCount = 0;
    let activatingCount = 0;
    let doneCount = 0;
    let todayOrders = 0;
    let todayRevenue = 0;

    for (const order of allOrders) {
      totalRevenue += order.amount || 0;

      if (order.status === 'pending') pendingCount++;
      else if (order.status === 'activating') activatingCount++;
      else if (order.status === 'done') doneCount++;

      if (order.createdAt && order.createdAt.startsWith(today)) {
        todayOrders++;
        todayRevenue += order.amount || 0;
      }
    }

    const totalOrders = allOrders.length;

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
