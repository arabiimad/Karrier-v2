require('./_env');
const kvStore = require('./_kv');
const { hashToken, encryptSecret, isExpired } = require('./_credentials');

const CREDENTIAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const token = req.method === 'GET' ? req.query.token : (req.body || {}).token;
    if (!token) return res.status(400).json({ error: 'Missing token' });

    const lookup = await findOrderByToken(token);
    if (!lookup.ok) return res.status(lookup.status).json({ error: lookup.error });

    if (req.method === 'GET') {
      const order = lookup.order;
      return res.status(200).json({
        valid: true,
        expiresAt: order.credentialLink.expiresAt,
        order: {
          sessionId: order.sessionId,
          plan: order.planLabel || order.plan,
          audience: order.audience,
          amount: order.amount,
          currency: order.currency || 'EUR',
          linkedinEmail: order.linkedinEmail
        }
      });
    }

    const { linkedinPassword } = req.body || {};
    if (!linkedinPassword || String(linkedinPassword).length < 4) {
      return res.status(400).json({ error: 'LinkedIn password is required' });
    }

    const now = new Date().toISOString();
    const order = lookup.order;
    order.credentials = {
      linkedinPassword: encryptSecret(linkedinPassword),
      submittedAt: now,
      expiresAt: new Date(Date.now() + CREDENTIAL_RETENTION_MS).toISOString()
    };
    order.credentialsSubmittedAt = now;
    order.hasCredentials = true;
    order.status = 'activating';
    order.updatedAt = now;
    if (order.credentialLink) order.credentialLink.usedAt = now;
    delete order.linkedinPassword;
    delete order.credentialsDeletedAt;

    await kvStore.set(`order:${order.sessionId}`, JSON.stringify(order));
    await kvStore.del(`credential-token:${lookup.tokenHash}`);
    await logAction({
      action: 'credentials_submitted',
      sessionId: order.sessionId,
      timestamp: now
    });

    res.status(200).json({ success: true, status: order.status });
  } catch (error) {
    console.error('Submit credentials error:', error.message);
    res.status(500).json({ error: 'Failed to submit credentials' });
  }
};

async function findOrderByToken(token) {
  const tokenHash = hashToken(token);
  const sessionId = await kvStore.get(`credential-token:${tokenHash}`);
  if (!sessionId) {
    return { ok: false, status: 404, error: 'Invalid or used link' };
  }

  const data = await kvStore.get(`order:${sessionId}`);
  if (!data) return { ok: false, status: 404, error: 'Order not found' };

  const order = typeof data === 'string' ? JSON.parse(data) : data;
  if (!order.credentialLink || order.credentialLink.tokenHash !== tokenHash) {
    return { ok: false, status: 404, error: 'Invalid link' };
  }
  if (order.credentialLink.usedAt) {
    return { ok: false, status: 410, error: 'Link already used' };
  }
  if (order.status === 'done' || order.status === 'refunded') {
    return { ok: false, status: 410, error: 'Order is closed' };
  }
  if (isExpired(order.credentialLink.expiresAt)) {
    await kvStore.del(`credential-token:${tokenHash}`);
    return { ok: false, status: 410, error: 'Link expired' };
  }

  return { ok: true, order, tokenHash };
}

async function logAction(entry) {
  try {
    const logData = await kvStore.get('audit:log');
    const logs = logData ? (typeof logData === 'string' ? JSON.parse(logData) : logData) : [];
    logs.unshift(entry);
    if (logs.length > 500) logs.length = 500;
    await kvStore.set('audit:log', JSON.stringify(logs));
  } catch (e) {
    console.error('Submit credentials audit error:', e.message);
  }
}
