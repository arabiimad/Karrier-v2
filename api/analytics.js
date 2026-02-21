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
    const { period = '30' } = req.query;
    const days = parseInt(period, 10);

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);

    const allOrders = await kvStore.getAllOrders(order => {
      return new Date(order.createdAt) >= cutoffDate;
    });

    const analytics = {
      period: `${days} days`,
      revenue: {
        total: 0,
        byPlan: {},
        byAudience: {},
        daily: []
      },
      orders: {
        total: 0,
        byStatus: {},
        byPlan: {},
        byAudience: {},
        byLanguage: {}
      },
      conversion: {
        averageOrderValue: 0,
        completionRate: 0
      },
      timeline: []
    };

    const dailyData = {};

    for (const order of allOrders) {
      analytics.orders.total++;
      analytics.revenue.total += order.amount || 0;

      analytics.orders.byStatus[order.status] = (analytics.orders.byStatus[order.status] || 0) + 1;
      analytics.orders.byPlan[order.plan] = (analytics.orders.byPlan[order.plan] || 0) + 1;
      analytics.orders.byAudience[order.audience] = (analytics.orders.byAudience[order.audience] || 0) + 1;
      analytics.orders.byLanguage[order.language || 'fr'] = (analytics.orders.byLanguage[order.language || 'fr'] || 0) + 1;

      analytics.revenue.byPlan[order.plan] = (analytics.revenue.byPlan[order.plan] || 0) + (order.amount || 0);
      analytics.revenue.byAudience[order.audience] = (analytics.revenue.byAudience[order.audience] || 0) + (order.amount || 0);

      const dateKey = new Date(order.createdAt).toISOString().split('T')[0];
      if (!dailyData[dateKey]) {
        dailyData[dateKey] = { date: dateKey, revenue: 0, orders: 0 };
      }
      dailyData[dateKey].revenue += order.amount || 0;
      dailyData[dateKey].orders++;
    }

    analytics.revenue.daily = Object.values(dailyData).sort((a, b) => a.date.localeCompare(b.date));
    analytics.timeline = analytics.revenue.daily;

    if (analytics.orders.total > 0) {
      analytics.conversion.averageOrderValue = analytics.revenue.total / analytics.orders.total;
      const doneOrders = analytics.orders.byStatus['done'] || 0;
      analytics.conversion.completionRate = (doneOrders / analytics.orders.total) * 100;
    }

    const topPlans = Object.entries(analytics.revenue.byPlan)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([plan, revenue]) => ({ plan, revenue, orders: analytics.orders.byPlan[plan] }));

    analytics.topPlans = topPlans;

    res.status(200).json(analytics);

  } catch (error) {
    console.error('Analytics error:', error.message);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
};
