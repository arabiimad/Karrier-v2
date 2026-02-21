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
    const { limit = '50' } = req.query;
    const limitNum = Math.min(parseInt(limit, 10) || 50, 200);

    const logData = await kvStore.get('audit:log');
    const logs = logData ? (typeof logData === 'string' ? JSON.parse(logData) : logData) : [];

    res.status(200).json({
      logs: logs.slice(0, limitNum),
      total: logs.length
    });
  } catch (error) {
    console.error('Audit log error:', error.message);
    res.status(500).json({ error: 'Failed to fetch audit log' });
  }
};
