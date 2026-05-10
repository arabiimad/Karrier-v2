require('./_env');
const { verifyAuth } = require('./_auth');
const kvStore = require('./_kv');
const { decryptSecret } = require('./_credentials');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    verifyAuth(req);
  } catch (e) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { session_id } = req.body || {};
    if (!session_id) return res.status(400).json({ error: 'Missing session_id' });

    const data = await kvStore.get(`order:${session_id}`);
    if (!data) return res.status(404).json({ error: 'Order not found' });

    const order = typeof data === 'string' ? JSON.parse(data) : data;
    let linkedinPassword = null;
    let source = 'encrypted';

    if (order.credentials && order.credentials.linkedinPassword) {
      linkedinPassword = decryptSecret(order.credentials.linkedinPassword);
    } else if (order.linkedinPassword) {
      linkedinPassword = order.linkedinPassword;
      source = 'legacy_plaintext';
    }

    if (!linkedinPassword) {
      return res.status(404).json({ error: 'No credentials available' });
    }

    await logAction({
      action: 'credentials_revealed',
      sessionId: session_id,
      source,
      timestamp: new Date().toISOString()
    });

    res.status(200).json({
      success: true,
      linkedinEmail: order.linkedinEmail,
      linkedinPassword
    });
  } catch (error) {
    console.error('Order credentials error:', error.message);
    res.status(500).json({ error: 'Failed to reveal credentials' });
  }
};

async function logAction(entry) {
  try {
    const logData = await kvStore.get('audit:log');
    const logs = logData ? (typeof logData === 'string' ? JSON.parse(logData) : logData) : [];
    logs.unshift(entry);
    if (logs.length > 500) logs.length = 500;
    await kvStore.set('audit:log', JSON.stringify(logs));
  } catch (e) {
    console.error('Order credentials audit error:', e.message);
  }
}
