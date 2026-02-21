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
    const { format = 'csv', status } = req.query;

    const orders = await kvStore.getAllOrders(order => {
      return !status || order.status === status;
    });

    if (format === 'csv') {
      const csv = generateCSV(orders);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="karrier-orders-${new Date().toISOString().split('T')[0]}.csv"`);
      res.status(200).send(csv);
    } else {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="karrier-orders-${new Date().toISOString().split('T')[0]}.json"`);
      res.status(200).json(orders);
    }

  } catch (error) {
    console.error('Export error:', error.message);
    res.status(500).json({ error: 'Failed to export orders' });
  }
};

function generateCSV(orders) {
  const headers = [
    'Session ID',
    'Date',
    'Plan',
    'Audience',
    'Amount',
    'Currency',
    'Status',
    'Customer Email',
    'LinkedIn Email',
    'Language',
    'Updated At'
  ];

  const rows = orders.map(order => [
    order.sessionId || '',
    order.createdAt || '',
    order.plan || '',
    order.audience || '',
    order.amount || 0,
    order.currency || 'eur',
    order.status || '',
    order.customerEmail || '',
    order.linkedinEmail || '',
    order.language || 'fr',
    order.updatedAt || ''
  ]);

  const csvContent = [
    headers.join(','),
    ...rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
  ].join('\n');

  return csvContent;
}
