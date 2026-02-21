require('./_env');
const kvStore = require('./_kv');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const checks = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    services: {}
  };

  // Check KV
  try {
    await kvStore.get('health:ping');
    checks.services.kv = 'ok';
  } catch (e) {
    checks.services.kv = 'error';
    checks.status = 'degraded';
  }

  // Check Stripe key configured
  checks.services.stripe = process.env.STRIPE_SECRET_KEY ? 'configured' : 'missing';
  if (!process.env.STRIPE_SECRET_KEY) checks.status = 'degraded';

  // Check email
  checks.services.email = process.env.RESEND_API_KEY ? 'configured' : 'missing';

  // Check Telegram
  checks.services.telegram = (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) ? 'configured' : 'missing';

  const statusCode = checks.status === 'ok' ? 200 : 503;
  res.status(statusCode).json(checks);
};
