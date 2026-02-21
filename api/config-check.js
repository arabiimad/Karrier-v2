require('./_env');
const { verifyAuth } = require('./_auth');
const kvStore = require('./_kv');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { action } = req.query;

  // Public health check (no auth required)
  if (action === 'health') {
    const checks = { status: 'ok', timestamp: new Date().toISOString(), services: {} };
    try { await kvStore.get('health:ping'); checks.services.kv = 'ok'; } catch (e) { checks.services.kv = 'error'; checks.status = 'degraded'; }
    checks.services.stripe = process.env.STRIPE_SECRET_KEY ? 'configured' : 'missing';
    if (!process.env.STRIPE_SECRET_KEY) checks.status = 'degraded';
    checks.services.email = process.env.RESEND_API_KEY ? 'configured' : 'missing';
    checks.services.telegram = (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) ? 'configured' : 'missing';
    return res.status(checks.status === 'ok' ? 200 : 503).json(checks);
  }

  // All other actions require auth
  try { verifyAuth(req); } catch (e) { return res.status(401).json({ error: 'Unauthorized' }); }

  // Audit log
  if (action === 'audit') {
    try {
      const { limit = '50' } = req.query;
      const limitNum = Math.min(parseInt(limit, 10) || 50, 200);
      const logData = await kvStore.get('audit:log');
      const logs = logData ? (typeof logData === 'string' ? JSON.parse(logData) : logData) : [];
      return res.status(200).json({ logs: logs.slice(0, limitNum), total: logs.length });
    } catch (error) {
      console.error('Audit log error:', error.message);
      return res.status(500).json({ error: 'Failed to fetch audit log' });
    }
  }

  // Default: config check
  const config = {
    stripe: !!process.env.STRIPE_SECRET_KEY,
    webhook: !!process.env.STRIPE_WEBHOOK_SECRET,
    resend: !!process.env.RESEND_API_KEY,
    telegram: !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
    kv: !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN)
  };

  res.status(200).json(config);
};
