require('./_env');
const { verifyAuth } = require('./_auth');
const kvStore = require('./_kv');
const { countsAsRevenue, isPaymentDue, QUEUES } = require('./_payment');
const { listAmbassadors } = require('./_ambassadors');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    verifyAuth(req);
  } catch (e) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { type = 'analytics', period = '30' } = req.query;

    // Route simple stats (anciennement /api/stats)
    if (type === 'stats') {
      const allOrders = await kvStore.getAllOrders();
      const today = new Date().toISOString().split('T')[0];

      // Revenue only counts money received and kept (paid, not refunded).
      let totalRevenue = 0;
      let dueAmount = 0;
      let dueCount = 0;
      let pendingCount = 0;
      let activatingCount = 0;
      let doneCount = 0;
      let todayOrders = 0;
      let todayRevenue = 0;
      const queues = { to_link: 0, waiting_credentials: 0, to_activate: 0, to_collect: 0, student_check: 0 };
      // Time from credentials received to activation, last 30 days.
      const since = Date.now() - 30 * 24 * 60 * 60 * 1000;
      let activationMinutes = 0;
      let activationSamples = 0;
      let lateCount = 0;

      for (const order of allOrders) {
        if (countsAsRevenue(order)) {
          totalRevenue += order.amount || 0;
          const paidDay = order.paidAt || order.createdAt || '';
          if (paidDay.startsWith(today)) todayRevenue += order.amount || 0;
        }
        if (isPaymentDue(order)) {
          dueAmount += order.amount || 0;
          dueCount++;
        }
        Object.keys(queues).forEach(name => { if (QUEUES[name](order)) queues[name]++; });

        const credsAt = order.credentialsSubmittedAt ? Date.parse(order.credentialsSubmittedAt) : NaN;
        const activatedAt = order.activatedAt ? Date.parse(order.activatedAt) : NaN;
        if (activatedAt >= credsAt && activatedAt >= since) {
          activationMinutes += (activatedAt - credsAt) / 60000;
          activationSamples++;
        }
        if (QUEUES.to_activate(order) && Date.now() - credsAt > 30 * 60000) lateCount++;

        if (['pending', 'pending_payment', 'awaiting_credentials'].includes(order.status)) pendingCount++;
        else if (order.status === 'activating') activatingCount++;
        else if (order.status === 'done') doneCount++;

        if (order.createdAt && order.createdAt.startsWith(today)) todayOrders++;
      }

      const totalOrders = allOrders.length;

      return res.status(200).json({
        totalRevenue,
        dueAmount,
        dueCount,
        totalOrders,
        pendingCount,
        activatingCount,
        doneCount,
        todayOrders,
        todayRevenue,
        queues,
        avgActivationMinutes: activationSamples ? Math.round(activationMinutes / activationSamples) : null,
        activationSamples,
        lateCount,
        ambassadorApplications: await countPendingAmbassadors()
      });
    }

    // Route analytics détaillées (par défaut)
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
        due: 0,
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
      const revenue = countsAsRevenue(order) ? (order.amount || 0) : 0;
      analytics.revenue.total += revenue;
      if (isPaymentDue(order)) analytics.revenue.due += order.amount || 0;

      analytics.orders.byStatus[order.status] = (analytics.orders.byStatus[order.status] || 0) + 1;
      analytics.orders.byPlan[order.plan] = (analytics.orders.byPlan[order.plan] || 0) + 1;
      analytics.orders.byAudience[order.audience] = (analytics.orders.byAudience[order.audience] || 0) + 1;
      analytics.orders.byLanguage[order.language || 'fr'] = (analytics.orders.byLanguage[order.language || 'fr'] || 0) + 1;

      analytics.revenue.byPlan[order.plan] = (analytics.revenue.byPlan[order.plan] || 0) + revenue;
      analytics.revenue.byAudience[order.audience] = (analytics.revenue.byAudience[order.audience] || 0) + revenue;

      const dateKey = new Date(order.createdAt).toISOString().split('T')[0];
      if (!dailyData[dateKey]) {
        dailyData[dateKey] = { date: dateKey, revenue: 0, orders: 0 };
      }
      dailyData[dateKey].revenue += revenue;
      dailyData[dateKey].orders++;
    }

    analytics.revenue.daily = Object.values(dailyData).sort((a, b) => a.date.localeCompare(b.date));
    analytics.timeline = analytics.revenue.daily;

    if (analytics.orders.total > 0) {
      const paidOrders = allOrders.filter(countsAsRevenue).length;
      analytics.conversion.averageOrderValue = paidOrders ? analytics.revenue.total / paidOrders : 0;
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

// Ambassador applications waiting for the team.
async function countPendingAmbassadors() {
  try {
    const accounts = await listAmbassadors();
    return accounts.filter(a => a.status === 'pending').length;
  } catch (e) {
    return 0;
  }
}
